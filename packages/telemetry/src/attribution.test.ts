import { describe, expect, it } from 'vitest';
import { attributeLatency, buildVapiPerformanceModel, detectGaps, significantGaps } from './attribution.js';
import type { EventName, TelemetryEvent } from './events.js';

const NS = (ms: number) => BigInt(Math.round(ms * 1e6));

/** Build a synthetic turn from (event, msAfterSpeechEnd) pairs. */
function buildTurn(pairs: Array<[EventName, number, Record<string, unknown>?]>): TelemetryEvent[] {
  const base = 1_000_000_000_000n;
  let seq = 0;
  return pairs.map(([event, at, metadata]) => ({
    seq: ++seq,
    traceId: 'trace',
    sessionId: 'sess',
    turnId: 'turn1',
    pipelineMode: 'C' as const,
    stage: event.split('.')[0] as any,
    event,
    timestampNs: base + NS(at),
    elapsedFromSpeechEndMs: at,
    elapsedFromEndpointMs: null,
    metadata: metadata ?? {},
  }));
}

/* -------------------------------------------------------------------------- */

describe('latency attribution', () => {
  // A turn where the model was reasonably fast but our own buffering was slow:
  // exactly the case where blaming the provider would be wrong.
  const OUR_FAULT: Array<[EventName, number]> = [
    ['vad.speech_ended', 0],
    ['turn.endpoint_detected', 300],
    ['stt.usable_transcript', 400],
    ['rag.completed', 900], // 500 ms of blocking retrieval
    ['llm.request_started', 910],
    ['llm.first_delta', 1760], // 850 ms TTFT — respectable
    ['chunker.first_phrase_ready', 4000], // 2,240 ms of sentence buffering
    ['tts.request_started', 4010],
    ['tts.first_audio', 4310],
    ['audio.first_sent', 4320],
    ['audio.browser_first_received', 4370],
    ['audio.playback_started', 4500],
  ];

  it('splits provider time from our own orchestration', () => {
    const a = attributeLatency(buildTurn(OUR_FAULT));
    expect(a.totalMs).toBeCloseTo(4500, 0);
    // provider = STT 100 + RAG 500 + LLM 850 + TTS 300
    expect(a.providerMs).toBeCloseTo(1750, 0);
    // ours = endpointing 300 + orchestration 10 + buffering 2240 + dispatch 10
    //        + relay 10 + network 50 + playback 130
    expect(a.oursMs).toBeCloseTo(2750, 0);
    // Nothing may be unexplained: the two must sum to the measured total.
    expect(a.providerMs + a.oursMs).toBeCloseTo(a.totalMs, 0);
  });

  it('names text buffering as the largest contributor, not the model', () => {
    const a = attributeLatency(buildTurn(OUR_FAULT));
    expect(a.largest?.key).toBe('text_buffering');
    expect(a.largest?.owner).toBe('ours');
    expect(a.verdict).toContain('ours to fix');
  });

  it('says so plainly when the provider really is the bottleneck', () => {
    const a = attributeLatency(
      buildTurn([
        ['vad.speech_ended', 0],
        ['turn.endpoint_detected', 300],
        ['stt.usable_transcript', 360],
        ['rag.completed', 380],
        ['llm.request_started', 390],
        ['llm.first_delta', 2820], // 2,430 ms TTFT
        ['chunker.first_phrase_ready', 2900],
        ['tts.request_started', 2910],
        ['tts.first_audio', 3200],
        ['audio.first_sent', 3210],
        ['audio.browser_first_received', 3250],
        ['audio.playback_started', 3330],
      ]),
    );
    expect(a.largest?.key).toBe('llm');
    expect(a.largest?.owner).toBe('provider');
    expect(a.providerMs).toBeGreaterThan(a.oursMs);
    expect(a.verdict).toContain('provider or model change');
  });

  it('assigns zero to a stage that finished before it was needed', () => {
    const a = attributeLatency(
      buildTurn([
        ['vad.speech_ended', 0],
        ['rag.completed', -500], // prefetched while the caller was still talking
        ['turn.endpoint_detected', 300],
        ['stt.usable_transcript', 360],
        ['llm.request_started', 370],
        ['llm.first_delta', 900],
        ['chunker.first_phrase_ready', 980],
        ['tts.request_started', 990],
        ['tts.first_audio', 1250],
        ['audio.first_sent', 1260],
        ['audio.browser_first_received', 1300],
        ['audio.playback_started', 1380],
      ]),
    );
    expect(a.entries.find((e) => e.key === 'rag')).toBeUndefined();
    expect(a.providerMs + a.oursMs).toBeCloseTo(a.totalMs, 0);
  });

  it('reports nothing rather than guessing when events are missing', () => {
    const a = attributeLatency(buildTurn([['vad.speech_ended', 0]]));
    expect(a.totalMs).toBe(0);
    expect(a.entries).toHaveLength(0);
    expect(a.verdict).toContain('Not enough events');
  });
});

describe('gap detection', () => {
  it('flags the LLM-to-TTS buffering gap as critical', () => {
    const gaps = detectGaps(
      buildTurn([
        ['vad.speech_ended', 0],
        ['turn.endpoint_detected', 300],
        ['stt.usable_transcript', 400],
        ['llm.request_started', 410],
        ['llm.first_delta', 1400],
        ['tts.request_started', 2600], // 1,200 ms holding usable text
        ['tts.first_audio', 2900],
      ]),
    );
    const g = gaps.find((x) => x.key === 'llm_to_tts')!;
    expect(g.durationMs).toBeCloseTo(1200, 0);
    expect(g.severity).toBe('critical');
    expect(g.owner).toBe('ours');
    expect(g.suggestion).toContain('chunk planner');
  });

  it('does not flag a healthy pipeline', () => {
    const gaps = detectGaps(
      buildTurn([
        ['vad.speech_ended', 0],
        ['turn.endpoint_detected', 200],
        ['stt.usable_transcript', 260],
        ['llm.request_started', 275],
        ['llm.first_delta', 700],
        ['tts.request_started', 760],
        ['tts.first_audio', 990],
        ['audio.first_sent', 1000],
        ['audio.browser_first_received', 1020],
        ['audio.playback_started', 1080],
      ]),
    );
    expect(significantGaps(gaps)).toHaveLength(0);
  });

  it('sorts the largest gap first', () => {
    const gaps = detectGaps(
      buildTurn([
        ['vad.speech_ended', 0],
        ['turn.endpoint_detected', 300],
        ['stt.usable_transcript', 1500],
        ['llm.request_started', 1510],
        ['llm.first_delta', 2000],
        ['tts.request_started', 2050],
        ['tts.first_audio', 2300],
      ]),
    );
    expect(gaps.length).toBeGreaterThan(1);
    expect(gaps[0].durationMs).toBeGreaterThanOrEqual(gaps[1].durationMs);
  });

  it('ignores out-of-order events from speculation rather than reporting a negative gap', () => {
    const gaps = detectGaps(
      buildTurn([
        ['vad.speech_ended', 0],
        ['llm.request_started', 100], // speculative: started before the endpoint
        ['turn.endpoint_detected', 300],
        ['stt.usable_transcript', 360],
        ['llm.first_delta', 900],
      ]),
    );
    for (const g of gaps) expect(g.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Vapi performance model', () => {
  it('keeps modelLatency as TTFT, never total generation', () => {
    const m = buildVapiPerformanceModel(
      buildTurn([
        ['vad.speech_started', -2000],
        ['stt.first_audio_sent', -1990],
        ['vad.speech_ended', 0],
        ['turn.endpoint_detected', 300],
        ['stt.usable_transcript', 380],
        ['rag.started', 385],
        ['rag.completed', 430],
        ['llm.request_started', 440],
        ['llm.first_delta', 1290], // TTFT 850
        ['llm.completed', 3800], // completion 3360 — must NOT be modelLatency
        ['tts.request_started', 1380],
        ['tts.first_audio', 1650],
        ['audio.first_sent', 1660],
        ['audio.playback_started', 1780],
      ]),
    );
    // The distinction the whole performance model exists to enforce.
    expect(m.modelLatency).toBeCloseTo(850, 0);
    expect(m.modelCompletionLatency).toBeCloseTo(3360, 0);
    expect(m.modelLatency).not.toBe(m.modelCompletionLatency);

    expect(m.endpointingLatency).toBeCloseTo(300, 0);
    expect(m.transcriberLatency).toBeCloseTo(80, 0);
    expect(m.ragLatency).toBeCloseTo(45, 0);
    expect(m.llmToVoiceLatency).toBeCloseTo(90, 0);
    expect(m.voiceLatency).toBeCloseTo(270, 0);
    expect(m.turnLatency).toBeCloseTo(1480, 0);
    expect(m.trueVoiceToVoiceLatency).toBeCloseTo(1780, 0);
  });

  it('returns null rather than zero for unobserved stages', () => {
    const m = buildVapiPerformanceModel(buildTurn([['vad.speech_ended', 0]]));
    expect(m.modelLatency).toBeNull();
    expect(m.voiceLatency).toBeNull();
    expect(m.trueVoiceToVoiceLatency).toBeNull();
  });
});
