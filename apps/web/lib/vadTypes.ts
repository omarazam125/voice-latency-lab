/**
 * Browser-side VAD contracts, mirroring @vll/audio but free of any Node import
 * so the bundle stays clean.
 */

export interface SpeechProbabilityModel {
  readonly name: string;
  readonly frameSamples: number;
  readonly sampleRate: number;
  process(frame: Float32Array): number | Promise<number>;
  reset(): void;
}

export interface VadTuning {
  silenceThresholdMs: number;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechFrames: number;
  bargeInSpeechFrames: number;
  /** When false, the caller talking over the agent never stops it. */
  bargeInEnabled: boolean;
}

export type VadEvent =
  | { type: 'speech_started'; atMs: number; probability: number }
  | { type: 'speech_ended'; atMs: number; durationMs: number }
  | { type: 'endpoint'; atMs: number; speechEndedAtMs: number; delayMs: number }
  | { type: 'barge_in'; atMs: number };

/**
 * Adaptive-threshold energy VAD.
 *
 * Always available, needs no model download, and is the automatic fallback if
 * the ONNX model fails to load -- so the application is never left without turn
 * detection, which would make it useless.
 */
export class EnergyVadModel implements SpeechProbabilityModel {
  readonly name = 'energy';
  readonly frameSamples: number;
  readonly sampleRate: number;

  private noiseFloor = 0.003;
  private initialised = 0;

  constructor(sampleRate = 16000, frameSamples = 512, private readonly marginDb = 9) {
    this.sampleRate = sampleRate;
    this.frameSamples = frameSamples;
  }

  process(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / Math.max(1, frame.length));

    // Learn the room for ~300 ms before trusting the threshold.
    if (this.initialised < 10) {
      this.initialised++;
      this.noiseFloor = this.noiseFloor * 0.7 + Math.max(rms, 1e-5) * 0.3;
      return 0;
    }

    const threshold = this.noiseFloor * 10 ** (this.marginDb / 20);
    const ratio = rms / Math.max(threshold, 1e-6);
    // Adapt only while quiet, so sustained speech cannot drag the floor up.
    if (ratio < 1) this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;

    if (ratio <= 0.7) return 0;
    if (ratio >= 2) return 1;
    return (ratio - 0.7) / 1.3;
  }

  reset(): void {
    this.noiseFloor = 0.003;
    this.initialised = 0;
  }
}

/**
 * Turn detector. Keeps the two instants that matter strictly separate:
 *
 *   speech_ended  -- the user ACTUALLY stopped talking (first silent frame)
 *   endpoint      -- the SYSTEM decided they stopped (after the hangover)
 *
 * Their difference is `endpoint_detection_delay`, the number this whole tool
 * exists to make visible.
 */
export class TurnDetector {
  private speaking = false;
  private speechFrames = 0;
  private silenceFrames = 0;
  private speechStartedAtMs: number | null = null;
  private speechEndedAtMs: number | null = null;
  private endpointFired = false;
  private assistantSpeaking = false;
  private bargeFrames = 0;
  private readonly frameMs: number;

  constructor(
    private tuning: VadTuning,
    frameSamples: number,
    sampleRate: number,
    private readonly emit: (e: VadEvent) => void,
  ) {
    this.frameMs = (frameSamples / sampleRate) * 1000;
  }

  updateTuning(t: Partial<VadTuning>): void {
    this.tuning = { ...this.tuning, ...t };
  }

  setAssistantSpeaking(v: boolean): void {
    this.assistantSpeaking = v;
    if (!v) this.bargeFrames = 0;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get silenceMs(): number {
    return this.speaking ? this.silenceFrames * this.frameMs : 0;
  }

  /** `atMs` is the wall instant of the END of this frame. */
  push(probability: number, atMs: number): { isSpeech: boolean; silenceMs: number } {
    const isSpeech = this.speaking
      ? probability > this.tuning.negativeSpeechThreshold
      : probability >= this.tuning.positiveSpeechThreshold;

    if (isSpeech) {
      this.speechFrames++;
      this.silenceFrames = 0;

      if (this.assistantSpeaking && this.tuning.bargeInEnabled !== false) {
        this.bargeFrames++;
        if (this.bargeFrames === this.tuning.bargeInSpeechFrames) {
          this.emit({ type: 'barge_in', atMs: atMs - this.bargeFrames * this.frameMs });
        }
      }

      if (!this.speaking && this.speechFrames >= this.tuning.minSpeechFrames) {
        this.speaking = true;
        this.endpointFired = false;
        this.speechEndedAtMs = null;
        // Backdate to the first speech frame so duration is not under-reported.
        this.speechStartedAtMs = atMs - this.speechFrames * this.frameMs;
        this.emit({ type: 'speech_started', atMs: this.speechStartedAtMs, probability });
      }
    } else {
      this.bargeFrames = 0;
      if (this.speaking) {
        this.silenceFrames++;
        const silenceMs = this.silenceFrames * this.frameMs;

        if (this.silenceFrames === 1) {
          this.speechEndedAtMs = atMs - this.frameMs;
          this.emit({
            type: 'speech_ended',
            atMs: this.speechEndedAtMs,
            durationMs: this.speechStartedAtMs != null ? this.speechEndedAtMs - this.speechStartedAtMs : 0,
          });
        }

        if (!this.endpointFired && silenceMs >= this.tuning.silenceThresholdMs) {
          this.endpointFired = true;
          this.speaking = false;
          this.speechFrames = 0;
          const speechEnd = this.speechEndedAtMs ?? atMs;
          this.emit({ type: 'endpoint', atMs, speechEndedAtMs: speechEnd, delayMs: atMs - speechEnd });
        }
      } else {
        this.speechFrames = 0;
      }
    }

    return { isSpeech, silenceMs: this.silenceMs };
  }

  reset(): void {
    this.speaking = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.speechStartedAtMs = null;
    this.speechEndedAtMs = null;
    this.endpointFired = false;
    this.bargeFrames = 0;
  }
}

/** Re-blocks arbitrary-length chunks into fixed-size frames. */
export class FrameSplitter {
  private buf: Float32Array;
  private filled = 0;

  constructor(private readonly frameSamples: number) {
    this.buf = new Float32Array(frameSamples);
  }

  push(input: Float32Array, onFrame: (frame: Float32Array) => void): void {
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(this.frameSamples - this.filled, input.length - offset);
      this.buf.set(input.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.frameSamples) {
        onFrame(this.buf);
        this.filled = 0;
      }
    }
  }

  reset(): void {
    this.filled = 0;
  }
}
