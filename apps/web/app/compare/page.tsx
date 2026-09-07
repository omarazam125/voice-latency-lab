'use client';

import { useEffect, useState } from 'react';
import { serverUrl, useStore } from '../../lib/store';
import { Breakdown, gradeTtfs, ms, Waterfall } from '../../components/viz';

export default function ComparePage() {
  const { recording, clipDurationMs, compareResult, benchProgress, startRecording, stopRecording, connected, config } =
    useStore();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<{ durationMs: number; bytes: number } | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);

  const refreshClip = async () => {
    try {
      const r = await fetch(`${serverUrl()}/api/compare/clip`);
      const d = await r.json();
      setClip(d.clip);
      setAnalysis(d.analysis ?? null);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void refreshClip();
  }, [clipDurationMs]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch(`${serverUrl()}/api/compare/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok) setError(d.error ?? 'Comparison failed');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  const a = compareResult?.a;
  const b = compareResult?.b;

  return (
    <>
      <h1>Mode comparison</h1>
      <p className="sub">
        Record one utterance, then replay that exact audio through Mode B and Mode C. Model, system prompt, voice,
        knowledge base, STT settings and input audio are identical — the only difference is orchestration, which is what
        makes the result meaningful.
      </p>

      {error && <div className="banner error">{error}</div>}
      {benchProgress && <div className="banner info">{benchProgress}</div>}

      <div className="card" style={{ marginBottom: 12 }}>
        <h2>1 · Record a test utterance</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          {!recording ? (
            <button className="primary" disabled={!connected} onClick={startRecording}>
              Start recording
            </button>
          ) : (
            <button className="danger" onClick={stopRecording}>
              Stop recording
            </button>
          )}
          <button disabled={!clip || running} onClick={run} className={clip ? 'primary' : ''}>
            {running ? 'Running both pipelines…' : '2 · Run comparison'}
          </button>
          {clip && (
            <span className="badge ok">
              clip {(clip.durationMs / 1000).toFixed(2)} s · {(clip.bytes / 1024).toFixed(0)} KB
            </span>
          )}
          {recording && <span className="badge warn">RECORDING — speak now, then stop</span>}
        </div>
        <p className="hint">
          The microphone must already be running on the Console page. Recording captures the same 16 kHz PCM stream that
          is sent to Speechmatics, so the replay is byte-identical to what a live turn would have produced.
        </p>
        {analysis && (
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>speech start (offline analysis)</dt>
            <dd>{ms(analysis.speechStartMs)}</dd>
            <dt>speech end</dt>
            <dd>{ms(analysis.speechEndMs)}</dd>
            <dt>endpoint</dt>
            <dd>{ms(analysis.endpointMs)}</dd>
          </dl>
        )}
        {analysis && (
          <p className="hint">
            The endpoint is computed from the clip itself, so both modes are compared at exactly the same turn boundary
            rather than re-detecting it differently on each run.
          </p>
        )}
      </div>

      {compareResult && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <div className="stat">
                <span className="k">Mode C saved</span>
                <span className={`headline ${compareResult.savedMs > 0 ? 'ok' : 'bad'}`}>
                  {compareResult.savedMs != null ? `${compareResult.savedMs > 0 ? '−' : '+'}${Math.abs(Math.round(compareResult.savedMs))} ms` : '—'}
                </span>
              </div>
              <div className="stat" style={{ marginLeft: 40 }}>
                <span className="k">relative</span>
                <span className={`headline ${compareResult.savedPct > 0 ? 'ok' : 'bad'}`}>
                  {compareResult.savedPct != null ? `${compareResult.savedPct.toFixed(1)}%` : '—'}
                </span>
              </div>
              <div className="spacer" />
              <div style={{ textAlign: 'right' }}>
                <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>
                  MEASUREMENT SCOPE
                </div>
                <div className="dim" style={{ fontSize: 12, maxWidth: 340, lineHeight: 1.5 }}>
                  Endpoint detected → first audio byte ready to send. Browser transport and playback are excluded because
                  no browser is in the replay loop; they are identical for both modes, so the comparison is unbiased.
                </div>
              </div>
            </div>
          </div>

          <div className="split" style={{ marginBottom: 12 }}>
            {[
              { m: a, title: `MODE ${compareResult.leftMode ?? 'B'} — streaming pipeline`, tone: 'bad' },
              { m: b, title: `MODE ${compareResult.rightMode ?? 'C'} — Vapi-style orchestration`, tone: 'ok' },
            ].map(({ m, title }) => (
              <div className="card" key={title}>
                <h2>{title}</h2>
                {m?.ok ? (
                  <>
                    <div className="stat" style={{ marginBottom: 14 }}>
                      <span className="k">Server-side TTFS</span>
                      <span className={`headline ${gradeTtfs(m.serverTtfsMs)}`}>{ms(m.serverTtfsMs)}</span>
                    </div>
                    <Breakdown
                      segments={m.metrics?.criticalPath ?? []}
                      total={m.metrics?.trueE2EFromPhysicalSpeechEndMs ?? m.serverTtfsMs}
                      bottleneck={m.metrics?.bottleneck}
                    />
                    <h3>Detail</h3>
                    <dl className="kv">
                      <dt>chunker policy</dt>
                      <dd className="dim">{m.detail?.chunkerPolicy}</dd>
                      <dt>transcript source</dt>
                      <dd>{m.detail?.transcriptSource}</dd>
                      <dt>RAG prefetched</dt>
                      <dd>{m.detail?.ragPrefetched ? 'yes' : 'no'}</dd>
                      <dt>first audio bytes</dt>
                      <dd>{m.detail?.firstAudioBytes}</dd>
                      <dt>total audio bytes</dt>
                      <dd>{m.detail?.totalAudioBytes}</dd>
                    </dl>
                    <h3>Transcript</h3>
                    <div className="pre" dir="auto">
                      {m.detail?.transcript || '—'}
                    </div>
                    <h3>Assistant</h3>
                    <div className="pre" dir="auto">
                      {m.detail?.assistantText || '—'}
                    </div>
                  </>
                ) : (
                  <div className="banner error">{m?.error ?? 'Not run'}</div>
                )}
              </div>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h2>Where the difference came from</h2>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th className="num">Mode {compareResult.leftMode ?? 'B'}</th>
                    <th className="num">Mode {compareResult.rightMode ?? 'C'}</th>
                    <th className="num">Delta</th>
                    <th>Attribution</th>
                  </tr>
                </thead>
                <tbody>
                  {(compareResult.attribution ?? []).map((r: any) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td className="num">{Math.round(r.aMs)}</td>
                      <td className="num">{Math.round(r.bMs)}</td>
                      <td
                        className="num"
                        style={{ fontWeight: 700, color: r.deltaMs > 5 ? 'var(--ok)' : r.deltaMs < -5 ? 'var(--bad)' : undefined }}
                      >
                        {r.deltaMs > 0 ? '−' : r.deltaMs < 0 ? '+' : ''}
                        {Math.abs(Math.round(r.deltaMs))}
                      </td>
                      <td className="faint" style={{ fontSize: 11.5 }}>
                        {Math.abs(r.deltaMs) < 5
                          ? 'no material difference'
                          : r.deltaMs > 0
                            ? `Mode ${compareResult.rightMode ?? 'C'} faster here`
                            : `Mode ${compareResult.leftMode ?? 'B'} faster here`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">
              All values in milliseconds of critical path. A positive delta means Mode{' '}
              {compareResult.rightMode ?? 'C'} spent less time in that stage.
            </p>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <h2>Identical inputs (proof the comparison is fair)</h2>
            <dl className="kv">
              {Object.entries(compareResult.identicalInputs ?? {}).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="split">
            {[
              { m: a, title: `Mode ${compareResult.leftMode ?? 'B'} waterfall` },
              { m: b, title: `Mode ${compareResult.rightMode ?? 'C'} waterfall` },
            ].map(({ m, title }) => (
              <div className="card" key={title}>
                <h2>{title}</h2>
                {m?.metrics?.spans ? <Waterfall spans={m.metrics.spans} /> : <div className="empty">—</div>}
              </div>
            ))}
          </div>
        </>
      )}

      {!compareResult && (
        <div className="card">
          <div className="empty">
            Record an utterance, then run the comparison.
            <br />
            Suggested Arabic test phrase:
            <div dir="rtl" style={{ fontSize: 16, marginTop: 10, color: 'var(--fg)' }}>
              السلام عليكم، بدي أعرف شو الخدمات المتوفرة عندكم
            </div>
          </div>
        </div>
      )}
    </>
  );
}
