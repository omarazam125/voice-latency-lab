/**
 * Boundary analysis for Arabic + English text.
 *
 * The chunker must never cut through a token whose meaning -- or whose
 * pronunciation by the TTS engine -- depends on staying whole. A split inside
 * "1,250.50" produces "one thousand two hundred fifty" followed by "point five
 * zero", which is both wrong and audibly broken. The same applies to URLs,
 * emails, dates, decimals and abbreviations.
 *
 * The strategy is a PROTECTION MASK: every character index that falls strictly
 * inside a protected token is marked, and no boundary inside a protected span is
 * ever offered to the chunker.
 */

/* -------------------------------------------------------------------------- */
/* Character classes                                                           */
/* -------------------------------------------------------------------------- */

/** Terminators that end a full sentence. Includes Arabic question mark. */
export const HARD_BOUNDARY_CHARS = '.!?\u061F\u06D4\u3002\uFF01\uFF1F\n';

/**
 * Softer phrase boundaries: commas, colons, semicolons, dashes. Arabic comma
 * (U+060C) and Arabic semicolon (U+061B) are first-class members -- Arabic text
 * from an LLM uses them constantly, and they are exactly the natural breathing
 * points we want for the first speech chunk.
 */
export const SOFT_BOUNDARY_CHARS = ',\u060C;\u061B:\u2013\u2014\uFF0C\uFF1A\uFF1B)]}\u00BB\u201D';

const HARD_SET = new Set(HARD_BOUNDARY_CHARS.split(''));
const SOFT_SET = new Set(SOFT_BOUNDARY_CHARS.split(''));

export const isHardBoundaryChar = (c: string): boolean => HARD_SET.has(c);
export const isSoftBoundaryChar = (c: string): boolean => SOFT_SET.has(c);

/** Arabic-Indic and extended Arabic-Indic digits, plus ASCII. */
const DIGIT = '0-9\u0660-\u0669\u06F0-\u06F9';
/** Arabic decimal separator U+066B and thousands separator U+066C. */
const NUM_SEP = '.,\u066B\u066C\u2009\u00A0';

/**
 * Abbreviations whose trailing period is NOT a sentence end.
 *
 * This list is deliberately conservative. Short words that are also ordinary
 * sentence-final words -- "no.", "co.", "st.", "am.", "sec." -- are EXCLUDED:
 * treating "The answer is no." as an abbreviation would stall the chunker,
 * which is a far worse failure than occasionally breaking after a rare
 * abbreviation.
 */
export const ABBREVIATIONS = [
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'vs',
  'etc',
  'inc',
  'ltd',
  'corp',
  'dept',
  'approx',
  'vol',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
  'u.s',
  'u.k',
  'u.a.e',
  'ph.d',
];

// Lookbehind rather than a consuming prefix, so the span covers exactly the
// abbreviation and leaves the preceding space usable as a word boundary.
const ABBREV_RE = new RegExp(
  `(?<=^|[\\s(\\[{"'\u00AB\u201C])(?:${ABBREVIATIONS.map((a) => a.replace(/\./g, '\\.')).join('|')})\\.`,
  'giu',
);

/** Patterns whose interiors are never splittable. Order does not matter. */
const PROTECTED_PATTERNS: RegExp[] = [
  // URLs with a scheme, and bare www./domain-looking tokens.
  /\b(?:https?|ftp|ws|wss):\/\/[^\s\u060C\u061B]+/giu,
  /\bwww\.[^\s\u060C\u061B]+/giu,
  /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|ai|co|sa|ae|eg|jo|gov|edu|app|dev|me)\b(?:\/[^\s]*)?/giu,
  // Email addresses.
  /[^\s@\u060C\u061B]+@[^\s@\u060C\u061B]+\.[a-z]{2,}/giu,
  // Numbers with grouping and/or decimals, optional sign, optional currency/percent tail.
  new RegExp(`[+\\-]?[${DIGIT}]+(?:[${NUM_SEP}][${DIGIT}]+)+`, 'gu'),
  // ISO and slash/dot dates: 2025-01-31, 31/01/2025, 31.01.2025
  new RegExp(`[${DIGIT}]{1,4}[-/.][${DIGIT}]{1,2}[-/.][${DIGIT}]{1,4}`, 'gu'),
  // Clock times: 14:30, 14:30:05
  new RegExp(`[${DIGIT}]{1,2}:[${DIGIT}]{2}(?::[${DIGIT}]{2})?`, 'gu'),
  // Version-like and IP-like dotted numerals: 1.2.3, 192.168.0.1
  new RegExp(`[${DIGIT}]+(?:\\.[${DIGIT}]+){2,}`, 'gu'),
  // Acronyms with internal periods: U.S.A., A.I.
  /\b(?:[A-Za-z]\.){2,}/gu,
  // Ellipsis, in any of its forms.
  /\.{2,}|\u2026/gu,
  // Decimal with a single separator, e.g. 3.14 or ٣٫١٤ (covered above too, kept
  // explicit so a lone decimal without grouping is definitely protected).
  new RegExp(`[${DIGIT}]+[.\u066B][${DIGIT}]+`, 'gu'),
  // File-ish tokens: report.pdf, index.html
  /\b[\w\u0600-\u06FF-]+\.(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|json|html?|js|ts|png|jpe?g|mp3|wav)\b/giu,
];

export interface ProtectedSpan {
  start: number;
  /** Exclusive. */
  end: number;
  kind: string;
  /**
   * When true the FINAL character of the span is protected too.
   *
   * For most tokens ("1,250.50") cutting immediately after the token is legal,
   * so only the interior is masked. For an abbreviation the trailing period IS
   * the thing that must not be mistaken for a boundary, so the whole span is
   * masked.
   */
  maskAll?: boolean;
}

/**
 * Compute protected spans for `text`. A boundary index `i` is unusable when
 * `start < i < end - 1` for some span -- that is, cutting there would leave part
 * of the token behind.
 */
export function protectedSpans(text: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const re of PROTECTED_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      spans.push({ start: m.index, end: m.index + m[0].length, kind: re.source.slice(0, 24) });
    }
  }
  ABBREV_RE.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ABBREV_RE.exec(text)) !== null) {
    if (a[0].length === 0) {
      ABBREV_RE.lastIndex++;
      continue;
    }
    spans.push({ start: a.index, end: a.index + a[0].length, kind: 'abbreviation', maskAll: true });
  }
  return spans;
}

/** Build a boolean mask: true where a cut is forbidden. */
export function protectionMask(text: string, spans = protectedSpans(text)): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const s of spans) {
    const stop = s.maskAll ? s.end : s.end - 1;
    for (let i = s.start; i < stop && i < mask.length; i++) mask[i] = 1;
  }
  return mask;
}

/* -------------------------------------------------------------------------- */
/* Word counting                                                               */
/* -------------------------------------------------------------------------- */

const WORDISH = /[\p{L}\p{N}]/u;

/**
 * Counts "useful" words: whitespace-separated tokens containing at least one
 * letter or digit. A stray comma or a lone dash is not a word, so it cannot
 * satisfy a minimum-word threshold and trick the chunker into flushing noise.
 */
export function countWords(text: string): number {
  let n = 0;
  for (const tok of text.split(/\s+/)) if (tok && WORDISH.test(tok)) n++;
  return n;
}

/** True when the text contains no letters or digits at all. */
export function isPunctuationOnly(text: string): boolean {
  return !WORDISH.test(text);
}

/* -------------------------------------------------------------------------- */
/* Boundary discovery                                                          */
/* -------------------------------------------------------------------------- */

export type BoundaryKind = 'hard' | 'soft' | 'word';

export interface Boundary {
  /** Index of the LAST character included in the phrase when cutting here. */
  index: number;
  /** Exclusive cut position: text.slice(0, cut). */
  cut: number;
  kind: BoundaryKind;
  char: string;
}

export interface FindBoundaryOptions {
  /**
   * Require at least one character to exist AFTER a punctuation boundary before
   * trusting it. Without this, a buffer ending in "3." would be treated as a
   * sentence end when in fact "3.14" was still streaming in.
   */
  requireLookahead?: boolean;
  /** Ignore boundaries at a cut position below this. */
  minCut?: number;
  /** Ignore boundaries at a cut position above this. */
  maxCut?: number;
}

/**
 * All legal boundaries in `text`, in ascending order.
 *
 * A word boundary is reported at each run of whitespace: the whitespace itself
 * proves the preceding word is complete, so no lookahead is needed for it.
 */
export function findBoundaries(text: string, opts: FindBoundaryOptions = {}): Boundary[] {
  const { requireLookahead = true, minCut = 0, maxCut = Number.MAX_SAFE_INTEGER } = opts;
  const mask = protectionMask(text);
  const out: Boundary[] = [];
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const c = text[i];

    if (isHardBoundaryChar(c) || isSoftBoundaryChar(c)) {
      if (mask[i]) continue;
      // Consume a run of punctuation ("?!" or "،," ) so the whole run stays together.
      let j = i;
      while (j + 1 < n && (isHardBoundaryChar(text[j + 1]) || isSoftBoundaryChar(text[j + 1])) && !mask[j + 1]) j++;
      const hasHard = (() => {
        for (let k = i; k <= j; k++) if (isHardBoundaryChar(text[k])) return true;
        return false;
      })();
      const cut = j + 1;
      if (requireLookahead && cut >= n && c !== '\n') {
        // Nothing after the punctuation yet -- it may still be mid-token.
        i = j;
        continue;
      }
      if (cut >= minCut && cut <= maxCut) {
        out.push({ index: j, cut, kind: hasHard ? 'hard' : 'soft', char: text.slice(i, j + 1) });
      }
      i = j;
      continue;
    }

    if (/\s/.test(c)) {
      if (mask[i]) continue;
      let j = i;
      while (j + 1 < n && /\s/.test(text[j + 1])) j++;
      const cut = i; // cut BEFORE the whitespace; the trailing space is trimmed anyway
      if (cut >= minCut && cut <= maxCut && cut > 0) {
        out.push({ index: i - 1, cut, kind: 'word', char: ' ' });
      }
      i = j;
    }
  }

  return out;
}

/** The last boundary at or before `maxCut`, preferring stronger kinds. */
export function lastBoundaryAtOrBefore(boundaries: Boundary[], maxCut: number): Boundary | null {
  let best: Boundary | null = null;
  for (const b of boundaries) {
    if (b.cut > maxCut) break;
    best = b;
  }
  return best;
}

/** The first boundary at or after `minCut` whose kind is in `kinds`. */
export function firstBoundaryOfKind(boundaries: Boundary[], kinds: BoundaryKind[], minCut: number): Boundary | null {
  for (const b of boundaries) {
    if (b.cut < minCut) continue;
    if (kinds.includes(b.kind)) return b;
  }
  return null;
}
