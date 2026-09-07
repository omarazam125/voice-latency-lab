'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useStore } from '../lib/store';
import { gradeTtfs, ms } from '../components/viz';

export default function ConsolePage() {
  const {
    connected,
    status,
    config,
    error,
    micOn,
    micStats,
    playerStats,
    partial,
    finalText,
    assistantText,
    turns,
    warmup,
    startMic,
    stopMic,
    manualEndpoint,
    resetConversation,
  } = useStore();

  const [busy, setBusy] = useState(false);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);

  // Pull server defaults once so the console shows the real active config even
  // before the user visits Settings.
  useEffect(() => {
    if (config || defaultsLoaded || !connected) return;
    setDefaultsLoaded(true);
    useStore.getState().updateConfig({});
  }, [config, connected, defaultsLoaded]);

  const last = turns[turns.length - 1];
  const ttfs = last?.ttfsMs ?? null;
  const trueE2E = last?.trueE2EFromPhysicalSpeechEndMs ?? null;
  const rtl = config?.language === 'ar';

  const steps = status?.steps ?? [];
  const failed = steps.filter((s) => s.state === 'failed');
  const allReady = status?.ready ?? false;

  return (
    <>
      <h1>Console</h1>
      <p className="sub">
        Warm every provider connection first, then start the microphone and speak. Time to first speech is measured from
        the moment you actually stop talking to the moment the first audio sample is audible in this browser — not from
        when the server finishes generating.
      </p>

      {error && <div className="banner error">{error}</div>}
      {!connected && (
        <div className="banner warn">
          Not connected to the server. Start it with <code>npm run dev:server</code> and this page will reconnect
          automatically.
        </div>
      )}
      {connected && failed.length > 0 && (
        <div className="banner error">
          Warm-up failed for: {failed.map((f) => f.label).join(', ')}.{' '}
          {failed.map((f) => f.detail).filter(Boolean).join(' · ')}
        </div>
      )}

      <div className="grid cols-3" style={{ marginBottom: 12 }}>
        <div className="card">
          <h2>Session</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <button
              className="primary"
              disabled={!connected || busy}
              onClick={async () => {
                setBusy(true);
                warmup();
                setTimeout(() => setBusy(false), 1200);
              }}
            >
              {busy ? 'Warming up…' : 'Warm up connections'}
            </button>
            <button disabled={!connected} onClick={resetConversation}>
              Reset conversation
            </button>
          </div>

          <div>
            {steps.map((s) => (
              <div
                key={s.key}
                className="row tight"
                style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}
              >
                <span className="row tight">
                  <span
                    className={`dot ${
                      s.state === 'ready' ? 'ok' : s.state === 'failed' ? 'bad' : s.state === 'running' ? 'active' : ''
                    }`}
                  />
                  <span className="dim">{s.label}</span>
                </span>
                <span className="mono faint">
                  {s.durationMs != null ? `${Math.round(s.durationMs)} ms` : s.state}
                </span>
              </div>
            ))}
            {steps.length === 0 && <div className="empty">Not warmed up yet.</div>}
          </div>
          <p className="hint">
            Connection setup is recorded separately and never counted in per-turn latency.
          </p>
        </div>

        <div className="card">
          <h2>Microphone</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            {!micOn ? (
              <button className="primary" disabled={!connected || !allReady} onClick={() => void startMic()}>
                Start microphone
              </button>
            ) : (
              <button className="danger" onClick={() => void stopMic()}>
                Stop microphone
              </button>
            )}
            <button disabled={!connected} onClick={manualEndpoint} title="Fire a turn without waiting for the VAD">
              Force turn
            </button>
          </div>

          {!allReady && !micOn && <p className="hint">The microphone unlocks once warm-up reports READY.</p>}

          {micStats ? (
            <>
              <div className="meter" style={{ marginBottom: 8 }}>
                <div style={{ width: `${Math.min(100, micStats.rms * 320)}%` }} />
              </div>
              <dl className="kv">
                <dt>connected</dt>
                <dd>yes · {micStats.nativeSampleRate} Hz → 16000 Hz</dd>
                <dt>frames/sec</dt>
                <dd>{micStats.framesPerSec}</dd>
                <dt>bytes/sec</dt>
                <dd>{(micStats.bytesPerSec / 1024).toFixed(1)} KB</dd>
                <dt>RMS level</dt>
                <dd>{micStats.rms.toFixed(4)}</dd>
                <dt>speech detected</dt>
                <dd style={{ color: micStats.isSpeech ? 'var(--ok)' : 'var(--fg-dim)' }}>
                  {micStats.isSpeech ? 'YES' : 'no'} (p={micStats.probability.toFixed(2)})
                </dd>
                <dt>silence</dt>
                <dd>{micStats.silenceMs > 0 ? `${micStats.silenceMs} ms` : '—'}</dd>
                <dt>VAD model</dt>
                <dd>{micStats.vadModel}</dd>
                <dt>frame #</dt>
                <dd>{micStats.frameCount}</dd>
              </dl>
            </>
          ) : (
            <div className="empty">Microphone not streaming.</div>
          )}
        </div>

        <div className="card">
          <h2>Last turn</h2>
          {last ? (
            <>
              <div className="stat" style={{ marginBottom: 14 }}>
                <span className="k">TTFS · endpoint → audio heard</span>
                <span className={`headline ${gradeTtfs(ttfs)}`}>{ms(ttfs)}</span>
              </div>
              <dl className="kv">
                <dt>from physical speech end</dt>
                <dd>{ms(trueE2E)}</dd>
                <dt>endpoint delay</dt>
                <dd>{ms(last.endpointDetectionDelayMs)}</dd>
                <dt>LLM TTFT</dt>
                <dd>{ms(last.llmTtftMs)}</dd>
                <dt>LLM → TTS handoff</dt>
                <dd>{ms(last.llmToTtsBufferDelayMs)}</dd>
                <dt>TTS TTFA</dt>
                <dd>{ms(last.ttsTtfaMs)}</dd>
                <dt>audio transport</dt>
                <dd>{ms(last.audioDeliveryLatencyMs)}</dd>
                <dt>bottleneck</dt>
                <dd style={{ color: 'var(--bad)' }}>
                  {last.bottleneck ?? '—'} {last.bottleneckMs != null ? `(${Math.round(last.bottleneckMs)} ms)` : ''}
                </dd>
                <dt>mode</dt>
                <dd>{last.pipelineMode ?? '—'}</dd>
              </dl>
              <p className="hint">
                <Link href="/turns">Open the waterfall →</Link>
              </p>
            </>
          ) : (
            <div className="empty">
              No turns yet. Warm up, start the microphone and say something — for example
              <br />
              <span dir="rtl" style={{ fontSize: 15, display: 'inline-block', marginTop: 8 }}>
                السلام عليكم، بدي أعرف شو الخدمات المتوفرة عندكم
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="split">
        <div className="card">
          <h2>You said</h2>
          <div className={`transcript ${rtl ? 'rtl' : ''}`}>
            {finalText || partial ? (
              <>
                {finalText}
                {partial && <span className="partial">{finalText ? ' ' : ''}{partial}</span>}
              </>
            ) : (
              <span className="placeholder">Waiting for speech…</span>
            )}
          </div>
          <p className="hint">
            Partials are shown in italics as they are revised. Mode B may proceed from a stabilised partial rather than
            waiting for the final transcript; the monitor records which one was used and whether the final later
            disagreed.
          </p>
        </div>

        <div className="card">
          <h2>Assistant said</h2>
          <div className={`transcript ${rtl ? 'rtl' : ''}`}>
            {assistantText ? assistantText : <span className="placeholder">No response yet.</span>}
          </div>
          {playerStats && (
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>playback buffer</dt>
              <dd>{playerStats.bufferedMs.toFixed(0)} ms</dd>
              <dt>state</dt>
              <dd>{playerStats.playing ? 'playing' : 'idle'}</dd>
              <dt>underruns</dt>
              <dd style={{ color: playerStats.underruns > 0 ? 'var(--warn)' : undefined }}>{playerStats.underruns}</dd>
              <dt>stale frames dropped</dt>
              <dd>{playerStats.droppedStale}</dd>
            </dl>
          )}
        </div>
      </div>
    </>
  );
}
