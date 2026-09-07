'use client';

import { useMemo, useState } from 'react';

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export function ms(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(2)} s`;
  return `${v.toFixed(digits)} ms`;
}

export function msRaw(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export const STAGE_COLORS: Record<string, string> = {
  mic: 'var(--stage-mic)',
  vad: 'var(--stage-vad)',
  turn: 'var(--stage-turn)',
  stt: 'var(--stage-stt)',
  rag: 'var(--stage-rag)',
  llm: 'var(--stage-llm)',
  chunker: 'var(--stage-chunker)',
  tts: 'var(--stage-tts)',
  audio: 'var(--stage-audio)',
  pipeline: 'var(--stage-pipeline)',
  session: 'var(--stage-pipeline)',
  bench: 'var(--stage-pipeline)',
};

export function stageColor(stage: string): string {
  return STAGE_COLORS[stage] ?? 'var(--fg-faint)';
}

/** Traffic-light grading against the engineering budget (spec section 26). */
const BUDGET: Record<string, { good: number; warn: number }> = {
  endpointing: { good: 350, warn: 500 },
  stt: { good: 150, warn: 400 },
  rag: { good: 100, warn: 300 },
  orchestration: { good: 20, warn: 60 },
  llm_ttft: { good: 500, warn: 1200 },
  llm_buffer: { good: 120, warn: 250 },
  tts_dispatch: { good: 15, warn: 50 },
  tts_ttfa: { good: 300, warn: 700 },
  server_relay: { good: 10, warn: 30 },
  network: { good: 60, warn: 250 },
  playback: { good: 120, warn: 250 },
};

export function grade(key: string, v: number | null): 'ok' | 'warn' | 'bad' | '' {
  const b = BUDGET[key];
  if (!b || v === null || !Number.isFinite(v)) return '';
  if (v <= b.good) return 'ok';
  if (v <= b.warn) return 'warn';
  return 'bad';
}

export function gradeTtfs(v: number | null): 'ok' | 'warn' | 'bad' | '' {
  if (v === null || !Number.isFinite(v)) return '';
  if (v <= 1500) return 'ok';
  if (v <= 2500) return 'warn';
  return 'bad';
}

/* -------------------------------------------------------------------------- */
/* Critical-path breakdown                                                     */
/* -------------------------------------------------------------------------- */

export interface Segment {
  key: string;
  label: string;
  stage: string;
  durationMs: number;
  hidden: boolean;
  missing: boolean;
  note?: string;
}

/**
 * "Where the time went". These segments are constructed to be NON-OVERLAPPING
 * and to sum exactly to the end-to-end latency, so the bars are an honest
 * decomposition rather than a set of independently-measured spans that happen
 * to be drawn together.
 */
export function Breakdown({
  segments,
  total,
  bottleneck,
}: {
  segments: Segment[];
  total: number | null;
  bottleneck?: string | null;
}) {
  const shown = segments.filter((s) => !s.missing);
  const max = Math.max(1, ...shown.map((s) => s.durationMs));
  const sum = shown.reduce((n, s) => n + s.durationMs, 0);

  return (
    <div>
      {shown.map((s) => {
        const g = grade(s.key, s.durationMs);
        const isBottleneck = bottleneck === s.key && s.durationMs > 0;
        return (
          <div
            key={s.key}
            className={`bd-row ${isBottleneck ? 'bottleneck' : ''} ${s.hidden ? 'hidden-seg' : ''}`}
            title={s.note ?? `${s.label}: ${s.durationMs.toFixed(1)} ms`}
          >
            <div className="bd-label">
              {s.label}
              {s.hidden && <span className="faint"> · hidden</span>}
            </div>
            <div className="bd-bar-wrap">
              <div
                className="bd-bar"
                style={{
                  width: `${(s.durationMs / max) * 100}%`,
                  background: isBottleneck ? 'var(--bad)' : g === 'bad' ? 'var(--warn)' : stageColor(s.stage),
                  opacity: s.durationMs === 0 ? 0.25 : 1,
                }}
              />
            </div>
            <div className="bd-val">
              {s.durationMs.toFixed(0)}
              {isBottleneck && ' ←'}
            </div>
          </div>
        );
      })}
      <div className="bd-row" style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <div className="bd-label" style={{ fontWeight: 600, color: 'var(--fg)' }}>
          Total
        </div>
        <div />
        <div className="bd-val" style={{ fontWeight: 700 }}>
          {(total ?? sum).toFixed(0)}
        </div>
      </div>
      {total !== null && Math.abs(total - sum) > 1.5 && (
        <p className="hint">
          Segments sum to {sum.toFixed(0)} ms against a measured total of {total.toFixed(0)} ms.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Waterfall / Gantt                                                           */
/* -------------------------------------------------------------------------- */

export interface Span {
  key: string;
  label: string;
  stage: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  children?: Array<{ key: string; label: string; startMs: number; endMs: number; durationMs: number; metadata?: any }>;
  metadata?: any;
}

/**
 * Spans here MAY overlap, and that is the point: overlap is the visual proof
 * that a streamed pipeline overlaps its stages rather than serialising them.
 */
export function Waterfall({ spans, originLabel = 'speech end' }: { spans: Span[]; originLabel?: string }) {
  const [hover, setHover] = useState<string | null>(null);

  const { min, max } = useMemo(() => {
    if (spans.length === 0) return { min: 0, max: 1000 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of spans) {
      lo = Math.min(lo, s.startMs);
      hi = Math.max(hi, s.endMs);
    }
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = lo + 1000;
    const pad = Math.max(40, (hi - lo) * 0.03);
    return { min: Math.min(0, lo) - pad * 0.2, max: hi + pad };
  }, [spans]);

  const range = Math.max(1, max - min);
  const pct = (v: number) => ((v - min) / range) * 100;

  const ticks = useMemo(() => {
    const targetCount = 8;
    const raw = range / targetCount;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? mag * 10;
    const out: number[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
    return out;
  }, [min, max, range]);

  if (spans.length === 0) return <div className="empty">No spans recorded for this turn.</div>;

  return (
    <div className="wf">
      {spans.map((s) => (
        <div className="wf-row" key={s.key}>
          <div className="wf-label">{s.label}</div>
          <div className="wf-track">
            <div className="wf-grid">
              {ticks.map((t) => (
                <div className="wf-gridline" key={t} style={{ left: `${pct(t)}%` }} />
              ))}
            </div>
            <div
              className="wf-bar"
              style={{
                left: `${pct(s.startMs)}%`,
                width: `${Math.max(0.4, ((s.endMs - s.startMs) / range) * 100)}%`,
                background: stageColor(s.stage),
              }}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
              title={`${s.label}\nstart: ${s.startMs.toFixed(1)} ms after ${originLabel}\nend: ${s.endMs.toFixed(1)} ms\nduration: ${s.durationMs.toFixed(1)} ms`}
            >
              {s.durationMs > range * 0.06 ? `${s.durationMs.toFixed(0)}ms` : ''}
            </div>
            {(s.children ?? []).map((c) => (
              <div
                key={c.key}
                className="wf-child"
                style={{
                  left: `${pct(c.startMs)}%`,
                  width: `${Math.max(0.3, ((c.endMs - c.startMs) / range) * 100)}%`,
                  background: stageColor(s.stage),
                }}
                title={`${c.label}\n${c.startMs.toFixed(1)} → ${c.endMs.toFixed(1)} ms (${c.durationMs.toFixed(1)} ms)${
                  c.metadata?.text ? `\n"${c.metadata.text}"` : ''
                }${c.metadata?.ttfaMs != null ? `\nTTFA ${c.metadata.ttfaMs} ms` : ''}`}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="wf-axis">
        <div />
        <div className="wf-ticks">
          {ticks.map((t) => (
            <div className="wf-tick" key={t} style={{ left: `${pct(t)}%` }}>
              {t >= 1000 ? `${(t / 1000).toFixed(1)}s` : `${t.toFixed(0)}`}
            </div>
          ))}
        </div>
      </div>
      <p className="hint">
        Time in milliseconds relative to {originLabel}. Bars are real start/end intervals and may overlap — overlapping
        bars mean stages ran concurrently. Hover any bar for exact timestamps; thin bars under the Hamsa and chunker rows
        are individual phrases.
      </p>
      {hover && <span className="faint" style={{ fontSize: 11 }} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary table                                                               */
/* -------------------------------------------------------------------------- */

export interface SummaryLike {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export function SummaryTable({ rows }: { rows: Array<{ label: string; s: SummaryLike; headline?: boolean }> }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">n</th>
            <th className="num">min</th>
            <th className="num">P50</th>
            <th className="num">P90</th>
            <th className="num">P95</th>
            <th className="num">max</th>
            <th className="num">avg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} style={r.headline ? { background: 'rgba(76,154,255,0.06)' } : undefined}>
              <td style={r.headline ? { fontWeight: 700 } : undefined}>{r.label}</td>
              <td className="num dim">{r.s.count || '—'}</td>
              <td className="num">{msRaw(r.s.min)}</td>
              <td className="num" style={{ fontWeight: 600 }}>
                {msRaw(r.s.p50)}
              </td>
              <td className="num">{msRaw(r.s.p90)}</td>
              <td className="num">{msRaw(r.s.p95)}</td>
              <td className="num">{msRaw(r.s.max)}</td>
              <td className="num dim">{msRaw(r.s.avg, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
