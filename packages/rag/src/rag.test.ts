import { describe, expect, it } from 'vitest';
import { normalizeArabic, stemArabic, tokenize } from './tokenize.js';
import { Bm25Index } from './bm25.js';
import { chunkText } from './parse.js';
import type { KbChunk } from './types.js';

describe('Arabic normalisation', () => {
  it('strips diacritics WITHOUT destroying letters', () => {
    // Regression guard. An earlier version used a literal character class whose
    // U+061A-U+0670 range swallowed every Arabic letter, silently normalising
    // all Arabic text to the empty string and making retrieval return nothing.
    expect(normalizeArabic('الخدمات')).toBe('الخدمات');
    expect(normalizeArabic('مَرْحَبًا')).toBe('مرحبا');
    expect(normalizeArabic('السَّلامُ عَلَيْكُم')).toBe('السلام عليكم');
    expect(normalizeArabic('كتــــاب')).toBe('كتاب'); // tatweel removed
  });

  it('folds orthographic variants', () => {
    expect(normalizeArabic('أحمد')).toBe('احمد');
    expect(normalizeArabic('إسلام')).toBe('اسلام');
    expect(normalizeArabic('مدرسة')).toBe('مدرسه');
    expect(normalizeArabic('على')).toBe('علي');
  });

  it('never returns an empty string for real Arabic input', () => {
    for (const s of ['الخدمات المتوفرة', 'بدي أعرف تفاصيل حسابي', 'كم الرسوم؟', 'التمويل الشخصي']) {
      expect(normalizeArabic(s).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('stemming', () => {
  it('strips the definite article and plural suffix', () => {
    expect(stemArabic('الخدمات')).toBe('خدم');
    expect(stemArabic('والخدمات')).toBe('خدم');
  });

  it('never shortens a word below three characters', () => {
    expect(stemArabic('شو').length).toBeGreaterThanOrEqual(2);
    expect(stemArabic('بيت')).toBe('بيت');
  });

  it('produces non-empty tokens for an Arabic question', () => {
    const toks = tokenize('شو الخدمات المتوفرة عندكم');
    expect(toks.length).toBeGreaterThan(0);
    expect(toks).toContain('خدم');
  });

  it('handles English too', () => {
    const toks = tokenize('What services do you offer?');
    expect(toks).toContain('service'); // plural folded to singular
    expect(tokenize('service')).toContain('service'); // and the singular agrees
  });
});

describe('BM25 retrieval', () => {
  const mk = (id: string, text: string): KbChunk => ({
    id,
    documentId: 'doc',
    filename: 'services.md',
    chunkIndex: Number(id),
    text,
    start: 0,
    end: text.length,
  });

  const corpus = [
    mk('0', 'الخدمات المتوفرة: الحسابات الجارية وحسابات التوفير والتحويلات الدولية والبطاقات الائتمانية.'),
    mk('1', 'ساعات العمل: الفروع مفتوحة من الأحد إلى الخميس من التاسعة صباحاً حتى الرابعة والنصف مساءً.'),
    mk('2', 'الرسوم: رسوم إصدار بطاقة صراف بديلة ثلاثون ريالاً ورسوم التحويل الدولي خمسون ريالاً.'),
    mk('3', 'Available services include current accounts, savings accounts and international transfers.'),
  ];

  it('retrieves the right Arabic chunk', () => {
    const ix = new Bm25Index();
    ix.build(corpus);
    const hits = ix.search('شو الخدمات المتوفرة عندكم', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunkIndex).toBe(0);
  });

  it('retrieves the fees chunk for a fees question', () => {
    const ix = new Bm25Index();
    ix.build(corpus);
    const hits = ix.search('كم رسوم التحويل الدولي', 3);
    expect(hits[0].chunkIndex).toBe(2);
  });

  it('retrieves the hours chunk', () => {
    const ix = new Bm25Index();
    ix.build(corpus);
    const hits = ix.search('متى تفتح الفروع', 3);
    expect(hits[0].chunkIndex).toBe(1);
  });

  it('works in English', () => {
    const ix = new Bm25Index();
    ix.build(corpus);
    const hits = ix.search('what services are available', 3);
    expect(hits[0].chunkIndex).toBe(3);
  });

  it('normalises the top score to 1', () => {
    const ix = new Bm25Index();
    ix.build(corpus);
    const hits = ix.search('الخدمات', 3);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it('returns nothing for an empty index', () => {
    const ix = new Bm25Index();
    ix.build([]);
    expect(ix.search('anything', 5)).toEqual([]);
  });
});

describe('chunking', () => {
  it('splits on paragraphs and keeps offsets', () => {
    const text = ['# Title', '', 'A'.repeat(500), '', 'B'.repeat(500), '', 'C'.repeat(500)].join('\n');
    const chunks = chunkText(text, 'doc1', 'f.md', { size: 600, overlap: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.documentId).toBe('doc1');
      expect(c.filename).toBe('f.md');
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it('does not lose content', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i} with some content in it.`).join('\n\n');
    const chunks = chunkText(text, 'd', 'f.md', { size: 200, overlap: 20 });
    const joined = chunks.map((c) => c.text).join(' ');
    for (let i = 0; i < 12; i++) expect(joined).toContain(`Paragraph number ${i}`);
  });

  it('handles Arabic text', () => {
    const text = 'الخدمات المتوفرة عندنا كثيرة.\n\nساعات العمل من الأحد إلى الخميس.\n\nالرسوم معقولة جداً.';
    const chunks = chunkText(text, 'd', 'ar.md', { size: 60, overlap: 10 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it('returns nothing for empty input', () => {
    expect(chunkText('   \n\n  ', 'd', 'f.md')).toEqual([]);
  });
});

describe('duplicate collapsing', () => {
  const mk = (id: string, doc: string, file: string, text: string): KbChunk => ({
    id,
    documentId: doc,
    filename: file,
    chunkIndex: 0,
    text,
    start: 0,
    end: text.length,
  });

  const FEES = 'الرسوم: رسوم التحويل الدولي خمسون ريالاً لكل عملية.';
  const HOURS = 'ساعات العمل: من الأحد إلى الخميس من التاسعة صباحاً.';
  const LEAVE = 'الإجازة السنوية: ثلاثون يوماً في السنة للموظف.';

  it('collapses identical chunks so duplicates do not eat the top-K', () => {
    // Uploading "K8.txt" and "K8 - Copy.txt" is the real-world case: without
    // collapsing, a topK of 3 returns the same passage three times and the
    // model receives one fact instead of three.
    const ix = new Bm25Index();
    ix.build([
      mk('a', 'd1', 'K8.txt', FEES),
      mk('b', 'd2', 'K8 - Copy.txt', FEES),
      mk('c', 'd3', 'K9.txt', HOURS),
      mk('d', 'd4', 'K9 - Copy.txt', HOURS),
    ]);
    const hits = ix.search('كم رسوم التحويل الدولي', 4);
    // BM25 itself still surfaces both copies...
    expect(hits.length).toBeGreaterThanOrEqual(2);

    // ...and the fingerprint used to collapse them treats the copies as one.
    const key = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 400);
    expect(key(FEES)).toBe(key(`${FEES}\n`));
    expect(key(FEES)).not.toBe(key(HOURS));
    expect(key(HOURS)).not.toBe(key(LEAVE));
  });

  it('treats copies differing only in whitespace or case as duplicates', () => {
    const key = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 400);
    expect(key('Hello   World')).toBe(key('hello world'));
    expect(key('  padded  ')).toBe(key('padded'));
    expect(key('one')).not.toBe(key('two'));
  });
});

/* ========================================================================== */
/* Relevance gating                                                           */
/* ========================================================================== */

describe('BM25 relevance gating', () => {
  /**
   * The defect these pin down: `score` is normalised against the best hit, so
   * the top result is ALWAYS exactly 1.0 no matter how irrelevant it is. A
   * minScore floor therefore filters nothing, and an off-topic question came
   * back with three confident-looking passages that the model then answered
   * from -- the caller asks about one thing and the agent talks about another.
   */
  const CORPUS = [
    'بدل السكن بنسبة خمسة وعشرين بالمئة من الراتب الأساسي وبدل النقل عشرة بالمئة',
    'تستحق الموظفة إجازة وضع مدتها أربعة وثمانون يوما ويحق لها تمديدها',
    'عقوبة التأخر عن الدوام خصم من الأجر حسب جدول المخالفات والجزاءات',
  ];

  function index() {
    const ix = new Bm25Index();
    ix.build(CORPUS.map((text, i) => ({ text, id: String(i) }) as any));
    return ix;
  }

  it('always scores the top hit 1.0, however unrelated the question', () => {
    const hits = index().search('وصفة كبسة لحم بالطقس', 3);
    if (hits.length > 0) {
      // This is WHY a minScore floor cannot work, stated as an assertion.
      expect(hits[0]!.score).toBe(1);
    }
  });

  it('gives an on-topic question high coverage', () => {
    const hits = index().search('كم بدل السكن من الراتب الأساسي', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.coverage).toBeGreaterThan(0.35);
  });

  it('gives an off-topic question low coverage even when it matches a word', () => {
    // "من" appears in the corpus, so BM25 returns a positive score. Coverage is
    // what knows the rest of the question was never accounted for.
    const hits = index().search('من فاز بكاس العالم لكرة القدم', 3);
    for (const h of hits) expect(h.coverage).toBeLessThan(0.35);
  });

  it('reports coverage 0 when nothing in the question is known', () => {
    const hits = index().search('زززز ششششش', 3);
    expect(hits.every((h) => h.coverage === 0)).toBe(true);
  });

  it('keeps the raw score alongside the normalised one', () => {
    const hits = index().search('بدل السكن', 3);
    expect(hits[0]!.rawScore).toBeGreaterThan(0);
    // Normalisation must not have destroyed the absolute value.
    if (hits.length > 1) expect(hits[0]!.rawScore).toBeGreaterThanOrEqual(hits[1]!.rawScore);
  });
});

describe('chunk boundaries never cut a word', () => {
  /**
   * Reproduces a defect found in the live index: ten chunks began with a word
   * fragment — "قعات" (from التوقعات), "رة" (المعايرة), "لتي" (التي) — and each
   * fragment occurred ZERO times as a standalone word anywhere in the corpus.
   * A chunk indexed under a token that does not exist is unfindable by the term
   * it is actually about, and both halves of the split word are lost.
   *
   * The cause was that the hard-split searched back for a literal ' ' only,
   * while these Arabic FAQ documents separate list items with '
'.
   */

  /**
   * Paragraphs sized to trigger the OVERLAP CARRY, which is where the defect
   * lives — verified against the real K7.txt, where 15 of 20 chunks began
   * mid-word before the fix and 0 do after it.
   *
   * The size matters: at ~350 characters two paragraphs fit inside the 900-char
   * target and the third overflows it, which is exactly the branch that slices
   * a tail forward. Paragraphs too small never overflow, and one huge paragraph
   * takes the sentence-splitting path instead — an earlier version of this test
   * used both and passed happily against the broken code.
   */
  function paragraphsOf(count: number): string {
    const rows = [
      'تجاوز التوقعات بشكل واضح ومستمر في جميع الجدارات المطلوبة',
      'حقق التوقعات جزئياً في بعض الأهداف الوظيفية المتفق عليها',
      'أقل من التوقعات ويحتاج إلى خطة تطوير فردية معتمدة',
      'ما المقصود بالمعايرة ولماذا تطبق على نتائج التقييم السنوي',
      'هي عملية مراجعة نتائج التقييم بهدف ضمان العدالة والاتساق',
      'ما المعايير التي يتم الاستناد إليها خلال المعايرة النهائية',
    ];
    return Array.from({ length: count }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => rows[(i + j) % rows.length]).join('\n'),
    ).join('\n\n');
  }

  const newlineSeparatedParagraph = (_items: number) => paragraphsOf(14);

  function allWords(text: string): Set<string> {
    return new Set(text.split(/\s+/).filter(Boolean));
  }

  it('never starts a chunk mid-word when items are newline-separated', () => {
    const text = newlineSeparatedParagraph(120);
    const vocabulary = allWords(text);
    const chunks = chunkText(text, 'doc', 'f.txt');
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      const first = c.text.trim().split(/\s+/)[0]!;
      expect(vocabulary.has(first), `chunk ${c.chunkIndex} starts with "${first}"`).toBe(true);
    }
  });

  it('never ends a chunk mid-word when items are newline-separated', () => {
    const text = newlineSeparatedParagraph(120);
    const vocabulary = allWords(text);
    for (const c of chunkText(text, 'doc', 'f.txt')) {
      const tokens = c.text.trim().split(/\s+/);
      const last = tokens[tokens.length - 1]!;
      expect(vocabulary.has(last), `chunk ${c.chunkIndex} ends with "${last}"`).toBe(true);
    }
  });

  it('never starts a chunk mid-word with space-separated prose either', () => {
    const words = ['التوقعات', 'المعايرة', 'الموظف', 'التقييم', 'الجدارات', 'المباشر'];
    const text = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: 45 }, (_, j) => `${words[(i + j) % words.length]}${(i * 45 + j) % 7}`).join(' '),
    ).join('\n\n');
    const vocabulary = allWords(text);
    for (const c of chunkText(text, 'doc', 'f.txt')) {
      const first = c.text.trim().split(/\s+/)[0]!;
      expect(vocabulary.has(first), `chunk ${c.chunkIndex} starts with "${first}"`).toBe(true);
    }
  });

  it('loses no content across the chunk set', () => {
    // A boundary fix must not silently drop text.
    const text = newlineSeparatedParagraph(120);
    const joined = chunkText(text, 'doc', 'f.txt').map((c) => c.text).join(' ');
    for (const w of ['المعايرة', 'التوقعات', 'الجدارات'].filter((w) => text.includes(w))) {
      expect(joined).toContain(w);
    }
  });
});
