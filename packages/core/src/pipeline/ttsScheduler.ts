/**
 * TTS phrase scheduler (spec sections 9 and 22).
 *
 * Sits between the text chunker and the TTS provider and owns three concerns
 * that must NOT live in a provider adapter:
 *
 *   ORDERING      Speech must be heard in the order it was generated. With a
 *                 concurrent transport, phrase 2 may finish synthesising before
 *                 phrase 1; its audio is buffered and released only once phrase
 *                 1 has finished. Audio is never reordered on the wire.
 *
 *   CONCURRENCY   Hamsa's realtime WebSocket carries no correlation id, so it is
 *                 strictly one request at a time. The HTTP transport can overlap
 *                 requests, which lets phrase N+1 be ready the instant phrase N
 *                 stops playing. `maxConcurrent` expresses that difference.
 *
 *   INVALIDATION  Every phrase and every audio frame carries (turnId, phraseSeq,
 *                 generation). On barge-in the generation is bumped and all
 *                 stale audio is discarded rather than played late.
 *
 * Backpressure policy: when too much audio is buffered awaiting release, the
 * scheduler stops DISPATCHING new phrases. It never drops audio mid-phrase,
 * because a hole in the middle of a sentence is worse than a slightly late one.
 */

import type { ProviderError, TtsAudioChunk, TtsHandle, TtsProvider, TtsSynthesisRequest } from '../providers.js';
import type { SpeechPhrase } from '../text/chunker.js';

export interface ScheduledPhrase {
  seq: number;
  text: string;
  turnId: string;
  generation: number;
  /** Monotonic ns when the phrase was handed to the scheduler. */
  queuedAtNs: bigint;
}

export interface TtsSchedulerHooks {
  onQueued?: (p: ScheduledPhrase, queueDepth: number) => void;
  onRequestStarted?: (p: ScheduledPhrase) => void;
  onFirstAudio?: (chunk: TtsAudioChunk, p: ScheduledPhrase) => void;
  /** Called for every chunk IN RELEASE ORDER. This is what goes to the browser. */
  onAudio?: (chunk: TtsAudioChunk) => void;
  onPhraseCompleted?: (p: ScheduledPhrase, info: { bytes: number; chunks: number }) => void;
  onAllCompleted?: () => void;
  onError?: (e: ProviderError, p?: ScheduledPhrase) => void;
  onBackpressure?: (info: { bufferedBytes: number; pendingPhrases: number }) => void;
  onDiscarded?: (info: { reason: string; phraseSeq: number; bytes: number }) => void;
}

export interface TtsSchedulerOptions {
  provider: TtsProvider;
  turnId: string;
  generation: number;
  maxConcurrent: number;
  /** Voice/format settings applied to every phrase in this turn. */
  voice: {
    speaker: string;
    dialect?: string;
    languageId?: string;
    sampleRate?: '8k' | '16k';
    mulaw?: boolean;
    expressiveness?: number;
  };
  /** Stop dispatching new phrases above this many buffered bytes. */
  maxBufferedBytes?: number;
  /** Hard cap on phrases queued but not yet dispatched. */
  maxPendingPhrases?: number;
  now: () => bigint;
}

interface PhraseState {
  phrase: ScheduledPhrase;
  handle?: TtsHandle;
  /** Chunks held back because an earlier phrase has not finished releasing. */
  buffered: TtsAudioChunk[];
  bufferedBytes: number;
  started: boolean;
  ended: boolean;
  failed: boolean;
  bytes: number;
  chunks: number;
}

const DEFAULT_MAX_BUFFERED = 2_000_000; // ~62 s of 16 kHz PCM16; generous, still bounded
const DEFAULT_MAX_PENDING = 64;

export class TtsPhraseScheduler {
  private states = new Map<number, PhraseState>();
  private pending: number[] = [];
  private inFlight = 0;
  private releaseSeq = 1;
  private nextSeq = 1;
  private bufferedBytes = 0;
  private cancelled = false;
  private finished = false;
  private chunkerDone = false;
  private backpressureActive = false;

  constructor(
    private readonly opts: TtsSchedulerOptions,
    private readonly hooks: TtsSchedulerHooks = {},
  ) {}

  get generation(): number {
    return this.opts.generation;
  }
  get queueDepth(): number {
    return this.pending.length + this.inFlight;
  }
  get isCancelled(): boolean {
    return this.cancelled;
  }
  get bufferedAudioBytes(): number {
    return this.bufferedBytes;
  }

  /** Accept a phrase from the chunker. Order of calls defines speech order. */
  enqueue(phrase: SpeechPhrase): ScheduledPhrase | null {
    if (this.cancelled) return null;

    if (this.pending.length >= (this.opts.maxPendingPhrases ?? DEFAULT_MAX_PENDING)) {
      // Dropping a phrase would corrupt the answer, so refuse instead and make
      // the condition visible. In practice this cannot be hit at speech rates.
      this.hooks.onBackpressure?.({ bufferedBytes: this.bufferedBytes, pendingPhrases: this.pending.length });
      return null;
    }

    const p: ScheduledPhrase = {
      seq: this.nextSeq++,
      text: phrase.text,
      turnId: this.opts.turnId,
      generation: this.opts.generation,
      queuedAtNs: this.opts.now(),
    };
    this.states.set(p.seq, {
      phrase: p,
      buffered: [],
      bufferedBytes: 0,
      started: false,
      ended: false,
      failed: false,
      bytes: 0,
      chunks: 0,
    });
    this.pending.push(p.seq);
    this.hooks.onQueued?.(p, this.queueDepth);
    this.pump();
    return p;
  }

  /** The LLM stream ended; no further phrases will arrive. */
  markChunkerDone(): void {
    this.chunkerDone = true;
    this.maybeFinish();
  }

  private pump(): void {
    if (this.cancelled) return;

    // Backpressure: hold off dispatching while too much audio waits to be
    // released. Audio already in flight is never discarded here.
    const limit = this.opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED;
    if (this.bufferedBytes > limit) {
      if (!this.backpressureActive) {
        this.backpressureActive = true;
        this.hooks.onBackpressure?.({ bufferedBytes: this.bufferedBytes, pendingPhrases: this.pending.length });
      }
      return;
    }
    this.backpressureActive = false;

    while (this.inFlight < this.opts.maxConcurrent && this.pending.length > 0) {
      const seq = this.pending.shift()!;
      const st = this.states.get(seq);
      if (!st) continue;
      this.dispatch(st);
    }
  }

  private dispatch(st: PhraseState): void {
    if (this.cancelled) return;
    st.started = true;
    this.inFlight++;

    const req: TtsSynthesisRequest = {
      text: st.phrase.text,
      speaker: this.opts.voice.speaker,
      dialect: this.opts.voice.dialect,
      languageId: this.opts.voice.languageId,
      sampleRate: this.opts.voice.sampleRate,
      mulaw: this.opts.voice.mulaw,
      expressiveness: this.opts.voice.expressiveness,
      turnId: st.phrase.turnId,
      phraseSeq: st.phrase.seq,
      generation: st.phrase.generation,
    };

    this.hooks.onRequestStarted?.(st.phrase);

    st.handle = this.opts.provider.synthesize(req, {
      onFirstAudio: (chunk) => {
        if (this.isStale(chunk)) return;
        this.hooks.onFirstAudio?.(chunk, st.phrase);
      },
      onChunk: (chunk) => {
        if (this.isStale(chunk)) return;
        st.bytes += chunk.data.byteLength;
        st.chunks++;
        this.route(st, chunk);
      },
      onEnd: () => {
        st.ended = true;
        this.inFlight--;
        this.advanceRelease();
        this.pump();
        this.maybeFinish();
      },
      onError: (e) => {
        st.failed = true;
        this.hooks.onError?.(e, st.phrase);
      },
    });

    void st.handle.done.then((r) => {
      // `onEnd` fires only on a clean finish; make sure a cancelled or failed
      // phrase still releases its slot and unblocks the ones behind it.
      if (!st.ended) {
        st.ended = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (r.error && !st.failed) this.hooks.onError?.(r.error, st.phrase);
        this.advanceRelease();
        this.pump();
        this.maybeFinish();
      }
    });
  }

  private isStale(chunk: TtsAudioChunk): boolean {
    if (this.cancelled || chunk.generation !== this.opts.generation || chunk.turnId !== this.opts.turnId) {
      this.hooks.onDiscarded?.({ reason: 'stale_generation', phraseSeq: chunk.phraseSeq, bytes: chunk.data.byteLength });
      return true;
    }
    return false;
  }

  /** Emit now if this phrase owns the release slot; otherwise hold it. */
  private route(st: PhraseState, chunk: TtsAudioChunk): void {
    if (st.phrase.seq === this.releaseSeq) {
      this.hooks.onAudio?.(chunk);
      return;
    }
    st.buffered.push(chunk);
    st.bufferedBytes += chunk.data.byteLength;
    this.bufferedBytes += chunk.data.byteLength;
  }

  /**
   * Move the release slot forward past every phrase that has finished, flushing
   * whatever each one buffered while it waited.
   */
  private advanceRelease(): void {
    for (;;) {
      const st = this.states.get(this.releaseSeq);
      if (!st) return;
      // Flush anything this phrase buffered before it owned the slot.
      if (st.buffered.length > 0) {
        for (const c of st.buffered) this.hooks.onAudio?.(c);
        this.bufferedBytes -= st.bufferedBytes;
        st.buffered = [];
        st.bufferedBytes = 0;
      }
      if (!st.ended) return; // still streaming; it keeps the slot
      this.hooks.onPhraseCompleted?.(st.phrase, { bytes: st.bytes, chunks: st.chunks });
      this.releaseSeq++;
    }
  }

  private maybeFinish(): void {
    if (this.finished || this.cancelled) return;
    if (!this.chunkerDone) return;
    if (this.pending.length > 0 || this.inFlight > 0) return;
    if (this.releaseSeq <= this.states.size) return;
    this.finished = true;
    this.hooks.onAllCompleted?.();
  }

  /**
   * Barge-in. Cancels everything in flight and guarantees no further audio is
   * emitted for this generation.
   */
  cancel(reason = 'barge_in'): void {
    if (this.cancelled) return;
    this.cancelled = true;

    let discarded = 0;
    for (const st of this.states.values()) {
      discarded += st.bufferedBytes;
      st.buffered = [];
      st.bufferedBytes = 0;
      try {
        st.handle?.cancel(reason);
      } catch {
        /* ignore */
      }
    }
    if (discarded > 0) {
      this.hooks.onDiscarded?.({ reason, phraseSeq: -1, bytes: discarded });
    }
    this.bufferedBytes = 0;
    this.pending = [];
    this.inFlight = 0;
  }

  stats() {
    return {
      phrases: this.states.size,
      pending: this.pending.length,
      inFlight: this.inFlight,
      releaseSeq: this.releaseSeq,
      bufferedBytes: this.bufferedBytes,
      cancelled: this.cancelled,
      finished: this.finished,
    };
  }
}
