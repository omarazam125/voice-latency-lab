/**
 * VoiceChunkPlanner — decides what to speak, and when, from a live model stream.
 *
 * Deliberately NOT called a "sentence builder": a sentence is exactly the wrong
 * unit. The caller is waiting for the FIRST syllable, and the model produces a
 * speakable phrase long before it produces a sentence.
 *
 * Differences from the Mode B chunker:
 *
 *   - Adaptive first chunk with an explicit "preferred" size, so the planner can
 *     stop hunting for a better boundary once the phrase is good enough.
 *   - Supports an inline `<flush />` control marker in model output. Text before
 *     the marker is submitted immediately; the marker itself is ALWAYS stripped
 *     and must never reach the TTS engine.
 *   - Protects structured output (JSON/XML fragments, tool markers) in addition
 *     to numbers, URLs, emails and dates.
 *
 * Mode B's chunker is untouched, so the comparison between modes stays valid.
 */

import { countWords, findBoundaries, isPunctuationOnly, type Boundary } from '../text/boundaries.js';
import { stripMarkdown } from '../text/chunker.js';
import type { ChunkPlanConfig } from './config.js';

export type VoiceChunkReason =
  | 'flush_marker'
  | 'punctuation_boundary'
  | 'preferred_size'
  | 'max_wait'
  | 'max_length'
  | 'stream_end'
  | 'forced';

export interface VoiceChunk {
  seq: number;
  text: string;
  reason: VoiceChunkReason;
  words: number;
  chars: number;
  isFirst: boolean;
  createdAtNs: bigint;
  /** Milliseconds from the model's first delta to this chunk being ready. */
  sinceFirstDeltaMs: number | null;
  /** How long the text sat in the buffer after becoming eligible. */
  waitedMs: number;
  /** True when an explicit flush marker produced this chunk. */
  flushTriggered: boolean;
  /** Character offset of the flush marker in the accumulated stream. */
  flushPosition?: number;
}

export interface VoiceChunkPlannerHooks {
  onChunk?: (c: VoiceChunk) => void;
  onFirstChunk?: (c: VoiceChunk) => void;
  onFlush?: (info: { position: number; text: string; atNs: bigint }) => void;
  onDecision?: (d: PlannerDecision) => void;
}

export interface PlannerDecision {
  atNs: bigint;
  buffer: string;
  chars: number;
  words: number;
  eligible: boolean;
  action: 'wait' | 'emit';
  reason?: VoiceChunkReason;
  waitedMs: number;
  candidates: number;
}

export interface PlannerDeps {
  now: () => bigint;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

const NS_PER_MS = 1_000_000;
const msSince = (a: bigint, b: bigint) => Number(b - a) / NS_PER_MS;

const defaultDeps: PlannerDeps = {
  now: () => {
    const g = globalThis as any;
    if (typeof g.process?.hrtime?.bigint === 'function') return g.process.hrtime.bigint() as bigint;
    return BigInt(Math.round((g.performance?.now?.() ?? Date.now()) * 1e6));
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as any),
};

/**
 * Structured output that must never be split or spoken mid-token: JSON/XML
 * fragments and tool-call markers the model may emit inline.
 */
const STRUCTURED = [
  /<[a-zA-Z/][^>]*>/g, // XML/HTML-ish tags
  /\{[^{}]*\}/g, // small JSON objects
  /\[[^\[\]]*\]/g, // small JSON arrays
];

function structuredSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const re of STRUCTURED) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push([m.index, m.index + m[0].length]);
    }
  }
  return out;
}

export class VoiceChunkPlanner {
  private buffer = '';
  private seq = 0;
  private consumed = 0;
  private firstDeltaNs: bigint | null = null;
  private eligibleSinceNs: bigint | null = null;
  private timer: unknown = null;
  private finished = false;
  private cancelled = false;
  private emitted: VoiceChunk[] = [];
  /** Partial flush marker held back across a delta boundary. */
  private pendingMarkerFragment = '';

  constructor(
    private config: ChunkPlanConfig,
    private readonly hooks: VoiceChunkPlannerHooks = {},
    private readonly deps: PlannerDeps = defaultDeps,
  ) {}

  get pendingBuffer(): string {
    return this.buffer;
  }
  get chunkCount(): number {
    return this.seq;
  }
  get chunks(): readonly VoiceChunk[] {
    return this.emitted;
  }
  get isCancelled(): boolean {
    return this.cancelled;
  }
  get firstDeltaAtNs(): bigint | null {
    return this.firstDeltaNs;
  }

  updateConfig(c: ChunkPlanConfig): void {
    this.config = c;
  }

  /** Feed one model text delta. */
  push(delta: string): void {
    if (this.cancelled || this.finished || !delta) return;
    if (this.firstDeltaNs === null) this.firstDeltaNs = this.deps.now();

    let text = this.pendingMarkerFragment + delta;
    this.pendingMarkerFragment = '';

    if (this.config.flushEnabled) {
      const marker = this.config.flushMarker;
      // A marker can straddle two deltas ("<flu" + "sh />"). Hold back a
      // trailing fragment that could still become one, so the marker is never
      // half-emitted into speech.
      const held = trailingPartialMarker(text, marker);
      if (held > 0) {
        this.pendingMarkerFragment = text.slice(text.length - held);
        text = text.slice(0, text.length - held);
      }

      let idx: number;
      while ((idx = indexOfMarker(text, marker)) !== -1) {
        const before = text.slice(0, idx);
        this.buffer += before;
        this.consumed += before.length;

        const atNs = this.deps.now();
        const position = this.consumed;
        this.hooks.onFlush?.({ position, text: this.buffer.trim(), atNs });

        // Everything buffered goes out NOW, whatever the size policy says.
        if (this.buffer.trim().length > 0) {
          this.emit(this.buffer.length, 'flush_marker', 0, true, position);
        }
        text = text.slice(idx + markerLength(text, idx, marker));
      }
    }

    this.buffer += text;
    this.consumed += text.length;
    this.evaluate();
  }

  /** The model stream ended; speak whatever is left. */
  finish(): void {
    if (this.cancelled || this.finished) return;
    this.finished = true;
    this.stopTimer();
    // A held-back fragment that never completed into a marker is real text.
    if (this.pendingMarkerFragment) {
      this.buffer += this.pendingMarkerFragment;
      this.pendingMarkerFragment = '';
    }
    if (this.buffer.trim().length > 0) this.emit(this.buffer.length, 'stream_end', 0, false);
    this.buffer = '';
  }

  cancel(): void {
    this.cancelled = true;
    this.stopTimer();
    this.buffer = '';
    this.pendingMarkerFragment = '';
  }

  forceFlush(): void {
    if (this.cancelled || this.buffer.trim().length === 0) return;
    this.emit(this.buffer.length, 'forced', 0, false);
  }

  /* ---------------------------------------------------------------------- */

  private evaluate(): void {
    let guard = 0;
    while (this.tryEmit() && guard++ < 512) {
      /* keep cutting */
    }
  }

  private tryEmit(): boolean {
    if (this.cancelled || this.finished) return false;
    if (!this.config.enabled) return false;
    const text = this.buffer;
    if (text.trim().length === 0) return false;

    const now = this.deps.now();
    const isFirst = this.seq === 0;
    const p = isFirst ? this.config.first : this.config.subsequent;

    const chars = text.trim().length;
    const words = countWords(text);

    const minChars = isFirst ? this.config.first.minCharacters : this.config.subsequent.minCharacters;
    const eligible = words >= p.minWords || chars >= minChars;

    if (!eligible) {
      this.stopTimer();
      this.eligibleSinceNs = null;
      this.hooks.onDecision?.({ atNs: now, buffer: text, chars, words, eligible: false, action: 'wait', waitedMs: 0, candidates: 0 });
      return false;
    }

    if (this.eligibleSinceNs === null) {
      this.eligibleSinceNs = now;
      this.armTimer(p.maxWaitMs);
    }
    const waitedMs = msSince(this.eligibleSinceNs, now);

    const boundaries = this.usableBoundaries(text, minChars, p.minWords);

    /* -- 1. a natural punctuation boundary is always taken --------------- */
    const punct = boundaries.find((b) => b.kind === 'hard' || b.kind === 'soft');
    if (punct) {
      this.emit(punct.cut, 'punctuation_boundary', waitedMs, false);
      return true;
    }

    /* -- 2. preferred size reached: stop hunting for a better cut --------- */
    const preferred = isFirst
      ? this.config.first.preferredCharacters
      : this.config.subsequent.maxCharacters;
    if (chars >= preferred) {
      const last = lastAtOrBefore(boundaries, preferred + 40);
      if (last) {
        const natural = preferNaturalCut(text, last, boundaries, (cut) => this.meetsMinimum(text, cut, minChars, p.minWords));
        this.emit(natural.cut, 'preferred_size', waitedMs, false);
        return true;
      }
    }

    /* -- 3. waited long enough: settle for a word boundary ---------------- */
    if (waitedMs >= p.maxWaitMs) {
      const word = lastAtOrBefore(boundaries, Number.MAX_SAFE_INTEGER);
      if (word) {
        // Do not leave the phrase hanging on "في" / "and": back off one
        // boundary when an earlier cut still satisfies the minimums.
        const natural = preferNaturalCut(text, word, boundaries, (cut) => this.meetsMinimum(text, cut, minChars, p.minWords));
        this.emit(natural.cut, 'max_wait', waitedMs, false);
        return true;
      }
    }

    /* -- 4. hard overflow guard ------------------------------------------ */
    const maxChars = isFirst ? this.config.first.preferredCharacters * 2 : this.config.subsequent.maxCharacters;
    const maxWords = isFirst ? this.config.first.minWords * 4 : this.config.subsequent.maxWords;
    if (chars >= maxChars || words >= maxWords) {
      const capped = boundaries.filter((b) => {
        const prefix = text.slice(0, b.cut).trim();
        return prefix.length <= maxChars && countWords(prefix) <= maxWords;
      });
      const pick = capped.length > 0 ? capped[capped.length - 1] : null;
      if (pick) {
        this.emit(pick.cut, 'max_length', waitedMs, false);
        return true;
      }
    }

    this.hooks.onDecision?.({
      atNs: now,
      buffer: text,
      chars,
      words,
      eligible: true,
      action: 'wait',
      waitedMs,
      candidates: boundaries.length,
    });
    return false;
  }

  private meetsMinimum(text: string, cut: number, minChars: number, minWords: number): boolean {
    const prefix = text.slice(0, cut).trim();
    if (prefix.length === 0) return false;
    return countWords(prefix) >= minWords || prefix.length >= minChars;
  }

  /**
   * Boundaries whose prefix already satisfies the minimums, restricted to the
   * configured punctuation set, and never inside a protected or structured
   * token.
   */
  private usableBoundaries(text: string, minChars: number, minWords: number): Boundary[] {
    const allowed = new Set(this.config.punctuationBoundaries);
    const structured = structuredSpans(text);
    const insideStructured = (cut: number) => structured.some(([s, e]) => cut > s && cut < e);

    return findBoundaries(text, { requireLookahead: true }).filter((b) => {
      if (insideStructured(b.cut)) return false;
      // Word boundaries are always available as a fallback; punctuation must be
      // in the configured set so the preset genuinely controls behaviour.
      if (b.kind !== 'word' && !b.char.split('').some((ch) => allowed.has(ch))) return false;
      const prefix = text.slice(0, b.cut).trim();
      if (prefix.length === 0) return false;
      return countWords(prefix) >= minWords || prefix.length >= minChars;
    });
  }

  private emit(cut: number, reason: VoiceChunkReason, waitedMs: number, flushTriggered: boolean, flushPosition?: number): void {
    const raw = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut).replace(/^[ \t]+/, '');
    this.eligibleSinceNs = null;
    this.stopTimer();

    // Strip markup BEFORE collapsing whitespace -- see the note in
    // chunker.ts. Fixing only one of the two emit paths leaves the other
    // broken, and they are separate code.
    let text = stripMarkdown(raw);
    // ALWAYS strip the marker, even when flush handling is disabled. With flush
    // off the marker carries no meaning, but it is still not something the
    // caller should ever hear the assistant say out loud.
    text = stripAllMarkers(text, this.config.flushMarker).trim();
    if (text.length === 0) return;

    if (isPunctuationOnly(text)) {
      // Not speakable on its own; fold it into the next chunk.
      this.buffer = `${text}${this.buffer}`;
      return;
    }

    const now = this.deps.now();
    const isFirst = this.seq === 0;
    const chunk: VoiceChunk = {
      seq: ++this.seq,
      text,
      reason,
      words: countWords(text),
      chars: text.length,
      isFirst,
      createdAtNs: now,
      sinceFirstDeltaMs: this.firstDeltaNs !== null ? msSince(this.firstDeltaNs, now) : null,
      waitedMs: Math.round(waitedMs * 100) / 100,
      flushTriggered,
      flushPosition,
    };

    this.emitted.push(chunk);
    if (isFirst) this.hooks.onFirstChunk?.(chunk);
    this.hooks.onChunk?.(chunk);
  }

  private armTimer(maxWaitMs: number): void {
    this.stopTimer();
    if (!Number.isFinite(maxWaitMs)) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.evaluate();
    }, Math.max(0, maxWaitMs));
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Flush marker helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Flush marker matcher.
 *
 * Three forms are accepted, matching the publicly documented behaviour:
 *
 *   <flush />    self-closing (recommended)
 *   <flush>      opening tag
 *   </flush>     closing tag
 *
 * Case-insensitive, tolerating internal whitespace. This is the documented
 * pattern verbatim; a model will not reproduce one exact spelling reliably, and
 * a missed marker is spoken aloud as "flush", so being permissive here matters.
 */
const MARKER_RE = /<\s*flush\s*\/?>|<\s*\/\s*flush\s*>/i;

export function indexOfMarker(text: string, marker: string): number {
  const exact = text.indexOf(marker);
  if (exact !== -1) return exact;
  const m = MARKER_RE.exec(text);
  return m ? m.index : -1;
}

function markerLength(text: string, index: number, marker: string): number {
  if (text.startsWith(marker, index)) return marker.length;
  const m = MARKER_RE.exec(text.slice(index));
  return m && m.index === 0 ? m[0].length : marker.length;
}

export function stripAllMarkers(text: string, marker: string): string {
  let out = marker ? text.split(marker).join(' ') : text;
  out = out.replace(new RegExp(MARKER_RE.source, 'gi'), ' ');
  return out.replace(/\s+/g, ' ');
}

/**
 * Length of a trailing fragment that could still become a flush marker.
 *
 * Without this, a marker split across two deltas ("<flu" then "sh />") would be
 * partially emitted, and the caller would hear the model say "flush".
 */
export function trailingPartialMarker(text: string, _marker: string): number {
  // Longest suffix that is a strict prefix of any accepted marker form. Without
  // this, a marker split across two deltas ("<flu" then "sh />") is partially
  // emitted and the caller hears the assistant say "flush".
  const forms = ['<flush />', '<flush>', '</flush>'];
  const max = Math.min(12, text.length);
  for (let n = max; n > 0; n--) {
    const tail = text.slice(text.length - n);
    if (!tail.includes('<')) continue;
    const candidate = tail.slice(tail.indexOf('<'));
    // A completed marker is not "partial" -- it will be handled normally.
    if (MARKER_RE.test(candidate)) return 0;
    const squashed = candidate.replace(/\s+/g, '').toLowerCase();
    if (forms.some((f) => f.replace(/\s+/g, '').toLowerCase().startsWith(squashed))) {
      return candidate.length;
    }
  }
  return 0;
}

function lastAtOrBefore(boundaries: Boundary[], maxCut: number): Boundary | null {
  let best: Boundary | null = null;
  for (const b of boundaries) {
    if (b.cut > maxCut) break;
    best = b;
  }
  return best;
}

/**
 * Function words that must not END a spoken phrase.
 *
 * Cutting after "في" or "and" leaves the phrase hanging: the TTS engine applies
 * a falling, finished-sounding intonation to a fragment that is obviously
 * incomplete, and it sounds worse than simply waiting for one more word.
 */
const TRAILING_FUNCTION_WORDS = new Set([
  // Arabic prepositions, conjunctions and particles
  'في', 'من', 'إلى', 'الى', 'على', 'عن', 'مع', 'عند', 'بعد', 'قبل', 'بين',
  'و', 'أو', 'او', 'ثم', 'لكن', 'بس', 'يعني', 'عشان', 'لأن', 'لان', 'حتى',
  'كل', 'أي', 'اي', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'ما', 'إن', 'ان',
  'خلال', 'حول', 'تحت', 'فوق', 'داخل', 'خارج', 'ضد', 'نحو', 'بدون', 'سوى',
  'كان', 'صار', 'قد', 'لقد', 'أن', 'أنّ', 'إذا', 'اذا', 'لو', 'كما', 'مثل',
  //
  // GULF AND SAUDI INTERROGATIVES.
  //
  // These belong here for a concrete reason: the production prompt mandates
  // Saudi white dialect, so these are the question words the model actually
  // produces, and a chunk that ends on one is the worst possible split —
  // "تفضل وش" is synthesised, then "تحتاج؟" arrives as a separate request, and
  // the caller hears the question snapped in half. Observed live in a real
  // call, twice in the same conversation.
  'وش', 'ايش', 'إيش', 'شنو', 'شلون', 'كيف', 'ليش', 'وين', 'متى', 'كم', 'هل',
  'مين', 'منو', 'اللي', 'الّي', 'وشو',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'as', 'that', 'this', 'is', 'are', 'was', 'were',
  'what', 'which', 'who', 'how', 'why', 'when', 'where',
]);

/**
 * Quote and bracket characters that must not be left dangling across a split.
 *
 * A cut inside a quotation produced a phrase ending `بـ"انتقلت أعمال من...` and
 * the next one starting `"؟ هل تقصد` — the closing quote and question mark were
 * spoken at the head of the following phrase, which sounds like a stray noise.
 */
const OPENERS = '“‘«([{';
const CLOSERS = '”’»)]}';

/** True when the text has an unbalanced opening quote or bracket. */
export function hasOpenQuote(text: string): boolean {
  let depth = 0;
  let straight = 0;
  for (const ch of text) {
    if (ch === '"') straight++;
    else if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth--;
  }
  return depth > 0 || straight % 2 === 1;
}

export function endsOnFunctionWord(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const tokens = t.split(/\s+/);
  const last = tokens[tokens.length - 1]?.replace(/[^\p{L}\p{N}]/gu, '');
  return !!last && TRAILING_FUNCTION_WORDS.has(last);
}

/**
 * Prefer a cut that does not leave the phrase ending on a function word.
 *
 * Falls back to the original choice when no earlier boundary still satisfies
 * the minimums — a slightly awkward phrase is better than no audio at all.
 */
export function preferNaturalCut(
  text: string,
  chosen: Boundary,
  boundaries: Boundary[],
  meetsMinimum: (cut: number) => boolean,
): Boundary {
  const bad = (upto: number) => {
    const head = text.slice(0, upto);
    return endsOnFunctionWord(head) || hasOpenQuote(head);
  };
  if (!bad(chosen.cut)) return chosen;
  for (let i = boundaries.indexOf(chosen) - 1; i >= 0; i--) {
    const cand = boundaries[i];
    if (!meetsMinimum(cand.cut)) break;
    if (!bad(cand.cut)) return cand;
  }
  return chosen;
}
