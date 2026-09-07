/**
 * Turn detection (spec section 5).
 *
 * The single most important distinction this module maintains is between:
 *
 *   speech_ended        -- the instant the USER ACTUALLY STOPPED TALKING,
 *                          detected by the VAD model on the audio itself; and
 *   endpoint_detected   -- the instant the SYSTEM DECIDED the user stopped,
 *                          which is `speech_ended + silenceThresholdMs`.
 *
 * Their difference is `endpoint_detection_delay`, the tunable that dominates
 * perceived latency in most call-centre pipelines. Reporting only one of the
 * two would hide it, so the detector emits both as separate timestamped events.
 *
 * The detector is model-agnostic: it consumes a per-frame speech PROBABILITY,
 * which may come from Silero (an ONNX model, high quality) or from the built-in
 * adaptive energy detector (zero dependencies, good enough for a quiet room).
 */

import { rmsFloat } from './pcm.js';

export interface VadTuning {
  /** Trailing silence, in ms, before the turn is declared over. */
  silenceThresholdMs: number;
  /** Probability at or above which a frame is speech. */
  positiveSpeechThreshold: number;
  /** Probability below which a frame is silence (hysteresis). */
  negativeSpeechThreshold: number;
  /** Consecutive speech frames required to open a turn (rejects clicks). */
  minSpeechFrames: number;
  /** Consecutive speech frames required to declare a barge-in. */
  bargeInSpeechFrames: number;
}

export interface VadFrameResult {
  probability: number;
  isSpeech: boolean;
  rms: number;
  /** Milliseconds of continuous silence so far; 0 while speech is active. */
  silenceMs: number;
}

export type VadEvent =
  | { type: 'speech_started'; atMs: number; probability: number }
  | { type: 'speech_ended'; atMs: number; durationMs: number }
  | { type: 'endpoint'; atMs: number; speechEndedAtMs: number; delayMs: number }
  | { type: 'barge_in'; atMs: number };

/**
 * A source of per-frame speech probability.
 *
 * `frameSamples` is how many samples the model wants per call. Silero v5 is
 * strict about this (512 samples at 16 kHz); the energy detector accepts any
 * size but declares the same value so the framing code is identical either way.
 */
export interface SpeechProbabilityModel {
  readonly name: string;
  readonly frameSamples: number;
  readonly sampleRate: number;
  /** Returns P(speech) in [0,1] for exactly `frameSamples` samples. */
  process(frame: Float32Array): number | Promise<number>;
  reset(): void;
}

/* -------------------------------------------------------------------------- */
/* Energy model (dependency-free default)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Adaptive-threshold energy detector.
 *
 * Tracks a slow noise floor and reports speech when the frame's level exceeds
 * it by a margin. Robust to steady background noise (fans, line hum) but not to
 * non-stationary noise (a door slam, another voice). It exists so the app is
 * fully functional with zero native dependencies, and so there is always a
 * fallback if the ONNX model fails to load. Silero is preferred when available.
 */
export class EnergyVadModel implements SpeechProbabilityModel {
  readonly name = 'energy';
  readonly frameSamples: number;
  readonly sampleRate: number;

  private noiseFloor = 0.003;
  private initialised = 0;

  constructor(sampleRate = 16_000, frameSamples = 512, private readonly marginDb = 9) {
    this.sampleRate = sampleRate;
    this.frameSamples = frameSamples;
  }

  process(frame: Float32Array): number {
    const rms = rmsFloat(frame);

    // Spend the first ~300 ms learning the room before trusting the threshold.
    if (this.initialised < 10) {
      this.initialised++;
      this.noiseFloor = this.noiseFloor * 0.7 + Math.max(rms, 1e-5) * 0.3;
      return 0;
    }

    const threshold = this.noiseFloor * 10 ** (this.marginDb / 20);
    const ratio = rms / Math.max(threshold, 1e-6);

    // Adapt the floor only while quiet, so sustained speech cannot drag it up.
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

/* -------------------------------------------------------------------------- */
/* Turn detector                                                               */
/* -------------------------------------------------------------------------- */

export interface TurnDetectorOptions extends VadTuning {
  sampleRate: number;
  frameSamples: number;
  /** Current wall position in the audio stream, in ms. Injected for testing. */
  now: () => number;
}

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
  private tuning: VadTuning;

  constructor(private opts: TurnDetectorOptions, private readonly emit: (e: VadEvent) => void) {
    this.frameMs = (opts.frameSamples / opts.sampleRate) * 1000;
    this.tuning = { ...opts };
  }

  updateTuning(t: Partial<VadTuning>): void {
    this.tuning = { ...this.tuning, ...t };
  }

  /** Tell the detector whether assistant audio is currently playing. */
  setAssistantSpeaking(v: boolean): void {
    this.assistantSpeaking = v;
    if (!v) this.bargeFrames = 0;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get currentSilenceMs(): number {
    return this.silenceFrames * this.frameMs;
  }

  get lastSpeechEndMs(): number | null {
    return this.speechEndedAtMs;
  }

  /**
   * Feed one frame's speech probability. Returns a per-frame summary for the
   * live meters; state transitions are delivered through `emit`.
   */
  push(probability: number, rms: number): VadFrameResult {
    const t = this.opts.now();
    const isSpeech = this.speaking
      ? probability > this.tuning.negativeSpeechThreshold
      : probability >= this.tuning.positiveSpeechThreshold;

    if (isSpeech) {
      this.speechFrames++;
      this.silenceFrames = 0;

      // Barge-in is evaluated independently of turn state: the user may start
      // talking over the assistant before any new turn has opened.
      if (this.assistantSpeaking) {
        this.bargeFrames++;
        if (this.bargeFrames === this.tuning.bargeInSpeechFrames) {
          this.emit({ type: 'barge_in', atMs: t - this.bargeFrames * this.frameMs });
        }
      }

      if (!this.speaking && this.speechFrames >= this.tuning.minSpeechFrames) {
        this.speaking = true;
        this.endpointFired = false;
        this.speechEndedAtMs = null;
        // Backdate to the first speech frame, not the frame that crossed the
        // confirmation threshold, so speech duration is not under-reported.
        this.speechStartedAtMs = t - this.speechFrames * this.frameMs;
        this.emit({ type: 'speech_started', atMs: this.speechStartedAtMs, probability });
      }
    } else {
      this.bargeFrames = 0;
      if (this.speaking) {
        this.silenceFrames++;
        const silenceMs = this.silenceFrames * this.frameMs;

        // The PHYSICAL end of speech is the first silent frame, recorded the
        // moment we see it -- long before we are willing to act on it.
        if (this.silenceFrames === 1) {
          this.speechEndedAtMs = t - this.frameMs;
          this.emit({
            type: 'speech_ended',
            atMs: this.speechEndedAtMs,
            durationMs: this.speechStartedAtMs != null ? this.speechEndedAtMs - this.speechStartedAtMs : 0,
          });
        }

        // The SYSTEM's decision comes only after the configured hangover.
        if (!this.endpointFired && silenceMs >= this.tuning.silenceThresholdMs) {
          this.endpointFired = true;
          this.speaking = false;
          this.speechFrames = 0;
          const speechEnd = this.speechEndedAtMs ?? t;
          this.emit({ type: 'endpoint', atMs: t, speechEndedAtMs: speechEnd, delayMs: t - speechEnd });
        }
      } else {
        this.speechFrames = 0;
      }
    }

    return {
      probability,
      isSpeech,
      rms,
      silenceMs: this.speaking ? this.silenceFrames * this.frameMs : 0,
    };
  }

  /** Abandon the in-progress turn without emitting an endpoint. */
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

/* -------------------------------------------------------------------------- */
/* Framing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-blocks a stream of arbitrary-length Float32 chunks into fixed-size frames.
 * Silero requires exactly 512 samples per call at 16 kHz, and the microphone
 * delivers whatever the AudioWorklet quantum happens to be, so this sits
 * between them.
 */
export class FrameSplitter {
  private buf: Float32Array;
  private filled = 0;

  constructor(private readonly frameSamples: number) {
    this.buf = new Float32Array(frameSamples);
  }

  push(input: Float32Array, onFrame: (frame: Float32Array) => void): void {
    let offset = 0;
    while (offset < input.length) {
      const need = this.frameSamples - this.filled;
      const take = Math.min(need, input.length - offset);
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
