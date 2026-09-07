'use client';

import { useEffect, useState } from 'react';
import { serverUrl, useStore } from '../../lib/store';
import { ms } from '../../components/viz';

export default function BenchmarksPage() {
  const benchResults = useStore((s) => s.benchResults);
  const benchProgress = useStore((s) => s.benchProgress);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [clip, setClip] = useState<any>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [reps, setReps] = useState(3);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${serverUrl()}/api/bench/catalog`)
      .then((r) => r.json())
      .then((d) => {
        setCatalog(d.benchmarks ?? []);
        setClip(d.clip ?? null);
      })
      .catch(() => setErr('Cannot reach the server'));
  }, [benchResults]);

  const run = async (id: string) => {
    setRunning(id);
    setErr(null);
    try {
      const r = await fetch(`${serverUrl()}/api/bench/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ benchmark: id, repetitions: reps }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? 'Benchmark failed');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setRunning(null);
    }
  };

  return (
    <>
      <h1>Isolated benchmarks</h1>
      <p className="sub">
        Prove where the time actually goes. Each probe exercises one part of the pipeline with everything else removed,
        so a four-second turn can be attributed to a specific provider rather than argued about. Repetitions are reported
        individually so an outlier stays visible instead of being averaged away.
      </p>

      {err && <div className="banner error">{err}</div>}
      {benchProgress && <div className="banner info">{benchProgress}</div>}
      {!clip && (
        <div className="banner warn">
          No recorded clip yet. The STT and full-pipeline probes need one — record a test utterance on the{' '}
          <a href="/compare">Compare</a> page first.
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="faint" style={{ fontSize: 12 }}>REPETITIONS</span>
        {[1, 3, 5, 10].map((n) => (
          <button key={n} className={`sm ${reps === n ? 'primary' : ''}`} onClick={() => setReps(n)}>
            {n}
          </button>
        ))}
        {clip && (
          <span className="badge ok">
            clip {(clip.durationMs / 1000).toFixed(2)} s
          </span>
        )}
      </div>

      <div className="grid cols-2">
        {catalog.map((b) => {
          const result = benchResults[b.id];
          const disabled = running !== null || (b.needsAudio && !clip);
          const s = result?.summary;
          return (
            <div className="card" key={b.id}>
              <div className="row" style={{ marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>{b.label}</h2>
                <div className="spacer" />
                <button className="sm primary" disabled={disabled} onClick={() => void run(b.id)}>
                  {running === b.id ? 'running…' : 'Run'}
                </button>
              </div>
              <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                {b.description}
              </p>

              {result ? (
                <>
                  <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
                    <div className="stat">
                      <span className="k">P50</span>
                      <span className="v">{s ? Math.round(s.p50) : '—'}<span className="u"> ms</span></span>
                    </div>
                    <div className="stat" style={{ marginLeft: 22 }}>
                      <span className="k">min</span>
                      <span className="v sm">{s ? Math.round(s.min) : '—'}</span>
                    </div>
                    <div className="stat" style={{ marginLeft: 22 }}>
                      <span className="k">max</span>
                      <span className="v sm">{s ? Math.round(s.max) : '—'}</span>
                    </div>
                    <div className="spacer" />
                    <span className="badge">{result.runs.filter((r: any) => r.ok).length}/{result.runs.length} ok</span>
                  </div>
                  <div className="faint" style={{ fontSize: 11.5, marginBottom: 8 }}>
                    {result.runs[0]?.headlineLabel}
                  </div>

                  <div className="scroll" style={{ maxHeight: 150 }}>
                    <table>
                      <thead>
                        <tr>
                          <th className="num">#</th>
                          <th className="num">ms</th>
                          <th>Steps</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.runs.map((r: any, i: number) => (
                          <tr key={i}>
                            <td className="num faint">{i + 1}</td>
                            <td className="num" style={{ fontWeight: 600, color: r.ok ? undefined : 'var(--bad)' }}>
                              {r.ok ? Math.round(r.headlineMs) : 'fail'}
                            </td>
                            <td className="faint" style={{ fontSize: 11 }}>
                              {r.ok
                                ? r.steps.map((st: any) => `${st.label} @${Math.round(st.atMs)}`).join(' → ')
                                : r.error}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <button
                    className="sm ghost"
                    style={{ marginTop: 8 }}
                    onClick={() => setExpanded(expanded === b.id ? null : b.id)}
                  >
                    {expanded === b.id ? 'hide detail' : 'show detail'}
                  </button>
                  {expanded === b.id && (
                    <pre className="pre" style={{ marginTop: 8, maxHeight: 300 }}>
                      {JSON.stringify({ config: result.config, lastRunDetail: result.runs[result.runs.length - 1]?.detail }, null, 2)}
                    </pre>
                  )}
                </>
              ) : (
                <div className="empty" style={{ padding: 14 }}>
                  Not run yet.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
