/**
 * Latency attribution: gap detection and provider-vs-our-code accounting.
 *
 * This module answers the question the whole project exists for. When a turn
 * takes 4.5 seconds and the model's TTFT was 850 ms, something consumed the
 * other 3,650 ms — and blaming the model is both easy and wrong.
 *
 * Two outputs:
 *
 *   1. GAPS — consecutive milestones with unexplained time between them, each
 *      classified and severity-ranked.
 *   2. ATTRIBUTION — every millisecond assigned to either an EXTERNAL PROVIDER
 *      (we waited for someone else) or OUR ORCHESTRATION (we did this to
 *      ourselves). The two always sum to the measured end-to-end latency.
 */

import { deltaMs, roundMs } from './clock.js';
import type { EventName, TelemetryEvent } from './events.js';

/* -------------------------------------------------------------------------- */
/* Gap detection                                                               */
/* -------------------------------------------------------------------------- */

export type GapSeverity = 'ok' | 'notice' | 'warning' | 'critical';

export interface LatencyGap {
  key: string;
  label: string;
  fromEvent: EventName;
  toEvent: EventName;
  fromMs: number;
  toMs: number;
  durationMs: number;
  severity: GapSeverity;
  /** Who is responsible for this stretch of time. */
  owner: 'provider' | 'ours';
  /** Plain-language explanation shown directly in the UI. */
  explanation: string;
  /** What to do about it, when there is something to do. */
  suggestion?: string;
}

interface GapRule {
  key: string;
  label: string;
  from: EventName;
  to: EventName;
  owner: 'provider' | 'ours';
  /** Milliseconds above which this stretch stops being normal. */
  noticeMs: number;
  warningMs: number;
  criticalMs: number;
  explain: (ms: number) => string;
  suggest?: (ms: number) => string;
}

/**
 * The consecutive milestone pairs worth watching. Each is a stretch of wall
 * time where something specific should be happening; when it takes much longer
 * than it should, that is a finding.
 */
const GAP_RULES: GapRule[] = [
  {
    key: 'endpoint_to_transcript',
    label: 'Endpoint to usable transcript',
    from: 'turn.endpoint_detected',
    to: 'stt.usable_transcript',
    owner: 'provider',
    noticeMs: 250,
    warningMs: 600,
    criticalMs: 1200,
    explain: (ms) =>
      `${Math.round(ms)} ms passed between deciding the caller finished and having text to act on.`,
    suggest: () =>
      'Speechmatics enforces max_delay >= 0.7 s for FINAL transcripts. Proceeding from a stabilised PARTIAL removes most of this.',
  },
  {
    key: 'transcript_to_llm',
    label: 'Transcript to LLM request',
    from: 'stt.usable_transcript',
    to: 'llm.request_started',
    owner: 'ours',
    noticeMs: 60,
    warningMs: 200,
    criticalMs: 500,
    explain: (ms) =>
      `${Math.round(ms)} ms of ORCHESTRATION time: we had the text but had not yet asked the model.`,
    suggest: () => 'Usually retrieval on the critical path. Prefetch it, or skip it for conversational turns.',
  },
  {
    key: 'llm_ttft',
    label: 'LLM time to first token',
    from: 'llm.request_started',
    to: 'llm.first_delta',
    owner: 'provider',
    noticeMs: 700,
    warningMs: 1400,
    criticalMs: 2500,
    explain: (ms) => `The model took ${Math.round(ms)} ms to produce its first token.`,
    suggest: () =>
      'External. Compare against the raw-API benchmark: if a bare request is fast and this is slow, the prompt context is the cause.',
  },
  {
    key: 'llm_to_tts',
    label: 'LLM first token to TTS submission',
    from: 'llm.first_delta',
    to: 'tts.request_started',
    owner: 'ours',
    noticeMs: 150,
    warningMs: 400,
    criticalMs: 900,
    explain: (ms) =>
      `${Math.round(ms)} ms elapsed between the model producing usable text and us sending any of it to the voice engine.`,
    suggest: () =>
      'This is text buffering, entirely ours. Sentence-boundary buffering is the usual cause; a phrase-level chunk planner removes it.',
  },
  {
    key: 'tts_ttfa',
    label: 'TTS time to first audio',
    from: 'tts.request_started',
    to: 'tts.first_audio',
    owner: 'provider',
    noticeMs: 350,
    warningMs: 700,
    criticalMs: 1500,
    explain: (ms) => `The voice engine took ${Math.round(ms)} ms to return its first audio byte.`,
    suggest: () => 'External. Verify the connection was already warm and any cloned voice was preloaded.',
  },
  {
    key: 'audio_relay',
    label: 'TTS audio to browser send',
    from: 'tts.first_audio',
    to: 'audio.first_sent',
    owner: 'ours',
    noticeMs: 15,
    warningMs: 50,
    criticalMs: 150,
    explain: (ms) => `${Math.round(ms)} ms holding audio before forwarding it.`,
    suggest: () => 'Should be a passthrough. Anything here is buffering, transcoding or a blocked event loop.',
  },
  {
    key: 'audio_transport',
    label: 'Audio transport to browser',
    from: 'audio.first_sent',
    to: 'audio.browser_first_received',
    owner: 'ours',
    noticeMs: 80,
    warningMs: 250,
    criticalMs: 600,
    explain: (ms) => `${Math.round(ms)} ms in transit to the browser.`,
    suggest: () => 'On loopback this should be near zero. A large value points at socket backpressure.',
  },
  {
    key: 'playback_delay',
    label: 'Audio received to playback',
    from: 'audio.browser_first_received',
    to: 'audio.playback_started',
    owner: 'ours',
    noticeMs: 120,
    warningMs: 300,
    criticalMs: 700,
    explain: (ms) => `${Math.round(ms)} ms between audio arriving and the caller hearing it.`,
    suggest: () => 'Mostly the jitter buffer, which is directly configurable. Lower it until underruns appear.',
  },
];

function severityFor(ms: number, r: GapRule): GapSeverity {
  if (ms >= r.criticalMs) return 'critical';
  if (ms >= r.warningMs) return 'warning';
  if (ms >= r.noticeMs) return 'notice';
  return 'ok';
}

export function detectGaps(events: TelemetryEvent[], originNs?: bigint): LatencyGap[] {
  const first = new Map<EventName, TelemetryEvent>();
  for (const e of events) if (!first.has(e.event)) first.set(e.event, e);

  const origin =
    originNs ?? first.get('vad.speech_ended')?.timestampNs ?? first.get('turn.endpoint_detected')?.timestampNs;

  const out: LatencyGap[] = [];
  for (const r of GAP_RULES) {
    const a = first.get(r.from);
    const b = first.get(r.to);
    if (!a || !b) continue;
    const ms = deltaMs(a.timestampNs, b.timestampNs);
    if (ms < 0) continue; // out of order (speculation); not a gap
    out.push({
      key: r.key,
      label: r.label,
      fromEvent: r.from,
      toEvent: r.to,
      fromMs: origin ? roundMs(deltaMs(origin, a.timestampNs)) : 0,
      toMs: origin ? roundMs(deltaMs(origin, b.timestampNs)) : roundMs(ms),
      durationMs: roundMs(ms),
      severity: severityFor(ms, r),
      owner: r.owner,
      explanation: r.explain(ms),
      suggestion: r.suggest?.(ms),
    });
  }
  return out.sort((x, y) => y.durationMs - x.durationMs);
}

/** Only the gaps worth showing as findings. */
export function significantGaps(gaps: LatencyGap[]): LatencyGap[] {
  return gaps.filter((g) => g.severity !== 'ok');
}

/* -------------------------------------------------------------------------- */
/* Provider vs our orchestration                                               */
/* -------------------------------------------------------------------------- */

export interface AttributionEntry {
  key: string;
  label: string;
  owner: 'provider' | 'ours';
  /** Which external service, when the owner is a provider. */
  provider?: string;
  durationMs: number;
  /** Share of the measured end-to-end latency. */
  sharePct: number;
}

export interface LatencyAttribution {
  totalMs: number;
  providerMs: number;
  oursMs: number;
  providerPct: number;
  oursPct: number;
  entries: AttributionEntry[];
  /** The single biggest contributor. */
  largest: AttributionEntry | null;
  /** Plain-language verdict, generated from the numbers. */
  verdict: string;
}

interface AttributionSegment {
  key: string;
  label: string;
  owner: 'provider' | 'ours';
  provider?: string;
  end: EventName;
}

/**
 * The critical path, each stretch tagged with who owns it.
 *
 * Segments are built as a CHAIN (each starts where the previous ended), so they
 * are non-overlapping and sum exactly to the measured total. That is what makes
 * "providers cost X, we cost Y" an arithmetic fact rather than an opinion.
 */
const ATTRIBUTION_CHAIN: AttributionSegment[] = [
  { key: 'endpointing', label: 'Endpoint detection', owner: 'ours', end: 'turn.endpoint_detected' },
  { key: 'stt', label: 'Speech recognition', owner: 'provider', provider: 'Speechmatics', end: 'stt.usable_transcript' },
  { key: 'rag', label: 'Knowledge retrieval', owner: 'provider', provider: 'Vector/lexical search', end: 'rag.completed' },
  { key: 'orchestration', label: 'Orchestration glue', owner: 'ours', end: 'llm.request_started' },
  { key: 'llm', label: 'Language model TTFT', owner: 'provider', provider: 'OpenAI', end: 'llm.first_delta' },
  { key: 'text_buffering', label: 'Text buffering / chunking', owner: 'ours', end: 'chunker.first_phrase_ready' },
  { key: 'tts_dispatch', label: 'TTS dispatch', owner: 'ours', end: 'tts.request_started' },
  { key: 'tts', label: 'Speech synthesis', owner: 'provider', provider: 'Hamsa', end: 'tts.first_audio' },
  { key: 'relay', label: 'Server relay', owner: 'ours', end: 'audio.first_sent' },
  { key: 'network', label: 'Audio transport', owner: 'ours', end: 'audio.browser_first_received' },
  { key: 'playback', label: 'Jitter buffer and playback', owner: 'ours', end: 'audio.playback_started' },
];

export function attributeLatency(events: TelemetryEvent[]): LatencyAttribution {
  const first = new Map<EventName, TelemetryEvent>();
  for (const e of events) if (!first.has(e.event)) first.set(e.event, e);

  const originNs =
    first.get('vad.speech_ended')?.timestampNs ?? first.get('turn.endpoint_detected')?.timestampNs ?? null;
  const endNs = first.get('audio.playback_started')?.timestampNs ?? first.get('audio.first_sent')?.timestampNs ?? null;

  if (!originNs || !endNs) {
    return {
      totalMs: 0,
      providerMs: 0,
      oursMs: 0,
      providerPct: 0,
      oursPct: 0,
      entries: [],
      largest: null,
      verdict: 'Not enough events to attribute this turn.',
    };
  }

  const totalMs = roundMs(deltaMs(originNs, endNs));
  const entries: AttributionEntry[] = [];
  let cursor = originNs;

  for (const seg of ATTRIBUTION_CHAIN) {
    const e = first.get(seg.end);
    if (!e) continue;
    // Clamp: work that finished before it was needed contributes zero.
    const segEnd = e.timestampNs > cursor ? e.timestampNs : cursor;
    const ms = roundMs(deltaMs(cursor, segEnd));
    cursor = segEnd;
    if (ms <= 0) continue;
    entries.push({
      key: seg.key,
      label: seg.label,
      owner: seg.owner,
      provider: seg.provider,
      durationMs: ms,
      sharePct: totalMs > 0 ? Math.round((ms / totalMs) * 1000) / 10 : 0,
    });
  }

  const providerMs = roundMs(entries.filter((e) => e.owner === 'provider').reduce((n, e) => n + e.durationMs, 0));
  const oursMs = roundMs(entries.filter((e) => e.owner === 'ours').reduce((n, e) => n + e.durationMs, 0));
  const largest = entries.reduce<AttributionEntry | null>((b, e) => (!b || e.durationMs > b.durationMs ? e : b), null);

  return {
    totalMs,
    providerMs,
    oursMs,
    providerPct: totalMs > 0 ? Math.round((providerMs / totalMs) * 1000) / 10 : 0,
    oursPct: totalMs > 0 ? Math.round((oursMs / totalMs) * 1000) / 10 : 0,
    entries,
    largest,
    verdict: buildVerdict(totalMs, providerMs, oursMs, largest),
  };
}

function buildVerdict(totalMs: number, providerMs: number, oursMs: number, largest: AttributionEntry | null): string {
  if (totalMs <= 0) return 'No measured latency.';
  const pct = (n: number) => Math.round((n / totalMs) * 100);

  if (!largest) return `Total ${Math.round(totalMs)} ms.`;

  const who = largest.owner === 'provider' ? `${largest.provider ?? 'an external provider'}` : 'our own code';
  const head = `Largest single contributor: ${largest.label} at ${Math.round(largest.durationMs)} ms (${largest.sharePct}%), owned by ${who}.`;

  if (oursMs > providerMs) {
    return `${head} Our orchestration accounts for ${Math.round(oursMs)} ms (${pct(
      oursMs,
    )}%) against ${Math.round(providerMs)} ms (${pct(
      providerMs,
    )}%) of external provider time — the majority of this turn's latency is ours to fix.`;
  }
  return `${head} External providers account for ${Math.round(providerMs)} ms (${pct(
    providerMs,
  )}%) against ${Math.round(oursMs)} ms (${pct(
    oursMs,
  )}%) of our own orchestration. Reducing this further needs a provider or model change, not an architecture change.`;
}

/* -------------------------------------------------------------------------- */
/* Vapi-style performance model                                                */
/* -------------------------------------------------------------------------- */

/**
 * The named latency categories from the Mode C specification. These are
 * deliberately distinct from the internal critical-path keys so the two can
 * never be confused: `modelLatency` is TIME TO FIRST TOKEN and nothing else.
 */
export interface VapiPerformanceModel {
  transportLatency: number | null;
  endpointingLatency: number | null;
  transcriberLatency: number | null;
  ragLatency: number | null;
  /** TIME TO FIRST TEXT TOKEN. Never total generation time. */
  modelLatency: number | null;
  /** Total generation time, reported separately so it cannot be mistaken. */
  modelCompletionLatency: number | null;
  llmToVoiceLatency: number | null;
  voiceLatency: number | null;
  audioOutputLatency: number | null;
  turnLatency: number | null;
  trueVoiceToVoiceLatency: number | null;
}

export function buildVapiPerformanceModel(events: TelemetryEvent[]): VapiPerformanceModel {
  const first = new Map<EventName, TelemetryEvent>();
  for (const e of events) if (!first.has(e.event)) first.set(e.event, e);
  const at = (n: EventName) => first.get(n)?.timestampNs ?? null;
  const gap = (a: EventName, b: EventName): number | null => {
    const x = at(a);
    const y = at(b);
    return x && y ? roundMs(deltaMs(x, y)) : null;
  };

  return {
    // Mic frame reaching the pipeline. Measured from the first audio the STT
    // session accepted relative to speech onset.
    transportLatency: gap('vad.speech_started', 'stt.first_audio_sent'),
    endpointingLatency: gap('vad.speech_ended', 'turn.endpoint_detected'),
    transcriberLatency: gap('turn.endpoint_detected', 'stt.usable_transcript'),
    ragLatency: gap('rag.started', 'rag.completed'),
    modelLatency: gap('llm.request_started', 'llm.first_delta'),
    modelCompletionLatency: gap('llm.request_started', 'llm.completed'),
    llmToVoiceLatency: gap('llm.first_delta', 'tts.request_started'),
    voiceLatency: gap('tts.request_started', 'tts.first_audio'),
    audioOutputLatency: gap('audio.first_sent', 'audio.playback_started'),
    turnLatency: gap('turn.endpoint_detected', 'audio.playback_started'),
    trueVoiceToVoiceLatency: gap('vad.speech_ended', 'audio.playback_started'),
  };
}
