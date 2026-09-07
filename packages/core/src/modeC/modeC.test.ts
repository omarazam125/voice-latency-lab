import { describe, expect, it } from 'vitest';
import {
  EndpointingManager,
  classifyInterruption,
  classifyTranscript,
  computeStability,
  stablePrefixOf,
  usefulWordCount,
  type EndpointingInputs,
} from './endpointing.js';
import {
  VoiceChunkPlanner,
  endsOnFunctionWord,
  hasOpenQuote,
  indexOfMarker,
  stripAllMarkers,
  trailingPartialMarker,
  type VoiceChunk,
} from './voiceChunkPlanner.js';
import { defaultModeCConfig, MODE_C_PRESETS, clampModeCConfig } from './config.js';

/* -------------------------------------------------------------------------- */
/* Virtual clock                                                               */
/* -------------------------------------------------------------------------- */

class VClock {
  private ns = 1_000_000_000n;
  private timers: Array<{ at: bigint; fn: () => void; id: number }> = [];
  private next = 1;
  deps = {
    now: () => this.ns,
    setTimer: (fn: () => void, ms: number) => {
      const id = this.next++;
      this.timers.push({ at: this.ns + BigInt(Math.round(ms * 1e6)), fn, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      this.timers = this.timers.filter((t) => t.id !== h);
    },
  };
  advance(ms: number): void {
    const target = this.ns + BigInt(Math.round(ms * 1e6));
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => (a.at < b.at ? -1 : 1));
      if (!due.length) break;
      const t = due[0];
      this.timers = this.timers.filter((x) => x.id !== t.id);
      this.ns = t.at;
      t.fn();
    }
    this.ns = target;
  }
}

/* -------------------------------------------------------------------------- */
/* Content classification                                                      */
/* -------------------------------------------------------------------------- */

describe('transcript classification', () => {
  it('recognises Arabic sentence punctuation', () => {
    expect(classifyTranscript('بدي أعرف رصيدي؟')).toBe('punctuation');
    expect(classifyTranscript('خلاص شكراً.')).toBe('punctuation');
    expect(classifyTranscript('ممتاز!')).toBe('punctuation');
  });

  it('recognises a trailing number in both digit systems', () => {
    expect(classifyTranscript('رقم الحساب هو 1234')).toBe('number');
    expect(classifyTranscript('رقم الحساب هو ١٢٣٤')).toBe('number');
  });

  it('treats a comma as a pause, not an ending', () => {
    expect(classifyTranscript('بدي أعرف الرصيد،')).toBe('soft_punctuation');
  });

  it('recognises an explicit unfinished ellipsis', () => {
    expect(classifyTranscript('بدي أعرف...')).toBe('ellipsis');
  });

  it('reports no punctuation when there is none', () => {
    expect(classifyTranscript('بدي أعرف رصيدي')).toBe('none');
  });

  it('counts only useful words', () => {
    expect(usefulWordCount('بدي أعرف رصيدي')).toBe(3);
    expect(usefulWordCount('  ،  -  ')).toBe(0);
  });
});

describe('transcript stability', () => {
  it('finds the stable prefix at a word boundary', () => {
    // The divergence falls INSIDE "أعرف" (the shorter transcript simply ends
    // there), so that word is not yet proven — it could still grow into
    // "أعرفها". Only "بدي" is certain.
    expect(stablePrefixOf('بدي أعرف رصيدي', 'بدي أعرف')).toBe('بدي');

    // Here the common prefix ends ON a space, so "world" is complete and
    // proven; only the final token is in flux.
    expect(stablePrefixOf('hello world foo', 'hello world bar')).toBe('hello world');
  });

  it('reports full stability when nothing changed', () => {
    expect(stablePrefixOf('بدي أعرف رصيدي', 'بدي أعرف رصيدي')).toBe('بدي أعرف رصيدي');
  });

  it('scores an unchanged transcript higher than a churning one', () => {
    const settled = computeStability('بدي أعرف رصيدي', 'بدي أعرف رصيدي', 400, 1, 180);
    const churning = computeStability('بدي أعرف رصيدي', 'بدي أعرف', 20, 9, 180);
    expect(settled).toBeGreaterThan(churning);
    expect(settled).toBeGreaterThan(0.7);
  });

  it('stays within [0,1]', () => {
    for (const t of [0, 50, 5000]) {
      const s = computeStability('abc def', 'abc', t, 3, 180);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Endpointing                                                                 */
/* -------------------------------------------------------------------------- */

function inputs(over: Partial<EndpointingInputs> = {}): EndpointingInputs {
  return {
    speaking: false,
    silenceMs: 0,
    transcript: '',
    hasFinal: false,
    timeSinceTranscriptChangedMs: 500,
    revisions: 1,
    previousTranscript: '',
    ...over,
  };
}

describe('EndpointingManager — content-aware timing', () => {
  const mk = () => new EndpointingManager(defaultModeCConfig().endpointing);

  it('never commits while the caller is speaking', () => {
    const d = mk().evaluate(inputs({ speaking: true, silenceMs: 0, transcript: 'بدي أعرف' }));
    expect(d.commit).toBe(false);
    expect(d.reasonCode).toBe('waiting');
  });

  it('commits a punctuated question far sooner than an unpunctuated one', () => {
    const m = mk();
    const q = 'بدي أعرف رصيدي؟';
    const noPunct = 'بدي أعرف رصيدي';

    // 450 ms of silence: past waitSeconds (400 ms) and past onPunctuation (100 ms).
    const punctuated = m.evaluate(inputs({ silenceMs: 450, transcript: q, previousTranscript: q }));
    expect(punctuated.commit).toBe(true);
    expect(punctuated.reasonCode).toBe('punctuation_complete');

    // Same silence, no punctuation: must still be waiting (needs 1500 ms).
    const plain = m.evaluate(inputs({ silenceMs: 450, transcript: noPunct, previousTranscript: noPunct }));
    expect(plain.commit).toBe(false);
    expect(plain.requiredSilenceMs).toBe(1500);
  });

  it('waits longer when the transcript ends in a number', () => {
    const m = mk();
    const t = 'رقم الحساب هو 1234';
    const early = m.evaluate(inputs({ silenceMs: 450, transcript: t, previousTranscript: t }));
    expect(early.commit).toBe(false);
    expect(early.contentClass).toBe('number');
    expect(early.requiredSilenceMs).toBe(500);

    const later = m.evaluate(inputs({ silenceMs: 520, transcript: t, previousTranscript: t }));
    expect(later.commit).toBe(true);
    expect(later.reasonCode).toBe('number_pause_elapsed');
  });

  it('honours the minimum wait even when punctuation says commit now', () => {
    const m = mk();
    const t = 'تمام؟';
    // 200 ms is past onPunctuationSeconds (100 ms) but below waitSeconds (400 ms).
    const d = m.evaluate(inputs({ silenceMs: 200, transcript: t, previousTranscript: t }));
    expect(d.commit).toBe(false);
    expect(d.reasonCode).toBe('below_wait_seconds');
  });

  it('refuses to commit on punctuation while the transcript is still churning', () => {
    const m = mk();
    // Punctuation present, but the text changed 10 ms ago after 8 revisions.
    const d = m.evaluate(
      inputs({
        silenceMs: 450,
        transcript: 'بدي أعرف رصيدي؟',
        previousTranscript: 'بدي أعرف',
        timeSinceTranscriptChangedMs: 10,
        revisions: 8,
      }),
    );
    expect(d.commit).toBe(false);
    expect(d.reason).toContain('still changing');
  });

  it('applies a custom rule for a trailing conjunction', () => {
    const m = mk();
    const t = 'بدي أعرف الرصيد و';
    const d = m.evaluate(inputs({ silenceMs: 600, transcript: t, previousTranscript: t }));
    expect(d.commit).toBe(false);
    expect(d.ruleName).toContain('conjunction');
    expect(d.requiredSilenceMs).toBe(1800);
  });

  it('always commits at the maximum-wait ceiling', () => {
    const m = mk();
    const t = 'بدي أعرف الرصيد و';
    const d = m.evaluate(inputs({ silenceMs: 2600, transcript: t, previousTranscript: t }));
    expect(d.commit).toBe(true);
    expect(d.reasonCode).toBe('max_wait_ceiling');
  });

  it('falls back to a plain fixed timer in vad_silence strategy', () => {
    const cfg = defaultModeCConfig().endpointing;
    cfg.strategy = 'vad_silence';
    const m = new EndpointingManager(cfg);
    const t = 'بدي أعرف رصيدي؟';
    // Punctuation is ignored entirely: this is the control strategy.
    expect(m.evaluate(inputs({ silenceMs: 450, transcript: t, previousTranscript: t })).commit).toBe(false);
    expect(m.evaluate(inputs({ silenceMs: 1550, transcript: t, previousTranscript: t })).commit).toBe(true);
  });

  it('reports how much time the content-aware path saved', () => {
    const m = mk();
    const t = 'بدي أعرف رصيدي؟';
    const d = m.evaluate(inputs({ silenceMs: 450, transcript: t, previousTranscript: t }));
    // 1500 ms fixed timer vs 400 ms actually required.
    expect(m.savedVersusFixedTimer(d)).toBe(1100);
  });

  it('always explains itself', () => {
    const m = mk();
    for (const t of ['بدي أعرف رصيدي؟', 'رقم 1234', 'بدي أعرف', '']) {
      const d = m.evaluate(inputs({ silenceMs: 500, transcript: t, previousTranscript: t }));
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.reasonCode.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Interruption                                                                */
/* -------------------------------------------------------------------------- */

describe('interruption classification', () => {
  const cfg = defaultModeCConfig().stopSpeaking;

  it('treats a backchannel as agreement, not an interruption', () => {
    for (const p of ['تمام', 'اه', 'ايوه', 'أوكي']) {
      const d = classifyInterruption(p, 500, cfg);
      expect(d.interrupt, p).toBe(false);
      expect(d.klass, p).toBe('acknowledgement');
    }
  });

  it('interrupts immediately on an explicit stop phrase', () => {
    const d = classifyInterruption('لحظة', 50, cfg);
    expect(d.interrupt).toBe(true);
    expect(d.klass).toBe('interruption');
  });

  // Expressed relative to the configured threshold rather than as bare
  // milliseconds: these assert the RULE, and hard-coded numbers made them fail
  // the moment the default was retuned, which says nothing about correctness.
  const belowThresholdMs = cfg.voiceSeconds * 1000 - 50;
  const aboveThresholdMs = cfg.voiceSeconds * 1000 + 50;

  it('requires sustained voice activity', () => {
    const d = classifyInterruption('بدي أسأل عن شي ثاني', belowThresholdMs, cfg);
    expect(d.interrupt).toBe(false);
    expect(d.klass).toBe('insufficient');
  });

  it('interrupts on sustained speech when numWords is 0', () => {
    const d = classifyInterruption('بدي أسأل عن شي ثاني', aboveThresholdMs, cfg);
    expect(d.interrupt).toBe(true);
  });

  /**
   * The backoff window raises the bar; it does not close the door.
   *
   * It previously suppressed EVERYTHING for a second after an interruption,
   * which was observed live silencing a caller: an 872 ms three-word question
   * was labelled a backchannel and ignored purely because of when it landed.
   * Suppressing an explicit "stop" is worse still.
   */
  it('still suppresses a brief utterance inside the backoff window', () => {
    const d = classifyInterruption('طيب', 250, cfg, true);
    expect(d.interrupt).toBe(false);
    expect(d.klass).toBe('backoff');
  });

  it('always honours an explicit stop phrase, even inside the backoff window', () => {
    // A caller saying "stop" must never be ignored because of timing.
    const d = classifyInterruption('وقف', 900, cfg, true);
    expect(d.interrupt).toBe(true);
    expect(d.klass).toBe('interruption');
  });

  it('lets emphatically sustained speech through the backoff window', () => {
    // Twice the normal voice threshold: the caller has clearly taken the floor.
    const brief = classifyInterruption('انا كنت اسأل عن شي', aboveThresholdMs, cfg, true);
    expect(brief.interrupt).toBe(false);

    const emphatic = classifyInterruption('انا كنت اسأل عن شي', cfg.voiceSeconds * 2000 + 50, cfg, true);
    expect(emphatic.interrupt).toBe(true);
  });

  it('honours a word threshold when configured', () => {
    const strict = { ...cfg, numWords: 3 };
    expect(classifyInterruption('بدي', 500, strict).interrupt).toBe(false);
    expect(classifyInterruption('بدي أسأل سؤال ثاني', 500, strict).interrupt).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* VoiceChunkPlanner                                                           */
/* -------------------------------------------------------------------------- */

function planner(overrides: Partial<ReturnType<typeof defaultModeCConfig>['chunkPlan']> = {}) {
  const clock = new VClock();
  const chunks: VoiceChunk[] = [];
  const flushes: Array<{ position: number; text: string }> = [];
  const cfg = { ...defaultModeCConfig().chunkPlan, ...overrides };
  const p = new VoiceChunkPlanner(
    cfg,
    { onChunk: (c) => chunks.push(c), onFlush: (f) => flushes.push({ position: f.position, text: f.text }) },
    clock.deps,
  );
  return { p, clock, chunks, flushes, texts: () => chunks.map((c) => c.text) };
}

describe('VoiceChunkPlanner — first chunk', () => {
  it('emits an early speakable phrase before the sentence completes', () => {
    const h = planner();
    h.p.push('أكيد');
    h.p.push('، ');
    h.p.push('أقدر ');
    h.p.push('أساعدك ');
    h.p.push('في ');
    // Mode C prefers a punctuation boundary and gives the model a short grace
    // window (maxWaitMs) to produce one before settling for a word boundary.
    h.clock.advance(200);
    expect(h.chunks.length).toBeGreaterThanOrEqual(1);
    expect(h.chunks[0].isFirst).toBe(true);
    expect(h.chunks[0].text).not.toMatch(/[.؟!]$/);
    expect(h.chunks[0].words).toBeGreaterThanOrEqual(3);
  });

  it('takes a punctuation boundary as soon as one is eligible', () => {
    const h = planner();
    h.p.push('وعليكم السلام، أقدر أساعدك في هذا الموضوع. وكمان في تفاصيل ثانية.');
    expect(h.chunks[0].reason).toBe('punctuation_boundary');
    expect(h.chunks[0].text.endsWith('.')).toBe(true);
  });

  it('loses no text across the whole stream', () => {
    const h = planner();
    const tokens = ['أكيد', '، ', 'أقدر ', 'أساعدك ', 'في ', 'معرفة ', 'تفاصيل ', 'حسابك', '.'];
    for (const t of tokens) {
      h.p.push(t);
      h.clock.advance(25);
    }
    h.p.finish();
    expect(h.texts().join('').replace(/\s+/g, '')).toBe(tokens.join('').replace(/\s+/g, ''));
  });

  it('settles for a word boundary once maxWait elapses', () => {
    const h = planner();
    h.p.push('واحد اثنان ثلاثة أربعة');
    h.clock.advance(400);
    expect(h.chunks.length).toBeGreaterThanOrEqual(1);
    expect(h.chunks[0].reason).toBe('max_wait');
  });

  it('does not end a phrase on a trailing function word', () => {
    const h = planner();
    // A naive "last word boundary" cut would end on "في", which the TTS engine
    // would speak with a falling, finished intonation on an obvious fragment.
    h.p.push('أكيد، أقدر أساعدك في ');
    h.clock.advance(300);
    expect(h.chunks.length).toBeGreaterThanOrEqual(1);
    expect(h.chunks[0].text).toBe('أكيد، أقدر أساعدك');
  });

  it('emits a one-word answer only at stream end', () => {
    const h = planner();
    h.p.push('نعم.');
    h.p.finish();
    expect(h.texts()).toEqual(['نعم.']);
  });
});

describe('VoiceChunkPlanner — flush marker', () => {
  it('submits everything before the marker immediately', () => {
    const h = planner();
    h.p.push('أكيد، خليني أتأكد لك. <flush /> التفاصيل هي...');
    expect(h.chunks[0].text).toBe('أكيد، خليني أتأكد لك.');
    expect(h.chunks[0].flushTriggered).toBe(true);
    expect(h.chunks[0].reason).toBe('flush_marker');
  });

  it('never lets the marker reach the TTS text', () => {
    const h = planner();
    h.p.push('أكيد <flush /> تمام <flush/> خلاص.');
    h.p.finish();
    for (const t of h.texts()) {
      expect(t).not.toContain('flush');
      expect(t).not.toContain('<');
    }
  });

  it('handles a marker split across two deltas', () => {
    const h = planner();
    // The model emits the marker in pieces; "flush" must never be spoken.
    h.p.push('أكيد خليني أتأكد لك. <flu');
    h.p.push('sh /> التفاصيل هنا.');
    h.p.finish();
    const joined = h.texts().join(' ');
    expect(joined).not.toContain('flush');
    expect(joined).not.toContain('<');
    expect(joined).toContain('أكيد');
    expect(joined).toContain('التفاصيل');
  });

  it('tolerates spacing variants', () => {
    for (const marker of ['<flush />', '<flush/>', '< flush />']) {
      const h = planner();
      h.p.push(`مرحبا بك ${marker} تفاصيل`);
      h.p.finish();
      expect(h.texts().join(' ')).not.toContain('flush');
    }
  });

  it('reports the flush position for telemetry', () => {
    const h = planner();
    h.p.push('أكيد خليني أتأكد. <flush /> باقي');
    expect(h.flushes).toHaveLength(1);
    expect(h.flushes[0].position).toBeGreaterThan(0);
  });

  it('does not treat a lone angle bracket as a marker', () => {
    const h = planner();
    h.p.push('السعر أقل من 5 ريال تقريبا اليوم.');
    h.p.finish();
    expect(h.texts().join(' ')).toContain('5');
  });

  it('can be disabled', () => {
    const h = planner({ flushEnabled: false });
    h.p.push('أكيد تمام خلاص <flush /> باقي الكلام هنا.');
    h.p.finish();
    // With flush off the marker carries no control meaning, but it must STILL
    // never be spoken: otherwise the caller hears the assistant say "flush".
    expect(h.texts().join(' ')).not.toContain('flush');
  });
});

describe('flush marker helpers', () => {
  it('finds exact and spaced variants', () => {
    expect(indexOfMarker('a <flush /> b', '<flush />')).toBe(2);
    expect(indexOfMarker('a <flush/> b', '<flush />')).toBe(2);
    expect(indexOfMarker('a < flush /> b', '<flush />')).toBe(2);
    expect(indexOfMarker('nothing here', '<flush />')).toBe(-1);
  });

  it('strips every variant', () => {
    expect(stripAllMarkers('a <flush /> b <flush/> c', '<flush />').trim()).toBe('a b c');
  });

  it('detects a trailing partial marker', () => {
    expect(trailingPartialMarker('hello <flu', '<flush />')).toBeGreaterThan(0);
    expect(trailingPartialMarker('hello <', '<flush />')).toBeGreaterThan(0);
    expect(trailingPartialMarker('hello world', '<flush />')).toBe(0);
    expect(trailingPartialMarker('done <flush />', '<flush />')).toBe(0);
  });
});

describe('VoiceChunkPlanner — protection', () => {
  it('does not split a decimal number', () => {
    const h = planner();
    h.p.push('المبلغ المستحق هو 1,250.50 ريال سعودي فقط اليوم.');
    h.p.finish();
    expect(h.texts().join(' ')).toContain('1,250.50');
  });

  it('does not split structured output', () => {
    const h = planner();
    h.p.push('النتيجة {"amount": 500} والتفاصيل موجودة هنا الآن.');
    h.p.finish();
    expect(h.texts().join(' ')).toContain('500');
  });

  it('cancels cleanly', () => {
    const h = planner();
    h.p.push('أكيد أقدر أساعدك في ');
    const before = h.chunks.length;
    h.p.cancel();
    h.p.push('معرفة تفاصيل حسابك بالكامل.');
    h.p.finish();
    h.clock.advance(1000);
    expect(h.chunks).toHaveLength(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

/* ========================================================================== */
/* Regressions taken from a real recorded call                                */
/* ========================================================================== */

describe('phrase boundaries observed failing on a live call', () => {
  it('never ends a phrase on a Gulf interrogative', () => {
    // Heard twice in one call: "تفضل وش" was synthesised, then "تحتاج؟" arrived
    // as a separate request, so the caller heard the question snapped in half.
    // The production prompt mandates Saudi dialect, so these are exactly the
    // words the model produces.
    for (const w of ['وش', 'ايش', 'إيش', 'شلون', 'ليش', 'وين', 'كيف', 'كم', 'هل', 'مين']) {
      expect(endsOnFunctionWord(`تفضل ${w}`), w).toBe(true);
    }
  });

  it('still allows a phrase to end on a content word', () => {
    // The guard must not become so broad that nothing can ever be emitted.
    for (const s of ['تفضل وش تحتاج', 'أقدر أساعدك', 'بدل السكن']) {
      expect(endsOnFunctionWord(s), s).toBe(false);
    }
  });

  it('detects an unclosed quotation so a phrase is not cut inside one', () => {
    // Observed: one phrase ended `بـ"انتقلت أعمال من...` and the next began
    // `"؟ هل تقصد` — the closing quote was spoken as a stray sound.
    expect(hasOpenQuote('تقصد بـ"انتقلت أعمال من')).toBe(true);
    expect(hasOpenQuote('تقصد بـ"انتقلت أعمال من"؟')).toBe(false);
    expect(hasOpenQuote('نص عادي بدون اقتباس')).toBe(false);
  });

  it('does not treat the Arabic comma as an opening bracket', () => {
    // It is U+060C, adjacent in the tables to real punctuation. Treating it as
    // an opener made EVERY comma-bearing phrase look unbalanced, which silently
    // disabled the natural-cut preference altogether.
    expect(hasOpenQuote('أكيد، أقدر أساعدك')).toBe(false);
  });
});

describe('Mode C configuration', () => {
  it('ships the documented Vapi timing profile as the default preset', () => {
    const e = defaultModeCConfig().endpointing;
    expect(e.waitSeconds).toBe(0.4);
    expect(e.onPunctuationSeconds).toBe(0.1);
    expect(e.onNoPunctuationSeconds).toBe(1.5);
    expect(e.onNumberSeconds).toBe(0.5);
  });

  it('keeps perceived-latency and speculation OFF by default', () => {
    const c = defaultModeCConfig();
    // Both flatter the numbers; a baseline must never enable them silently.
    expect(c.perceivedLatency.enabled).toBe(false);
    expect(c.preemptiveLlm.enabled).toBe(false);
    expect(c.ttsCache.enabled).toBe(false);
  });

  it('offers a VAD-only control preset that disables the smart path', () => {
    const preset = MODE_C_PRESETS.find((p) => p.id === 'vad_baseline')!;
    const applied = preset.apply(defaultModeCConfig());
    expect(applied.endpointing.strategy).toBe('vad_silence');
    expect(applied.rag.strategy).toBe('serial');
  });

  it('clamps out-of-range values', () => {
    const c = defaultModeCConfig();
    c.endpointing.waitSeconds = 99;
    c.chunkPlan.first.minCharacters = 0;
    c.transport.jitterBufferMs = -5;
    clampModeCConfig(c);
    expect(c.endpointing.waitSeconds).toBeLessThanOrEqual(3);
    expect(c.chunkPlan.first.minCharacters).toBeGreaterThanOrEqual(1);
    expect(c.transport.jitterBufferMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps preferred >= minimum after clamping', () => {
    const c = defaultModeCConfig();
    c.chunkPlan.first.minCharacters = 100;
    c.chunkPlan.first.preferredCharacters = 10;
    clampModeCConfig(c);
    expect(c.chunkPlan.first.preferredCharacters).toBeGreaterThanOrEqual(c.chunkPlan.first.minCharacters);
  });
});
