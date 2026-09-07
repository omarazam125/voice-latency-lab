/**
 * PCM helpers shared by the browser capture path, the server relay and the
 * benchmark runner.
 *
 * Everything here is deliberately allocation-conscious: these functions run on
 * every 20 ms audio frame, so an unnecessary array copy is a real cost.
 */

export const PCM16_BYTES_PER_SAMPLE = 2;

/** Milliseconds of audio represented by a PCM16 mono byte length. */
export function pcm16DurationMs(byteLength: number, sampleRate: number): number {
  return (byteLength / PCM16_BYTES_PER_SAMPLE / sampleRate) * 1000;
}

/** Bytes required for a given duration of PCM16 mono audio. */
export function pcm16BytesForMs(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate) * PCM16_BYTES_PER_SAMPLE;
}

/** Float32 [-1,1] -> Int16, with clipping. */
export function floatToInt16(input: Float32Array, out?: Int16Array): Int16Array {
  const dst = out && out.length >= input.length ? out : new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    // Asymmetric scaling is the conventional, non-clipping mapping.
    dst[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return dst.length === input.length ? dst : dst.subarray(0, input.length);
}

/** Int16 -> Float32 [-1,1]. */
export function int16ToFloat(input: Int16Array, out?: Float32Array): Float32Array {
  const dst = out && out.length >= input.length ? out : new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) dst[i] = input[i] / 0x8000;
  return dst.length === input.length ? dst : dst.subarray(0, input.length);
}

/** Little-endian byte view -> Int16Array, tolerating unaligned offsets. */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  if (bytes.byteOffset % 2 === 0 && bytes.byteLength % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  }
  const copy = new Uint8Array(bytes.byteLength - (bytes.byteLength % 2));
  copy.set(bytes.subarray(0, copy.length));
  return new Int16Array(copy.buffer);
}

export function int16ToBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/* -------------------------------------------------------------------------- */
/* Level metering                                                              */
/* -------------------------------------------------------------------------- */

/** Root-mean-square level of a float frame, in [0,1]. */
export function rmsFloat(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

export function rmsInt16(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

export function peakInt16(frame: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = Math.abs(frame[i]);
    if (v > peak) peak = v;
  }
  return peak / 0x8000;
}

/** RMS expressed in dBFS; returns -Infinity for digital silence. */
export function toDbfs(rms: number): number {
  return rms <= 0 ? -Infinity : 20 * Math.log10(rms);
}

/* -------------------------------------------------------------------------- */
/* Resampling                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Anti-aliased decimator for integer-ratio downsampling (the common
 * 48000 -> 16000 case is exactly 3:1).
 *
 * A naive "take every Nth sample" decimation folds everything above the new
 * Nyquist frequency back into the passband as audible aliasing, which both
 * degrades STT accuracy and confuses an energy VAD. A windowed-sinc FIR run
 * before decimation avoids that. The kernel is precomputed once per ratio.
 */
export class Decimator {
  private readonly kernel: Float32Array;
  private readonly ratio: number;
  private history: Float32Array;

  constructor(ratio: number, taps = 32) {
    if (!Number.isInteger(ratio) || ratio < 1) throw new Error(`Decimator ratio must be a positive integer, got ${ratio}`);
    this.ratio = ratio;
    const n = ratio === 1 ? 1 : taps * ratio + 1;
    this.kernel = buildLowpass(n, 0.5 / ratio);
    this.history = new Float32Array(n - 1);
  }

  outputLengthFor(inputLength: number): number {
    return Math.floor(inputLength / this.ratio);
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input;
    const k = this.kernel;
    const kn = k.length;
    const hist = this.history;
    const total = hist.length + input.length;

    // Working buffer: previous tail + this block.
    const work = new Float32Array(total);
    work.set(hist, 0);
    work.set(input, hist.length);

    const outLen = Math.floor((total - kn + 1) / this.ratio);
    const out = new Float32Array(Math.max(0, outLen));
    for (let i = 0; i < outLen; i++) {
      const base = i * this.ratio;
      let acc = 0;
      for (let j = 0; j < kn; j++) acc += work[base + j] * k[j];
      out[i] = acc;
    }

    // Retain the last (kn - 1) samples so the next block is continuous.
    const consumed = outLen * this.ratio;
    const keep = total - consumed;
    this.history = work.slice(total - Math.min(keep, kn - 1));
    return out;
  }

  reset(): void {
    this.history = new Float32Array(this.kernel.length - 1);
  }
}

/** Blackman-windowed sinc low-pass, normalised to unity DC gain. */
function buildLowpass(n: number, cutoff: number): Float32Array {
  const k = new Float32Array(n);
  const mid = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    const v = sinc * (Number.isFinite(w) ? w : 1);
    k[i] = v;
    sum += v;
  }
  if (sum !== 0) for (let i = 0; i < n; i++) k[i] /= sum;
  return k;
}

/**
 * Linear-interpolation resampler for arbitrary (non-integer) ratios. Used only
 * for odd device rates such as 44100 -> 16000, where an exact decimator does
 * not apply. Quality is lower than the FIR path, which is why an integer ratio
 * is preferred whenever the device offers one.
 */
export class LinearResampler {
  private position = 0;
  private last = 0;

  constructor(
    private readonly inRate: number,
    private readonly outRate: number,
  ) {}

  process(input: Float32Array): Float32Array {
    const step = this.inRate / this.outRate;
    const out: number[] = [];
    let pos = this.position;
    while (pos < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.last : input[i - 1];
      const b = input[i];
      out.push(a + (b - a) * frac);
      pos += step;
    }
    this.position = pos - input.length;
    this.last = input.length > 0 ? input[input.length - 1] : this.last;
    return Float32Array.from(out);
  }

  reset(): void {
    this.position = 0;
    this.last = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* mu-law                                                                      */
/* -------------------------------------------------------------------------- */

const MULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    t[i] = sign ? -sample : sample;
  }
  return t;
})();

/** G.711 mu-law -> PCM16. Needed only when the Hamsa `mulaw` flag is on. */
export function mulawToPcm16(input: Uint8Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = MULAW_TABLE[input[i]];
  return out;
}
