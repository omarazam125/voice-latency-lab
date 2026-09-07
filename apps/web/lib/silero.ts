/**
 * Silero VAD v5 running in the browser via onnxruntime-web.
 *
 * Deliberately implemented directly against the ONNX graph rather than through
 * a wrapper library, because this application needs per-frame control of
 * TIMING: the exact frame at which speech stopped is the anchor for every
 * latency number, and a callback-style API that only reports "speech ended"
 * after its own hangover would destroy that measurement.
 *
 * Graph signature (verified against the published v5 model, and identical in
 * v6, so the newer weights drop in without a code change):
 *
 *   input  float32 [batch, samples]     512 samples at 16 kHz, plus 64 of context
 *   state  float32 [2, batch, 128]      carried between calls
 *   sr     int64   scalar               16000
 *   ->
 *   output float32 [batch, 1]           P(speech)
 *   stateN float32 [2, batch, 128]      next state
 *
 * The 64-sample context prefix matches the official Python wrapper, which
 * prepends the tail of the previous chunk before inference.
 */

import type { SpeechProbabilityModel } from './vadTypes';

const FRAME_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const SAMPLE_RATE = 16000;

export interface SileroOptions {
  modelUrl?: string;
  /** Single-threaded avoids needing cross-origin isolation just for the VAD. */
  numThreads?: number;
}

export class SileroVad implements SpeechProbabilityModel {
  readonly name = 'silero-v5';
  readonly frameSamples = FRAME_SAMPLES;
  readonly sampleRate = SAMPLE_RATE;

  private session: any = null;
  private ort: any = null;
  private state: any = null;
  private srTensor: any = null;
  private context = new Float32Array(CONTEXT_SAMPLES);
  private input = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
  private busy = false;

  constructor(private readonly opts: SileroOptions = {}) {}

  get loaded(): boolean {
    return this.session !== null;
  }

  async load(): Promise<void> {
    if (this.session) return;
    // Default entry point bundles the WASM inline, so there are no wasmPaths to
    // configure and no separate .wasm/.mjs files to copy or serve.
    const ort = await import('onnxruntime-web');
    this.ort = ort;
    try {
      ort.env.wasm.numThreads = this.opts.numThreads ?? 1;
      ort.env.logLevel = 'error';
    } catch {
      /* non-fatal */
    }

    const url = this.opts.modelUrl ?? '/models/silero_vad.onnx';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load Silero model from ${url} (HTTP ${res.status})`);
    const buf = await res.arrayBuffer();

    this.session = await ort.InferenceSession.create(buf, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    this.srTensor = new ort.Tensor('int64', [BigInt(SAMPLE_RATE)]);
    this.resetState();
  }

  private resetState(): void {
    this.state = new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  }

  /**
   * Returns P(speech) for exactly `frameSamples` samples.
   *
   * If a previous inference is still running the frame is skipped and the
   * caller is told so by the returned -1, rather than queueing: on the audio
   * path a stale answer is worse than a missing one, and at 32 ms per frame
   * this effectively never happens.
   */
  async process(frame: Float32Array): Promise<number> {
    if (!this.session || this.busy) return -1;
    this.busy = true;
    try {
      this.input.set(this.context, 0);
      this.input.set(frame.subarray(0, FRAME_SAMPLES), CONTEXT_SAMPLES);

      const t = new this.ort.Tensor('float32', this.input, [1, this.input.length]);
      const out = await this.session.run({ input: t, state: this.state, sr: this.srTensor });
      if (out.stateN) this.state = out.stateN;

      // Carry the tail forward as the next call's context prefix.
      this.context.set(frame.subarray(FRAME_SAMPLES - CONTEXT_SAMPLES, FRAME_SAMPLES));

      return Number(out.output.data[0]);
    } catch {
      return -1;
    } finally {
      this.busy = false;
    }
  }

  reset(): void {
    if (!this.ort) return;
    this.resetState();
    this.context.fill(0);
  }

  async dispose(): Promise<void> {
    try {
      await this.session?.release?.();
    } catch {
      /* ignore */
    }
    this.session = null;
  }
}
