/**
 * Derives per-turn latency metrics, the critical-path decomposition and the
 * waterfall spans from a raw telemetry event list.
 *
 * Two different views of the same turn are produced, and they answer different
 * questions:
 *
 *   1. `criticalPath` -- a chain of NON-OVERLAPPING segments that sums EXACTLY
 *      to the end-to-end latency. This is the "where did the time go" table.
 *      Segments are clamped so that a stage which finished early (a prefetched
 *      RAG lookup, a speculative LLM call) contributes ZERO to the critical
 *      path, which is precisely the point being demonstrated.
 *
 *   2. `spans` -- real start/end intervals for each stage, which MAY overlap.
 *      This is the Gantt / waterfall. Overlap here is the visual proof that
 *      the pipeline overlaps its stages rather than serialising them.
 *
 * Nothing here fabricates a number. Every field is null when the underlying
 * events were not observed.
 */

import { deltaMs, roundMs } from './clock.js';
import type { EventName, PipelineMode, Stage, TelemetryEvent } from './events.js';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface CriticalPathSegment {
  key: string;
  label: string;
  stage: Stage;
  startNs: bigint;
  endNs: bigint;
  durationMs: number;
  /** True when the underlying work happened but was fully hidden by overlap. */
  hidden: boolean;
  /** True when the events needed to measure this segment were not observed. */
  missing: boolean;
  note?: string;
}

export interface WaterfallSpan {
  key: string;
  label: string;
  stage: Stage;
  startNs: bigint;
  endNs: bigint;
  /** Milliseconds relative to the turn origin (physical speech end). */
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Optional sub-items, e.g. individual TTS phrases inside the Hamsa lane. */
  children?: WaterfallSpan[];
  metadata?: Record<string, unknown>;
}

export interface TurnMetrics {
  turnId: string;
  traceId: string;
  sessionId: string;
  pipelineMode: PipelineMode | null;

  /** Turn origin: the VAD-detected physical end of user speech. */
  speechEndNs: bigint | null;
  endpointNs: bigint | null;

  /* -- headline ---------------------------------------------------------- */
  /** TTFS measured from the SYSTEM's endpoint decision. */
  ttfsMs: number | null;
  /** TTFS measured from the user's PHYSICAL speech end. The honest number. */
  trueE2EFromPhysicalSpeechEndMs: number | null;
  /** Server-side TTFS: excludes network + browser playback scheduling. */
  serverTtfsMs: number | null;

  /* -- stage metrics ----------------------------------------------------- */
  endpointDetectionDelayMs: number | null;
  userSpeechDurationMs: number | null;
  silenceThresholdMs: number | null;

  sttFirstPartialLatencyMs: number | null;
  sttFinalLatencyMs: number | null;
  sttUsableTranscriptLatencyMs: number | null;
  sttPartialCount: number;

  ragLatencyMs: number | null;
  ragCriticalPathMs: number | null;
  ragPrefetchHit: boolean | null;
  ragEnabled: boolean | null;

  llmQueueMs: number | null;
  llmTtftMs: number | null;
  llmTotalMs: number | null;
  llmDeltaCount: number;
  llmChars: number | null;

  /** The LLM-to-TTS handoff: llm.first_delta -> first phrase handed to TTS. */
  llmToTtsBufferDelayMs: number | null;
  /** Same instants, Mode B naming. Identical computation on purpose. */
  textChunkingDelayMs: number | null;

  ttsDispatchMs: number | null;
  ttsTtfaMs: number | null;
  ttsPhraseCount: number;
  ttsFirstPhraseChars: number | null;

  serverRelayMs: number | null;
  audioDeliveryLatencyMs: number | null;
  playbackScheduleMs: number | null;

  /** Wall time from turn start to the last audio chunk of the response. */
  totalResponseDurationMs: number | null;
  /** Time the assistant audio actually plays for. */
  spokenAudioDurationMs: number | null;

  /* -- flags ------------------------------------------------------------- */
  cancelled: boolean;
  bargedIn: boolean;
  speculative: { started: boolean; hit: boolean; cancelled: boolean };
  retries: { llm: number; tts: number; stt: number };
  errors: Array<{ stage: Stage; event: EventName; message: string }>;

  criticalPath: CriticalPathSegment[];
  spans: WaterfallSpan[];
  /** Key of the largest critical-path segment. The bottleneck. */
  bottleneck: string | null;
  bottleneckMs: number | null;
}

/* -------------------------------------------------------------------------- */
/* Chain definition                                                            */
/* -------------------------------------------------------------------------- */

interface ChainStep {
  key: string;
  label: string;
  stage: Stage;
  /** Event whose timestamp closes this segment. */
  end: EventName;
  note?: string;
}

/**
 * The critical path to first audible speech, in causal order. Each step's
 * segment runs from wherever the previous step ended, to this step's event.
 * That construction makes the segments non-negative and exactly additive even
 * when work happened out of order (prefetch, speculation).
 */
const CRITICAL_PATH: ChainStep[] = [
  { key: 'endpointing', label: 'Endpoint detection', stage: 'turn', end: 'turn.endpoint_detected' },
  { key: 'stt', label: 'STT usable transcript', stage: 'stt', end: 'stt.usable_transcript' },
  { key: 'rag', label: 'RAG retrieval', stage: 'rag', end: 'rag.completed' },
  { key: 'orchestration', label: 'Orchestration', stage: 'pipeline', end: 'llm.request_started' },
  { key: 'llm_ttft', label: 'LLM TTFT', stage: 'llm', end: 'llm.first_delta' },
  { key: 'llm_buffer', label: 'LLM to TTS text buffering', stage: 'chunker', end: 'chunker.first_phrase_ready' },
  { key: 'tts_dispatch', label: 'TTS dispatch', stage: 'tts', end: 'tts.request_started' },
  { key: 'tts_ttfa', label: 'TTS time to first audio', stage: 'tts', end: 'tts.first_audio' },
  { key: 'server_relay', label: 'Server relay', stage: 'audio', end: 'audio.first_sent' },
  { key: 'network', label: 'Audio transport to browser', stage: 'audio', end: 'audio.browser_first_received' },
  { key: 'playback', label: 'Jitter buffer, decode and scheduling', stage: 'audio', end: 'audio.playback_started' },
];

export const CRITICAL_PATH_KEYS = CRITICAL_PATH.map((s) => s.key);
export const CRITICAL_PATH_LABELS: Record<string, string> = Object.fromEntries(
  CRITICAL_PATH.map((s) => [s.key, s.label]),
);

/* -------------------------------------------------------------------------- */
/* Derivation                                                                  */
/* -------------------------------------------------------------------------- */

class TurnIndex {
  private firstOf = new Map<string, TelemetryEvent>();
  private lastOf = new Map<string, TelemetryEvent>();
  private counts = new Map<string, number>();
  readonly events: TelemetryEvent[];

  constructor(events: TelemetryEvent[]) {
    this.events = [...events].sort((a, b) =>
      a.timestampNs < b.timestampNs ? -1 : a.timestampNs > b.timestampNs ? 1 : a.seq - b.seq,
    );
    for (const e of this.events) {
      if (!this.firstOf.has(e.event)) this.firstOf.set(e.event, e);
      this.lastOf.set(e.event, e);
      this.counts.set(e.event, (this.counts.get(e.event) ?? 0) + 1);
    }
  }

  first(n: EventName): TelemetryEvent | undefined {
    return this.firstOf.get(n);
  }
  last(n: EventName): TelemetryEvent | undefined {
    return this.lastOf.get(n);
  }
  ts(n: EventName): bigint | null {
    return this.firstOf.get(n)?.timestampNs ?? null;
  }
  lastTs(n: EventName): bigint | null {
    return this.lastOf.get(n)?.timestampNs ?? null;
  }
  count(n: EventName): number {
    return this.counts.get(n) ?? 0;
  }
  has(n: EventName): boolean {
    return this.firstOf.has(n);
  }
  meta<T = unknown>(n: EventName, key: string): T | null {
    const v = this.firstOf.get(n)?.metadata?.[key];
    return (v as T) ?? null;
  }
  lastMeta<T = unknown>(n: EventName, key: string): T | null {
    const v = this.lastOf.get(n)?.metadata?.[key];
    return (v as T) ?? null;
  }
  allOf(n: EventName): TelemetryEvent[] {
    return this.events.filter((e) => e.event === n);
  }
}

const diff = (a: bigint | null, b: bigint | null): number | null =>
  a != null && b != null ? roundMs(deltaMs(a, b)) : null;

export function deriveTurnMetrics(events: TelemetryEvent[]): TurnMetrics | null {
  if (events.length === 0) return null;
  const ix = new TurnIndex(events);
  const head = ix.events[0];

  const speechEndNs = ix.ts('vad.speech_ended');
  const speechStartNs = ix.ts('vad.speech_started');
  const endpointNs = ix.ts('turn.endpoint_detected');

  // Origin for relative display. Prefer physical speech end; fall back to the
  // endpoint decision, then to the first event, so a turn is always renderable.
  const originNs = speechEndNs ?? endpointNs ?? head.timestampNs;

  const usableNs = ix.ts('stt.usable_transcript') ?? ix.ts('stt.final');
  const llmStartNs = ix.ts('llm.request_started');
  const llmFirstDeltaNs = ix.ts('llm.first_delta');
  const llmDoneNs = ix.ts('llm.completed');
  const firstPhraseNs = ix.ts('chunker.first_phrase_ready');
  const ttsReqNs = ix.ts('tts.request_started');
  const ttsFirstAudioNs = ix.ts('tts.first_audio');
  const audioSentNs = ix.ts('audio.first_sent');
  const browserRecvNs = ix.ts('audio.browser_first_received');
  const playbackNs = ix.ts('audio.playback_started');
  const ragStartNs = ix.ts('rag.started') ?? ix.ts('rag.prefetch_started');
  const ragDoneNs = ix.ts('rag.completed');

  /* ---- critical path --------------------------------------------------- */
  const criticalPath: CriticalPathSegment[] = [];
  let cursor = originNs;
  for (const step of CRITICAL_PATH) {
    const endNs = ix.ts(step.end);
    if (endNs == null) {
      criticalPath.push({
        key: step.key,
        label: step.label,
        stage: step.stage,
        startNs: cursor,
        endNs: cursor,
        durationMs: 0,
        hidden: false,
        missing: true,
      });
      continue;
    }
    const segEnd = endNs > cursor ? endNs : cursor;
    const durationMs = roundMs(deltaMs(cursor, segEnd));
    const hidden = endNs <= cursor;
    criticalPath.push({
      key: step.key,
      label: step.label,
      stage: step.stage,
      startNs: cursor,
      endNs: segEnd,
      durationMs,
      hidden,
      missing: false,
      note: hidden ? 'completed before it was needed; fully hidden by overlap' : undefined,
    });
    cursor = segEnd;
  }

  const measured = criticalPath.filter((s) => !s.missing && s.durationMs > 0);
  let bottleneck: CriticalPathSegment | null = null;
  for (const s of measured) if (!bottleneck || s.durationMs > bottleneck.durationMs) bottleneck = s;

  /* ---- RAG critical-path contribution ---------------------------------- */
  // How much of the RAG span actually sat on the critical path, i.e. the part
  // of [ragStart, ragDone] that was NOT overlapped with earlier pipeline work.
  let ragCriticalPathMs: number | null = null;
  if (ragStartNs != null && ragDoneNs != null) {
    const gateStart = usableNs ?? endpointNs ?? originNs;
    const gateEnd = llmStartNs ?? ragDoneNs;
    const lo = ragStartNs > gateStart ? ragStartNs : gateStart;
    const hi = ragDoneNs < gateEnd ? ragDoneNs : gateEnd;
    ragCriticalPathMs = hi > lo ? roundMs(deltaMs(lo, hi)) : 0;
  } else if (ix.has('rag.skipped')) {
    ragCriticalPathMs = 0;
  }

  /* ---- spans ----------------------------------------------------------- */
  const spans = buildSpans(ix, originNs);

  /* ---- errors / retries ------------------------------------------------ */
  const errors: TurnMetrics['errors'] = [];
  for (const e of ix.events) {
    if (e.event.endsWith('.error') || e.event === 'session.warmup_step_failed' || e.event === 'bench.failed') {
      errors.push({
        stage: e.stage,
        event: e.event,
        message: String(e.metadata?.message ?? e.metadata?.error ?? 'unknown error'),
      });
    }
  }

  const ttsPhrases = ix.allOf('tts.request_started');
  const audioChunks = ix.allOf('tts.audio_chunk');
  let spokenMs: number | null = null;
  {
    // Sum durations reported by the TTS lane if available.
    let total = 0;
    let seen = false;
    for (const c of audioChunks) {
      const d = c.metadata?.durationMs;
      if (typeof d === 'number') {
        total += d;
        seen = true;
      }
    }
    if (seen) spokenMs = roundMs(total);
  }

  const lastAudio = ix.lastTs('audio.sent') ?? ix.lastTs('tts.audio_chunk');

  const llmToTtsBufferDelayMs = diff(llmFirstDeltaNs, firstPhraseNs);

  return {
    turnId: head.turnId ?? 'unknown',
    traceId: head.traceId,
    sessionId: head.sessionId,
    pipelineMode: head.pipelineMode ?? ix.events.find((e) => e.pipelineMode)?.pipelineMode ?? null,

    speechEndNs,
    endpointNs,

    ttfsMs: diff(endpointNs, playbackNs),
    trueE2EFromPhysicalSpeechEndMs: diff(speechEndNs, playbackNs),
    serverTtfsMs: diff(endpointNs, audioSentNs),

    endpointDetectionDelayMs: diff(speechEndNs, endpointNs),
    userSpeechDurationMs: diff(speechStartNs, speechEndNs),
    silenceThresholdMs: ix.meta<number>('turn.endpoint_detected', 'silenceThresholdMs'),

    sttFirstPartialLatencyMs: diff(speechStartNs, ix.ts('stt.first_partial')),
    sttFinalLatencyMs: diff(endpointNs, ix.ts('stt.final')),
    sttUsableTranscriptLatencyMs: diff(endpointNs, usableNs),
    sttPartialCount: ix.count('stt.partial') + ix.count('stt.first_partial'),

    ragLatencyMs: diff(ragStartNs, ragDoneNs),
    ragCriticalPathMs,
    ragPrefetchHit: ix.has('rag.prefetch_hit') ? true : ix.has('rag.prefetch_miss') ? false : null,
    ragEnabled: ix.has('rag.skipped') ? false : ragStartNs != null ? true : null,

    llmQueueMs: diff(usableNs ?? endpointNs, llmStartNs),
    llmTtftMs: diff(llmStartNs, llmFirstDeltaNs),
    llmTotalMs: diff(llmStartNs, llmDoneNs),
    llmDeltaCount: ix.count('llm.delta') + (ix.has('llm.first_delta') ? 1 : 0),
    llmChars: ix.lastMeta<number>('llm.completed', 'chars') ?? null,

    llmToTtsBufferDelayMs,
    textChunkingDelayMs: llmToTtsBufferDelayMs,

    ttsDispatchMs: diff(firstPhraseNs, ttsReqNs),
    ttsTtfaMs: diff(ttsReqNs, ttsFirstAudioNs),
    ttsPhraseCount: ttsPhrases.length,
    ttsFirstPhraseChars: ix.meta<number>('tts.request_started', 'chars'),

    serverRelayMs: diff(ttsFirstAudioNs, audioSentNs),
    audioDeliveryLatencyMs: diff(audioSentNs, browserRecvNs),
    playbackScheduleMs: diff(browserRecvNs, playbackNs),

    totalResponseDurationMs: diff(endpointNs, lastAudio),
    spokenAudioDurationMs: spokenMs,

    cancelled: ix.has('turn.cancelled'),
    bargedIn: ix.has('vad.barge_in_detected'),
    speculative: {
      started: ix.has('pipeline.speculative_started'),
      hit: ix.has('pipeline.speculative_hit'),
      cancelled: ix.has('pipeline.speculative_cancelled'),
    },
    retries: {
      llm: ix.count('llm.retry'),
      tts: ix.count('tts.retry'),
      stt: ix.count('stt.reconnect'),
    },
    errors,

    criticalPath,
    spans,
    bottleneck: bottleneck?.key ?? null,
    bottleneckMs: bottleneck?.durationMs ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Waterfall spans                                                             */
/* -------------------------------------------------------------------------- */

interface SpanDef {
  key: string;
  label: string;
  stage: Stage;
  from: EventName[];
  to: EventName[];
  /** When true, `to` uses the LAST occurrence rather than the first. */
  toLast?: boolean;
}

const SPAN_DEFS: SpanDef[] = [
  { key: 'voice', label: 'Voice activity', stage: 'vad', from: ['vad.speech_started'], to: ['vad.speech_ended'] },
  {
    key: 'endpointing',
    label: 'Endpoint detection',
    stage: 'turn',
    from: ['vad.speech_ended'],
    to: ['turn.endpoint_detected'],
  },
  {
    key: 'stt',
    label: 'Speechmatics',
    stage: 'stt',
    from: ['stt.first_audio_sent', 'vad.speech_started'],
    to: ['stt.usable_transcript', 'stt.final'],
  },
  {
    key: 'rag',
    label: 'RAG',
    stage: 'rag',
    from: ['rag.prefetch_started', 'rag.started'],
    to: ['rag.completed', 'rag.prefetch_completed'],
    toLast: true,
  },
  {
    key: 'llm',
    label: 'OpenAI',
    stage: 'llm',
    from: ['llm.request_started'],
    // Fall back progressively: a cancelled or errored turn never emits
    // `llm.completed`, and a lane silently vanishing from the waterfall is far
    // worse than one that ends at the last observed activity.
    to: ['llm.completed', 'llm.cancelled', 'llm.error', 'llm.delta', 'llm.first_delta'],
    toLast: true,
  },
  {
    key: 'llm_buffer',
    label: 'LLM buffer',
    stage: 'chunker',
    from: ['llm.first_delta'],
    to: ['chunker.first_phrase_ready'],
  },
  {
    key: 'chunker',
    label: 'Text chunker',
    stage: 'chunker',
    from: ['llm.first_delta'],
    to: ['chunker.completed', 'chunker.phrase_ready'],
    toLast: true,
  },
  {
    key: 'tts',
    label: 'Hamsa',
    stage: 'tts',
    from: ['tts.request_started'],
    to: ['tts.completed', 'tts.audio_chunk', 'tts.first_audio', 'tts.cancelled', 'tts.error'],
    toLast: true,
  },
  {
    key: 'transport',
    label: 'Audio transport',
    stage: 'audio',
    from: ['audio.first_sent'],
    to: ['audio.browser_first_received'],
  },
  {
    key: 'playback',
    label: 'Audio playback',
    stage: 'audio',
    from: ['audio.playback_started'],
    to: ['audio.playback_finished', 'audio.playback_started'],
    toLast: true,
  },
];

function buildSpans(ix: TurnIndex, originNs: bigint): WaterfallSpan[] {
  const out: WaterfallSpan[] = [];

  for (const def of SPAN_DEFS) {
    let startNs: bigint | null = null;
    for (const n of def.from) {
      const t = ix.ts(n);
      if (t != null) {
        startNs = t;
        break;
      }
    }
    let endNs: bigint | null = null;
    for (const n of def.to) {
      const t = def.toLast ? ix.lastTs(n) : ix.ts(n);
      if (t != null) {
        endNs = t;
        break;
      }
    }
    if (startNs == null || endNs == null) continue;
    if (endNs < startNs) endNs = startNs;

    const span: WaterfallSpan = {
      key: def.key,
      label: def.label,
      stage: def.stage,
      startNs,
      endNs,
      startMs: roundMs(deltaMs(originNs, startNs)),
      endMs: roundMs(deltaMs(originNs, endNs)),
      durationMs: roundMs(deltaMs(startNs, endNs)),
    };

    if (def.key === 'tts') span.children = buildTtsPhraseSpans(ix, originNs);
    if (def.key === 'chunker') span.children = buildChunkSpans(ix, originNs);

    out.push(span);
  }

  return out;
}

function buildTtsPhraseSpans(ix: TurnIndex, originNs: bigint): WaterfallSpan[] {
  const starts = ix.allOf('tts.request_started');
  const firstAudios = ix.allOf('tts.first_audio');
  const dones = ix.allOf('tts.completed');
  const bySeq = (list: TelemetryEvent[]) => {
    const m = new Map<number, TelemetryEvent>();
    for (const e of list) {
      const s = Number(e.metadata?.phraseSeq ?? -1);
      if (!m.has(s)) m.set(s, e);
    }
    return m;
  };
  const audioMap = bySeq(firstAudios);
  const doneMap = bySeq(dones);

  return starts.map((s) => {
    const seq = Number(s.metadata?.phraseSeq ?? -1);
    const end = doneMap.get(seq)?.timestampNs ?? audioMap.get(seq)?.timestampNs ?? s.timestampNs;
    return {
      key: `tts_phrase_${seq}`,
      label: `Phrase #${seq}`,
      stage: 'tts' as Stage,
      startNs: s.timestampNs,
      endNs: end,
      startMs: roundMs(deltaMs(originNs, s.timestampNs)),
      endMs: roundMs(deltaMs(originNs, end)),
      durationMs: roundMs(deltaMs(s.timestampNs, end)),
      metadata: {
        text: s.metadata?.text,
        chars: s.metadata?.chars,
        ttfaMs: audioMap.get(seq) ? roundMs(deltaMs(s.timestampNs, audioMap.get(seq)!.timestampNs)) : null,
      },
    };
  });
}

function buildChunkSpans(ix: TurnIndex, originNs: bigint): WaterfallSpan[] {
  const phrases = [...ix.allOf('chunker.first_phrase_ready'), ...ix.allOf('chunker.phrase_ready')].sort((a, b) =>
    a.timestampNs < b.timestampNs ? -1 : 1,
  );
  return phrases.map((p, i) => ({
    key: `chunk_${i}`,
    label: `Chunk #${Number(p.metadata?.phraseSeq ?? i + 1)}`,
    stage: 'chunker' as Stage,
    startNs: p.timestampNs,
    endNs: p.timestampNs,
    startMs: roundMs(deltaMs(originNs, p.timestampNs)),
    endMs: roundMs(deltaMs(originNs, p.timestampNs)),
    durationMs: 0,
    metadata: {
      text: p.metadata?.text,
      reason: p.metadata?.reason,
      words: p.metadata?.words,
    },
  }));
}

/* -------------------------------------------------------------------------- */
/* Target budget (spec section 26)                                             */
/* -------------------------------------------------------------------------- */

export interface BudgetTarget {
  key: string;
  label: string;
  good: number;
  warn: number;
  note: string;
}

/**
 * Engineering TARGETS, not provider SLAs. Displayed alongside measurements so a
 * regression is obvious without hard-coding a pass/fail judgement.
 */
export const LATENCY_BUDGET: BudgetTarget[] = [
  { key: 'endpointing', label: 'Endpoint detection', good: 350, warn: 500, note: 'Tunable via the silence threshold.' },
  { key: 'stt', label: 'STT usable transcript', good: 150, warn: 400, note: 'After the endpoint decision.' },
  { key: 'rag', label: 'RAG retrieval', good: 100, warn: 300, note: 'Should be ~0 when prefetched.' },
  { key: 'orchestration', label: 'Orchestration', good: 20, warn: 60, note: 'Our own glue code. Should be tiny.' },
  { key: 'llm_ttft', label: 'LLM TTFT', good: 500, warn: 1200, note: 'Model, provider and network dependent.' },
  { key: 'llm_buffer', label: 'LLM to TTS buffering', good: 120, warn: 250, note: 'The metric Mode B is built to crush.' },
  { key: 'tts_dispatch', label: 'TTS dispatch', good: 15, warn: 50, note: 'Requires an already-warm connection.' },
  { key: 'tts_ttfa', label: 'TTS TTFA', good: 300, warn: 700, note: 'Hundreds of ms, not seconds.' },
  { key: 'server_relay', label: 'Server relay', good: 10, warn: 30, note: 'Binary passthrough; no transcoding.' },
  { key: 'network', label: 'Audio transport', good: 60, warn: 250, note: 'Localhost should be near zero.' },
  { key: 'playback', label: 'Jitter buffer and decode', good: 120, warn: 250, note: 'Tunable via the playback buffer.' },
];

export const TTFS_TARGET = Object.freeze({ good: 1500, warn: 2500, ceiling: 3000 });

export function gradeSegment(key: string, ms: number): 'good' | 'warn' | 'bad' | 'unknown' {
  const b = LATENCY_BUDGET.find((x) => x.key === key);
  if (!b || !Number.isFinite(ms)) return 'unknown';
  if (ms <= b.good) return 'good';
  if (ms <= b.warn) return 'warn';
  return 'bad';
}

export function gradeTtfs(ms: number): 'good' | 'warn' | 'bad' | 'unknown' {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms <= TTFS_TARGET.good) return 'good';
  if (ms <= TTFS_TARGET.warn) return 'warn';
  return 'bad';
}
