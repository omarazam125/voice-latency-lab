/**
 * Mode C background audio — browser rendering.
 *
 * Everything here shares the StreamingPlayer's AudioContext rather than opening
 * a second one. That is not tidiness: a second AudioContext gets its own output
 * device callback and its own base latency, so ambience and speech would drift
 * against each other, and `getOutputTimestamp()` — the clock the whole TTFS
 * measurement rests on — would no longer describe both.
 *
 *   playerWorklet ──► playerGain ──┐
 *   bedSource     ──► bedGain    ──┼──► destination
 *   keyboard      ──► kbGain     ──┤
 *   filler        ──► fillerGain ──┘
 *
 * The bed and keyboard are SYNTHESISED, not sampled. That avoids shipping audio
 * assets whose licences would have to be audited (most Freesound material is
 * CC-BY, not CC0), keeps the bundle unchanged, and works with no network. An
 * operator who wants a real recording can still point `bed.url` at one.
 *
 * Nothing in this file ever reports a timestamp into the latency pipeline. See
 * the measurement contract in packages/core/src/modeC/backgroundAudio.ts.
 */

import type { BackgroundCue } from '@vll/core';

const BED_SECONDS = 8;
/** Crossfade length used to make the bed loop without an audible seam. */
const BED_SEAM_SECONDS = 1.2;

export interface AmbienceCallbacks {
  /** Fired when a filler/backchannel sound actually reaches the output. */
  onPerceptualAudio?: (info: { kind: 'filler' | 'backchannel'; phrase: string }) => void;
  onError?: (message: string) => void;
}

export class AmbienceEngine {
  private bedGain: GainNode;
  private kbGain: GainNode;
  private fillerGain: GainNode;

  private bedBuffer: AudioBuffer | null = null;
  private bedSource: AudioBufferSourceNode | null = null;
  private bedUrl: string | null = null;

  private kbTimer: ReturnType<typeof setTimeout> | null = null;
  private kbRate = 6;
  private kbJitter = 0.4;

  /** Pre-rendered hesitation sounds, keyed by phrase. */
  private fillers = new Map<string, AudioBuffer>();
  private activeFiller: AudioBufferSourceNode | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly cb: AmbienceCallbacks = {},
  ) {
    this.bedGain = ctx.createGain();
    this.kbGain = ctx.createGain();
    this.fillerGain = ctx.createGain();
    this.bedGain.gain.value = 0;
    this.kbGain.gain.value = 0;
    this.fillerGain.gain.value = 1;
    this.bedGain.connect(ctx.destination);
    this.kbGain.connect(ctx.destination);
    this.fillerGain.connect(ctx.destination);
  }

  /**
   * Build the bed buffer ahead of time.
   *
   * Synthesis is a few million samples of arithmetic. Doing it lazily on the
   * first cue would put that work directly in front of the first thing the
   * caller hears, which is precisely the latency this feature exists to hide.
   */
  async prepare(source: 'procedural_office' | 'url', url: string | null): Promise<void> {
    if (source === 'url') {
      if (!url || url === this.bedUrl) return;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.bedBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
        this.bedUrl = url;
      } catch (e: any) {
        // Fall back rather than leaving the caller in silence.
        this.cb.onError?.(`Background audio URL failed (${e?.message ?? e}); using synthesised bed.`);
        this.bedBuffer = this.buildOfficeBed();
        this.bedUrl = null;
      }
      return;
    }
    if (!this.bedBuffer || this.bedUrl !== null) {
      this.bedBuffer = this.buildOfficeBed();
      this.bedUrl = null;
    }
  }

  /** Install a pre-rendered hesitation sound (PCM16 mono at `rate`). */
  setFillerSample(phrase: string, pcm: Int16Array, rate: number): void {
    if (pcm.length === 0) return;
    const buf = this.ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
    this.fillers.set(phrase, buf);
  }

  get preparedFillers(): number {
    return this.fillers.size;
  }

  apply(cue: BackgroundCue): void {
    switch (cue.kind) {
      case 'bed':
        if (cue.action === 'gain') this.ramp(this.bedGain, cue.gain, cue.fadeMs);
        else if (cue.action === 'start') this.startBed();
        else this.stopBed();
        break;

      case 'keyboard':
        if (cue.action === 'start') this.startKeyboard(cue.gain, cue.rate, cue.jitter);
        else this.stopKeyboard(cue.fadeMs);
        break;

      case 'filler':
      case 'backchannel':
        this.playSample(cue.kind, cue.phrase, cue.gain);
        break;

      case 'all':
        // Real speech is starting: kill everything that is not the answer.
        this.stopKeyboard(60);
        this.stopFiller();
        break;
    }
  }

  dispose(): void {
    this.stopKeyboard(0);
    this.stopFiller();
    this.stopBed();
    try {
      this.bedGain.disconnect();
      this.kbGain.disconnect();
      this.fillerGain.disconnect();
    } catch {
      /* already torn down */
    }
  }

  /* -- bed ---------------------------------------------------------------- */

  private startBed(): void {
    if (this.bedSource || !this.bedBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.bedBuffer;
    src.loop = true;
    src.connect(this.bedGain);
    src.start();
    this.bedSource = src;
  }

  private stopBed(): void {
    this.ramp(this.bedGain, 0, 200);
    const src = this.bedSource;
    this.bedSource = null;
    if (!src) return;
    setTimeout(() => {
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* already stopped */
      }
    }, 250);
  }

  /**
   * A call-centre floor heard from a few desks away: broadband room tone,
   * a voice-band layer whose amplitude wanders so it reads as speech rather
   * than hiss, and the occasional distant phone.
   */
  private buildOfficeBed(): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const seam = Math.floor(BED_SEAM_SECONDS * rate);
    // Work at full length, then publish a buffer SHORTENED by the seam: the
    // tail gets folded into the head and must not also be played.
    const total = Math.floor(BED_SECONDS * rate);
    const out = new Float32Array(total);

    // Pink-ish noise: cheap Voss-McCartney style accumulation. White noise on
    // its own sounds like a hiss; real rooms have far more low-end energy.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < total; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.0555179;
      b1 = 0.963 * b1 + w * 0.0750759;
      b2 = 0.57 * b2 + w * 0.153852;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
    }

    // Babble envelope: several slow oscillators at incommensurate rates, so the
    // level never repeats on a period the ear can latch onto.
    for (let i = 0; i < total; i++) {
      const t = i / rate;
      const env =
        0.55 +
        0.2 * Math.sin(2 * Math.PI * 0.13 * t) +
        0.14 * Math.sin(2 * Math.PI * 0.37 * t + 1.1) +
        0.11 * Math.sin(2 * Math.PI * 0.91 * t + 2.3);
      out[i]! *= env;
    }

    // A couple of distant phone rings. These are what make a bed read as an
    // OFFICE rather than as generic noise.
    const ring = (startS: number) => {
      const dur = 0.4;
      const start = Math.floor(startS * rate);
      const len = Math.floor(dur * rate);
      for (let i = 0; i < len && start + i < total; i++) {
        const t = i / rate;
        // Two tones, warbling, with a soft attack and decay.
        const tone = Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t);
        const shape = Math.sin((Math.PI * i) / len) ** 2;
        out[start + i]! += tone * shape * 0.012;
      }
    };
    ring(1.9);
    ring(2.35);
    ring(5.6);
    ring(6.05);

    // Seamless loop: fold the tail into the head, then DISCARD the tail by
    // publishing a shorter buffer.
    //
    // The discard is the part that matters. Zeroing the tail in place instead
    // left 1.2 s of dead silence at the end of every 8 s pass -- the exact
    // opposite of a seamless loop, and far more noticeable than any seam.
    for (let i = 0; i < seam; i++) {
      const f = i / seam;
      const tail = out[total - seam + i]!;
      out[i] = out[i]! * f + tail * (1 - f);
    }

    const loopLength = total - seam;
    const buf = this.ctx.createBuffer(1, loopLength, rate);
    buf.getChannelData(0).set(out.subarray(0, loopLength));
    return buf;
  }

  /* -- keyboard ----------------------------------------------------------- */

  private startKeyboard(gain: number, rate: number, jitter: number): void {
    this.kbRate = rate;
    this.kbJitter = jitter;
    this.ramp(this.kbGain, gain, 60);
    if (!this.kbTimer) this.scheduleKeystroke();
  }

  private stopKeyboard(fadeMs: number): void {
    if (this.kbTimer) {
      clearTimeout(this.kbTimer);
      this.kbTimer = null;
    }
    this.ramp(this.kbGain, 0, Math.max(10, fadeMs));
  }

  private scheduleKeystroke(): void {
    const base = 1000 / this.kbRate;
    // Perfectly even keystrokes read as a machine; humans are irregular.
    const delay = base * (1 + (Math.random() * 2 - 1) * this.kbJitter);
    this.kbTimer = setTimeout(() => {
      this.kbTimer = null;
      this.click();
      this.scheduleKeystroke();
    }, Math.max(20, delay));
  }

  /** One keystroke: a short filtered noise burst with a sharp decay. */
  private click(): void {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(0.028 * rate);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      // Exponential decay gives the plastic "tick"; linear sounds like a thud.
      d[i] = (Math.random() * 2 - 1) * Math.exp((-i / len) * 14);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    // Vary the timbre per key so it does not sound like one sample retriggered.
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800 + Math.random() * 1600;
    bp.Q.value = 0.9;

    src.connect(bp).connect(this.kbGain);
    src.start();
    src.onended = () => {
      try {
        src.disconnect();
        bp.disconnect();
      } catch {
        /* already gone */
      }
    };
  }

  /* -- fillers ------------------------------------------------------------ */

  private playSample(kind: 'filler' | 'backchannel', phrase: string, gain: number): void {
    const buf = this.fillers.get(phrase);
    // Silently skipping is correct: a hesitation that was never pre-rendered
    // must not be synthesised on the spot, because that request would take
    // longer than the wait it is meant to cover.
    if (!buf) return;

    this.stopFiller();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    this.fillerGain.gain.value = gain;
    src.connect(this.fillerGain);
    src.start();
    this.activeFiller = src;
    src.onended = () => {
      if (this.activeFiller === src) this.activeFiller = null;
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
    };
    this.cb.onPerceptualAudio?.({ kind, phrase });
  }

  private stopFiller(): void {
    const src = this.activeFiller;
    this.activeFiller = null;
    if (!src) return;
    try {
      src.stop();
      src.disconnect();
    } catch {
      /* already stopped */
    }
  }

  /* -- helpers ------------------------------------------------------------ */

  /** Ramp rather than assign: an instantaneous gain change is an audible click. */
  private ramp(node: GainNode, to: number, ms: number): void {
    const t = this.ctx.currentTime;
    const p = node.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(to, t + Math.max(0.01, ms / 1000));
  }
}
