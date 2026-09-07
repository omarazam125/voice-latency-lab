import { describe, expect, it } from 'vitest';
import { ClockSynchronizer, deltaMs, msToNs, nsToMs, nowNs, roundMs } from './clock.js';
import { TelemetryBus, ScopedEmitter } from './bus.js';
import type { PipelineMode } from './events.js';
import { deriveTurnMetrics, CRITICAL_PATH_KEYS, gradeSegment, gradeTtfs } from './derive.js';
import { improvementPct, percentile, summarize, summarizeBy } from './stats.js';
import type { EventName, TelemetryEvent } from './events.js';

/* -------------------------------------------------------------------------- */
/* Clock                                                                       */
/* -------------------------------------------------------------------------- */

describe('monotonic clock', () => {
  it('never goes backwards', () => {
    let prev = nowNs();
    for (let i = 0; i < 2000; i++) {
      const now = nowNs();
      expect(now >= prev).toBe(true);
      prev = now;
    }
  });

  it('converts between ns and ms losslessly enough for latency work', () => {
    expect(nsToMs(1_500_000n)).toBeCloseTo(1.5, 9);
    expect(msToNs(1.5)).toBe(1_500_000n);
    expect(nsToMs(msToNs(123.456))).toBeCloseTo(123.456, 6);
  });

  it('computes durations from bigint instants', () => {
    const a = 1_000_000_000n;
    const b = a + 1_234_567_000n;
    expect(deltaMs(a, b)).toBeCloseTo(1234.567, 6);
  });

  it('returns a negative duration rather than lying when order is reversed', () => {
    expect(deltaMs(2_000_000_000n, 1_000_000_000n)).toBeCloseTo(-1000, 6);
  });

  it('rounds for display without accumulating error', () => {
    expect(roundMs(1234.5678)).toBe(1234.57);
    expect(roundMs(1234.5678, 0)).toBe(1235);
  });
});

describe('clock synchronisation', () => {
  it('recovers a known offset from a symmetric round trip', () => {
    const sync = new ClockSynchronizer();
    // Server clock runs 5,000 ms ahead of the client. RTT 20 ms, symmetric.
    const OFFSET = 5_000_000_000n;
    for (let i = 0; i < 8; i++) {
      const t0 = BigInt(i) * 1_000_000_000n;
      const t1 = t0 + OFFSET + 10_000_000n; // +10 ms one-way
      const t2 = t0 + 20_000_000n; // 20 ms RTT
      sync.addSample(t0, t1, t2);
    }
    const r = sync.get()!;
    expect(nsToMs(r.offsetNs)).toBeCloseTo(5000, 3);
    expect(nsToMs(r.uncertaintyNs)).toBeCloseTo(10, 3);
  });

  it('prefers the sample with the smallest round trip', () => {
    const sync = new ClockSynchronizer();
    // A congested sample with a huge, asymmetric RTT would skew a naive average.
    sync.addSample(0n, 1_000_000_000n + 400_000_000n, 800_000_000n);
    // Then a clean one: RTT 2 ms, true offset exactly 1000 ms.
    sync.addSample(10_000_000_000n, 11_001_000_000n, 10_002_000_000n);
    const r = sync.get()!;
    expect(nsToMs(r.offsetNs)).toBeCloseTo(1000, 3);
    expect(nsToMs(r.minRttNs)).toBeCloseTo(2, 3);
  });

  it('round-trips a client instant into the server timebase', () => {
    const sync = new ClockSynchronizer();
    sync.addSample(0n, 1_000_000_000n, 0n);
    const clientNs = 500_000_000n;
    const serverNs = sync.clientToServer(clientNs);
    expect(sync.serverToClient(serverNs)).toBe(clientNs);
  });

  it('is a no-op conversion before any sample arrives', () => {
    const sync = new ClockSynchronizer();
    expect(sync.ready).toBe(false);
    expect(sync.clientToServer(123n)).toBe(123n);
  });

  it('ignores nonsensical negative round trips', () => {
    const sync = new ClockSynchronizer();
    sync.addSample(100n, 100n, 50n);
    expect(sync.get()).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Statistics                                                                  */
/* -------------------------------------------------------------------------- */

describe('summary statistics', () => {
  it('uses nearest-rank percentiles so every value is one that occurred', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 90)).toBe(90);
    // With n=10 the 95th percentile IS the maximum under nearest-rank; it must
    // not be an interpolated 95 that no turn ever produced.
    expect(percentile(v, 95)).toBe(100);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile(v, 0)).toBe(10);
  });

  it('summarises correctly', () => {
    const s = summarize([100, 200, 300, 400]);
    expect(s.count).toBe(4);
    expect(s.min).toBe(100);
    expect(s.max).toBe(400);
    expect(s.avg).toBe(250);
    expect(s.p50).toBe(200);
    expect(s.sum).toBe(1000);
    expect(s.stddev).toBeCloseTo(111.803, 2);
  });

  it('skips null, undefined and non-finite samples', () => {
    const s = summarizeBy([{ v: 10 }, { v: null }, { v: undefined }, { v: NaN }, { v: 30 }], (r) => r.v as number);
    expect(s.count).toBe(2);
    expect(s.avg).toBe(20);
  });

  it('returns an empty summary rather than NaN chaos for no data', () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(Number.isNaN(s.p50)).toBe(true);
  });

  it('computes improvement as positive-is-better', () => {
    expect(improvementPct(4000, 1500)).toBeCloseTo(62.5, 3);
    expect(improvementPct(1000, 1200)).toBeCloseTo(-20, 3);
  });
});

/* -------------------------------------------------------------------------- */
/* Bus                                                                         */
/* -------------------------------------------------------------------------- */

describe('telemetry bus', () => {
  const mkBus = () => new TelemetryBus({ sessionId: 'sess_test', traceId: 'trace_test', capacity: 100 });

  it('anchors elapsed time to the physical speech end', () => {
    const bus = mkBus();
    const t0 = 1_000_000_000n;
    bus.setSpeechEnd('turn1', t0);
    const e = bus.emit({ event: 'llm.first_delta', turnId: 'turn1', timestampNs: t0 + 500_000_000n })!;
    expect(e.elapsedFromSpeechEndMs).toBeCloseTo(500, 6);
  });

  it('backfills elapsed values for events recorded before the anchor existed', () => {
    const bus = mkBus();
    const t0 = 1_000_000_000n;
    // A partial transcript arrives while the user is still speaking.
    bus.emit({ event: 'stt.partial', turnId: 'turn1', timestampNs: t0 - 200_000_000n });
    expect(bus.forTurn('turn1')[0].elapsedFromSpeechEndMs).toBeNull();
    bus.setSpeechEnd('turn1', t0);
    expect(bus.forTurn('turn1')[0].elapsedFromSpeechEndMs).toBeCloseTo(-200, 6);
  });

  it('evicts oldest events when the ring buffer fills', () => {
    const bus = new TelemetryBus({ sessionId: 's', traceId: 't', capacity: 10 });
    for (let i = 0; i < 25; i++) bus.emit({ event: 'llm.delta' });
    expect(bus.all()).toHaveLength(10);
    expect(bus.stats().evicted).toBe(15);
    expect(bus.stats().emitted).toBe(25);
  });

  it('delivers to subscribers only on flush, never synchronously from emit', () => {
    const bus = mkBus();
    const batches: unknown[][] = [];
    bus.subscribe((evts) => batches.push(evts));
    bus.emit({ event: 'llm.first_delta' });
    bus.emit({ event: 'llm.delta' });
    // emit() must never call the subscriber: a slow consumer cannot stall audio.
    expect(batches).toHaveLength(0);
    bus.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    bus.dispose();
  });

  it('coalesces high-frequency events', () => {
    const bus = new TelemetryBus({ sessionId: 's', traceId: 't', highFrequencyCoalesceMs: 50 });
    const base = 1_000_000_000n;
    expect(bus.emit({ event: 'llm.delta', timestampNs: base })).not.toBeNull();
    expect(bus.emit({ event: 'llm.delta', timestampNs: base + 10_000_000n })).toBeNull();
    expect(bus.emit({ event: 'llm.delta', timestampNs: base + 60_000_000n })).not.toBeNull();
    // Milestones are never coalesced.
    expect(bus.emit({ event: 'llm.first_delta', timestampNs: base })).not.toBeNull();
    expect(bus.emit({ event: 'llm.first_delta', timestampNs: base + 1_000_000n })).not.toBeNull();
  });

  it('survives a throwing subscriber', () => {
    const bus = mkBus();
    bus.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    const good: unknown[][] = [];
    bus.subscribe((e) => good.push(e));
    bus.emit({ event: 'llm.delta' });
    expect(() => bus.flush()).not.toThrow();
    expect(good).toHaveLength(1);
    bus.dispose();
  });

  it('scopes emissions to a turn and mode', () => {
    const bus = mkBus();
    const e = new ScopedEmitter(bus, 'turn9', 'B');
    e.emit('llm.first_delta', { ttftMs: 400 });
    const ev = bus.forTurn('turn9')[0];
    expect(ev.pipelineMode).toBe('B');
    expect(ev.metadata.ttftMs).toBe(400);
    expect(ev.stage).toBe('llm');
  });
});

/* -------------------------------------------------------------------------- */
/* Derived metrics                                                             */
/* -------------------------------------------------------------------------- */

const NS = (ms: number) => BigInt(Math.round(ms * 1e6));

/** Build a synthetic turn from (event, msAfterSpeechEnd) pairs. */
function buildTurn(pairs: Array<[EventName, number, Record<string, unknown>?]>, mode: PipelineMode = 'B'): TelemetryEvent[] {
  const base = 1_000_000_000_000n;
  let seq = 0;
  return pairs.map(([event, at, metadata]) => ({
    seq: ++seq,
    traceId: 'trace',
    sessionId: 'sess',
    turnId: 'turn1',
    pipelineMode: mode,
    stage: event.split('.')[0] as any,
    event,
    timestampNs: base + NS(at),
    elapsedFromSpeechEndMs: at,
    elapsedFromEndpointMs: null,
    metadata: metadata ?? {},
  }));
}

describe('turn metric derivation', () => {
  const TURN: Array<[EventName, number, Record<string, unknown>?]> = [
    ['vad.speech_started', -2000],
    ['vad.speech_ended', 0],
    ['turn.endpoint_detected', 310, { endpointDetectionDelayMs: 310, silenceThresholdMs: 300 }],
    ['stt.usable_transcript', 355, { source: 'stable_partial' }],
    ['rag.completed', 390, { chunks: 3, durationMs: 35 }],
    ['llm.request_started', 430],
    ['llm.first_delta', 1030, { ttftMs: 600 }],
    ['chunker.first_phrase_ready', 1150, { text: 'وعليكم السلام، أكيد' }],
    ['tts.request_started', 1180, { phraseSeq: 1 }],
    ['tts.first_audio', 1390, { phraseSeq: 1 }],
    ['audio.first_sent', 1400],
    ['audio.browser_first_received', 1450],
    ['audio.playback_started', 1490],
    ['llm.completed', 1800, { chars: 84 }],
  ];

  it('computes the headline metrics from the specification example', () => {
    const m = deriveTurnMetrics(buildTurn(TURN))!;
    expect(m.endpointDetectionDelayMs).toBeCloseTo(310, 1);
    expect(m.ttfsMs).toBeCloseTo(1180, 1); // playback - endpoint
    expect(m.trueE2EFromPhysicalSpeechEndMs).toBeCloseTo(1490, 1); // playback - speech end
    expect(m.llmTtftMs).toBeCloseTo(600, 1);
    expect(m.llmToTtsBufferDelayMs).toBeCloseTo(120, 1);
    expect(m.textChunkingDelayMs).toBe(m.llmToTtsBufferDelayMs);
    expect(m.ttsTtfaMs).toBeCloseTo(210, 1);
    expect(m.audioDeliveryLatencyMs).toBeCloseTo(50, 1);
    expect(m.playbackScheduleMs).toBeCloseTo(40, 1);
    expect(m.serverRelayMs).toBeCloseTo(10, 1);
  });

  it('produces a critical path that sums EXACTLY to the end-to-end latency', () => {
    const m = deriveTurnMetrics(buildTurn(TURN))!;
    const sum = m.criticalPath.reduce((n, s) => n + s.durationMs, 0);
    expect(sum).toBeCloseTo(m.trueE2EFromPhysicalSpeechEndMs!, 1);
  });

  it('never produces a negative segment', () => {
    const m = deriveTurnMetrics(buildTurn(TURN))!;
    for (const s of m.criticalPath) expect(s.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('identifies the largest segment as the bottleneck', () => {
    const m = deriveTurnMetrics(buildTurn(TURN))!;
    expect(m.bottleneck).toBe('llm_ttft'); // 430 -> 1030 is the biggest slice
    expect(m.bottleneckMs).toBeCloseTo(600, 1);
  });

  it('attributes a sentence-buffered stall to the LLM buffer segment', () => {
    // The same LLM, but nothing is spoken until the sentence completes.
    const buffered = buildTurn(
      [
        ['vad.speech_ended', 0],
        ['turn.endpoint_detected', 310],
        ['stt.usable_transcript', 1050, { source: 'final' }],
        ['rag.completed', 1090],
        ['llm.request_started', 1100],
        ['llm.first_delta', 1700],
        ['chunker.first_phrase_ready', 4000], // waited for the full sentence
        ['tts.request_started', 4010],
        ['tts.first_audio', 4270],
        ['audio.first_sent', 4280],
        ['audio.browser_first_received', 4330],
        ['audio.playback_started', 4380],
      ],
      'B',
    );
    const m = deriveTurnMetrics(buffered)!;
    expect(m.bottleneck).toBe('llm_buffer');
    expect(m.llmToTtsBufferDelayMs).toBeCloseTo(2300, 1);
    const sum = m.criticalPath.reduce((n, s) => n + s.durationMs, 0);
    expect(sum).toBeCloseTo(m.trueE2EFromPhysicalSpeechEndMs!, 1);
  });

  it('reports a prefetched retrieval as contributing ZERO to the critical path', () => {
    const events = buildTurn([
      ['vad.speech_ended', 0],
      ['rag.prefetch_started', -800],
      ['rag.prefetch_completed', -700],
      ['turn.endpoint_detected', 310],
      ['stt.usable_transcript', 355],
      ['rag.prefetch_hit', 356],
      ['rag.completed', 356, { prefetched: true }],
      ['llm.request_started', 360],
      ['llm.first_delta', 900],
      ['chunker.first_phrase_ready', 1000],
      ['tts.request_started', 1010],
      ['tts.first_audio', 1200],
      ['audio.first_sent', 1210],
      ['audio.browser_first_received', 1250],
      ['audio.playback_started', 1290],
    ]);
    const m = deriveTurnMetrics(events)!;
    expect(m.ragPrefetchHit).toBe(true);
    expect(m.ragCriticalPathMs).toBeLessThanOrEqual(2);
    const ragSeg = m.criticalPath.find((s) => s.key === 'rag')!;
    expect(ragSeg.durationMs).toBeLessThanOrEqual(2);
  });

  it('marks a stage hidden when it finished before it was needed', () => {
    const events = buildTurn([
      ['vad.speech_ended', 0],
      ['turn.endpoint_detected', 300],
      ['stt.usable_transcript', 350],
      ['rag.completed', 100], // completed long before the transcript existed
      ['llm.request_started', 360],
      ['llm.first_delta', 800],
      ['chunker.first_phrase_ready', 900],
      ['tts.request_started', 910],
      ['tts.first_audio', 1100],
      ['audio.first_sent', 1110],
      ['audio.browser_first_received', 1150],
      ['audio.playback_started', 1190],
    ]);
    const m = deriveTurnMetrics(events)!;
    const rag = m.criticalPath.find((s) => s.key === 'rag')!;
    expect(rag.hidden).toBe(true);
    expect(rag.durationMs).toBe(0);
  });

  it('marks missing stages rather than inventing a duration', () => {
    const m = deriveTurnMetrics(
      buildTurn([
        ['vad.speech_ended', 0],
        ['turn.endpoint_detected', 300],
      ]),
    )!;
    expect(m.ttfsMs).toBeNull();
    expect(m.llmTtftMs).toBeNull();
    const missing = m.criticalPath.filter((s) => s.missing).map((s) => s.key);
    expect(missing).toContain('llm_ttft');
    expect(missing).toContain('playback');
  });

  it('covers every declared critical-path key', () => {
    const m = deriveTurnMetrics(buildTurn(TURN))!;
    expect(m.criticalPath.map((s) => s.key)).toEqual(CRITICAL_PATH_KEYS);
  });

  it('builds waterfall spans that may legitimately overlap', () => {
    const m = deriveTurnMetrics(buildTurn(TURN))!;
    const llm = m.spans.find((s) => s.key === 'llm')!;
    const tts = m.spans.find((s) => s.key === 'tts')!;
    // The point of Mode B: TTS starts while the LLM is still generating.
    expect(tts.startMs).toBeLessThan(llm.endMs);
  });

  it('flags a cancelled and barged-in turn', () => {
    const m = deriveTurnMetrics(
      buildTurn([
        ['vad.speech_ended', 0],
        ['turn.endpoint_detected', 300],
        ['vad.barge_in_detected', 900],
        ['turn.cancelled', 905],
      ]),
    )!;
    expect(m.cancelled).toBe(true);
    expect(m.bargedIn).toBe(true);
  });

  it('counts retries so they can never be hidden', () => {
    const m = deriveTurnMetrics(
      buildTurn([
        ['vad.speech_ended', 0],
        ['llm.retry', 100],
        ['llm.retry', 200],
        ['tts.retry', 300],
      ]),
    )!;
    expect(m.retries.llm).toBe(2);
    expect(m.retries.tts).toBe(1);
  });

  it('collects errors with their stage', () => {
    const m = deriveTurnMetrics(
      buildTurn([
        ['vad.speech_ended', 0],
        ['tts.error', 500, { message: 'Voice not owned by user' }],
      ]),
    )!;
    expect(m.errors).toHaveLength(1);
    expect(m.errors[0].stage).toBe('tts');
    expect(m.errors[0].message).toContain('Voice not owned');
  });

  it('returns null for an empty event list', () => {
    expect(deriveTurnMetrics([])).toBeNull();
  });

  it('falls back to the endpoint as origin when no VAD speech end exists', () => {
    const m = deriveTurnMetrics(
      buildTurn([
        ['turn.endpoint_detected', 0],
        ['audio.playback_started', 1200],
      ]),
    )!;
    expect(m.ttfsMs).toBeCloseTo(1200, 1);
    expect(m.trueE2EFromPhysicalSpeechEndMs).toBeNull();
  });
});

describe('budget grading', () => {
  it('grades segments against the documented targets', () => {
    expect(gradeSegment('llm_ttft', 400)).toBe('good');
    expect(gradeSegment('llm_ttft', 900)).toBe('warn');
    expect(gradeSegment('llm_ttft', 2000)).toBe('bad');
    expect(gradeSegment('unknown_key', 10)).toBe('unknown');
  });

  it('grades TTFS against the 1.5 / 2.5 / 3 second targets', () => {
    expect(gradeTtfs(1200)).toBe('good');
    expect(gradeTtfs(2000)).toBe('warn');
    expect(gradeTtfs(4800)).toBe('bad');
    expect(gradeTtfs(NaN)).toBe('unknown');
  });
});
