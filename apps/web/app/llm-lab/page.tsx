'use client';

import { useEffect, useState } from 'react';
import { serverUrl, useStore } from '../../lib/store';
import { ms } from '../../components/viz';

export default function LlmLabPage() {
  const config = useStore((s) => s.config);
  const benchProgress = useStore((s) => s.benchProgress);

  const [probes, setProbes] = useState<any[]>([]);
  const [results, setResults] = useState<Record<string, any>>({});
  const [sweep, setSweep] = useState<any>(null);
  const [raw, setRaw] = useState<any>(null);
  const [ragBreakdown, setRagBreakdown] = useState<any>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reps, setReps] = useState(5);

  useEffect(() => {
    fetch(`${serverUrl()}/api/modec/presets`)
      .then((r) => r.json())
      .then((d) => setProbes(d.probes ?? []))
      .catch(() => undefined);
  }, []);

  const post = async (path: string, body: unknown, onOk: (d: any) => void, tag: string) => {
    setRunning(tag);
    setErr(null);
    try {
      const r = await fetch(`${serverUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? 'Request failed');
      else onOk(d);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setRunning(null);
    }
  };

  const runAll = () =>
    post('/api/llmlab/all', { repetitions: reps }, (d) => {
      const map: Record<string, any> = {};
      for (const r of d.results) map[r.id] = r;
      setResults(map);
    }, 'all');

  const rows = probes.map((p) => results[p.id]).filter(Boolean);
  const baseline = results['minimal'];

  // Widest bar in the sweep chart, for scaling.
  const sweepMax = sweep ? Math.max(...sweep.points.map((p: any) => p.ttft?.p50 ?? 0), 1) : 1;

  return (
    <>
      <h1>GPT lab — is it the model or the context?</h1>
      <p className="sub">
        The same model can be fast in one system and slow in another. These probes hold the model constant and vary only
        what surrounds it, so the answer is a measurement rather than an argument. Every number here is TIME TO FIRST
        TOKEN unless explicitly labelled otherwise.
      </p>

      {err && <div className="banner error">{err}</div>}
      {benchProgress && <div className="banner info">{benchProgress}</div>}

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="badge">model: {config?.llm.model ?? '—'}</span>
        <span className="badge">effort: {config?.llm.reasoningEffort ?? 'not sent'}</span>
        <span className="faint" style={{ fontSize: 12 }}>REPETITIONS</span>
        {[3, 5, 10].map((n) => (
          <button key={n} className={`sm ${reps === n ? 'primary' : ''}`} onClick={() => setReps(n)}>
            {n}
          </button>
        ))}
        <div className="spacer" />
        <button className="primary" disabled={running !== null} onClick={() => void runAll()}>
          {running === 'all' ? 'Running…' : 'Run all context probes'}
        </button>
      </div>

      {/* ---------------- prompt / context comparison ---------------- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <h2>Prompt and context comparison</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Identical model, identical settings. The only variable is how much context the request carries.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Probe</th>
                <th className="num">est. input tokens</th>
                <th className="num">prompt chars</th>
                <th className="num">RAG chars</th>
                <th className="num">TTFT P50</th>
                <th className="num">TTFT P90</th>
                <th className="num">vs minimal</th>
                <th className="num">full generation P50</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">Not run yet.</div>
                  </td>
                </tr>
              )}
              {rows.map((r: any) => {
                const delta =
                  baseline?.ttft?.p50 != null && r.ttft?.p50 != null ? Math.round(r.ttft.p50 - baseline.ttft.p50) : null;
                return (
                  <tr key={r.id}>
                    <td>
                      {r.label}
                      <div className="faint" style={{ fontSize: 11 }}>
                        {r.description}
                      </div>
                    </td>
                    <td className="num">{r.estimatedInputTokens}</td>
                    <td className="num">{r.systemPromptChars}</td>
                    <td className="num">{r.ragChars}</td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {r.ttft ? Math.round(r.ttft.p50) : '—'}
                    </td>
                    <td className="num">{r.ttft ? Math.round(r.ttft.p90) : '—'}</td>
                    <td
                      className="num"
                      style={{ color: delta == null ? undefined : delta > 50 ? 'var(--bad)' : 'var(--ok)' }}
                    >
                      {delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta}`}
                    </td>
                    <td className="num dim">{r.completion ? Math.round(r.completion.p50) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > 1 && baseline?.ttft?.p50 != null && (
          <div className="banner info" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            {(() => {
              const heaviest = rows.reduce((a: any, b: any) => ((a.ttft?.p50 ?? 0) > (b.ttft?.p50 ?? 0) ? a : b));
              const d = Math.round((heaviest.ttft?.p50 ?? 0) - baseline.ttft.p50);
              return d > 100
                ? `Context costs ${d} ms: "${heaviest.label}" is ${d} ms slower to first token than a minimal prompt on the same model. Prompt prefill is a real contributor here.`
                : `Context is NOT the bottleneck: the heaviest prompt is only ${d} ms slower to first token than a minimal one. If production feels slower than this, the time is being spent outside the model.`;
            })()}
          </div>
        )}
      </div>

      {/* ---------------- prompt caching analysis ---------------- */}
      {rows.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h2>Prompt prefix stability</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            A provider prompt cache can only match a STABLE PREFIX. Static content (system prompt, history) is placed
            first and volatile content (retrieved context, the new question) last, which maximises the cacheable span
            without changing the prompt&apos;s meaning.
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Probe</th>
                  <th className="num">static prefix</th>
                  <th className="num">dynamic suffix</th>
                  <th>Cacheable share</th>
                  <th className="num">cached tokens reported</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => {
                  const total = r.staticPrefixChars + r.dynamicSuffixChars;
                  const pct = total > 0 ? Math.round((r.staticPrefixChars / total) * 100) : 0;
                  const usage = r.runs?.find((x: any) => x.usage)?.usage as any;
                  const cached =
                    usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? null;
                  return (
                    <tr key={r.id}>
                      <td>{r.label}</td>
                      <td className="num">{r.staticPrefixChars}</td>
                      <td className="num">{r.dynamicSuffixChars}</td>
                      <td>
                        <div className="bd-bar-wrap" style={{ width: 160 }}>
                          <div className="bd-bar" style={{ width: `${pct}%`, background: 'var(--ok)' }} />
                        </div>
                      </td>
                      <td className="num">{cached ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="hint">
            The cached-token column shows what the provider actually reported. It is never estimated, and stays blank
            when no usage detail comes back.
          </p>
        </div>
      )}

      {/* ---------------- context sweep ---------------- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Input tokens vs TTFT</h2>
          <div className="spacer" />
          <button
            disabled={running !== null}
            onClick={() => void post('/api/llmlab/context-sweep', { repetitions: 3 }, setSweep, 'sweep')}
          >
            {running === 'sweep' ? 'Sweeping…' : 'Run context sweep'}
          </button>
        </div>
        {sweep ? (
          <>
            {sweep.points.map((p: any) => (
              <div className="bd-row" key={p.targetTokens}>
                <div className="bd-label">
                  ~{p.targetTokens.toLocaleString()} tokens
                  <span className="faint"> · {p.promptChars.toLocaleString()} chars</span>
                </div>
                <div className="bd-bar-wrap">
                  <div
                    className="bd-bar"
                    style={{
                      width: `${((p.ttft?.p50 ?? 0) / sweepMax) * 100}%`,
                      background: 'var(--stage-llm)',
                    }}
                  />
                </div>
                <div className="bd-val">{p.ttft ? Math.round(p.ttft.p50) : '—'}</div>
              </div>
            ))}
            <p className="hint">
              TTFT P50 against prompt size, same model and question throughout. A flat line means prefill is not your
              problem; a steep one means trimming context is the highest-value optimisation available.
            </p>
          </>
        ) : (
          <div className="empty">Not run yet. Takes about a minute.</div>
        )}
      </div>

      {/* ---------------- raw API ---------------- */}
      <div className="split" style={{ marginBottom: 12 }}>
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Raw provider benchmark</h2>
            <div className="spacer" />
            <button
              disabled={running !== null}
              onClick={() => void post('/api/llmlab/raw', { requests: 10 }, setRaw, 'raw')}
            >
              {running === 'raw' ? 'Running…' : 'Run 10 raw requests'}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Bare HTTP straight to the provider, bypassing our entire pipeline. <code>curl</code>&apos;s total time
            includes generating the WHOLE response, which is why it reads as 2–3 seconds; a voice pipeline only waits
            for the first token.
          </p>
          {raw ? (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th className="num">min</th>
                    <th className="num">P50</th>
                    <th className="num">P90</th>
                    <th className="num">max</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['Response headers', raw.headers],
                    ['First SSE event', raw.firstEvent],
                    ['First TEXT delta', raw.firstText],
                    ['Complete response', raw.complete],
                  ].map(([label, s]: any) => (
                    <tr key={label} style={label === 'First TEXT delta' ? { background: 'rgba(76,154,255,0.07)' } : undefined}>
                      <td style={label === 'First TEXT delta' ? { fontWeight: 700 } : undefined}>{label}</td>
                      <td className="num">{s ? Math.round(s.min) : '—'}</td>
                      <td className="num" style={{ fontWeight: label === 'First TEXT delta' ? 700 : 400 }}>
                        {s ? Math.round(s.p50) : '—'}
                      </td>
                      <td className="num">{s ? Math.round(s.p90) : '—'}</td>
                      <td className="num">{s ? Math.round(s.max) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">{raw.note}</p>
              {raw.runs?.[0] && (
                <p className="hint">
                  First request: {Math.round(raw.runs[0].firstTextMs ?? 0)} ms · later requests P50{' '}
                  {raw.firstText ? Math.round(raw.firstText.p50) : '—'} ms. The difference is connection setup, not the
                  model.
                </p>
              )}
            </div>
          ) : (
            <div className="empty">Not run yet.</div>
          )}
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>RAG breakdown</h2>
            <div className="spacer" />
            <button
              disabled={running !== null}
              onClick={() => void post('/api/llmlab/rag-breakdown', { repetitions: 10 }, setRagBreakdown, 'rag')}
            >
              {running === 'rag' ? 'Running…' : 'Break down retrieval'}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            If retrieval is reported as ~500 ms in production, this shows where that time could possibly be going.
          </p>
          {ragBreakdown ? (
            <>
              <dl className="kv">
                <dt>retriever</dt>
                <dd>{ragBreakdown.retriever}</dd>
                <dt>embedder</dt>
                <dd>{ragBreakdown.embedder ?? 'none'}</dd>
                <dt>documents / chunks</dt>
                <dd>
                  {ragBreakdown.documents} / {ragBreakdown.chunks}
                </dd>
                <dt>embedding call</dt>
                <dd>{ragBreakdown.breakdown.embeddingMs === 0 ? 'none (in-process)' : ms(ragBreakdown.breakdown.embeddingMs)}</dd>
                <dt>search</dt>
                <dd>{ragBreakdown.breakdown.searchMs.toFixed(3)} ms</dd>
                <dt>prompt assembly</dt>
                <dd>{ragBreakdown.breakdown.promptAssemblyMs.toFixed(3)} ms</dd>
                <dt>total</dt>
                <dd style={{ fontWeight: 700 }}>{ragBreakdown.breakdown.totalMs.toFixed(3)} ms</dd>
              </dl>
              <div className="banner info" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
                {ragBreakdown.note}
              </div>
            </>
          ) : (
            <div className="empty">Not run yet.</div>
          )}
        </div>
      </div>
    </>
  );
}
