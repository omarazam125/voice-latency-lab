'use client';

import { useEffect, useState } from 'react';
import { serverUrl, useStore } from '../../lib/store';
import { ms, stageColor, SummaryTable, gradeTtfs } from '../../components/viz';

const METRIC_ROWS: Array<{ key: string; label: string; headline?: boolean }> = [
  { key: 'ttfsMs', label: 'TTFS — endpoint to audio heard', headline: true },
  { key: 'trueE2EFromPhysicalSpeechEndMs', label: 'True E2E — physical speech end to audio' },
  { key: 'endpointDetectionDelayMs', label: 'Endpoint detection' },
  { key: 'sttUsableTranscriptLatencyMs', label: 'STT usable transcript' },
  { key: 'sttFinalLatencyMs', label: 'STT final transcript' },
  { key: 'ragLatencyMs', label: 'RAG retrieval' },
  { key: 'llmTtftMs', label: 'LLM TTFT' },
  { key: 'llmToTtsBufferDelayMs', label: 'LLM to TTS handoff' },
  { key: 'ttsTtfaMs', label: 'TTS TTFA' },
  { key: 'audioDeliveryLatencyMs', label: 'Server to browser transport' },
  { key: 'playbackScheduleMs', label: 'Jitter buffer and playback' },
  { key: 'totalResponseDurationMs', label: 'Total response duration' },
];

export default function DashboardPage() {
  const turns = useStore((s) => s.turns);
  const [window, setWindow] = useState(20);
  const [data, setData] = useState<any>(null);
  const [mode, setMode] = useState<'all' | 'B' | 'C'>('all');
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch(`${serverUrl()}/api/dashboard?window=${window}`);
      if (!r.ok) {
        setErr((await r.json().catch(() => ({}))).error ?? 'Failed to load');
        return;
      }
      setErr(null);
      setData(await r.json());
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window, turns.length]);

  const d = data?.dashboard;
  const byMode = d?.byMode?.[mode];
  const breakdown = d?.averageBreakdown?.[mode] ?? [];
  const ttfs = byMode?.ttfsMs;

  return (
    <>
      <h1>Performance dashboard</h1>
      <p className="sub">
        Distribution statistics across recent turns. Percentiles use the nearest-rank definition, so every figure shown
        is a measurement that actually occurred rather than an interpolated value — important when the sample is small.
      </p>

      {err && <div className="banner warn">{err}</div>}

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="faint" style={{ fontSize: 12 }}>WINDOW</span>
        {[10, 20, 50, 100].map((w) => (
          <button key={w} className={`sm ${window === w ? 'primary' : ''}`} onClick={() => setWindow(w)}>
            last {w}
          </button>
        ))}
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 12 }}>MODE</span>
        {(['all', 'B', 'C'] as const).map((m) => (
          <button key={m} className={`sm ${mode === m ? 'primary' : ''}`} onClick={() => setMode(m)}>
            {m === 'all' ? 'all' : `Mode ${m}`}
          </button>
        ))}
        <button className="sm ghost" onClick={() => void load()}>
          refresh
        </button>
      </div>

      {d && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 12 }}>
            <div className="card">
              <div className="stat">
                <span className="k">P50 TTFS</span>
                <span className={`headline ${gradeTtfs(ttfs?.p50)}`}>{ms(ttfs?.p50)}</span>
              </div>
              <p className="hint">Target: 1.5–2.5 s</p>
            </div>
            <div className="card">
              <div className="stat">
                <span className="k">P90 TTFS</span>
                <span className={`headline ${gradeTtfs(ttfs?.p90)}`}>{ms(ttfs?.p90)}</span>
              </div>
              <p className="hint">Consistency matters as much as the median.</p>
            </div>
            <div className="card">
              <div className="stat">
                <span className="k">P95 TTFS</span>
                <span className={`headline ${gradeTtfs(ttfs?.p95)}`}>{ms(ttfs?.p95)}</span>
              </div>
              <p className="hint">Target ceiling: 3 s</p>
            </div>
            <div className="card">
              <div className="stat">
                <span className="k">Turns analysed</span>
                <span className="headline">{d.turns}</span>
              </div>
              <p className="hint">
                Mode B: {d.modeCounts.B} · Mode C: {d.modeCounts.C}
              </p>
            </div>
          </div>

          <div className="split" style={{ marginBottom: 12 }}>
            <div className="card">
              <h2>Average critical path ({mode === 'all' ? 'all turns' : `Mode ${mode}`})</h2>
              {breakdown.length === 0 && <div className="empty">No data.</div>}
              {breakdown.map((r: any) => (
                <div className="bd-row" key={r.key}>
                  <div className="bd-label">{r.label}</div>
                  <div className="bd-bar-wrap">
                    <div
                      className="bd-bar"
                      style={{
                        width: `${Math.min(100, r.share * 2)}%`,
                        background: stageColor(r.key.includes('llm') ? 'llm' : r.key),
                      }}
                    />
                  </div>
                  <div className="bd-val">
                    {r.avgMs.toFixed(0)} <span className="faint">({r.share.toFixed(0)}%)</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="card">
              <h2>Bottleneck frequency</h2>
              {d.bottlenecks.length === 0 && <div className="empty">No data.</div>}
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th className="num">Turns</th>
                      <th className="num">Share</th>
                      <th className="num">Avg ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.bottlenecks.map((b: any) => (
                      <tr key={b.key}>
                        <td style={{ color: 'var(--bad)', fontWeight: 600 }}>{b.label}</td>
                        <td className="num">{b.count}</td>
                        <td className="num">{d.turns > 0 ? `${Math.round((b.count / d.turns) * 100)}%` : '—'}</td>
                        <td className="num">{b.avgMs.toFixed(0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint">
                The stage that consumed the largest slice of the critical path, counted per turn. This is the single most
                useful table for deciding what to fix next.
              </p>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h2>Distribution ({mode === 'all' ? 'all turns' : `Mode ${mode}`})</h2>
            {byMode ? (
              <SummaryTable rows={METRIC_ROWS.map((r) => ({ label: r.label, s: byMode[r.key], headline: r.headline }))} />
            ) : (
              <div className="empty">No data.</div>
            )}
          </div>

          <div className="card">
            <h2>Latency budget</h2>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th className="num">Good</th>
                    <th className="num">Warn above</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.budget ?? []).map((b: any) => (
                    <tr key={b.key}>
                      <td>{b.label}</td>
                      <td className="num" style={{ color: 'var(--ok)' }}>
                        ≤{b.good}
                      </td>
                      <td className="num" style={{ color: 'var(--warn)' }}>
                        {b.warn}
                      </td>
                      <td className="faint" style={{ fontSize: 11.5 }}>
                        {b.note}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">
              These are engineering targets for a well-configured pipeline, not provider SLAs. They exist so a
              regression is obvious, not to pass or fail a run.
            </p>
          </div>
        </>
      )}

      {!d && !err && <div className="card"><div className="empty">Loading…</div></div>}
    </>
  );
}
