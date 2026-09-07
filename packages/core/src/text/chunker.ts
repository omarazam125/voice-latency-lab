/**
 * StreamingSpeechChunker -- the component that decides WHEN a partially
 * generated LLM response is speakable.
 *
 * This is the single highest-leverage piece of the pipeline. Everything
 * upstream (STT, RAG, LLM TTFT) is largely bounded by provider behaviour; the
 * LLM-to-TTS handoff is entirely ours, and it is where a sentence-buffered
 * architecture silently loses seconds.
 *
 * The streaming policy emits a short speakable phrase as soon as one exists, at
 * a natural boundary, without ever requiring sentence-terminating punctuation.
 *
 * The clock and timer are injected so the tests can drive time deterministically
 * instead of sleeping.
 */

import {
  countWords,
  findBoundaries,
  isPunctuationOnly,
  type Boundary,
  type BoundaryKind,
} from './boundaries.js';

/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */

export type FlushReason =
  | 'hard_boundary'
  | 'soft_boundary'
  | 'word_boundary'
  | 'grace_timeout'
  | 'max_length'
  | 'stream_end'
  | 'forced';

export interface ChunkPolicy {
  /** Flush becomes POSSIBLE once words >= minWords OR chars >= minChars. */
  minWords: number;
  minChars: number;
  /** Flush becomes MANDATORY once words >= maxWords OR chars >= maxChars. */
  maxWords: number;
  maxChars: number;
  /**
   * How long to keep waiting for a better boundary after the buffer became
   * eligible. On expiry the chunker settles for the latest safe word boundary.
   */
  graceMs: number;
  /** Terminating punctuation is always an acceptable boundary. */
  allowSoftBoundary: boolean;
  /** When true a plain inter-word space is an acceptable boundary. */
  allowWordBoundary: boolean;
  /**
   * 'earliest'  -- take the first eligible boundary of ANY allowed kind
   *                (minimum latency; used for the first phrase).
   * 'strongest' -- prefer hard, then soft, then word-after-grace
   *                (better prosody; used for later phrases).
   */
  boundaryPreference: 'earliest' | 'strongest';
}

export interface ChunkerConfig {
  /** Policy for the very first phrase of a turn. Latency matters most here. */
  first: ChunkPolicy;
  /** Policy for every phrase after the first. */
  subsequent: ChunkPolicy;
  /** Strip markdown emphasis/bullets before handing text to the TTS engine. */
  stripMarkdown: boolean;
  /** Emit phrases containing no letters or digits (default: drop them). */
  emitPunctuationOnly: boolean;
}

/** Aggressive first phrase, phrase-shaped continuations. */
export const STREAMING_POLICY: ChunkerConfig = {
  first: {
    minWords: 3,
    minChars: 20,
    maxWords: 8,
    maxChars: 60,
    graceMs: 140,
    allowSoftBoundary: true,
    allowWordBoundary: true,
    boundaryPreference: 'earliest',
  },
  subsequent: {
    minWords: 8,
    minChars: 50,
    maxWords: 16,
    maxChars: 120,
    graceMs: 180,
    allowSoftBoundary: true,
    allowWordBoundary: true,
    boundaryPreference: 'strongest',
  },
  stripMarkdown: true,
  emitPunctuationOnly: false,
};

export function clonePolicy(c: ChunkerConfig): ChunkerConfig {
  return { ...c, first: { ...c.first }, subsequent: { ...c.subsequent } };
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export interface SpeechPhrase {
  seq: number;
  text: string;
  reason: FlushReason;
  words: number;
  chars: number;
  isFirst: boolean;
  createdAtNs: bigint;
  /** Milliseconds from the first text delta to this phrase being ready. */
  sinceFirstDeltaMs: number | null;
  /** How long this phrase waited in the buffer after becoming eligible. */
  waitedMs: number;
  /** Total characters consumed from the LLM stream when this phrase was cut. */
  consumedChars: number;
}

export interface ChunkerHooks {
  onPhrase?: (p: SpeechPhrase) => void;
  /** Fired once per turn, for the first phrase only. */
  onFirstPhrase?: (p: SpeechPhrase) => void;
  /** Diagnostic: every evaluation decision, for the debug panel. */
  onDecision?: (d: ChunkerDecision) => void;
}

export interface ChunkerDecision {
  atNs: bigint;
  buffer: string;
  words: number;
  chars: number;
  eligible: boolean;
  action: 'wait' | 'flush';
  reason?: FlushReason;
  waitingForMs?: number;
  candidates: Array<{ kind: BoundaryKind; cut: number }>;
}

export interface ChunkerDeps {
  now: () => bigint;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const defaultDeps: ChunkerDeps = {
  now: () => {
    const g = globalThis as any;
    if (typeof g.process?.hrtime?.bigint === 'function') return g.process.hrtime.bigint() as bigint;
    return BigInt(Math.round((g.performance?.now?.() ?? Date.now()) * 1e6));
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as any),
};

const NS_PER_MS = 1_000_000;
const msSince = (a: bigint, b: bigint) => Number(b - a) / NS_PER_MS;

/* -------------------------------------------------------------------------- */
/* Chunker                                                                     */
/* -------------------------------------------------------------------------- */

export class StreamingSpeechChunker {
  private buffer = '';
  private seq = 0;
  private eligibleSinceNs: bigint | null = null;
  private firstDeltaNs: bigint | null = null;
  private timer: unknown = null;
  private finished = false;
  private cancelled = false;
  private consumed = 0;
  private emitted: SpeechPhrase[] = [];

  constructor(
    private config: ChunkerConfig,
    private readonly hooks: ChunkerHooks = {},
    private readonly deps: ChunkerDeps = defaultDeps,
  ) {}

  /* ---- introspection (used by the debug panel) ------------------------- */
  get pendingBuffer(): string {
    return this.buffer;
  }
  get phraseCount(): number {
    return this.seq;
  }
  get phrases(): readonly SpeechPhrase[] {
    return this.emitted;
  }
  get isFirstPending(): boolean {
    return this.seq === 0;
  }
  get isCancelled(): boolean {
    return this.cancelled;
  }
  get firstDeltaAtNs(): bigint | null {
    return this.firstDeltaNs;
  }

  updateConfig(config: ChunkerConfig): void {
    this.config = config;
  }

  /** Feed one LLM text delta. Safe to call with an empty string. */
  push(delta: string): void {
    if (this.cancelled || this.finished || !delta) return;
    if (this.firstDeltaNs === null) this.firstDeltaNs = this.deps.now();
    this.buffer += delta;
    this.consumed += delta.length;
    this.evaluate();
  }

  /**
   * The LLM stream ended. Everything still buffered is emitted as a final
   * phrase, because dropping the tail would truncate the spoken answer.
   */
  finish(): void {
    if (this.cancelled || this.finished) return;
    this.finished = true;
    this.stopTimer();
    const rest = this.buffer.trim();
    if (rest.length > 0) this.flushAt(this.buffer.length, 'stream_end');
    this.buffer = '';
  }

  /** Barge-in / abort. Nothing further is emitted. */
  cancel(): void {
    this.cancelled = true;
    this.stopTimer();
    this.buffer = '';
  }

  /** Force whatever is buffered out immediately (used by benchmarks). */
  forceFlush(): void {
    if (this.cancelled || this.buffer.trim().length === 0) return;
    this.flushAt(this.buffer.length, 'forced');
  }

  /* ---------------------------------------------------------------------- */
  /* Core evaluation                                                         */
  /* ---------------------------------------------------------------------- */

  private evaluate(): void {
    // A single delta can unlock several phrases at once when the stream is
    // bursty (or when the whole response arrives in one chunk), so keep cutting
    // until no further flush is justified.
    let guard = 0;
    while (this.tryFlushOnce() && guard++ < 512) {
      /* keep going */
    }
  }

  private tryFlushOnce(): boolean {
    if (this.cancelled || this.finished) return false;
    const text = this.buffer;
    if (text.trim().length === 0) return false;

    const now = this.deps.now();
    const p = this.seq === 0 ? this.config.first : this.config.subsequent;

    const words = countWords(text);
    const chars = text.trim().length;
    const eligible = words >= p.minWords || chars >= p.minChars;

    if (!eligible) {
      this.stopTimer();
      this.eligibleSinceNs = null;
      this.hooks.onDecision?.({
        atNs: now,
        buffer: text,
        words,
        chars,
        eligible: false,
        action: 'wait',
        candidates: [],
      });
      return false;
    }

    if (this.eligibleSinceNs === null) {
      this.eligibleSinceNs = now;
      this.armTimer(p.graceMs);
    }
    const waitedMs = msSince(this.eligibleSinceNs, now);

    const boundaries = findBoundaries(text, { requireLookahead: true });
    const allowed: BoundaryKind[] = ['hard'];
    if (p.allowSoftBoundary) allowed.push('soft');
    if (p.allowWordBoundary) allowed.push('word');

    // Only boundaries whose PREFIX already satisfies the minimums are usable --
    // otherwise we would emit "أكيد،" on its own, which sounds clipped.
    const usable = boundaries.filter((b) => allowed.includes(b.kind) && this.prefixEligible(text, b.cut, p));

    let chosen: Boundary | null = null;
    let reason: FlushReason | null = null;

    if (p.boundaryPreference === 'earliest') {
      chosen = usable[0] ?? null;
      if (chosen) reason = chosen.kind === 'hard' ? 'hard_boundary' : chosen.kind === 'soft' ? 'soft_boundary' : 'word_boundary';
    } else {
      const hard = usable.find((b) => b.kind === 'hard');
      if (hard) {
        chosen = hard;
        reason = 'hard_boundary';
      } else if (p.allowSoftBoundary) {
        const soft = usable.find((b) => b.kind === 'soft');
        if (soft) {
          chosen = soft;
          reason = 'soft_boundary';
        }
      }
      // A bare word boundary is a compromise: only accept it once the grace
      // window has elapsed with no stronger candidate.
      if (!chosen && p.allowWordBoundary && waitedMs >= p.graceMs) {
        const word = lastOf(usable, (b) => b.kind === 'word');
        if (word) {
          chosen = word;
          reason = 'grace_timeout';
        }
      }
    }

    // Overflow guard: the buffer has outgrown the policy. Cut at the LATEST
    // boundary that still fits inside the cap -- not simply the latest boundary
    // available, which would emit a phrase far longer than the policy allows.
    if (!chosen && (words >= p.maxWords || chars >= p.maxChars)) {
      const fitsCap = (b: Boundary) => {
        const prefix = text.slice(0, b.cut).trim();
        return prefix.length > 0 && prefix.length <= p.maxChars && countWords(prefix) <= p.maxWords;
      };
      const capped = boundaries.filter(fitsCap);
      const pick =
        lastOf(capped, (b) => allowed.includes(b.kind) && this.prefixEligible(text, b.cut, p)) ??
        lastOf(capped, (b) => this.prefixEligible(text, b.cut, p)) ??
        lastOf(capped, () => true);
      if (pick) {
        chosen = pick;
        reason = 'max_length';
      }
    }

    this.hooks.onDecision?.({
      atNs: now,
      buffer: text,
      words,
      chars,
      eligible: true,
      action: chosen ? 'flush' : 'wait',
      reason: reason ?? undefined,
      waitingForMs: waitedMs,
      candidates: usable.map((b) => ({ kind: b.kind, cut: b.cut })),
    });

    if (!chosen || !reason) return false;

    this.flushAt(chosen.cut, reason, waitedMs);
    return true;
  }

  private prefixEligible(text: string, cut: number, p: ChunkPolicy): boolean {
    const prefix = text.slice(0, cut).trim();
    if (prefix.length === 0) return false;
    return countWords(prefix) >= p.minWords || prefix.length >= p.minChars;
  }

  private flushAt(cut: number, reason: FlushReason, waitedMs = 0): void {
    const raw = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    // Leading whitespace on the remainder would distort the next word count.
    this.buffer = this.buffer.replace(/^[ \t]+/, '');
    this.eligibleSinceNs = null;
    this.stopTimer();

    // ORDER MATTERS. Strip markup FIRST, while the newlines are still there.
    //
    // Three of stripMarkdown's rules -- headings, bullets, blockquotes -- are
    // `^`-anchored with the m flag. Collapsing whitespace first destroys every
    // newline, so `^` can only match position 0 and at most ONE marker per
    // phrase is removed. A bulleted answer was therefore spoken with its
    // hyphens intact: "التنافسية والمجزية - المسار المهني الواضح - التدريب".
    // stripMarkdown ends with its own collapse-and-trim, so nothing is lost.
    let text = this.config.stripMarkdown ? stripMarkdown(raw) : raw.trim().replace(/\s+/g, ' ');
    if (text.length === 0) return;
    if (!this.config.emitPunctuationOnly && isPunctuationOnly(text)) {
      // Pure punctuation is not speakable; fold it into the next phrase instead
      // of wasting a TTS round trip on it.
      this.buffer = `${text}${this.buffer}`;
      return;
    }

    const now = this.deps.now();
    const isFirst = this.seq === 0;
    const phrase: SpeechPhrase = {
      seq: ++this.seq,
      text,
      reason,
      words: countWords(text),
      chars: text.length,
      isFirst,
      createdAtNs: now,
      sinceFirstDeltaMs: this.firstDeltaNs !== null ? msSince(this.firstDeltaNs, now) : null,
      waitedMs,
      consumedChars: this.consumed,
    };

    this.emitted.push(phrase);
    if (isFirst) this.hooks.onFirstPhrase?.(phrase);
    this.hooks.onPhrase?.(phrase);
  }

  /* ---- timer ----------------------------------------------------------- */

  private armTimer(graceMs: number): void {
    this.stopTimer();
    if (!Number.isFinite(graceMs) || graceMs >= Number.MAX_SAFE_INTEGER) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      // The grace window expired with no better boundary: re-evaluate, which
      // will now accept a word boundary.
      this.evaluate();
    }, Math.max(0, graceMs));
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

function lastOf<T>(arr: T[], pred: (t: T) => boolean): T | null {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return null;
}

/**
 * Markdown decoration is meaningless to a TTS engine and is frequently read
 * aloud as "asterisk asterisk". Strip the common cases while leaving the words
 * and all punctuation that affects prosody intact.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    // Numbered lists. No rule covered these, so "1." and "2." were spoken --
    // and a sentence-buffered chunker made each one its own TTS request.
    .replace(/^\s{0,3}\d{1,2}[.)]\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    // HTML/XML tags. NOTHING stripped these, in any mode.
    //
    // The production prompt is built entirely from <role>, <speaking_style>,
    // <fallback> and so on, and a streaming model echoes that structure back.
    // Verified by running the real chunker: a delta of a bare "<role>" tag
    // followed by Arabic produced a TTS request whose entire text was the tag.
    // Mode C was
    // no safer -- its marker stripper only ever matched <flush />.
    .replace(/<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s[^<>]*)?\/?>/g, ' ')
    // A stray bullet left mid-line once the newlines are gone.
    .replace(/(^|\s)[-*+](?=\s)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
