/**
 * Summary statistics for latency distributions.
 *
 * Percentiles use the NEAREST-RANK definition:
 *
 *     rank = ceil(p / 100 * n),  value = sorted[rank - 1]
 *
 * chosen deliberately over linear interpolation because a benchmark run here is
 * typically 10-100 turns. With n = 10, an interpolated "p95" is a synthetic
 * number that no turn actually produced; nearest-rank always reports a real
 * observed measurement, which is what an engineer diagnosing a pipeline wants.
 * `p95` of 10 samples is therefore the 10th-slowest -- i.e. the max -- and the
 * UI shows the sample count so that is not mistaken for precision.
 */

export interface Summary {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  stddev: number;
  /** Sum of all samples; handy for weighted roll-ups. */
  sum: number;
}

export const EMPTY_SUMMARY: Summary = Object.freeze({
  count: 0,
  min: NaN,
  max: NaN,
  avg: NaN,
  p50: NaN,
  p90: NaN,
  p95: NaN,
  p99: NaN,
  stddev: NaN,
  sum: 0,
});

/** Nearest-rank percentile over an ALREADY SORTED ascending array. */
export function percentileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[n - 1];
  const rank = Math.ceil((p / 100) * n);
  return sorted[Math.min(n, Math.max(1, rank)) - 1];
}

export function percentile(values: readonly number[], p: number): number {
  return percentileSorted([...values].filter(isUsable).sort(asc), p);
}

const asc = (a: number, b: number) => a - b;
const isUsable = (v: number): boolean => typeof v === 'number' && Number.isFinite(v);

export function summarize(values: readonly number[]): Summary {
  const clean = values.filter(isUsable);
  const n = clean.length;
  if (n === 0) return { ...EMPTY_SUMMARY };

  const sorted = [...clean].sort(asc);
  let sum = 0;
  for (const v of sorted) sum += v;
  const avg = sum / n;

  let sq = 0;
  for (const v of sorted) sq += (v - avg) ** 2;
  // Population standard deviation: we are describing the observed sample set,
  // not estimating a wider population.
  const stddev = Math.sqrt(sq / n);

  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    avg,
    p50: percentileSorted(sorted, 50),
    p90: percentileSorted(sorted, 90),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    stddev,
    sum,
  };
}

/** Summarise a numeric field across a list of records, skipping null/undefined. */
export function summarizeBy<T>(records: readonly T[], pick: (r: T) => number | null | undefined): Summary {
  const vals: number[] = [];
  for (const r of records) {
    const v = pick(r);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  return summarize(vals);
}

export function roundSummary(s: Summary, decimals = 1): Summary {
  const f = 10 ** decimals;
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * f) / f : v);
  return {
    count: s.count,
    min: r(s.min),
    max: r(s.max),
    avg: r(s.avg),
    p50: r(s.p50),
    p90: r(s.p90),
    p95: r(s.p95),
    p99: r(s.p99),
    stddev: r(s.stddev),
    sum: r(s.sum),
  };
}

/** Relative improvement of `b` over `a`, as a positive-is-better percentage. */
export function improvementPct(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return NaN;
  return ((a - b) / a) * 100;
}
