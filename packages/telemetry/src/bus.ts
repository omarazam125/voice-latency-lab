/**
 * In-memory telemetry bus.
 *
 * DESIGN CONSTRAINT (spec section 29): nothing on this path may block the
 * realtime audio pipeline. Therefore `emit()` performs only:
 *
 *   - one bigint clock read
 *   - two O(1) array writes (ring buffer + per-turn index)
 *   - N O(1) pushes into bounded subscriber outboxes
 *
 * No JSON serialisation, no I/O, no `await`, no database. Serialisation happens
 * later on a timer, in the flush path, off the critical section. Persistence is
 * a separate opt-in sink that batches writes.
 */

import { nowNs, deltaMs } from './clock.js';
import {
  type EventMetadata,
  type EventName,
  type PipelineMode,
  type TelemetryEvent,
  type WireEvent,
  isHighFrequency,
  stageOf,
  toWire,
} from './events.js';

export interface EmitInput {
  event: EventName;
  turnId?: string | null;
  pipelineMode?: PipelineMode | null;
  metadata?: EventMetadata;
  /**
   * Override the timestamp. Used for browser-originated events, which arrive
   * late but must be recorded at the instant they actually occurred (after
   * conversion into the server timebase).
   */
  timestampNs?: bigint;
  clientOriginated?: boolean;
  /** Override the trace id (used by isolated benchmarks). */
  traceId?: string;
}

export interface TurnAnchors {
  /** VAD-detected physical end of user speech. The zero point for the monitor. */
  speechEndNs: bigint | null;
  /** Instant the system *decided* the turn was over. */
  endpointNs: bigint | null;
}

export interface TelemetryBusOptions {
  sessionId: string;
  traceId: string;
  /** Ring-buffer capacity. Older events are evicted. */
  capacity?: number;
  /** Max events held per subscriber before the oldest are dropped. */
  subscriberQueueLimit?: number;
  /** Coalesce window for high-frequency events, in ms. 0 disables coalescing. */
  highFrequencyCoalesceMs?: number;
}

export type Unsubscribe = () => void;

interface Subscriber {
  outbox: TelemetryEvent[];
  dropped: number;
  deliver: (events: WireEvent[]) => void;
  filter?: (e: TelemetryEvent) => boolean;
}

export class TelemetryBus {
  readonly sessionId: string;
  readonly traceId: string;

  private readonly capacity: number;
  private readonly subscriberQueueLimit: number;
  private readonly hfCoalesceMs: number;

  private ring: TelemetryEvent[] = [];
  private ringStart = 0; // index of the oldest entry
  private ringCount = 0;
  private seq = 0;
  private evicted = 0;

  private byTurn = new Map<string, TelemetryEvent[]>();
  private anchors = new Map<string, TurnAnchors>();
  private subscribers = new Set<Subscriber>();
  private sinks = new Set<(events: TelemetryEvent[]) => void>();

  /** Last emit time per (turn, event) used for high-frequency coalescing. */
  private lastHf = new Map<string, bigint>();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pendingSink: TelemetryEvent[] = [];

  constructor(opts: TelemetryBusOptions) {
    this.sessionId = opts.sessionId;
    this.traceId = opts.traceId;
    this.capacity = opts.capacity ?? 50_000;
    this.subscriberQueueLimit = opts.subscriberQueueLimit ?? 4_000;
    this.hfCoalesceMs = opts.highFrequencyCoalesceMs ?? 0;
    this.ring = new Array(this.capacity);
  }

  /* ---------------------------------------------------------------------- */
  /* Anchors                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Records the physical speech-end instant for a turn. Every subsequent event
   * in that turn reports `elapsedFromSpeechEndMs` relative to this.
   */
  setSpeechEnd(turnId: string, ns: bigint): void {
    const a = this.anchorsFor(turnId);
    a.speechEndNs = ns;
    // Backfill: events already recorded for this turn (e.g. STT partials that
    // arrived before endpointing) get their elapsed values filled in so the
    // waterfall is complete rather than showing nulls before the anchor.
    const list = this.byTurn.get(turnId);
    if (list) for (const e of list) if (e.elapsedFromSpeechEndMs === null) e.elapsedFromSpeechEndMs = deltaMs(ns, e.timestampNs);
  }

  setEndpoint(turnId: string, ns: bigint): void {
    const a = this.anchorsFor(turnId);
    a.endpointNs = ns;
    const list = this.byTurn.get(turnId);
    if (list) for (const e of list) if (e.elapsedFromEndpointMs === null) e.elapsedFromEndpointMs = deltaMs(ns, e.timestampNs);
  }

  getAnchors(turnId: string): TurnAnchors {
    return this.anchorsFor(turnId);
  }

  private anchorsFor(turnId: string): TurnAnchors {
    let a = this.anchors.get(turnId);
    if (!a) {
      a = { speechEndNs: null, endpointNs: null };
      this.anchors.set(turnId, a);
    }
    return a;
  }

  /* ---------------------------------------------------------------------- */
  /* Emit -- the hot path                                                    */
  /* ---------------------------------------------------------------------- */

  emit(input: EmitInput): TelemetryEvent | null {
    const ts = input.timestampNs ?? nowNs();
    const turnId = input.turnId ?? null;

    // Coalesce chatty events so the monitor stays readable and the ring buffer
    // is not dominated by per-frame noise. Never coalesces milestones.
    if (this.hfCoalesceMs > 0 && isHighFrequency(input.event)) {
      const key = `${turnId ?? '-'}::${input.event}`;
      const last = this.lastHf.get(key);
      if (last !== undefined && deltaMs(last, ts) < this.hfCoalesceMs) return null;
      this.lastHf.set(key, ts);
    }

    const anchors = turnId ? this.anchors.get(turnId) : undefined;

    const e: TelemetryEvent = {
      seq: ++this.seq,
      traceId: input.traceId ?? this.traceId,
      sessionId: this.sessionId,
      turnId,
      pipelineMode: input.pipelineMode ?? null,
      stage: stageOf(input.event),
      event: input.event,
      timestampNs: ts,
      elapsedFromSpeechEndMs: anchors?.speechEndNs != null ? deltaMs(anchors.speechEndNs, ts) : null,
      elapsedFromEndpointMs: anchors?.endpointNs != null ? deltaMs(anchors.endpointNs, ts) : null,
      metadata: input.metadata ?? {},
    };
    if (input.clientOriginated) e.clientOriginated = true;

    this.push(e);
    return e;
  }

  private push(e: TelemetryEvent): void {
    // Ring buffer write.
    const idx = (this.ringStart + this.ringCount) % this.capacity;
    if (this.ringCount === this.capacity) {
      const old = this.ring[this.ringStart];
      this.ringStart = (this.ringStart + 1) % this.capacity;
      this.evicted++;
      if (old?.turnId) {
        const l = this.byTurn.get(old.turnId);
        if (l && l[0] === old) l.shift();
      }
    } else {
      this.ringCount++;
    }
    this.ring[idx] = e;

    // Per-turn index.
    if (e.turnId) {
      let list = this.byTurn.get(e.turnId);
      if (!list) {
        list = [];
        this.byTurn.set(e.turnId, list);
      }
      list.push(e);
    }

    // Subscriber outboxes (bounded; oldest dropped under pressure).
    for (const sub of this.subscribers) {
      if (sub.filter && !sub.filter(e)) continue;
      if (sub.outbox.length >= this.subscriberQueueLimit) {
        sub.outbox.shift();
        sub.dropped++;
      }
      sub.outbox.push(e);
    }

    if (this.sinks.size > 0) this.pendingSink.push(e);
  }

  /* ---------------------------------------------------------------------- */
  /* Subscriptions                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Subscribe to the live event stream. `deliver` is invoked on the flush timer
   * with a batch of already-serialised events -- never synchronously from
   * `emit()`, so a slow consumer can never stall the pipeline.
   */
  subscribe(deliver: (events: WireEvent[]) => void, filter?: (e: TelemetryEvent) => boolean): Unsubscribe {
    const sub: Subscriber = { outbox: [], dropped: 0, deliver, filter };
    this.subscribers.add(sub);
    this.ensureTimer();
    return () => {
      this.subscribers.delete(sub);
      this.maybeStopTimer();
    };
  }

  /** Register an async persistence sink. Also driven by the flush timer. */
  addSink(sink: (events: TelemetryEvent[]) => void): Unsubscribe {
    this.sinks.add(sink);
    this.ensureTimer();
    return () => {
      this.sinks.delete(sink);
      this.maybeStopTimer();
    };
  }

  private ensureTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), 40);
    // Never hold the process open for telemetry.
    (this.flushTimer as any).unref?.();
  }

  private maybeStopTimer(): void {
    if (this.subscribers.size === 0 && this.sinks.size === 0 && this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Serialise and deliver everything queued. Safe to call manually in tests. */
  flush(): void {
    for (const sub of this.subscribers) {
      if (sub.outbox.length === 0) continue;
      const batch = sub.outbox;
      sub.outbox = [];
      const dropped = sub.dropped;
      sub.dropped = 0;
      try {
        const wire = batch.map(toWire);
        if (dropped > 0) {
          wire.unshift(
            toWire({
              seq: -1,
              traceId: this.traceId,
              sessionId: this.sessionId,
              turnId: null,
              pipelineMode: null,
              stage: 'pipeline',
              event: 'pipeline.backpressure',
              timestampNs: nowNs(),
              elapsedFromSpeechEndMs: null,
              elapsedFromEndpointMs: null,
              metadata: { where: 'telemetry_subscriber', dropped },
            }),
          );
        }
        sub.deliver(wire);
      } catch {
        // A broken subscriber must never take down the pipeline.
      }
    }

    if (this.pendingSink.length > 0 && this.sinks.size > 0) {
      const batch = this.pendingSink;
      this.pendingSink = [];
      for (const sink of this.sinks) {
        try {
          sink(batch);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  all(): TelemetryEvent[] {
    const out: TelemetryEvent[] = new Array(this.ringCount);
    for (let i = 0; i < this.ringCount; i++) out[i] = this.ring[(this.ringStart + i) % this.capacity];
    return out;
  }

  forTurn(turnId: string): TelemetryEvent[] {
    return this.byTurn.get(turnId) ?? [];
  }

  turnIds(): string[] {
    return [...this.byTurn.keys()];
  }

  /** First occurrence of an event within a turn. */
  first(turnId: string, event: EventName): TelemetryEvent | undefined {
    return this.byTurn.get(turnId)?.find((e) => e.event === event);
  }

  /** Last occurrence of an event within a turn. */
  last(turnId: string, event: EventName): TelemetryEvent | undefined {
    const list = this.byTurn.get(turnId);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].event === event) return list[i];
    return undefined;
  }

  count(turnId: string, event: EventName): number {
    let n = 0;
    for (const e of this.byTurn.get(turnId) ?? []) if (e.event === event) n++;
    return n;
  }

  stats() {
    return {
      buffered: this.ringCount,
      capacity: this.capacity,
      evicted: this.evicted,
      emitted: this.seq,
      turns: this.byTurn.size,
      subscribers: this.subscribers.size,
      sinks: this.sinks.size,
    };
  }

  /** Drop a turn's retained events (used when a session resets). */
  forgetTurn(turnId: string): void {
    this.byTurn.delete(turnId);
    this.anchors.delete(turnId);
  }

  dispose(): void {
    this.flush();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.subscribers.clear();
    this.sinks.clear();
    this.byTurn.clear();
    this.anchors.clear();
    this.lastHf.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Scoped emitter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A thin, allocation-light facade bound to one turn + pipeline mode, so call
 * sites read as `t.emit('llm.first_delta', { chars })` instead of repeating the
 * turn plumbing everywhere.
 */
export class ScopedEmitter {
  constructor(
    readonly bus: TelemetryBus,
    readonly turnId: string | null,
    readonly pipelineMode: PipelineMode | null,
    readonly traceId?: string,
  ) {}

  emit(event: EventName, metadata?: EventMetadata, timestampNs?: bigint): TelemetryEvent | null {
    return this.bus.emit({
      event,
      turnId: this.turnId,
      pipelineMode: this.pipelineMode,
      metadata,
      timestampNs,
      traceId: this.traceId,
    });
  }

  child(turnId: string | null, mode?: PipelineMode | null): ScopedEmitter {
    return new ScopedEmitter(this.bus, turnId, mode ?? this.pipelineMode, this.traceId);
  }
}
