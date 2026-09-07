/**
 * Arabic-aware tokenisation and light stemming for the lexical index.
 *
 * Arabic retrieval degrades badly with a naive whitespace tokeniser: the
 * definite article, conjunctions and pronoun suffixes all attach directly to
 * the word, so "الخدمات", "وخدمات" and "خدماتنا" are three distinct tokens for
 * the same concept. Stripping the common clitics collapses them and materially
 * improves recall on a small knowledge base, without needing a full morphology
 * engine or a network call.
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

/** Arabic stop words that carry no retrieval signal. */
const AR_STOP = new Set([
  'من','في','على','الى','إلى','عن','مع','هذا','هذه','ذلك','التي','الذي','ما','لا','ان','أن','إن','كان','كانت',
  'هو','هي','هم','هن','انا','أنا','نحن','انت','أنت','لكن','او','أو','ثم','قد','كل','بعض','غير','بين','عند',
  'يكون','تكون','هل','كيف','متى','اين','أين','لماذا','ماذا','بس','يا','و','ب','ل','ك','ف',
]);

const EN_STOP = new Set([
  'the','a','an','and','or','but','if','of','to','in','on','at','for','with','is','are','was','were','be','been',
  'this','that','these','those','it','its','as','by','from','can','could','will','would','do','does','did','not',
  'i','you','he','she','we','they','my','your','our','their','have','has','had','what','how','when','where','why',
]);

/** Prefix clitics, longest first so "وال" is stripped before "و". */
const AR_PREFIXES = ['وال', 'فال', 'بال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب', 'ك', 'ل'];
/** Suffixes, longest first. */
const AR_SUFFIXES = ['هما', 'كما', 'هن', 'هم', 'كم', 'كن', 'نا', 'ها', 'ات', 'ان', 'ون', 'ين', 'ية', 'ه', 'ك', 'ي'];

export function normalizeArabic(s: string): string {
  return s
    .normalize('NFKC')
    .replace(AR_DIACRITICS, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

const isArabic = (t: string) => /[؀-ۿ]/.test(t);

/**
 * Strip clitics conservatively: never shorten a word below three characters,
 * because that turns distinct short words into collisions.
 */
export function stemArabic(token: string): string {
  let t = token;
  for (const p of AR_PREFIXES) {
    if (t.length - p.length >= 3 && t.startsWith(p)) {
      t = t.slice(p.length);
      break;
    }
  }
  for (const s of AR_SUFFIXES) {
    if (t.length - s.length >= 3 && t.endsWith(s)) {
      t = t.slice(0, -s.length);
      break;
    }
  }
  return t;
}

/** Very light English stemmer: plurals and common verb endings only. */
export function stemEnglish(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) return token.slice(0, -1);
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  return token;
}

export interface TokenizeOptions {
  stem?: boolean;
  removeStopWords?: boolean;
  minLength?: number;
}

export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const { stem = true, removeStopWords = true, minLength = 2 } = opts;
  const normalized = normalizeArabic(text).toLowerCase();
  // Keep letters and digits from any script; split on everything else.
  const raw = normalized.split(/[^\p{L}\p{N}]+/u);

  const out: string[] = [];
  for (const tok of raw) {
    if (!tok || tok.length < minLength) continue;
    const arabic = isArabic(tok);
    if (removeStopWords && (arabic ? AR_STOP.has(tok) : EN_STOP.has(tok))) continue;
    const stemmed = stem ? (arabic ? stemArabic(tok) : stemEnglish(tok)) : tok;
    if (stemmed.length >= minLength) out.push(stemmed);
  }
  return out;
}
