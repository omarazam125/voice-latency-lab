/**
 * Recording what actually happened on a call.
 *
 * WHY
 * ---
 * When an operator reports "the agent said something strange" or "it stalled",
 * nothing on disk can answer it. The server log holds only "session opened" and
 * "session closed"; `PERSIST_TELEMETRY` was declared in the environment config
 * and read by no code at all. Every fact needed to diagnose a bad turn —
 * what the transcriber heard, which candidate transcript the pipeline chose to
 * act on, what retrieval injected, what the model wrote, and the exact string
 * handed to the voice engine — existed only in memory and died with the socket.
 *
 * WHAT IT WRITES, per session, under data/calls/
 *   <sessionId>.ndjson   every recorded event, machine readable
 *   <sessionId>.txt      a turn-by-turn narrative meant to be read by a human
 *
 * The `.txt` is the one that matters in practice. A wrong answer has several
 * quite different causes that look identical from outside the system, and they
 * are only distinguishable when the transcript, the retrieved context, the
 * model output and the spoken string are lined up side by side.
 *
 * OFF THE MEASUREMENT PATH
 * ------------------------
 * This subscribes to the telemetry bus, which already batches deliveries on a
 * 40 ms timer, so nothing here runs inside `emit()`. Writes are additionally
 * buffered and flushed on their own timer: disk I/O must never land on the
 * thread that timestamps audio frames, or the recorder would corrupt the very
 * latency numbers it exists to explain.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TelemetryBus, WireEvent } from '@vll/telemetry';
import { serverConfig } from './env.js';

const FLUSH_MS = 500;
/** Stop growing a single call file without bound; a stuck session must not fill the disk. */
const MAX_EVENTS = 200_000;

/** Events worth keeping. Per-frame chatter is excluded: it would bury the story. */
const RECORDED = new Set<string>([
  'session.created',
  'session.ready',
  'session.config_updated',
  'turn.started',
  'turn.endpoint_detected',
  'turn.cancelled',
  'turn.completed',
  'vad.speech_started',
  'vad.speech_ended',
  'vad.barge_in_detected',
  'vad.barge_in_classified',
  'stt.first_partial',
  'stt.final',
  'stt.usable_transcript',
  'stt.error',
  'stt.disconnected',
  'rag.prefetch_started',
  'rag.completed',
  'rag.skipped',
  'rag.error',
  'llm.request_started',
  'llm.first_delta',
  'llm.completed',
  'llm.error',
  'chunker.first_phrase_ready',
  'chunker.phrase_ready',
  // The exact string handed to Hamsa. Without this, "the agent said something
  // strange" can never be traced past the model.
  'tts.request_started',
  'tts.first_audio',
  'tts.completed',
  'tts.error',
  'audio.playback_started',
  'audio.dropped_stale',
  'pipeline.backpressure',
]);

export class CallRecorder {
  private jsonl: string[] = [];
  private narrative: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private count = 0;
  private started = false;
  private turnCount = 0;
  private lastError: string | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly bus: TelemetryBus,
  ) {}

  get eventCount(): number {
    return this.count;
  }
  get files(): { ndjson: string; text: string } {
    const dir = join(serverConfig.dataDir, 'calls');
    return { ndjson: join(dir, `${this.sessionId}.ndjson`), text: join(dir, `${this.sessionId}.txt`) };
  }
  get error(): string | null {
    return this.lastError;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.narrative.push(
      `=== call ${this.sessionId} — started ${new Date().toISOString()} ===`,
      '',
    );
    this.unsubscribe = this.bus.subscribe(
      (events) => this.onEvents(events),
      (e) => RECORDED.has(e.event as string),
    );
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.narrative.push('', `=== call ended ${new Date().toISOString()} — ${this.count} events ===`);
    await this.flush();
  }

  private onEvents(events: WireEvent[]): void {
    if (this.count >= MAX_EVENTS) return;
    for (const e of events) {
      this.count++;
      this.jsonl.push(JSON.stringify(e));
      const line = this.describe(e);
      if (line) this.narrative.push(line);
    }
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
  }

  /** One human-readable line per event, or null to omit it from the narrative. */
  private describe(e: WireEvent): string | null {
    const m = (e.metadata ?? {}) as Record<string, any>;
    const at = e.elapsedFromSpeechEndMs;
    const t = at == null ? '        ' : `+${String(Math.round(at)).padStart(5)}ms`;
    const say = (s: string) => `${t}  ${s}`;
    const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

    switch (e.event) {
      case 'turn.started':
        this.turnCount++;
        return `\n---------- TURN ${this.turnCount} (${e.turnId ?? '?'}, mode ${e.pipelineMode ?? '?'}) ----------`;

      case 'vad.speech_ended':
        return say('caller stopped speaking');

      case 'turn.endpoint_detected':
        return say(
          `endpoint  [detection cost ${Math.round(m.endpointDetectionDelayMs ?? 0)}ms, source ${m.source ?? '?'}]`,
        );

      case 'stt.first_partial':
        return say(`heard (partial): ${text(m.text)}`);

      case 'stt.final':
        return say(
          `heard (FINAL${m.late ? ', late' : ''}): ${text(m.text)}` +
            (m.diverged ? `   <<< DIVERGED from what we acted on (agreement ${m.agreement})` : ''),
        );

      case 'stt.usable_transcript':
        // The single most important line in the file: what the pipeline
        // actually answered, which is not always what the caller said.
        return say(
          `ACTED ON [${m.source}${m.provisional ? ', PROVISIONAL' : ''}]: ${text(m.text)}`,
        );

      case 'rag.completed': {
        const n = m.chunks ?? m.hits ?? m.count;
        const cov = m.topCoverage ?? m.coverage;
        return say(
          `retrieval: ${n ?? '?'} chunks in ${Math.round(m.durationMs ?? 0)}ms` +
            (cov != null ? ` (top coverage ${cov})` : '') +
            (Array.isArray(m.sources) && m.sources.length ? `  from ${m.sources.join(', ')}` : ''),
        );
      }

      case 'rag.skipped':
        return say(`retrieval skipped (${m.reason ?? '?'})`);

      case 'llm.request_started':
        return say(
          `model request: ${m.model ?? '?'}, ~${m.estimatedInputTokens ?? m.inputTokens ?? '?'} input tokens` +
            (m.historyTurns != null ? `, ${m.historyTurns} history turns` : ''),
        );

      case 'llm.completed':
        return say(`MODEL WROTE: ${text(m.text)}`);

      case 'tts.request_started':
        // Compare this against MODEL WROTE above. A mismatch is the whole
        // explanation for "the agent said something strange".
        return say(`  -> SPOKEN [phrase ${m.phraseSeq}]: ${JSON.stringify(text(m.text))}`);

      case 'tts.first_audio':
        return m.cacheHit ? say(`  -> phrase ${m.phraseSeq} served from CACHE`) : null;

      case 'audio.playback_started':
        // The number the whole application exists to produce: not when we sent
        // audio, but when the caller's speaker actually rendered it.
        return say('CALLER HEARS AUDIO');

      case 'vad.barge_in_detected':
        return say(`barge-in detected (classified: ${m.classified})`);

      case 'vad.barge_in_classified':
        return say(
          `barge-in verdict: ${m.interrupt ? 'INTERRUPT' : 'backchannel, keep talking'} ` +
            `("${text(m.transcript)}", ${m.reason}, voice ${Math.round(m.voiceMs ?? 0)}ms, via ${m.trigger})`,
        );

      case 'turn.cancelled':
        return say(`turn cancelled (${m.reason ?? '?'})`);

      case 'audio.dropped_stale':
        return say(`stale audio dropped (${m.reason ?? '?'}, ${m.bytes ?? '?'} bytes)`);

      case 'pipeline.backpressure':
        return say(`BACKPRESSURE at ${m.where ?? '?'}`);

      case 'stt.error':
      case 'llm.error':
      case 'tts.error':
      case 'rag.error':
        return say(`!! ${e.event}: ${text(m.message)} ${text(m.hint)}`);

      case 'stt.disconnected':
        return say(`STT disconnected (${text(m.reason) || text(m.code)})`);

      case 'session.config_updated':
        return say(`config changed: ${(m.keys ?? []).join(', ')}`);

      default:
        return null;
    }
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const rows = this.jsonl;
    const lines = this.narrative;
    if (rows.length === 0 && lines.length === 0) return;
    this.jsonl = [];
    this.narrative = [];

    try {
      const f = this.files;
      await mkdir(join(serverConfig.dataDir, 'calls'), { recursive: true });
      if (rows.length) await appendFile(f.ndjson, `${rows.join('\n')}\n`, 'utf8');
      if (lines.length) await appendFile(f.text, `${lines.join('\n')}\n`, 'utf8');
      this.lastError = null;
    } catch (err: any) {
      // A recorder that throws would take down the call it is observing. The
      // failure is remembered so it can be surfaced, and then dropped.
      this.lastError = err?.message ?? String(err);
    }
  }
}
