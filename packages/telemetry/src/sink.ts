/**
 * Asynchronous NDJSON persistence sink.
 *
 * Spec section 29 forbids synchronous analytics writes on the realtime path, so
 * this sink:
 *   - accepts batches handed over by the bus flush timer (never by `emit`)
 *   - serialises on a macrotask, not inline
 *   - keeps at most one write in flight and coalesces the rest
 *   - drops the oldest pending records rather than growing without bound
 *
 * If disk falls behind, telemetry is lost -- deliberately. Audio is not.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TelemetryEvent } from './events.js';
import { toWire } from './events.js';

export interface NdjsonSinkOptions {
  filePath: string;
  maxPending?: number;
  flushIntervalMs?: number;
}

export class NdjsonSink {
  private pending: TelemetryEvent[] = [];
  private writing = false;
  private ready: Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private droppedTotal = 0;
  private writtenTotal = 0;
  private readonly maxPending: number;

  constructor(private readonly opts: NdjsonSinkOptions) {
    this.maxPending = opts.maxPending ?? 20_000;
    this.ready = mkdir(dirname(opts.filePath), { recursive: true }).then(() => undefined);
    this.timer = setInterval(() => void this.drain(), opts.flushIntervalMs ?? 250);
    (this.timer as any).unref?.();
  }

  /** Bus sink entry point. Must return immediately. */
  readonly accept = (events: TelemetryEvent[]): void => {
    const overflow = this.pending.length + events.length - this.maxPending;
    if (overflow > 0) {
      this.pending.splice(0, overflow);
      this.droppedTotal += overflow;
    }
    for (const e of events) this.pending.push(e);
  };

  private async drain(): Promise<void> {
    if (this.writing || this.pending.length === 0) return;
    this.writing = true;
    const batch = this.pending;
    this.pending = [];
    try {
      await this.ready;
      const lines = batch.map((e) => JSON.stringify(toWire(e))).join('\n') + '\n';
      await appendFile(this.opts.filePath, lines, 'utf8');
      this.writtenTotal += batch.length;
    } catch {
      // Persistence is best-effort by design; never surfaces into the pipeline.
      this.droppedTotal += batch.length;
    } finally {
      this.writing = false;
    }
  }

  stats() {
    return { written: this.writtenTotal, dropped: this.droppedTotal, pending: this.pending.length };
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drain();
  }
}
