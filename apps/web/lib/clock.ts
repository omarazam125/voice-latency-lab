/**
 * Browser-side monotonic clock and server clock synchronisation.
 *
 * `performance.now()` is monotonic and microsecond-resolution, so it is the
 * browser's equivalent of `process.hrtime.bigint()`. Everything the client
 * timestamps uses it; nothing uses `Date.now()`.
 */

export const NS_PER_MS = 1_000_000;

/** Monotonic nanoseconds on the browser's own timebase. */
export function nowNs(): bigint {
  return BigInt(Math.round(performance.now() * NS_PER_MS));
}

export function nowMs(): number {
  return performance.now();
}

export function nsToMs(ns: bigint): number {
  return Number(ns) / NS_PER_MS;
}

/**
 * Convert an AudioContext `currentTime` instant into a performance.now()
 * -comparable wall instant.
 *
 * This is the NORMATIVE formula from the Web Audio specification's definition
 * of getOutputTimestamp(). `contextTime` there is the frame currently being
 * rendered BY THE OUTPUT DEVICE, so device output latency is already included
 * -- adding `outputLatency` on top would double-count it.
 */
export function audioTimeToPerformanceMs(ctx: AudioContext, contextTime: number): number {
  try {
    const ts = ctx.getOutputTimestamp();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.contextTime > 0) {
      return ts.performanceTime + (contextTime - ts.contextTime) * 1000;
    }
  } catch {
    /* fall through */
  }
  // Fallback for browsers where getOutputTimestamp is unavailable or has not
  // yet rendered a block. `currentTime` is the RENDER clock (ahead of playout),
  // so outputLatency must be added explicitly here.
  const outputLatency = (ctx as any).outputLatency ?? (ctx as any).baseLatency ?? 0;
  return performance.now() + (contextTime - ctx.currentTime + outputLatency) * 1000;
}

/** Same, expressed in the monotonic nanosecond units used on the wire. */
export function audioTimeToNs(ctx: AudioContext, contextTime: number): bigint {
  return BigInt(Math.round(audioTimeToPerformanceMs(ctx, contextTime) * NS_PER_MS));
}

/* -------------------------------------------------------------------------- */
/* Clock synchronisation                                                       */
/* -------------------------------------------------------------------------- */

export interface ClockEstimate {
  /** Add to a CLIENT ns value to obtain a SERVER ns value. */
  offsetNs: bigint;
  uncertaintyMs: number;
  minRttMs: number;
  samples: number;
}

/**
 * Cristian's algorithm with min-RTT filtering. The sample with the smallest
 * round trip is least contaminated by queueing delay, so it gives the best
 * offset estimate; half that RTT is the honest error bar, which the UI shows
 * rather than pretending the conversion is exact.
 */
export class ClockSync {
  private samples: Array<{ rttNs: bigint; offsetNs: bigint }> = [];
  private pending = new Map<number, bigint>();
  private nextId = 1;
  private estimate: ClockEstimate | null = null;

  constructor(private readonly keep = 32) {}

  /** Create a ping payload; remember t0 locally. */
  createPing(): { id: number; t0: string } {
    const id = this.nextId++;
    const t0 = nowNs();
    this.pending.set(id, t0);
    return { id, t0: t0.toString() };
  }

  /**
   * Handle the server's reply. Returns the full triple so the caller can send
   * it back, letting the SERVER build its own estimate for converting our
   * timestamps into its timebase.
   */
  handlePong(id: number, t0Str: string, t1Str: string): { t0: string; t1: string; t2: string } | null {
    const t0 = this.pending.get(id);
    this.pending.delete(id);
    if (t0 === undefined) return null;
    const t1 = BigInt(t1Str);
    const t2 = nowNs();
    const rttNs = t2 - t0;
    if (rttNs < 0n) return null;

    this.samples.push({ rttNs, offsetNs: t1 - (t0 + t2) / 2n });
    if (this.samples.length > this.keep) this.samples.shift();
    this.recompute();

    return { t0: t0Str, t1: t1Str, t2: t2.toString() };
  }

  private recompute(): void {
    if (this.samples.length === 0) return;
    let best = this.samples[0];
    for (const s of this.samples) if (s.rttNs < best.rttNs) best = s;
    this.estimate = {
      offsetNs: best.offsetNs,
      uncertaintyMs: Number(best.rttNs / 2n) / NS_PER_MS,
      minRttMs: Number(best.rttNs) / NS_PER_MS,
      samples: this.samples.length,
    };
  }

  get(): ClockEstimate | null {
    return this.estimate;
  }

  get ready(): boolean {
    return this.samples.length >= 3;
  }

  reset(): void {
    this.samples = [];
    this.pending.clear();
    this.estimate = null;
  }
}
