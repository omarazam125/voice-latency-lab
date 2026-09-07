import { describe, expect, it, vi } from 'vitest';
import {
  STREAMING_POLICY,
  StreamingSpeechChunker,
  clonePolicy,
  stripMarkdown,
  type ChunkerConfig,
  type ChunkerDeps,
  type SpeechPhrase,
} from './chunker.js';
import { countWords, findBoundaries, protectedSpans } from './boundaries.js';
import { applyModelCapabilities, defaultConfig, mergeConfig, modelCapabilities } from '../config.js';

/* -------------------------------------------------------------------------- */
/* Deterministic virtual clock                                                 */
/* -------------------------------------------------------------------------- */

class VirtualClock {
  private ns = 1_000_000_000n;
  private timers: Array<{ at: bigint; fn: () => void; id: number }> = [];
  private nextId = 1;

  deps: ChunkerDeps = {
    now: () => this.ns,
    setTimer: (fn, ms) => {
      const id = this.nextId++;
      this.timers.push({ at: this.ns + BigInt(Math.round(ms * 1e6)), fn, id });
      return id;
    },
    clearTimer: (h) => {
      this.timers = this.timers.filter((t) => t.id !== h);
    },
  };

  /** Advance virtual time, firing any timers that come due. */
  advance(ms: number): void {
    const target = this.ns + BigInt(Math.round(ms * 1e6));
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => (a.at < b.at ? -1 : 1));
      if (due.length === 0) break;
      const t = due[0];
      this.timers = this.timers.filter((x) => x.id !== t.id);
      this.ns = t.at;
      t.fn();
    }
    this.ns = target;
  }
}

interface Harness {
  chunker: StreamingSpeechChunker;
  clock: VirtualClock;
  phrases: SpeechPhrase[];
  texts: () => string[];
}

function harness(config = STREAMING_POLICY): Harness {
  const clock = new VirtualClock();
  const phrases: SpeechPhrase[] = [];
  const chunker = new StreamingSpeechChunker(
    clonePolicy(config),
    { onPhrase: (p) => phrases.push(p) },
    clock.deps,
  );
  return { chunker, clock, phrases, texts: () => phrases.map((p) => p.text) };
}

/** Feed tokens with a realistic inter-token gap. */
function stream(h: Harness, tokens: string[], gapMs = 30): void {
  for (const t of tokens) {
    h.chunker.push(t);
    h.clock.advance(gapMs);
  }
}

/* -------------------------------------------------------------------------- */

describe('StreamingSpeechChunker — Mode B first-phrase aggression', () => {
  it('emits the first phrase BEFORE the final period arrives (spec §33)', () => {
    const h = harness();
    const tokens = ['أكيد', '، ', 'أقدر ', 'أساعدك ', 'في ', 'هذا ', 'الموضوع.'];

    // Feed only up to the point where three useful words exist.
    h.chunker.push(tokens[0]);
    h.chunker.push(tokens[1]);
    h.chunker.push(tokens[2]);
    h.chunker.push(tokens[3]);

    expect(h.phrases.length).toBeGreaterThanOrEqual(1);
    expect(h.phrases[0].text).toBe('أكيد، أقدر أساعدك');
    expect(h.phrases[0].isFirst).toBe(true);
    // Crucially, this happened with no sentence terminator anywhere in the input.
    expect(h.phrases[0].text).not.toMatch(/[.!?؟]/);
  });

  it('matches the worked example from the specification end to end', () => {
    const h = harness();
    stream(h, ['أكيد،', ' أقدر', ' أساعدك', ' في معرفة', ' تفاصيل حسابك...']);
    h.chunker.finish();

    expect(h.texts()[0]).toBe('أكيد، أقدر أساعدك');
    expect(h.texts().join(' ')).toContain('تفاصيل حسابك');
    // Nothing is lost.
    expect(h.texts().join(' ').replace(/\s+/g, '')).toBe('أكيد،أقدرأساعدكفيمعرفةتفاصيلحسابك...'.replace(/\s+/g, ''));
  });

  it('does not emit before the minimum word count is reached', () => {
    const h = harness();
    h.chunker.push('أكيد، ');
    expect(h.phrases).toHaveLength(0);
    h.chunker.push('أقدر ');
    expect(h.phrases).toHaveLength(0);
    h.chunker.push('أساعدك ');
    expect(h.phrases).toHaveLength(1);
  });

  it('English: first phrase lands on an early natural boundary', () => {
    const h = harness();
    stream(h, ['Sure', ', ', 'I ', 'can ', 'help ', 'you ', 'with ', 'that ', 'today.']);
    h.chunker.finish();
    // Three useful words is the configured minimum, and the earliest legal
    // boundary at or beyond it wins — no waiting for the sentence to finish.
    expect(h.phrases[0].text).toBe('Sure, I can');
    expect(h.phrases[0].reason).toBe('word_boundary');
  });
});

describe('StreamingSpeechChunker — subsequent phrase policy', () => {
  it('prefers punctuation for later phrases', () => {
    const h = harness();
    stream(h, [
      'أكيد أقدر أساعدك ',
      'في معرفة تفاصيل حسابك الشخصي ',
      'والخدمات المتاحة، ',
      'وبعدها نقدر نكمل باقي الطلبات المطلوبة. ',
    ]);
    h.chunker.finish();
    expect(h.phrases.length).toBeGreaterThanOrEqual(2);
    const later = h.phrases.slice(1);
    // At least one later phrase ends on real punctuation rather than mid-air.
    expect(later.some((p) => /[،.]$/.test(p.text))).toBe(true);
  });

  it('falls back to a word boundary after the grace window expires', () => {
    const h = harness();
    // First phrase clears immediately.
    stream(h, ['Sure I can help you '], 0);
    h.phrases.length = 0;

    // Now feed a long run with no punctuation at all, slowly.
    stream(h, ['with ', 'the ', 'account ', 'details ', 'that ', 'you ', 'asked ', 'about ', 'right '], 40);
    h.clock.advance(300);

    expect(h.phrases.length).toBeGreaterThanOrEqual(1);
    expect(['grace_timeout', 'max_length']).toContain(h.phrases[0].reason);
  });

  it('honours the max-length overflow guard', () => {
    const h = harness();
    const long = 'كلمة '.repeat(40);
    h.chunker.push(long);
    h.chunker.finish();
    for (const p of h.phrases) {
      // No phrase should wildly exceed the configured maximum.
      expect(p.chars).toBeLessThanOrEqual(STREAMING_POLICY.subsequent.maxChars + 20);
    }
  });
});

/**
 * A deliberately strict policy, used ONLY to make boundary detection
 * observable.
 *
 * It refuses soft and word boundaries, so a phrase is emitted exactly when the
 * chunker decides it has found a real sentence terminator — which turns
 * "was this period treated as the end of a sentence?" into a directly testable
 * question. The streaming policy would emit early on a word boundary and hide
 * the answer. This is test scaffolding, not a shipped pipeline configuration.
 */
const HARD_BOUNDARY_ONLY: ChunkerConfig = {
  first: {
    minWords: 1,
    minChars: 1,
    maxWords: Number.MAX_SAFE_INTEGER,
    maxChars: Number.MAX_SAFE_INTEGER,
    graceMs: Number.MAX_SAFE_INTEGER,
    allowSoftBoundary: false,
    allowWordBoundary: false,
    boundaryPreference: 'strongest',
  },
  subsequent: {
    minWords: 1,
    minChars: 1,
    maxWords: Number.MAX_SAFE_INTEGER,
    maxChars: Number.MAX_SAFE_INTEGER,
    graceMs: Number.MAX_SAFE_INTEGER,
    allowSoftBoundary: false,
    allowWordBoundary: false,
    boundaryPreference: 'strongest',
  },
  stripMarkdown: true,
  emitPunctuationOnly: false,
};

describe('StreamingSpeechChunker — token protection', () => {
  it('never splits inside a grouped decimal number', () => {
    const h = harness();
    stream(h, ['المبلغ ', 'المستحق ', 'هو ', '1,250.50 ', 'ريال ', 'سعودي ', 'فقط.'], 10);
    h.chunker.finish();
    const joined = h.texts().join(' ');
    expect(joined).toContain('1,250.50');
    for (const p of h.texts()) {
      expect(p).not.toMatch(/1,250$/);
      expect(p).not.toMatch(/^250\.50/);
      expect(p).not.toMatch(/1,$/);
    }
  });

  it('never splits an email address', () => {
    const h = harness();
    stream(h, ['Please ', 'contact ', 'us ', 'at ', 'support@example.com ', 'for ', 'more ', 'help.'], 10);
    h.chunker.finish();
    expect(h.texts().join(' ')).toContain('support@example.com');
    for (const p of h.texts()) expect(p).not.toMatch(/support@example$/);
  });

  it('never splits a URL', () => {
    const h = harness();
    stream(h, ['Visit ', 'https://docs.example.com/a/b ', 'to ', 'read ', 'the ', 'full ', 'guide.'], 10);
    h.chunker.finish();
    expect(h.texts().join(' ')).toContain('https://docs.example.com/a/b');
  });

  it('does not treat an abbreviation period as a sentence end', () => {
    const h = harness(HARD_BOUNDARY_ONLY);
    h.chunker.push('Dr. Ahmed will call you back');
    expect(h.phrases).toHaveLength(0);
    h.chunker.push(' shortly. ');
    expect(h.texts()).toEqual(['Dr. Ahmed will call you back shortly.']);
  });

  it('does not treat a decimal point as a sentence end', () => {
    const h = harness(HARD_BOUNDARY_ONLY);
    h.chunker.push('The rate is 3.5 percent');
    expect(h.phrases).toHaveLength(0);
    h.chunker.push(' today. ');
    expect(h.texts()).toEqual(['The rate is 3.5 percent today.']);
  });

  it('does not split a date', () => {
    const h = harness();
    stream(h, ['الموعد ', 'المحدد ', 'هو ', '2026-01-31 ', 'إن ', 'شاء ', 'الله.'], 10);
    h.chunker.finish();
    expect(h.texts().join(' ')).toContain('2026-01-31');
  });

  it('holds a trailing period until lookahead proves it is a real terminator', () => {
    const h = harness(HARD_BOUNDARY_ONLY);
    h.chunker.push('The total is 1');
    h.chunker.push('.');
    // Could still be "1.5" — must not fire yet.
    expect(h.phrases).toHaveLength(0);
    h.chunker.push('5 million.');
    h.chunker.push(' ');
    expect(h.texts()).toEqual(['The total is 1.5 million.']);
  });
});

describe('StreamingSpeechChunker — stream shapes', () => {
  it('handles the entire response arriving in one delta', () => {
    const h = harness();
    h.chunker.push('وعليكم السلام، أكيد أقدر أساعدك في معرفة الخدمات المتوفرة عندنا اليوم. عندنا خدمات كثيرة.');
    h.chunker.finish();
    expect(h.phrases.length).toBeGreaterThan(1);
    expect(h.phrases[0].text).toBe('وعليكم السلام، أكيد');
  });

  it('handles a one-character-at-a-time stream', () => {
    const h = harness();
    const full = 'Sure, I can help you with your account today.';
    for (const ch of full) {
      h.chunker.push(ch);
      h.clock.advance(4);
    }
    h.chunker.finish();
    expect(h.texts().join(' ').replace(/\s+/g, ' ')).toBe(full);
  });

  it('handles an extremely slow stream via the grace timer', () => {
    const h = harness();
    h.chunker.push('نعم ');
    h.chunker.push('أكيد ');
    h.chunker.push('تمام ');
    expect(h.phrases).toHaveLength(1);
    h.clock.advance(5000);
    // No spurious extra phrases from an idle buffer.
    expect(h.phrases).toHaveLength(1);
  });

  it('emits a one-word answer only at stream end', () => {
    const h = harness();
    h.chunker.push('نعم.');
    expect(h.phrases).toHaveLength(0);
    h.chunker.finish();
    expect(h.texts()).toEqual(['نعم.']);
  });

  it('loses no characters across any stream shape', () => {
    const cases: string[][] = [
      ['Hello ', 'there ', 'friend', '.'],
      ['مرحبا ', 'كيف ', 'حالك ', 'اليوم؟ ', 'أنا ', 'بخير.'],
      ['a'],
      ['1,250.50 ريال '],
      ['Visit www.example.com now, please. Thanks!'],
    ];
    for (const tokens of cases) {
      const h = harness();
      stream(h, tokens, 5);
      h.chunker.finish();
      const expected = tokens.join('').replace(/\s+/g, '').trim();
      const actual = h.texts().join('').replace(/\s+/g, '');
      expect(actual).toBe(expected);
    }
  });
});

describe('StreamingSpeechChunker — cancellation', () => {
  it('stops emitting immediately on cancel', () => {
    const h = harness();
    stream(h, ['أكيد أقدر أساعدك في '], 0);
    const before = h.phrases.length;
    h.chunker.cancel();
    h.chunker.push('معرفة تفاصيل حسابك الشخصي بالكامل. ');
    h.chunker.finish();
    h.clock.advance(1000);
    expect(h.phrases).toHaveLength(before);
    expect(h.chunker.isCancelled).toBe(true);
  });

  it('does not fire a pending grace timer after cancellation', () => {
    const h = harness();
    const spy = vi.fn();
    const c = new StreamingSpeechChunker(clonePolicy(STREAMING_POLICY), { onPhrase: spy }, h.clock.deps);
    c.push('one two three four five six seven');
    spy.mockClear();
    c.cancel();
    h.clock.advance(1000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('flushes the tail on finish, never dropping it', () => {
    const h = harness();
    stream(h, ['أكيد أقدر أساعدك في معرفة'], 0);
    h.chunker.finish();
    expect(h.texts().join(' ')).toContain('معرفة');
  });
});

describe('StreamingSpeechChunker — hygiene', () => {
  it('drops markdown decoration before TTS', () => {
    const h = harness();
    h.chunker.push('**مرحبا** بك في *خدمة* العملاء اليوم. ');
    h.chunker.finish();
    const joined = h.texts().join(' ');
    expect(joined).not.toContain('*');
    expect(joined).toContain('مرحبا');
  });

  it('never emits a punctuation-only phrase', () => {
    const h = harness();
    stream(h, ['... ', '، ', 'نعم ', 'أكيد ', 'تمام ', 'جدا.'], 5);
    h.chunker.finish();
    for (const p of h.texts()) expect(p).toMatch(/[\p{L}\p{N}]/u);
  });

  it('assigns strictly increasing sequence numbers', () => {
    const h = harness();
    h.chunker.push('واحد اثنان ثلاثة أربعة خمسة ستة سبعة ثمانية تسعة عشرة أحد عشر اثنا عشر.');
    h.chunker.finish();
    expect(h.phrases.map((p) => p.seq)).toEqual(h.phrases.map((_, i) => i + 1));
  });

  it('reports sinceFirstDeltaMs relative to the first delta', () => {
    const h = harness();
    h.chunker.push('أكيد ');
    h.clock.advance(100);
    h.chunker.push('أقدر أساعدك ');
    expect(h.phrases[0].sinceFirstDeltaMs).toBeCloseTo(100, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Boundary primitives                                                         */
/* -------------------------------------------------------------------------- */

describe('boundary analysis', () => {
  it('counts only useful words', () => {
    expect(countWords('أكيد، أقدر أساعدك')).toBe(3);
    expect(countWords('  ,  -  ')).toBe(0);
    expect(countWords('1,250.50 ريال')).toBe(2);
  });

  it('protects numbers, urls, emails and dates', () => {
    const t = 'Pay 1,250.50 at https://x.example.com or mail a@b.co on 2026-01-31';
    const spans = protectedSpans(t);
    const covered = (needle: string) => {
      const i = t.indexOf(needle);
      return spans.some((s) => s.start <= i && s.end >= i + needle.length);
    };
    expect(covered('1,250.50')).toBe(true);
    expect(covered('https://x.example.com')).toBe(true);
    expect(covered('a@b.co')).toBe(true);
    expect(covered('2026-01-31')).toBe(true);
  });

  it('offers no boundary inside a protected token', () => {
    const t = 'total 1,250.50 riyal';
    const bs = findBoundaries(t);
    const numStart = t.indexOf('1,250.50');
    for (const b of bs) {
      const insideNumber = b.cut > numStart && b.cut < numStart + '1,250.50'.length;
      expect(insideNumber).toBe(false);
    }
  });

  it('recognises Arabic punctuation as boundaries', () => {
    const bs = findBoundaries('نعم، أكيد؛ تمام؟ خلاص. ');
    const kinds = bs.map((b) => b.kind);
    expect(kinds).toContain('soft');
    expect(kinds).toContain('hard');
  });

  it('strips markdown safely', () => {
    expect(stripMarkdown('**bold** and *em* and `code`')).toBe('bold and em and code');
    expect(stripMarkdown('- item one')).toBe('item one');
    expect(stripMarkdown('[link](http://x.com)')).toBe('link');
  });
});

/* -------------------------------------------------------------------------- */
/* Model capability guarding                                                   */
/* -------------------------------------------------------------------------- */

describe('model capabilities', () => {
  it('knows gpt-4.1 rejects reasoning.effort and verbosity', () => {
    // Verified against the live API: sending either returns HTTP 400, which
    // produces no audio at all rather than degrading gracefully.
    const c = modelCapabilities('gpt-4.1');
    expect(c.reasoning).toBe(false);
    expect(c.verbosity).toBe(false);
    expect(c.temperature).toBe(true);
  });

  it('covers the whole gpt-4.1 family', () => {
    for (const m of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'GPT-4.1']) {
      expect(modelCapabilities(m).reasoning, m).toBe(false);
    }
  });

  it('allows reasoning parameters on GPT-5 and later', () => {
    for (const m of ['gpt-5.6-terra', 'gpt-5.5', 'gpt-6-astra']) {
      expect(modelCapabilities(m).reasoning, m).toBe(true);
      expect(modelCapabilities(m).verbosity, m).toBe(true);
    }
  });

  it('marks o-series as reasoning-only, no temperature', () => {
    expect(modelCapabilities('o3-mini').reasoning).toBe(true);
    expect(modelCapabilities('o3-mini').temperature).toBe(false);
  });

  it('is permissive about unknown models so a new id is never blocked', () => {
    const c = modelCapabilities('some-future-model-v9');
    expect(c.reasoning).toBe(true);
    expect(c.verbosity).toBe(true);
  });

  it('strips parameters the selected model would reject', () => {
    const cfg = defaultConfig();
    cfg.llm.model = 'gpt-4.1';
    cfg.llm.reasoningEffort = 'none';
    cfg.llm.verbosity = 'low';
    applyModelCapabilities(cfg);
    expect(cfg.llm.reasoningEffort).toBeNull();
    expect(cfg.llm.verbosity).toBeNull();
    expect(cfg.llm.temperature).not.toBeNull();
  });

  it('applies the guard automatically when configuration is merged', () => {
    // Switching model in the UI must not leave a stale reasoning.effort behind
    // and break every subsequent turn.
    const cfg = mergeConfig(defaultConfig(), { llm: { model: 'gpt-5.6-terra', reasoningEffort: 'none' } });
    expect(cfg.llm.reasoningEffort).toBe('none');

    const switched = mergeConfig(cfg, { llm: { model: 'gpt-4.1' } });
    expect(switched.llm.reasoningEffort).toBeNull();
    expect(switched.llm.verbosity).toBeNull();
  });

  it('ships gpt-4.1 as the default model', () => {
    expect(defaultConfig().llm.model).toBe('gpt-4.1');
    expect(defaultConfig().llm.reasoningEffort).toBeNull();
  });
});

/* ========================================================================== */
/* Markup must never be spoken                                                */
/* ========================================================================== */

describe('stripMarkdown removes everything the caller must not hear', () => {
  it('strips EVERY bullet in a list, not just the first', () => {
    // The defect: the bullet, heading and blockquote rules are `^`-anchored
    // with the m flag, but whitespace was collapsed BEFORE they ran. With the
    // newlines gone `^` could only match position 0, so exactly one marker per
    // phrase was removed and the rest were spoken. Heard on a real call as
    // "التنافسية والمجزية - المسار المهني الواضح - التدريب".
    const md = '- الرواتب التنافسية\n- المسار المهني الواضح\n- التدريب والتطوير';
    const out = stripMarkdown(md);
    expect(out).not.toContain('-');
    expect(out).toContain('الرواتب التنافسية');
    expect(out).toContain('التدريب والتطوير');
  });

  it('strips numbered lists', () => {
    const out = stripMarkdown('1. افهم السؤال\n2. ابحث في المعرفة\n3. أجب');
    expect(out).not.toMatch(/\d\./);
    expect(out).toContain('ابحث في المعرفة');
  });

  it('strips XML-ish tags from the system prompt', () => {
    // Nothing stripped these in any mode. The production prompt is built
    // entirely from such tags, and a streaming model echoes that structure.
    for (const tag of ['<role>', '</role>', '<speaking_style>', '</fallback>', '<answer_quality level="high">']) {
      const out = stripMarkdown(`${tag} الرواتب تنافسية`);
      expect(out, tag).not.toContain('<');
      expect(out, tag).toContain('الرواتب تنافسية');
    }
  });

  it('leaves a tag-only phrase empty so it is dropped rather than spoken', () => {
    expect(stripMarkdown('<role>').length).toBe(0);
    expect(stripMarkdown('</fallback>').length).toBe(0);
  });

  it('does not mangle ordinary Arabic containing a hyphen inside a word', () => {
    // The stray-bullet rule must only fire on a hyphen standing alone.
    expect(stripMarkdown('البريد الإلكتروني هو e-mail')).toContain('e-mail');
    expect(stripMarkdown('رقم ٢٠٢٤-٢٠٢٥')).toContain('٢٠٢٤-٢٠٢٥');
  });

  it('still strips the markdown it always handled', () => {
    expect(stripMarkdown('**مهم** جداً')).toBe('مهم جداً');
    expect(stripMarkdown('## عنوان')).toBe('عنوان');
    expect(stripMarkdown('> اقتباس')).toBe('اقتباس');
  });
});
