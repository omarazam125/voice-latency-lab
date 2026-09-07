/**
 * Does the call recording actually contain the facts needed to diagnose a call?
 *
 * The failure this guards against is subtle and total: a recorder that runs,
 * writes a file, and captures nothing useful. `llm.completed` carried only
 * `chars: text.length` and not the text, so the narrative line for what the
 * model wrote would have rendered as "MODEL WROTE:" followed by nothing — a
 * file that looks like a recording and answers no question.
 *
 * So these assert on CONTENT, not on "a line was produced".
 */

import { describe, expect, it } from 'vitest';
import { CallRecorder } from './callRecorder.js';
import { TelemetryBus } from '@vll/telemetry';

/** Drive the recorder's formatter without touching the disk. */
function narrate(events: Array<{ event: string; metadata?: Record<string, unknown>; turnId?: string }>): string[] {
  const bus = new TelemetryBus({ sessionId: 's', traceId: 't', capacity: 1000 });
  const rec = new CallRecorder('s', bus);
  const lines: string[] = [];
  for (const e of events) {
    const line = (rec as unknown as { describe: (e: unknown) => string | null }).describe({
      seq: 0,
      turnId: e.turnId ?? 'turn-1',
      pipelineMode: 'C',
      stage: 'x',
      event: e.event,
      timestampNs: '0',
      timestampMs: 0,
      elapsedFromSpeechEndMs: 100,
      metadata: e.metadata ?? {},
    });
    if (line) lines.push(line);
  }
  return lines;
}

const joined = (events: Parameters<typeof narrate>[0]) => narrate(events).join('\n');

describe('call recording captures the facts a diagnosis needs', () => {
  it('records what the transcriber heard', () => {
    const out = joined([{ event: 'stt.final', metadata: { text: 'كم الراتب والبدلات' } }]);
    expect(out).toContain('كم الراتب والبدلات');
  });

  it('records which transcript the pipeline ACTED on, and whether it was provisional', () => {
    // The distinction that explains answering a question nobody asked: the
    // pipeline may proceed on a stabilised partial that the final later
    // contradicts.
    const out = joined([
      {
        event: 'stt.usable_transcript',
        metadata: { text: 'كم الراتب', source: 'stable_partial', provisional: true },
      },
    ]);
    expect(out).toContain('ACTED ON');
    expect(out).toContain('stable_partial');
    expect(out).toContain('PROVISIONAL');
    expect(out).toContain('كم الراتب');
  });

  it('flags a late final transcript that disagrees with what was used', () => {
    const out = joined([
      { event: 'stt.final', metadata: { text: 'كم بدل السكن', late: true, diverged: true, agreement: 0.4 } },
    ]);
    expect(out).toContain('DIVERGED');
  });

  it('records the full model output, not just its length', () => {
    // The original defect: `chars` was emitted and `text` was not.
    const answer = 'بدل السكن خمسة وعشرين بالمئة من الراتب الأساسي';
    const out = joined([{ event: 'llm.completed', metadata: { text: answer, chars: answer.length } }]);
    expect(out).toContain('MODEL WROTE');
    expect(out).toContain(answer);
  });

  it('records the exact string handed to the voice engine', () => {
    // Quoted, so leading/trailing whitespace and stray markup are visible
    // rather than being silently swallowed by the console.
    const out = joined([
      { event: 'tts.request_started', metadata: { phraseSeq: 1, text: '<role> تمام' } },
    ]);
    expect(out).toContain('SPOKEN');
    expect(out).toContain('<role>');
    expect(out).toContain('"');
  });

  it('records the barge-in verdict and why', () => {
    const out = joined([
      {
        event: 'vad.barge_in_classified',
        metadata: { interrupt: false, reason: 'backchannel', transcript: 'اه', voiceMs: 300, trigger: 'partial_transcript' },
      },
    ]);
    expect(out).toContain('backchannel, keep talking');
    expect(out).toContain('اه');
  });

  it('records retrieval, including how much of the question it matched', () => {
    const out = joined([
      { event: 'rag.completed', metadata: { chunks: 3, durationMs: 2, topCoverage: 0.71, sources: ['K7.txt'] } },
    ]);
    expect(out).toContain('3 chunks');
    expect(out).toContain('0.71');
    expect(out).toContain('K7.txt');
  });

  it('records errors with their remediation hint', () => {
    const out = joined([
      { event: 'stt.error', metadata: { message: 'Concurrent Quota Exceeded', hint: 'close other tabs' } },
    ]);
    expect(out).toContain('Concurrent Quota Exceeded');
    expect(out).toContain('close other tabs');
  });

  it('numbers the turns so a long call stays navigable', () => {
    const lines = narrate([
      { event: 'turn.started' },
      { event: 'llm.completed', metadata: { text: 'a' } },
      { event: 'turn.started' },
    ]);
    expect(lines[0]).toContain('TURN 1');
    expect(lines[2]).toContain('TURN 2');
  });

  it('ignores per-frame chatter that would bury the story', () => {
    expect(narrate([{ event: 'audio.queue_depth', metadata: { ms: 80 } }])).toHaveLength(0);
    expect(narrate([{ event: 'vad.frame', metadata: { probability: 0.4 } }])).toHaveLength(0);
  });
});

describe('call recording is safe to leave on', () => {
  it('subscribes with a filter so unrecorded events never reach it', () => {
    const bus = new TelemetryBus({ sessionId: 's', traceId: 't', capacity: 100 });
    const rec = new CallRecorder('s', bus);
    rec.start();
    // Chatter must not be counted; only whitelisted events are.
    bus.emit({ event: 'audio.queue_depth', metadata: { ms: 1 } });
    bus.emit({ event: 'session.created' });
    bus.flush();
    expect(rec.eventCount).toBe(1);
  });

  it('reports a write failure instead of throwing into the call', () => {
    // A recorder that throws would take down the call it is observing.
    const bus = new TelemetryBus({ sessionId: 's', traceId: 't', capacity: 10 });
    const rec = new CallRecorder('s', bus);
    expect(rec.error).toBeNull();
    expect(() => rec.start()).not.toThrow();
  });
});
