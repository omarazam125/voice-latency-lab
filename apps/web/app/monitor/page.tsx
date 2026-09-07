'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { eventBuffer, useStore, type WireEventLite } from '../../lib/store';
import { Breakdown, gradeTtfs, ms, stageColor, Waterfall } from '../../components/viz';

const LANES: Array<{ key: string; label: string }> = [
  { key: 'mic', label: 'Microphone' },
  { key: 'vad', label: 'VAD' },
  { key: 'stt', label: 'Speechmatics' },
  { key: 'rag', label: 'RAG' },
  { key: 'llm', label: 'OpenAI' },
  { key: 'chunker', label: 'Text chunker' },
  { key: 'tts', label: 'Hamsa' },
  { key: 'audio', label: 'Audio output' },
];

const MILESTONES = new Set([
  'vad.speech_started',
  'vad.speech_ended',
  'turn.endpoint_detected',
  'stt.first_partial',
  'stt.final',
  'stt.usable_transcript',
  'stt.end_of_utterance',
  'rag.prefetch_hit',
  'rag.completed',
  'llm.request_started',
  'llm.first_delta',
  'llm.completed',
  'chunker.first_phrase_ready',
  'chunker.phrase_ready',
  'tts.request_started',
  'tts.first_audio',
  'audio.first_sent',
  'audio.browser_first_received',
  'audio.playback_started',
  'vad.barge_in_detected',
  'pipeline.speculative_hit',
  'turn.completed',
]);

const LABELS: Record<string, string> = {
  'vad.speech_started': 'User started speaking',
  'vad.speech_ended': 'User ACTUALLY stopped speaking',
  'turn.endpoint_detected': 'SYSTEM decided user stopped',
  'stt.first_partial': 'First partial transcript',
  'stt.final': 'Final transcript',
  'stt.usable_transcript': 'Usable transcript',
  'stt.end_of_utterance': 'Speechmatics EndOfUtterance',
  'rag.prefetch_hit': 'RAG prefetch HIT',
  'rag.completed': 'RAG context ready',
  'llm.request_started': 'OpenAI request sent',
  'llm.first_delta': 'OpenAI first token',
  'llm.completed': 'OpenAI completed',
  'chunker.first_phrase_ready': 'First speakable phrase ready',
  'chunker.phrase_ready': 'Next phrase ready',
  'tts.request_started': 'Hamsa request sent',
  'tts.first_audio': 'First Hamsa audio received',
  'audio.first_sent': 'First audio sent to browser',
  'audio.browser_first_received': 'Audio reached browser',
  'audio.playback_started': 'USER HEARS AI',
  'vad.barge_in_detected': 'BARGE-IN DETECTED',
  'pipeline.speculative_hit': 'Speculative generation HIT',
  'turn.completed': 'Turn completed',
};

function summarise(e: WireEventLite): string {
  const m = e.metadata ?? {};
  switch (e.event) {
    case 'turn.endpoint_detected':
      return `delay ${Math.round(Number(m.endpointDetectionDelayMs) || 0)} ms · threshold ${m.silenceThresholdMs} ms`;
    case 'stt.first_partial':
    case 'stt.usable_transcript':
      return `${m.source ? `[${m.source}] ` : ''}"${String(m.text ?? '').slice(0, 90)}"`;
    case 'stt.final':
      return m.late
        ? `late · agreement ${m.agreement} ${m.diverged ? '· DIVERGED' : ''}`
        : `"${String(m.text ?? '').slice(0, 90)}"`;
    case 'rag.completed':
      return `${m.chunks} chunks in ${Math.round(Number(m.durationMs) || 0)} ms${m.prefetched ? ' (prefetched)' : ''}`;
    case 'rag.prefetch_hit':
      return `saved ${Math.round(Number(m.savedMs) || 0)} ms · agreement ${m.agreement}`;
    case 'llm.request_started':
      return `${m.model} · effort=${m.reasoningEffort ?? 'default'} · ${m.ragChunks} kb chunks`;
    case 'llm.first_delta':
      return `TTFT ${Math.round(Number(m.ttftMs) || 0)} ms · "${String(m.delta ?? '').slice(0, 40)}"`;
    case 'llm.completed':
      return `${m.chars} chars in ${Math.round(Number(m.totalMs) || 0)} ms`;
    case 'chunker.first_phrase_ready':
    case 'chunker.phrase_ready':
      return `"${m.text}" · ${m.words}w · ${m.reason}${
        m.sinceFirstDeltaMs != null ? ` · +${Math.round(Number(m.sinceFirstDeltaMs))} ms after first token` : ''
      }`;
    case 'tts.request_started':
      return `phrase #${m.phraseSeq} · ${m.chars} chars`;
    case 'tts.first_audio':
      return `phrase #${m.phraseSeq} · ${m.bytes} bytes`;
    case 'audio.first_sent':
      return `${m.bytes} bytes`;
    case 'audio.playback_started':
      return `generation ${m.generation}${m.clockUncertaintyMs != null ? ` · clock ±${m.clockUncertaintyMs} ms` : ''}`;
    default:
      return '';
  }
}

export default function MonitorPage() {
  const lanes = useStore((s) => s.lanes);
  const eventVersion = useStore((s) => s.eventVersion);
  const turns = useStore((s) => s.turns);
  const currentTurnId = useStore((s) => s.currentTurnId);
  const partial = useStore((s) => s.partial);
  const assistantText = useStore((s) => s.assistantText);
  const config = useStore((s) => s.config);
  const clearEvents = useStore((s) => s.clearEvents);

  const [follow, setFollow] = useState(true);
  const timelineRef = useRef<HTMLDivElement>(null);

  const last = turns[turns.length - 1];
  const focusTurn = currentTurnId ?? last?.turnId ?? null;

  const timeline = useMemo(() => {
    if (!focusTurn) return [] as WireEventLite[];
    const out: WireEventLite[] = [];
    for (let i = eventBuffer.length - 1; i >= 0 && out.length < 400; i--) {
      const e = eventBuffer[i];
      if (e.turnId !== focusTurn) continue;
      if (!MILESTONES.has(e.event)) continue;
      out.push(e);
    }
    return out.reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTurn, eventVersion]);

  useEffect(() => {
    if (follow && timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
  }, [timeline.length, follow]);

  const rtl = config?.language === 'ar';

  return (
    <>
      <h1>Live latency monitor</h1>
      <p className="sub">
        What is happening inside the pipeline, right now. Every number is measured on a monotonic high-resolution clock —
        nothing here is estimated or simulated. Timings are relative to the instant the VAD detected that you physically
        stopped speaking.
      </p>

      <div className="grid cols-2" style={{ marginBottom: 12, alignItems: 'start' }}>
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Pipeline stages</h2>
            <div className="spacer" />
            <span className="badge">{focusTurn ? `turn ${focusTurn.slice(-6)}` : 'idle'}</span>
          </div>
          {LANES.map((l) => {
            const st = lanes[l.key] ?? { status: 'Idle', tone: 'idle' as const };
            return (
              <div key={l.key} className={`lane tone-${st.tone ?? 'idle'}`}>
                <div className="name" style={{ color: stageColor(l.key) }}>
                  {l.label}
                </div>
                <div className="body">
                  <div className="status">{st.status}</div>
                  {st.detail && <div className="detail">{st.detail}</div>}
                </div>
                <div className="at">{st.atMs != null ? `+${Math.round(st.atMs)}ms` : ''}</div>
              </div>
            );
          })}
        </div>

        <div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Turn timeline</h2>
              <div className="spacer" />
              <label className="row tight faint" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
              </label>
              <button className="sm ghost" onClick={clearEvents}>
                clear
              </button>
            </div>
            <div className="timeline scroll" ref={timelineRef} style={{ maxHeight: 340 }}>
              {timeline.length === 0 && <div className="empty">Speak to populate the timeline.</div>}
              {timeline.map((e) => {
                const t = e.elapsedFromSpeechEndMs;
                const isZero = e.event === 'vad.speech_ended';
                const detail = summarise(e);
                return (
                  <div key={e.seq} className="ev milestone">
                    <span className={`t ${isZero ? 'zero' : ''}`}>
                      {t === null ? '—' : isZero ? '0 ms' : `+${Math.round(t)} ms`}
                    </span>
                    <span className="pip" style={{ background: stageColor(e.stage) }} />
                    <span className="lbl">
                      {LABELS[e.event] ?? e.event}
                      {detail && <span className="meta">{detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <h2>Where the time went</h2>
            {last ? (
              <>
                <div className="row" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
                  <div className="stat">
                    <span className="k">TOTAL TTFS</span>
                    <span className={`headline ${gradeTtfs(last.ttfsMs)}`}>{ms(last.ttfsMs)}</span>
                  </div>
                  <div className="spacer" />
                  <div className="stat" style={{ alignItems: 'flex-end' }}>
                    <span className="k">from physical speech end</span>
                    <span className="v sm">{ms(last.trueE2EFromPhysicalSpeechEndMs)}</span>
                  </div>
                </div>
                <Breakdown
                  segments={last.criticalPath ?? []}
                  total={last.trueE2EFromPhysicalSpeechEndMs}
                  bottleneck={last.bottleneck}
                />
              </>
            ) : (
              <div className="empty">No completed turn yet.</div>
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h2>Waterfall — last turn</h2>
        {last?.spans ? <Waterfall spans={last.spans} /> : <div className="empty">No completed turn yet.</div>}
      </div>

      <div className="split">
        <div className="card">
          <h2>Live transcript</h2>
          <div className={`transcript ${rtl ? 'rtl' : ''}`} style={{ minHeight: 44 }}>
            {partial ? <span className="partial">{partial}</span> : <span className="placeholder">—</span>}
          </div>
        </div>
        <div className="card">
          <h2>Assistant stream</h2>
          <div className={`transcript ${rtl ? 'rtl' : ''}`} style={{ minHeight: 44 }}>
            {assistantText || <span className="placeholder">—</span>}
          </div>
        </div>
      </div>
    </>
  );
}
