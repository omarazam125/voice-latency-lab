/**
 * High-resolution monotonic clock, isomorphic across Node and the browser.
 *
 * Everything in this application is measured in MONOTONIC NANOSECONDS.
 * `Date.now()` is deliberately never used for latency math: it is subject to
 * NTP steps, leap-second smearing and VM clock drift, any of which can
 * silently produce negative or wildly wrong durations in a benchmark.
 *
 *   Node    -> process.hrtime.bigint()          (nanoseconds, monotonic)
 *   Browser -> performance.now()                (microsecond resolution, monotonic)
 *
 * Wall-clock time is still recorded, but ONLY as a human-readable annotation
 * (`wallEpochMs`); it never participates in a duration calculation.
 */

const NS_PER_MS = 1_000_000n;
export const NS_PER_MS_NUM = 1_000_000;

type NowFn = () => bigint;

function detectNow(): NowFn {
  const g = globalThis as any;
  if (typeof g.process?.hrtime?.bigint === 'function') {
    const hr = g.process.hrtime.bigint.bind(g.process.hrtime);
    return () => hr() as bigint;
  }
  if (typeof g.performance?.now === 'function') {
    const perf = g.performance;
    return () => BigInt(Math.round(perf.now() * 1e6));
  }
  // Last-resort fallback. Not monotonic; flagged loudly by `isMonotonic`.
  return () => BigInt(Date.now()) * NS_PER_MS;
}

const nowImpl = detectNow();

export const isMonotonic: boolean = (() => {
  const g = globalThis as any;
  return typeof g.process?.hrtime?.bigint === 'function' || typeof g.performance?.now === 'function';
})();

/** Current monotonic time in nanoseconds. This is THE clock for all measurements. */
export function nowNs(): bigint {
  return nowImpl();
}

/** Current monotonic time in fractional milliseconds (convenience for UI). */
export function nowMs(): number {
  return Number(nowImpl()) / NS_PER_MS_NUM;
}

/** Convert a nanosecond duration/instant to fractional milliseconds. */
export function nsToMs(ns: bigint | number): number {
  return typeof ns === 'bigint' ? Number(ns) / NS_PER_MS_NUM : ns / NS_PER_MS_NUM;
}

/** Convert fractional milliseconds to nanoseconds. */
export function msToNs(ms: number): bigint {
  return BigInt(Math.round(ms * NS_PER_MS_NUM));
}

/** Difference between two monotonic instants, expressed in fractional ms. */
export function deltaMs(startNs: bigint, endNs: bigint): number {
  return Number(endNs - startNs) / NS_PER_MS_NUM;
}

/** Round to a sane number of decimals for display / export. */
export function roundMs(ms: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(ms * f) / f;
}

/**
 * Anchor relating this process's monotonic clock to wall time. Captured once at
 * module load. Used exclusively for display / export annotation.
 */
export const EPOCH_ANCHOR = Object.freeze({
  wallEpochMs: Date.now(),
  monoNs: nowImpl(),
});

/** Best-effort wall-clock timestamp for a monotonic instant (display only). */
export function toWallMs(ns: bigint): number {
  return EPOCH_ANCHOR.wallEpochMs + Number(ns - EPOCH_ANCHOR.monoNs) / NS_PER_MS_NUM;
}

export function toIso(ns: bigint): string {
  return new Date(toWallMs(ns)).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Cross-process clock synchronisation                                         */
/* -------------------------------------------------------------------------- */

/**
 * The browser and the server each have their own monotonic epoch, so their
 * nanosecond values are NOT directly comparable. Measuring
 * `audio_delivery_latency = browser_first_audio - server_first_audio` therefore
 * requires an explicit offset estimate.
 *
 * We use Cristian's algorithm with min-RTT filtering, the standard approach for
 * one-way-delay estimation over a roughly symmetric transport:
 *
 *   t0 = client monotonic at send
 *   t1 = server monotonic at receipt
 *   t2 = client monotonic at reply receipt
 *
 *   rtt    = t2 - t0
 *   offset = t1 - (t0 + t2) / 2          (server_ns - client_ns)
 *
 * The sample with the SMALLEST rtt is least contaminated by queueing delay, so
 * it yields the best offset estimate. `uncertaintyNs = minRtt / 2` is the honest
 * error bar, and the UI displays it rather than pretending the conversion is
 * exact. On loopback (the normal case for this tool) it is typically well under
 * a millisecond.
 */
export interface ClockSyncSample {
  t0: bigint;
  t1: bigint;
  t2: bigint;
  rttNs: bigint;
  offsetNs: bigint;
}

export interface ClockSyncResult {
  /** Add this to a CLIENT monotonic ns value to obtain a SERVER monotonic ns value. */
  offsetNs: bigint;
  /** Half the best round-trip time: the irreducible uncertainty of the estimate. */
  uncertaintyNs: bigint;
  minRttNs: bigint;
  medianRttNs: bigint;
  samples: number;
}

export class ClockSynchronizer {
  private samples: ClockSyncSample[] = [];
  private result: ClockSyncResult | null = null;

  constructor(private readonly keep = 32) {}

  addSample(t0: bigint, t1: bigint, t2: bigint): void {
    const rttNs = t2 - t0;
    if (rttNs < 0n) return; // nonsensical; drop
    const offsetNs = t1 - (t0 + t2) / 2n;
    this.samples.push({ t0, t1, t2, rttNs, offsetNs });
    if (this.samples.length > this.keep) this.samples.shift();
    this.recompute();
  }

  private recompute(): void {
    if (this.samples.length === 0) {
      this.result = null;
      return;
    }
    let best = this.samples[0];
    for (const s of this.samples) if (s.rttNs < best.rttNs) best = s;

    const sorted = [...this.samples].sort((a, b) => (a.rttNs < b.rttNs ? -1 : a.rttNs > b.rttNs ? 1 : 0));
    const median = sorted[Math.floor(sorted.length / 2)];

    this.result = {
      offsetNs: best.offsetNs,
      uncertaintyNs: best.rttNs / 2n,
      minRttNs: best.rttNs,
      medianRttNs: median.rttNs,
      samples: this.samples.length,
    };
  }

  get(): ClockSyncResult | null {
    return this.result;
  }

  get ready(): boolean {
    return this.samples.length >= 3;
  }

  /** Convert a client monotonic ns instant into the server monotonic timebase. */
  clientToServer(clientNs: bigint): bigint {
    return clientNs + (this.result?.offsetNs ?? 0n);
  }

  /** Convert a server monotonic ns instant into the client monotonic timebase. */
  serverToClient(serverNs: bigint): bigint {
    return serverNs - (this.result?.offsetNs ?? 0n);
  }

  reset(): void {
    this.samples = [];
    this.result = null;
  }

  toJSON() {
    const r = this.result;
    return r
      ? {
          offsetMs: roundMs(nsToMs(r.offsetNs), 3),
          uncertaintyMs: roundMs(nsToMs(r.uncertaintyNs), 3),
          minRttMs: roundMs(nsToMs(r.minRttNs), 3),
          medianRttMs: roundMs(nsToMs(r.medianRttNs), 3),
          samples: r.samples,
        }
      : null;
  }
}
