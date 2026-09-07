'use client';

import { useEffect, useMemo, useState } from 'react';
import { eventBuffer, serverUrl, useStore, type WireEventLite } from '../../lib/store';
import { gradeTtfs, ms, stageColor, Waterfall } from '../../components/viz';

/* -------------------------------------------------------------------------- */

const LANES = [
  { key: 'mic', label: 'Transport' },
  { key: 'vad', label: 'VAD' },
  { key: 'turn', label: 'Endpointing' },
  { key: 'stt', label: 'Speechmatics' },
  { key: 'rag', label: 'RAG' },
  { key: 'llm', label: 'GPT' },
  { key: 'chunker', label: 'Voice chunker' },
  { key: 'tts', label: 'Hamsa' },
  { key: 'audio', label: 'Audio playback' },
];

const PERF_ROWS: Array<{ key: string; label: string; note: string; headline?: boolean }> = [
  { key: 'transportLatency', label: 'transportLatency', note: 'audio reaching the pipeline' },
  { key: 'endpointingLatency', label: 'endpointingLatency', note: 'physical speech end → turn committed' },
  { key: 'transcriberLatency', label: 'transcriberLatency', note: 'commit → usable transcript' },
  { key: 'ragLatency', label: 'ragLatency', note: 'retrieval duration' },
  { key: 'modelLatency', label: 'modelLatency', note: 'request → FIRST TEXT TOKEN', headline: true },
  { key: 'modelCompletionLatency', label: 'modelCompletionLatency', note: 'full generation — NOT model latency' },
  { key: 'llmToVoiceLatency', label: 'llmToVoiceLatency', note: 'first token → text sent to Hamsa' },
  { key: 'voiceLatency', label: 'voiceLatency', note: 'TTS request → first audio byte' },
  { key: 'audioOutputLatency', label: 'audioOutputLatency', note: 'server audio → audible' },
  { key: 'turnLatency', label: 'turnLatency', note: 'turn committed → first audio' },
  { key: 'trueVoiceToVoiceLatency', label: 'trueVoiceToVoiceLatency', note: 'physical speech end → audible', headline: true },
];

export default function VapiLabPage() {
  const status = useStore((s) => s.status);
  const config = useStore((s) => s.config);
  const turns = useStore((s) => s.turns);
  const eventVersion = useStore((s) => s.eventVersion);
  const benchProgress = useStore((s) => s.benchProgress);
  const currentTurnId = useStore((s) => s.currentTurnId);

  const [snapshot, setSnapshot] = useState<any>(null);
  const [comparison, setComparison] = useState<any>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isModeC = config?.mode === 'C';
  const last = turns[turns.length - 1];

  /* -- live endpointing snapshot ---------------------------------------- */
  useEffect(() => {
    if (!isModeC) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${serverUrl()}/api/modec/snapshot`);
        if (r.ok && alive) setSnapshot(await r.json());
      } catch {
        /* ignore */
      }
    };
    void poll();
    const t = setInterval(poll, 150);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [isModeC]);

  /* -- per-turn trace ---------------------------------------------------- */
  const trace = useMemo(() => {
    const turnId = currentTurnId ?? last?.turnId;
    if (!turnId) return [] as WireEventLite[];
    const wanted = new Set([
      'vad.speech_started',
      'vad.speech_ended',
      'turn.endpoint_detected',
      'stt.first_partial',
      'stt.usable_transcript',
      'stt.final',
      'rag.prefetch_hit',
      'rag.skipped',
      'rag.completed',
      'llm.request_started',
      'llm.first_delta',
      'chunker.first_phrase_ready',
      'chunker.phrase_ready',
      'chunker.flush_reason',
      'tts.request_started',
      'tts.first_audio',
      'audio.first_sent',
      'audio.browser_first_received',
      'audio.playback_started',
      'llm.completed',
    ]);
    return eventBuffer.filter((e) => e.turnId === turnId && wanted.has(e.event));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventVersion, currentTurnId, last?.turnId]);

  const runComparison = async () => {
    setRunning('compare');
    setErr(null);
    try {
      const r = await fetch(`${serverUrl()}/api/modec/compare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modes: ['B', 'C'] }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? 'Comparison failed');
      else setComparison(d);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setRunning(null);
    }
  };

  const setMode = (mode: 'B' | 'C') => useStore.getState().updateConfig({ mode });

  const perf = last?.performance ?? null;
  const attribution = last?.attribution ?? null;
  const gaps = (last?.gaps ?? []).filter((g: any) => g.severity !== 'ok');

  return (
    <>
      <h1>Vapi-style lab — Mode C</h1>
      <p className="sub">
        A reproduction of publicly documented Vapi orchestration principles using our own code, over the same
        Speechmatics, GPT-4.1 and Hamsa stack. This is <strong>not</strong> Vapi&apos;s internal implementation and makes no
        claim to be — it exists to answer why the same model can feel dramatically faster inside a better-scheduled
        pipeline.
      </p>

      {err && <div className="banner error">{err}</div>}
      {benchProgress && <div className="banner info">{benchProgress}</div>}
      {!isModeC && (
        <div className="banner warn">
          Mode C is not active — the endpointing engine and voice chunk planner are idle. Its settings are preserved
          regardless of the active mode.{' '}
          <button className="sm primary" style={{ marginLeft: 8 }} onClick={() => setMode('C')}>
            Switch to Mode C
          </button>
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="faint" style={{ fontSize: 12 }}>PIPELINE MODE</span>
        {(['B', 'C'] as const).map((m) => (
          <button key={m} className={`sm ${config?.mode === m ? 'primary' : ''}`} onClick={() => setMode(m)}>
            Mode {m}
          </button>
        ))}
        <div className="spacer" />
        <div className="stat" style={{ alignItems: 'flex-end' }}>
          <span className="k">Current TTFS</span>
          <span className={`v ${gradeTtfs(last?.ttfsMs)}`}>{ms(last?.ttfsMs)}</span>
        </div>
      </div>

      {/* ---------------- endpointing engine ---------------- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Endpointing engine</h2>
          <span className="badge">{snapshot?.strategy ?? config?.modeC?.endpointing?.strategy ?? '—'}</span>
          <div className="spacer" />
          {snapshot?.committed && <span className="badge ok">TURN COMMITTED</span>}
        </div>

        {isModeC && snapshot ? (
          <div className="grid cols-4" style={{ gap: 10 }}>
            <div className="stat">
              <span className="k">VAD</span>
              <span className="v sm" style={{ color: snapshot.speaking ? 'var(--ok)' : 'var(--fg-dim)' }}>
                {snapshot.speaking ? 'SPEAKING' : 'SILENT'}
              </span>
            </div>
            <div className="stat">
              <span className="k">silence</span>
              <span className="v sm">{Math.round(snapshot.silenceMs)} ms</span>
            </div>
            <div className="stat">
              <span className="k">required</span>
              <span className="v sm">
                {snapshot.decision ? `${Math.round(snapshot.decision.requiredSilenceMs)} ms` : '—'}
              </span>
            </div>
            <div className="stat">
              <span className="k">content class</span>
              <span className="v sm">{snapshot.decision?.contentClass ?? '—'}</span>
            </div>
            <div className="stat">
              <span className="k">stability</span>
              <span className="v sm">{snapshot.decision?.stabilityScore?.toFixed(2) ?? '—'}</span>
            </div>
            <div className="stat">
              <span className="k">confidence</span>
              <span className="v sm">{snapshot.decision?.confidence?.toFixed(2) ?? '—'}</span>
            </div>
            <div className="stat">
              <span className="k">words</span>
              <span className="v sm">{snapshot.decision?.words ?? 0}</span>
            </div>
            <div className="stat">
              <span className="k">vs fixed timer</span>
              <span
                className="v sm"
                style={{ color: (snapshot.decision?.savedVersusFixedMs ?? 0) > 0 ? 'var(--ok)' : 'var(--warn)' }}
              >
                {snapshot.decision ? `${snapshot.decision.savedVersusFixedMs > 0 ? '−' : '+'}${Math.abs(snapshot.decision.savedVersusFixedMs)} ms` : '—'}
              </span>
            </div>
          </div>
        ) : (
          <div className="empty">{isModeC ? 'Waiting for speech…' : 'Switch to Mode C to activate the engine.'}</div>
        )}

        {snapshot?.decision && (
          <div
            className="banner info"
            style={{ marginTop: 12, marginBottom: 0, fontFamily: 'var(--mono)', fontSize: 12 }}
          >
            <strong>{snapshot.decision.commit ? 'COMMITTED' : 'WAITING'}</strong> — {snapshot.decision.reason}
            {snapshot.decision.ruleName && <> · rule: {snapshot.decision.ruleName}</>}
          </div>
        )}
        {snapshot?.transcript && (
          <div className="transcript rtl" style={{ marginTop: 10, minHeight: 0, fontSize: 14 }}>
            {snapshot.transcript}
          </div>
        )}
        <p className="hint">
          A fixed silence timer has to be set for the worst case, so every short question waits as long as someone
          reading an account number. This engine picks the required silence from the content instead, and always shows
          why.
        </p>
      </div>

      {/* ---------------- performance model ---------------- */}
      <div className="split" style={{ marginBottom: 12 }}>
        <div className="card">
          <h2>Performance model</h2>
          {perf ? (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th className="num">ms</th>
                    <th>Definition</th>
                  </tr>
                </thead>
                <tbody>
                  {PERF_ROWS.map((r) => (
                    <tr key={r.key} style={r.headline ? { background: 'rgba(76,154,255,0.06)' } : undefined}>
                      <td className="mono" style={r.headline ? { fontWeight: 700 } : undefined}>
                        {r.label}
                      </td>
                      <td className="num" style={{ fontWeight: r.headline ? 700 : 400 }}>
                        {perf[r.key] != null ? Math.round(perf[r.key]) : '—'}
                      </td>
                      <td className="faint" style={{ fontSize: 11 }}>
                        {r.note}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">No completed turn yet.</div>
          )}
          <p className="hint">
            <code>modelLatency</code> is time to FIRST TOKEN. <code>modelCompletionLatency</code> is the whole
            generation. Reporting the second as the first is the most common way a voice-latency investigation blames
            the wrong component.
          </p>
        </div>

        <div className="card">
          <h2>Provider latency vs our latency</h2>
          {attribution && attribution.totalMs > 0 ? (
            <>
              <div className="row" style={{ marginBottom: 14 }}>
                <div className="stat">
                  <span className="k">External providers</span>
                  <span className="v" style={{ color: 'var(--cyan)' }}>
                    {Math.round(attribution.providerMs)}
                    <span className="u"> ms · {attribution.providerPct}%</span>
                  </span>
                </div>
                <div className="spacer" />
                <div className="stat" style={{ alignItems: 'flex-end' }}>
                  <span className="k">Our orchestration</span>
                  <span className="v" style={{ color: 'var(--warn)' }}>
                    {Math.round(attribution.oursMs)}
                    <span className="u"> ms · {attribution.oursPct}%</span>
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden', marginBottom: 14 }}>
                <div style={{ width: `${attribution.providerPct}%`, background: 'var(--cyan)' }} title="providers" />
                <div style={{ width: `${attribution.oursPct}%`, background: 'var(--warn)' }} title="ours" />
              </div>

              {attribution.entries.map((e: any) => (
                <div className="bd-row" key={e.key}>
                  <div className="bd-label">
                    {e.label}
                    <span className="faint"> · {e.owner === 'provider' ? e.provider ?? 'provider' : 'ours'}</span>
                  </div>
                  <div className="bd-bar-wrap">
                    <div
                      className="bd-bar"
                      style={{
                        width: `${Math.min(100, e.sharePct * 2)}%`,
                        background: e.owner === 'provider' ? 'var(--cyan)' : 'var(--warn)',
                      }}
                    />
                  </div>
                  <div className="bd-val">{Math.round(e.durationMs)}</div>
                </div>
              ))}

              <div className="banner info" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
                {attribution.verdict}
              </div>
            </>
          ) : (
            <div className="empty">No completed turn yet.</div>
          )}
        </div>
      </div>

      {/* ---------------- gap detector ---------------- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <h2>Unexplained time gaps</h2>
        {gaps.length === 0 ? (
          <div className="empty">
            {last ? 'No significant gaps detected in the last turn.' : 'No completed turn yet.'}
          </div>
        ) : (
          gaps.map((g: any) => (
            <div
              key={g.key}
              className={`banner ${g.severity === 'critical' ? 'error' : g.severity === 'warning' ? 'warn' : 'info'}`}
              style={{ marginBottom: 8 }}
            >
              <strong>
                {g.severity === 'critical' ? '🔴' : g.severity === 'warning' ? '⚠' : 'ℹ'} {Math.round(g.durationMs)} ms —{' '}
                {g.label}
              </strong>
              <span className="badge" style={{ marginLeft: 8 }}>
                {g.owner === 'provider' ? 'PROVIDER' : 'OURS'}
              </span>
              <div style={{ marginTop: 5 }}>{g.explanation}</div>
              {g.suggestion && (
                <div className="faint" style={{ marginTop: 4, fontSize: 12 }}>
                  → {g.suggestion}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* ---------------- exact turn trace ---------------- */}
      <div className="split" style={{ marginBottom: 12 }}>
        <div className="card">
          <h2>Exact turn trace</h2>
          <div className="timeline scroll" style={{ maxHeight: 340 }}>
            {trace.length === 0 && <div className="empty">Speak to populate the trace.</div>}
            {trace.map((e) => (
              <div key={e.seq} className="ev milestone">
                <span className={`t ${e.event === 'vad.speech_ended' ? 'zero' : ''}`}>
                  {e.elapsedFromSpeechEndMs == null
                    ? '—'
                    : e.event === 'vad.speech_ended'
                      ? '0 ms'
                      : `+${Math.round(e.elapsedFromSpeechEndMs)} ms`}
                </span>
                <span className="pip" style={{ background: stageColor(e.stage) }} />
                <span className="lbl">
                  {e.event}
                  {e.metadata?.reason && <span className="meta">{String(e.metadata.reason).slice(0, 70)}</span>}
                  {e.metadata?.text && <span className="meta">&quot;{String(e.metadata.text).slice(0, 50)}&quot;</span>}
                </span>
              </div>
            ))}
          </div>
          <p className="hint">Real measured timestamps relative to the physical end of speech. Never synthetic.</p>
        </div>

        <div className="card">
          <h2>Pipeline overlap</h2>
          {last?.spans ? <Waterfall spans={last.spans} /> : <div className="empty">No completed turn yet.</div>}
        </div>
      </div>

      {/* ---------------- three-way comparison ---------------- */}
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Mode comparison — A vs B vs C</h2>
          <div className="spacer" />
          <button className="primary" disabled={running !== null} onClick={() => void runComparison()}>
            {running === 'compare' ? 'Running all three modes…' : 'Run comparison'}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Replays the same recorded clip through all three pipelines with identical model, prompt, voice and knowledge.
          Record a clip on the Compare page first.
        </p>

        {comparison && (
          <>
            <div className="scroll" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Mode</th>
                    <th className="num">Endpointing</th>
                    <th className="num">STT</th>
                    <th className="num">RAG</th>
                    <th className="num">GPT TTFT</th>
                    <th className="num">LLM→TTS</th>
                    <th className="num">TTS TTFA</th>
                    <th className="num">Server TTFS</th>
                    <th className="num">Provider</th>
                    <th className="num">Ours</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((r: any) => (
                    <tr
                      key={r.mode}
                      style={r.mode === comparison.fastest ? { background: 'rgba(61,220,151,0.09)' } : undefined}
                    >
                      <td>
                        <span className="badge">{r.mode}</span>{' '}
                        <span className="faint" style={{ fontSize: 11 }}>
                          {r.label}
                        </span>
                      </td>
                      <td className="num">{r.endpointingMs != null ? Math.round(r.endpointingMs) : '—'}</td>
                      <td className="num">{r.sttMs != null ? Math.round(r.sttMs) : '—'}</td>
                      <td className="num">{r.ragMs != null ? Math.round(r.ragMs) : '—'}</td>
                      <td className="num">{r.llmTtftMs != null ? Math.round(r.llmTtftMs) : '—'}</td>
                      <td className="num">{r.llmToVoiceMs != null ? Math.round(r.llmToVoiceMs) : '—'}</td>
                      <td className="num">{r.ttsTtfaMs != null ? Math.round(r.ttsTtfaMs) : '—'}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {r.serverTtfsMs != null ? Math.round(r.serverTtfsMs) : r.error ? 'fail' : '—'}
                      </td>
                      <td className="num" style={{ color: 'var(--cyan)' }}>
                        {Math.round(r.providerMs)}
                      </td>
                      <td className="num" style={{ color: 'var(--warn)' }}>
                        {Math.round(r.oursMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Fastest: Mode {comparison.fastest ?? '—'}</h3>
            <div className="pre" style={{ whiteSpace: 'pre-wrap' }}>
              {(comparison.explanation ?? []).join('\n')}
            </div>
          </>
        )}
      </div>
    </>
  );
}
