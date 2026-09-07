/**
 * Streaming audio playback.
 *
 * Feeds PCM straight from the WebSocket into an AudioWorklet ring buffer. There
 * is no decode step because Hamsa's realtime stream is raw PCM16, and there is
 * no "wait for the whole response" step because that is precisely the
 * anti-pattern being measured.
 *
 * The one number this class exists to produce is the instant the user ACTUALLY
 * HEARS the first sample, obtained from the worklet's render-quantum time and
 * converted through AudioContext.getOutputTimestamp() so that real device
 * output latency is included rather than assumed away.
 */

import { audioTimeToPerformanceMs, NS_PER_MS } from './clock';

export interface PlayerStats {
  bufferedMs: number;
  frames: number;
  playing: boolean;
  underruns: number;
  droppedStale: number;
  generation: number;
}

export interface PlayerCallbacks {
  /** Fired once per generation, when the first sample is genuinely audible. */
  onPlaybackStarted: (info: { atNs: bigint; generation: number; phraseSeq: number; bufferedMs: number }) => void;
  onPlaybackFinished: (info: { atNs: bigint; generation: number }) => void;
  onStats: (s: PlayerStats) => void;
  onUnderrun: (info: { count: number; durationMs: number }) => void;
  onError: (message: string) => void;
}

export interface PlayerOptions {
  jitterMs: number;
  maxQueueMs: number;
  sourceRate: number;
}

export class StreamingPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private generation = 0;
  private underruns = 0;
  private droppedStale = 0;
  private lastStats: PlayerStats | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private sawAudioThisGeneration = false;

  constructor(
    private opts: PlayerOptions,
    private readonly cb: PlayerCallbacks,
  ) {}

  get ready(): boolean {
    return this.node !== null;
  }
  get currentGeneration(): number {
    return this.generation;
  }
  get stats(): PlayerStats | null {
    return this.lastStats;
  }
  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  async start(): Promise<void> {
    if (this.node) return;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('/worklets/player-processor.js');

    this.node = new AudioWorkletNode(this.ctx, 'vll-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        sourceRate: this.opts.sourceRate,
        jitterMs: this.opts.jitterMs,
        maxQueueMs: this.opts.maxQueueMs,
      },
    });

    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
    this.node.connect(this.gain).connect(this.ctx.destination);

    this.node.port.onmessage = (ev) => this.onMessage(ev.data);
  }

  private onMessage(d: any): void {
    if (!d || !this.ctx) return;
    switch (d.type) {
      case 'playback_started': {
        // The normative conversion: contextTime is the frame the OUTPUT DEVICE
        // is rendering, so this instant already includes output latency.
        const wallMs = audioTimeToPerformanceMs(this.ctx, d.contextTime);
        this.cb.onPlaybackStarted({
          atNs: BigInt(Math.round(wallMs * NS_PER_MS)),
          generation: d.generation,
          phraseSeq: d.phraseSeq ?? 0,
          bufferedMs: d.bufferedMs ?? 0,
        });
        break;
      }
      case 'stats':
        this.lastStats = {
          bufferedMs: d.bufferedMs,
          frames: d.frames,
          playing: d.playing,
          underruns: this.underruns,
          droppedStale: this.droppedStale,
          generation: d.generation,
        };
        this.cb.onStats(this.lastStats);
        this.scheduleFinishCheck(d.playing, d.bufferedMs);
        break;
      case 'underrun':
        this.underruns = d.count;
        this.cb.onUnderrun({ count: d.count, durationMs: d.durationMs });
        break;
      case 'dropped':
        this.droppedStale++;
        break;
      case 'overflow': {
        // Say what was actually lost. "dropped N samples of backlog" reads like
        // stale audio was discarded; in fact the answer was cut short, which is
        // a different problem with a different cause.
        const ms = Math.round((d.dropped / (this.opts.sourceRate || 16000)) * 1000);
        this.cb.onError(
          `Playback queue full (${Math.round(this.opts.maxQueueMs / 1000)}s): the last ${ms} ms of the reply ` +
            `were not queued. The answer is longer than the buffer — shorten the reply or raise Max queue ms.`,
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Playback "finished" is inferred rather than signalled, because the server
   * cannot know when the last sample leaves the speaker. When the buffer has
   * been empty and idle for a short grace period, the response is over.
   */
  private scheduleFinishCheck(playing: boolean, bufferedMs: number): void {
    if (playing || bufferedMs > 5) {
      if (this.finishTimer) {
        clearTimeout(this.finishTimer);
        this.finishTimer = null;
      }
      return;
    }
    if (this.finishTimer || !this.sawAudioThisGeneration) return;
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      if (!this.sawAudioThisGeneration) return;
      this.sawAudioThisGeneration = false;
      this.cb.onPlaybackFinished({
        atNs: BigInt(Math.round(performance.now() * NS_PER_MS)),
        generation: this.generation,
      });
    }, 320);
  }

  /** Push one PCM chunk. Zero-copy: the ArrayBuffer is transferred. */
  push(pcm: ArrayBuffer, generation: number, phraseSeq: number, audioSeq: number): void {
    if (!this.node) return;
    if (generation < this.generation) {
      this.droppedStale++;
      return;
    }
    this.sawAudioThisGeneration = true;
    this.node.port.postMessage({ type: 'audio', pcm, generation, phraseSeq, audioSeq }, [pcm]);
  }

  /** Barge-in: bump the generation and discard everything queued. */
  /**
   * Lower the volume WITHOUT discarding the queue.
   *
   * Used for a provisional barge-in: the caller must hear instantly that they
   * were noticed, but if the classifier decides their "مم" was a backchannel
   * the speech has to resume mid-word. Flushing would make that impossible,
   * because the discarded audio cannot be recovered.
   */
  duck(level: number, fadeMs = 80): void {
    if (!this.gain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.max(0, Math.min(1, level)), t + Math.max(0.01, fadeMs / 1000));
  }

  flush(generation: number): void {
    this.generation = generation;
    this.sawAudioThisGeneration = false;
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    this.node?.port.postMessage({ type: 'flush', generation });
  }

  setGeneration(generation: number): void {
    this.generation = generation;
    this.node?.port.postMessage({ type: 'generation', generation });
  }

  configure(opts: Partial<PlayerOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.node?.port.postMessage({ type: 'config', jitterMs: this.opts.jitterMs, sourceRate: this.opts.sourceRate });
  }

  setVolume(v: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Underrun and latency statistics reported by the browser itself. */
  playbackStats(): Record<string, number> | null {
    const s = (this.ctx as any)?.playbackStats;
    if (!s) return null;
    return {
      underrunDuration: s.underrunDuration,
      underrunEvents: s.underrunEvents,
      totalDuration: s.totalDuration,
      averageLatency: s.averageLatency,
      minimumLatency: s.minimumLatency,
      maximumLatency: s.maximumLatency,
    };
  }

  async stop(): Promise<void> {
    try {
      this.node?.disconnect();
      this.gain?.disconnect();
      await this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.node = null;
    this.gain = null;
  }
}
