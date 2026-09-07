/**
 * Text similarity utilities.
 *
 * Used to decide whether a speculatively prefetched retrieval (or a speculative
 * LLM call) is still valid once the authoritative transcript arrives. Getting
 * this wrong in either direction is costly: too strict and every prefetch is
 * wasted, too loose and the assistant answers a question the caller did not ask.
 */

/**
 * Arabic combining marks and tatweel ONLY.
 *
 * Written with explicit \uXXXX escapes on purpose: the equivalent literal-character
 * class is dangerously easy to get wrong. A range such as U+061A-U+0670 looks
 * like it covers diacritics, but it silently swallows every Arabic LETTER
 * between those code points, normalising all Arabic text to the empty string
 * and making retrieval and similarity return nothing at all.
 */
const AR_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Normalise for comparison only -- never for display or for sending to a model.
 * Folds Arabic orthographic variants that carry no semantic difference here
 * (alef forms, ta marbuta, alef maqsura) plus case and punctuation.
 */
export function normalizeForCompare(s: string): string {
  return s
    .normalize('NFKC')
    .replace(AR_DIACRITICS, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ -> ا
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/[٪-٭]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein distance with a rolling two-row buffer.
 * O(n*m) time, O(min(n,m)) space -- fine for utterance-length strings.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > b.length) [a, b] = [b, a];

  const prev = new Uint32Array(a.length + 1);
  const cur = new Uint32Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    cur[0] = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      const del = prev[i] + 1;
      const ins = cur[i - 1] + 1;
      const sub = prev[i - 1] + cost;
      cur[i] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    prev.set(cur);
  }
  return prev[a.length];
}

/** Normalised similarity in [0,1]; 1 means identical after normalisation. */
export function similarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return 1;
  const longest = Math.max(na.length, nb.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(na, nb) / longest;
}

/** Jaccard overlap of word sets. Cheaper and more robust for retrieval reuse. */
export function tokenOverlap(a: string, b: string): number {
  const sa = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const sb = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Combined score used for prefetch-reuse decisions.
 *
 * A prefetch is reusable when the query means the same thing, which is better
 * captured by word overlap than by character edit distance: STT commonly
 * revises a word ending or adds a trailing word without changing the intent.
 * We take the more forgiving of the two signals, because the cost of a false
 * reuse (slightly stale context) is far lower than the cost of a false miss
 * (paying full retrieval latency on the critical path).
 */
export function queryEquivalence(a: string, b: string): number {
  return Math.max(similarity(a, b), tokenOverlap(a, b));
}
