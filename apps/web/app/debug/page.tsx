'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { debugBuffer, eventBuffer, useStore, type WireEventLite } from '../../lib/store';
import { stageColor } from '../../components/viz';

const STAGES = ['all', 'vad', 'stt', 'rag', 'llm', 'chunker', 'tts', 'audio', 'turn', 'pipeline', 'session', 'mic'];

export default function DebugPage() {
  const eventVersion = useStore((s) => s.eventVersion);
  const debugVersion = useStore((s) => s.debugVersion);
  const playerStats = useStore((s) => s.playerStats);
  const status = useStore((s) => s.status);
  const clock = useStore((s) => s.clock);
  const clearEvents = useStore((s) => s.clearEvents);
  const setDebugRaw = useStore((s) => s.send);

  const [stage, setStage] = useState('all');
  const [filter, setFilter] = useState('');
  const [source, setSource] = useState('all');
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<WireEventLite | null>(null);

  const evRef = useRef<HTMLDivElement>(null);
  const rawRef = useRef<HTMLDivElement>(null);

  const events = useMemo(() => {
    const f = filter.toLowerCase();
    const out: WireEventLite[] = [];
    for (let i = eventBuffer.length - 1; i >= 0 && out.length < 500; i--) {
      const e = eventBuffer[i];
      if (stage !== 'all' && e.stage !== stage) continue;
      if (f && !e.event.toLowerCase().includes(f) && !JSON.stringify(e.metadata).toLowerCase().includes(f)) continue;
      out.push(e);
    }
    return out.reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventVersion, stage, filter]);

  const raw = useMemo(() => {
    const out = [];
    for (let i = debugBuffer.length - 1; i >= 0 && out.length < 300; i--) {
      const d = debugBuffer[i];
      if (source !== 'all' && d.source !== source) continue;
      out.push(d);
    }
    return out.reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugVersion, source]);

  useEffect(() => {
    if (follow && evRef.current) evRef.current.scrollTop = evRef.current.scrollHeight;
    if (follow && rawRef.current) rawRef.current.scrollTop = rawRef.current.scrollHeight;
  }, [events.length, raw.length, follow]);

  const sources = useMemo(() => ['all', ...new Set(debugBuffer.map((d) => d.source))], [debugVersion]);

  return (
    <>
      <h1>Debug</h1>
      <p className="sub">
        Raw provider frames and the full telemetry stream. This is the view that answers questions like &ldquo;OpenAI gave
        us text at 1,030 ms — why did Hamsa not receive anything until 2,700 ms?&rdquo; The chunker&rsquo;s buffer state and
        every flush decision are recorded, so the gap is always attributable.
      </p>

      <div className="grid cols-4" style={{ marginBottom: 12 }}>
        <div className="card tight">
          <div className="stat">
            <span className="k">Telemetry events</span>
            <span className="v sm">{eventBuffer.length}</span>
          </div>
        </div>
        <div className="card tight">
          <div className="stat">
            <span className="k">Playback queue</span>
            <span className="v sm">{playerStats ? `${playerStats.bufferedMs.toFixed(0)} ms` : '—'}</span>
          </div>
        </div>
        <div className="card tight">
          <div className="stat">
            <span className="k">Underruns / stale dropped</span>
            <span className="v sm">
              {playerStats ? `${playerStats.underruns} / ${playerStats.droppedStale}` : '—'}
            </span>
          </div>
        </div>
        <div className="card tight">
          <div className="stat">
            <span className="k">Clock offset</span>
            <span className="v sm">
              {clock ? `${clock.offsetMs.toFixed(2)} ms` : '—'}
              {clock && <span className="u"> ±{clock.uncertaintyMs.toFixed(2)}</span>}
            </span>
          </div>
        </div>
      </div>

      <div className="split" style={{ marginBottom: 12 }}>
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Telemetry stream</h2>
            <div className="spacer" />
            <label className="row tight faint" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
            </label>
            <button className="sm ghost" onClick={clearEvents}>
              clear
            </button>
          </div>
          <div className="row tight" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            {STAGES.map((s) => (
              <button key={s} className={`sm ${stage === s ? 'primary' : ''}`} onClick={() => setStage(s)}>
                {s}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="filter events and metadata…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div className="scroll" ref={evRef} style={{ maxHeight: 460, fontFamily: 'var(--mono)', fontSize: 11 }}>
            {events.length === 0 && <div className="empty">No events.</div>}
            {events.map((e) => (
              <div
                key={e.seq}
                onClick={() => setSelected(e)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '68px 1fr',
                  gap: 8,
                  padding: '2px 4px',
                  cursor: 'pointer',
                  background: selected?.seq === e.seq ? 'var(--bg-3)' : undefined,
                  borderBottom: '1px solid var(--bg-2)',
                }}
              >
                <span className="faint" style={{ textAlign: 'right' }}>
                  {e.elapsedFromSpeechEndMs != null ? `+${Math.round(e.elapsedFromSpeechEndMs)}` : '·'}
                </span>
                <span>
                  <span style={{ color: stageColor(e.stage) }}>{e.event}</span>
                  {e.clientOriginated && <span className="faint"> [browser]</span>}
                  <span className="dim"> {compact(e.metadata)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Raw provider frames</h2>
            <div className="spacer" />
            <div className="row tight">
              {sources.map((s) => (
                <button key={s} className={`sm ${source === s ? 'primary' : ''}`} onClick={() => setSource(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="scroll" ref={rawRef} style={{ maxHeight: 520 }}>
            {raw.length === 0 && (
              <div className="empty">
                No raw frames yet. These appear once a session is warmed up and Speechmatics or Hamsa start exchanging
                messages.
              </div>
            )}
            {raw.map((d) => (
              <div className="debug-line" key={d.id}>
                <span className="faint">{(d.atMs / 1000).toFixed(2)}s</span>
                <span className="src">{d.source}</span>
                <span className="dir">{d.direction === 'in' ? '←' : '→'}</span>
                <span className="pl">{compact(d.payload)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {selected && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>
              {selected.event} <span className="faint">seq {selected.seq}</span>
            </h2>
            <div className="spacer" />
            <button className="sm ghost" onClick={() => setSelected(null)}>
              close
            </button>
          </div>
          <pre className="pre" style={{ maxHeight: 340 }}>
            {JSON.stringify(selected, null, 2)}
          </pre>
        </div>
      )}

      <div className="card">
        <h2>Connection state</h2>
        <pre className="pre" style={{ maxHeight: 300 }}>
          {JSON.stringify({ status, clock, playerStats }, null, 2)}
        </pre>
      </div>
    </>
  );
}

function compact(v: unknown): string {
  if (v === null || v === undefined) return '';
  try {
    const s = JSON.stringify(v);
    if (s === '{}') return '';
    return s.length > 420 ? `${s.slice(0, 420)}…` : s;
  } catch {
    return String(v);
  }
}
