/**
 * Microphone capture pipeline.
 *
 *   getUserMedia -> AudioWorklet (downsample to 16 kHz PCM16)
 *        |                |
 *        |                +-> uplink: binary WebSocket frames, ~20 ms each
 *        |
 *        +-> 512-sample reblocking -> Silero VAD -> TurnDetector
 *
 * The VAD runs HERE, next to the microphone, rather than on the server, for two
 * reasons: the endpoint decision is not delayed by a network hop, and barge-in
 * can stop local playback the instant the user speaks instead of a round trip
 * later.
 */

import { audioTimeToPerformanceMs, nowNs, NS_PER_MS } from './clock';
import { SileroVad } from './silero';
import { EnergyVadModel, FrameSplitter, TurnDetector, type SpeechProbabilityModel, type VadEvent, type VadTuning } from './vadTypes';

export interface CaptureStats {
  framesPerSec: number;
  bytesPerSec: number;
  rms: number;
  peak: number;
  probability: number;
  isSpeech: boolean;
  silenceMs: number;
  frameCount: number;
  vadModel: string;
  nativeSampleRate: number;
}

export interface CaptureCallbacks {
  onAudioFrame: (pcm: Int16Array) => void;
  onVadEvent: (e: VadEvent, atNs: bigint) => void;
  onStats: (s: CaptureStats) => void;
  onError: (message: string) => void;
}

export interface CaptureOptions {
  frameMs: number;
  tuning: VadTuning;
  /** Disable the browser's own processing when testing raw latency behaviour. */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  preferSilero: boolean;
}

const TARGET_RATE = 16000;
const VAD_FRAME = 512;

export class MicrophoneCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private model: SpeechProbabilityModel = new EnergyVadModel(TARGET_RATE, VAD_FRAME);
  private silero: SileroVad | null = null;
  private splitter = new FrameSplitter(VAD_FRAME);
  private detector: TurnDetector | null = null;

  private frameCount = 0;
  private bytesInWindow = 0;
  private framesInWindow = 0;
  private windowStart = 0;
  private lastStats: CaptureStats | null = null;

  /** Samples consumed by the VAD so far, for exact frame dating. */
  private vadSamplesConsumed = 0;
  /** Wall instant (performance.now ms) of sample 0 of the 16 kHz stream. */
  private streamOriginMs = 0;
  private lastProbability = 0;

  private running = false;

  constructor(
    private opts: CaptureOptions,
    private readonly cb: CaptureCallbacks,
  ) {}

  get active(): boolean {
    return this.running;
  }
  get vadModelName(): string {
    return this.model.name;
  }
  get nativeSampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }
  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  updateTuning(t: Partial<VadTuning>): void {
    this.opts.tuning = { ...this.opts.tuning, ...t };
    this.detector?.updateTuning(t);
  }

  setAssistantSpeaking(v: boolean): void {
    this.detector?.setAssistantSpeaking(v);
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Echo cancellation is ON by default because barge-in is otherwise
        // impossible: without it the VAD hears the assistant's own voice
        // through the speakers and fires a false interruption on every reply.
        echoCancellation: this.opts.echoCancellation,
        noiseSuppression: this.opts.noiseSuppression,
        autoGainControl: this.opts.autoGainControl,
      },
    });

    // Use the DEVICE's native rate and resample in the worklet. Forcing a
    // 16 kHz AudioContext makes the browser resample the whole graph, and the
    // spec warns that can raise context latency "possibly by a large amount".
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    await this.ctx.audioWorklet.addModule('/worklets/capture-processor.js');

    const frameSamples = Math.max(80, Math.round((this.opts.frameMs / 1000) * TARGET_RATE));
    this.node = new AudioWorkletNode(this.ctx, 'vll-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSamples },
    });

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);

    /* -- VAD model ------------------------------------------------------- */
    if (this.opts.preferSilero) {
      try {
        this.silero = new SileroVad();
        await this.silero.load();
        this.model = this.silero;
      } catch (e: any) {
        // Never leave the app without turn detection.
        this.cb.onError(`Silero VAD unavailable (${e?.message ?? e}); using the energy detector instead.`);
        this.model = new EnergyVadModel(TARGET_RATE, VAD_FRAME);
      }
    }
    this.splitter = new FrameSplitter(VAD_FRAME);

    this.detector = new TurnDetector(this.opts.tuning, VAD_FRAME, TARGET_RATE, (e) => {
      // Convert the VAD's stream-relative instant into monotonic ns for the wire.
      this.cb.onVadEvent(e, BigInt(Math.round(e.atMs * NS_PER_MS)));
    });

    this.streamOriginMs = performance.now();
    this.windowStart = performance.now();
    this.node.port.onmessage = (ev) => this.onWorkletMessage(ev.data);
    this.running = true;
  }

  private onWorkletMessage(d: any): void {
    if (!d) return;
    if (d.type === 'ready') {
      // Anchor the 16 kHz stream to the wall clock once the graph is running.
      this.streamOriginMs = performance.now();
      return;
    }
    if (d.type !== 'frame') return;

    const pcm = new Int16Array(d.pcm);
    this.frameCount++;
    this.framesInWindow++;
    this.bytesInWindow += pcm.byteLength;

    // 1. Uplink immediately. This must not wait on the VAD.
    this.cb.onAudioFrame(pcm);

    // 2. Date this frame precisely. The worklet reported the AudioContext time
    //    at the start of the render quantum that produced it; converting via
    //    getOutputTimestamp keeps mic and playback on one comparable clock.
    if (this.ctx && d.contextTime != null && this.frameCount % 25 === 1) {
      const wall = audioTimeToPerformanceMs(this.ctx, d.contextTime);
      const expected = this.streamOriginMs + (d.startSample / TARGET_RATE) * 1000;
      // Slowly correct drift rather than jumping, so timestamps stay monotonic.
      this.streamOriginMs += (wall - expected) * 0.2;
    }

    // 3. Feed the VAD in its required 512-sample blocks.
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;

    this.splitter.push(floats, (frame) => {
      const framesEnd = this.vadSamplesConsumed + VAD_FRAME;
      const atMs = this.streamOriginMs + (framesEnd / TARGET_RATE) * 1000;
      this.vadSamplesConsumed = framesEnd;

      const p = this.model.process(frame);
      if (typeof p === 'number') {
        this.applyProbability(p, atMs);
      } else {
        // Silero is async; the frame timestamp travels with the promise so a
        // late result is still attributed to the instant it describes.
        void p.then((v) => this.applyProbability(v, atMs));
      }
    });

    this.emitStats(d.rms ?? 0, d.peak ?? 0);
  }

  private applyProbability(p: number, atMs: number): void {
    if (p < 0) return; // model skipped this frame
    this.lastProbability = p;
    this.detector?.push(p, atMs);
  }

  private emitStats(rms: number, peak: number): void {
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < 250) return;
    const stats: CaptureStats = {
      framesPerSec: Math.round((this.framesInWindow / elapsed) * 1000),
      bytesPerSec: Math.round((this.bytesInWindow / elapsed) * 1000),
      rms,
      peak,
      probability: this.lastProbability,
      isSpeech: this.detector?.isSpeaking ?? false,
      silenceMs: Math.round(this.detector?.silenceMs ?? 0),
      frameCount: this.frameCount,
      vadModel: this.model.name,
      nativeSampleRate: this.ctx?.sampleRate ?? 0,
    };
    this.lastStats = stats;
    this.framesInWindow = 0;
    this.bytesInWindow = 0;
    this.windowStart = now;
    this.cb.onStats(stats);
  }

  get stats(): CaptureStats | null {
    return this.lastStats;
  }

  /** Abandon the in-progress turn without firing an endpoint. */
  resetTurn(): void {
    this.detector?.reset();
    this.model.reset();
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      this.node?.port.postMessage({ type: 'stop' });
      this.node?.disconnect();
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    try {
      await this.ctx?.close();
    } catch {
      /* ignore */
    }
    await this.silero?.dispose();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.silero = null;
  }
}
