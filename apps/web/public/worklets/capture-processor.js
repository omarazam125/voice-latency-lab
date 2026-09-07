/**
 * Microphone capture worklet: native rate -> 16 kHz mono PCM16.
 *
 * Runs on the audio rendering thread, so it must not allocate per render
 * quantum where it can be avoided and must never block.
 *
 * WHY NOT MediaRecorder: MediaRecorder emits container-framed chunks on its own
 * schedule (typically 100 ms or more) and applies a codec. Both add buffering
 * that would appear in the measurements as provider latency. An AudioWorklet
 * delivers every 128-sample render quantum with no container and no codec.
 *
 * WHY NOT NAIVE DECIMATION: dropping every Nth sample folds everything above
 * the new Nyquist frequency back into the passband. That both degrades STT
 * accuracy and injects broadband energy that confuses an energy VAD. A
 * windowed-sinc FIR is applied before decimation for integer ratios (48000 ->
 * 16000 is exactly 3:1); non-integer device rates fall back to interpolation.
 */

const TARGET_RATE = 16000;

/** Blackman-windowed sinc low-pass, normalised to unity DC gain. */
function buildLowpass(n, cutoff) {
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

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.frameSamples = o.frameSamples || 320; // 20 ms at 16 kHz
    this.nativeRate = sampleRate;

    this.ratio = this.nativeRate / TARGET_RATE;
    this.integerRatio = Number.isInteger(this.ratio) ? this.ratio : 0;

    if (this.integerRatio > 1) {
      this.kernel = buildLowpass(16 * this.integerRatio + 1, 0.5 / this.integerRatio);
      this.history = new Float32Array(this.kernel.length - 1);
    } else {
      this.kernel = null;
      this.history = new Float32Array(0);
      this.fracPos = 0;
      this.lastSample = 0;
    }

    // Output accumulator: fills to frameSamples, then ships.
    this.out = new Float32Array(this.frameSamples);
    this.outFilled = 0;

    /** Total 16 kHz samples emitted. Lets the main thread date every frame exactly. */
    this.samplesEmitted = 0;
    this.muted = false;
    this.running = true;

    this.port.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'stop') this.running = false;
      else if (d.type === 'mute') this.muted = !!d.value;
    };

    this.port.postMessage({ type: 'ready', nativeRate: this.nativeRate, targetRate: TARGET_RATE, frameSamples: this.frameSamples });
  }

  /** Anti-aliased integer decimation with continuity across render quanta. */
  decimate(input) {
    const k = this.kernel;
    const kn = k.length;
    const hist = this.history;
    const total = hist.length + input.length;
    const work = new Float32Array(total);
    work.set(hist, 0);
    work.set(input, hist.length);

    const outLen = Math.max(0, Math.floor((total - kn + 1) / this.integerRatio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const base = i * this.integerRatio;
      let acc = 0;
      for (let j = 0; j < kn; j++) acc += work[base + j] * k[j];
      out[i] = acc;
    }
    const consumed = outLen * this.integerRatio;
    const keep = Math.min(total - consumed, kn - 1);
    this.history = work.slice(total - keep);
    return out;
  }

  /** Fallback for non-integer device rates (44100 -> 16000 and friends). */
  interpolate(input) {
    const step = this.ratio;
    const est = Math.ceil(input.length / step) + 2;
    const out = new Float32Array(est);
    let n = 0;
    let pos = this.fracPos;
    while (pos < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.lastSample : input[i - 1];
      const b = input[i];
      out[n++] = a + (b - a) * frac;
      pos += step;
    }
    this.fracPos = pos - input.length;
    this.lastSample = input.length > 0 ? input[input.length - 1] : this.lastSample;
    return out.subarray(0, n);
  }

  process(inputs) {
    if (!this.running) return false;
    const channel = inputs[0] && inputs[0][0];
    // No input yet (device still starting): keep the processor alive.
    if (!channel) return true;

    const down = this.integerRatio > 1 ? this.decimate(channel) : this.integerRatio === 1 ? channel : this.interpolate(channel);

    for (let i = 0; i < down.length; i++) {
      this.out[this.outFilled++] = this.muted ? 0 : down[i];
      if (this.outFilled === this.frameSamples) {
        this.ship();
      }
    }
    return true;
  }

  ship() {
    const n = this.frameSamples;
    const pcm = new Int16Array(n);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      let s = this.out[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      sumSq += s * s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.outFilled = 0;

    // `currentTime` is the AudioContext clock at the START of this render
    // quantum. The main thread converts it into a performance.now()-comparable
    // instant with AudioContext.getOutputTimestamp().
    this.port.postMessage(
      {
        type: 'frame',
        pcm: pcm.buffer,
        samples: n,
        // Index of the FIRST sample in this frame, in the 16 kHz stream.
        startSample: this.samplesEmitted,
        contextTime: currentTime,
        rms: Math.sqrt(sumSq / n),
        peak,
      },
      [pcm.buffer], // transfer, do not copy
    );
    this.samplesEmitted += n;
  }
}

registerProcessor('vll-capture', CaptureProcessor);
