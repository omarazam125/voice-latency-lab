'use client';

import { useState } from 'react';
import { useStore } from '../../lib/store';
import { Breakdown, gradeTtfs, ms, Waterfall } from '../../components/viz';
import { serverUrl } from '../../lib/store';

export default function TurnsPage() {
  const turns = useStore((s) => s.turns);
  const [selected, setSelected] = useState<string | null>(null);

  const turn = turns.find((t) => t.turnId === selected) ?? turns[turns.length - 1];

  return (
    <>
      <h1>Turns &amp; waterfall</h1>
      <p className="sub">
        Every conversational turn, with a Gantt view of what ran when. Bars may overlap: that is the visual difference
        between a pipeline where each provider merely <em>supports</em> streaming and one where the whole pipeline is
        actually streamed.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <a className="btn" href={`${serverUrl()}/api/export?format=json`} target="_blank" rel="noreferrer">
          Export JSON
        </a>
        <a className="btn" href={`${serverUrl()}/api/export?format=csv`} target="_blank" rel="noreferrer">
          Export CSV
        </a>
        <a className="btn" href={`${serverUrl()}/api/export?format=json&events=true`} target="_blank" rel="noreferrer">
          Export JSON + raw events
        </a>
        <span className="faint" style={{ fontSize: 12 }}>
          Exports never contain API keys — the system prompt is included only as a hash.
        </span>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h2>All turns ({turns.length})</h2>
        <div className="scroll" style={{ maxHeight: 260 }}>
          <table>
            <thead>
              <tr>
                <th>Turn</th>
                <th>Mode</th>
                <th className="num">TTFS</th>
                <th className="num">From speech end</th>
                <th className="num">Endpoint</th>
                <th className="num">STT</th>
                <th className="num">RAG</th>
                <th className="num">LLM TTFT</th>
                <th className="num">LLM→TTS</th>
                <th className="num">TTS TTFA</th>
                <th className="num">Transport</th>
                <th>Bottleneck</th>
              </tr>
            </thead>
            <tbody>
              {turns.length === 0 && (
                <tr>
                  <td colSpan={12}>
                    <div className="empty">No turns recorded yet.</div>
                  </td>
                </tr>
              )}
              {[...turns].reverse().map((t) => (
                <tr
                  key={t.turnId}
                  onClick={() => setSelected(t.turnId)}
                  style={{
                    cursor: 'pointer',
                    background: t.turnId === turn?.turnId ? 'rgba(76,154,255,0.09)' : undefined,
                  }}
                >
                  <td className="mono faint">{t.turnId.slice(-6)}</td>
                  <td>
                    <span className="badge">{t.pipelineMode ?? '—'}</span>
                  </td>
                  <td className="num" style={{ fontWeight: 700, color: `var(--${gradeTtfs(t.ttfsMs) || 'fg'})` }}>
                    {t.ttfsMs != null ? Math.round(t.ttfsMs) : '—'}
                  </td>
                  <td className="num">
                    {t.trueE2EFromPhysicalSpeechEndMs != null ? Math.round(t.trueE2EFromPhysicalSpeechEndMs) : '—'}
                  </td>
                  <td className="num">{t.endpointDetectionDelayMs != null ? Math.round(t.endpointDetectionDelayMs) : '—'}</td>
                  <td className="num">
                    {t.sttUsableTranscriptLatencyMs != null ? Math.round(t.sttUsableTranscriptLatencyMs) : '—'}
                  </td>
                  <td className="num">{t.ragCriticalPathMs != null ? Math.round(t.ragCriticalPathMs) : '—'}</td>
                  <td className="num">{t.llmTtftMs != null ? Math.round(t.llmTtftMs) : '—'}</td>
                  <td className="num">{t.llmToTtsBufferDelayMs != null ? Math.round(t.llmToTtsBufferDelayMs) : '—'}</td>
                  <td className="num">{t.ttsTtfaMs != null ? Math.round(t.ttsTtfaMs) : '—'}</td>
                  <td className="num">
                    {t.audioDeliveryLatencyMs != null ? Math.round(t.audioDeliveryLatencyMs) : '—'}
                  </td>
                  <td className="faint">{t.bottleneck ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">All values in milliseconds. Click a row to inspect it below.</p>
      </div>

      {turn && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Waterfall — turn {turn.turnId.slice(-6)}</h2>
              <span className="badge">MODE {turn.pipelineMode}</span>
              <div className="spacer" />
              <div className="stat" style={{ alignItems: 'flex-end' }}>
                <span className="k">TTFS</span>
                <span className={`v sm ${gradeTtfs(turn.ttfsMs)}`}>{ms(turn.ttfsMs)}</span>
              </div>
            </div>
            <Waterfall spans={turn.spans ?? []} />
          </div>

          <div className="split">
            <div className="card">
              <h2>Latency breakdown</h2>
              <Breakdown
                segments={turn.criticalPath ?? []}
                total={turn.trueE2EFromPhysicalSpeechEndMs}
                bottleneck={turn.bottleneck}
              />
            </div>

            <div className="card">
              <h2>Turn detail</h2>
              <dl className="kv">
                <dt>trace</dt>
                <dd className="faint">{turn.traceId}</dd>
                <dt>user speech duration</dt>
                <dd>{ms(turn.userSpeechDurationMs)}</dd>
                <dt>silence threshold</dt>
                <dd>{ms(turn.silenceThresholdMs)}</dd>
                <dt>endpoint detection delay</dt>
                <dd>{ms(turn.endpointDetectionDelayMs)}</dd>
                <dt>STT first partial</dt>
                <dd>{ms(turn.sttFirstPartialLatencyMs)}</dd>
                <dt>STT final (after endpoint)</dt>
                <dd>{ms(turn.sttFinalLatencyMs)}</dd>
                <dt>STT partial count</dt>
                <dd>{turn.sttPartialCount ?? '—'}</dd>
                <dt>RAG latency</dt>
                <dd>{ms(turn.ragLatencyMs)}</dd>
                <dt>RAG on critical path</dt>
                <dd>{ms(turn.ragCriticalPathMs)}</dd>
                <dt>RAG prefetch hit</dt>
                <dd>{turn.ragPrefetchHit === null ? '—' : turn.ragPrefetchHit ? 'yes' : 'no'}</dd>
                <dt>LLM queue</dt>
                <dd>{ms(turn.llmQueueMs)}</dd>
                <dt>LLM TTFT</dt>
                <dd>{ms(turn.llmTtftMs)}</dd>
                <dt>LLM total</dt>
                <dd>{ms(turn.llmTotalMs)}</dd>
                <dt>LLM → TTS buffering</dt>
                <dd style={{ color: (turn.llmToTtsBufferDelayMs ?? 0) > 400 ? 'var(--bad)' : undefined }}>
                  {ms(turn.llmToTtsBufferDelayMs)}
                </dd>
                <dt>TTS dispatch</dt>
                <dd>{ms(turn.ttsDispatchMs)}</dd>
                <dt>TTS TTFA</dt>
                <dd>{ms(turn.ttsTtfaMs)}</dd>
                <dt>TTS phrases</dt>
                <dd>{turn.ttsPhraseCount ?? '—'}</dd>
                <dt>server relay</dt>
                <dd>{ms(turn.serverRelayMs)}</dd>
                <dt>audio transport</dt>
                <dd>{ms(turn.audioDeliveryLatencyMs)}</dd>
                <dt>jitter buffer + playback</dt>
                <dd>{ms(turn.playbackScheduleMs)}</dd>
                <dt>total response duration</dt>
                <dd>{ms(turn.totalResponseDurationMs)}</dd>
                <dt>barge-in</dt>
                <dd>{turn.bargedIn ? 'yes' : 'no'}</dd>
                <dt>cancelled</dt>
                <dd>{turn.cancelled ? 'yes' : 'no'}</dd>
                <dt>retries</dt>
                <dd>
                  llm {turn.retries?.llm ?? 0} · tts {turn.retries?.tts ?? 0} · stt {turn.retries?.stt ?? 0}
                </dd>
              </dl>
              {turn.errors?.length > 0 && (
                <>
                  <h3>Errors</h3>
                  {turn.errors.map((e: any, i: number) => (
                    <div key={i} className="banner error" style={{ marginBottom: 6, fontSize: 12 }}>
                      [{e.stage}] {e.message}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
