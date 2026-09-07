/**
 * The typed telemetry event model.
 *
 * Every measurable moment in the pipeline is one of these events. The names are
 * stable wire identifiers -- the UI, the exporter, the derived-metric engine and
 * the tests all key off them, so treat them as an API.
 */

import { nsToMs, roundMs } from './clock.js';

/* -------------------------------------------------------------------------- */
/* Stages                                                                      */
/* -------------------------------------------------------------------------- */

export const STAGES = [
  'session',
  'mic',
  'vad',
  'stt',
  'turn',
  'rag',
  'llm',
  'chunker',
  'tts',
  'audio',
  'pipeline',
  'bench',
] as const;

export type Stage = (typeof STAGES)[number];

export type PipelineMode = 'A' | 'B' | 'C';

export const PIPELINE_MODE_LABELS: Record<PipelineMode, string> = {
  A: 'Baseline · Sentence-Buffered',
  B: 'Ultra Low Latency · Streaming',
  C: 'Vapi-Style · Orchestrated',
};

/* -------------------------------------------------------------------------- */
/* Event names                                                                 */
/* -------------------------------------------------------------------------- */

export const EVENT_NAMES = [
  // ---- session / warm-up -------------------------------------------------
  'session.created',
  'session.warmup_started',
  'session.warmup_step_started',
  'session.warmup_step_ready',
  'session.warmup_step_failed',
  'session.ready',
  'session.clock_synced',
  'session.closed',
  'session.config_updated',

  // ---- microphone --------------------------------------------------------
  'mic.opened',
  'mic.frame', // sampled, not emitted per-frame on the hot path
  'mic.stats',
  'mic.closed',

  // ---- voice activity detection -----------------------------------------
  'vad.speech_started',
  'vad.speech_ended', // PHYSICAL end of speech as detected by the VAD model
  'vad.silence_tick',
  'vad.barge_in_detected',
  'vad.barge_in_classified',

  // ---- turn / endpointing ------------------------------------------------
  'turn.endpoint_detected', // the SYSTEM decided the user stopped talking
  'turn.started',
  'turn.cancelled',
  'turn.completed',

  // ---- speech to text ----------------------------------------------------
  'stt.connection_started',
  'stt.connected',
  'stt.recognition_started',
  'stt.first_audio_sent',
  'stt.audio_ack',
  'stt.first_partial',
  'stt.partial',
  'stt.final',
  'stt.end_of_utterance',
  'stt.usable_transcript', // the transcript the pipeline actually proceeds with
  'stt.error',
  'stt.reconnect',
  'stt.disconnected',

  // ---- retrieval ---------------------------------------------------------
  'rag.started',
  'rag.completed',
  'rag.skipped',
  'rag.prefetch_started',
  'rag.prefetch_completed',
  'rag.prefetch_hit',
  'rag.prefetch_miss',
  'rag.prefetch_discarded',
  'rag.error',

  // ---- large language model ---------------------------------------------
  'llm.request_started',
  'llm.response_created',
  'llm.first_delta',
  'llm.delta',
  'llm.completed',
  'llm.cancelled',
  'llm.error',
  'llm.retry',

  // ---- text -> speech chunker -------------------------------------------
  'chunker.buffer_updated',
  'chunker.first_phrase_ready',
  'chunker.phrase_ready',
  'chunker.flush_reason',
  'chunker.completed',

  // ---- text to speech ----------------------------------------------------
  'tts.connect_started',
  'tts.connected',
  'tts.voice_preload_started',
  'tts.voice_preload_completed',
  'tts.voice_preload_failed',
  'tts.request_queued',
  'tts.request_started',
  'tts.first_audio',
  'tts.audio_chunk',
  'tts.completed',
  'tts.cancelled',
  'tts.error',
  'tts.retry',
  'tts.disconnected',

  // ---- audio transport & playback ---------------------------------------
  'audio.first_sent',
  'audio.sent',
  'audio.browser_received',
  'audio.browser_first_received',
  'audio.scheduled',
  'audio.playback_started',
  'audio.playback_finished',
  'audio.queue_depth',
  'audio.dropped_stale',
  'audio.underrun',
  'audio.flushed',

  // ---- pipeline / orchestration -----------------------------------------
  'pipeline.mode_selected',
  'pipeline.stage_overlap',
  'pipeline.speculative_started',
  'pipeline.speculative_cancelled',
  'pipeline.speculative_hit',
  'pipeline.backpressure',
  'pipeline.error',

  // ---- isolated benchmarks ----------------------------------------------
  'bench.started',
  'bench.step',
  'bench.completed',
  'bench.failed',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(EVENT_NAMES);
export const isKnownEvent = (n: string): n is EventName => EVENT_NAME_SET.has(n);

/* -------------------------------------------------------------------------- */
/* Event shape                                                                 */
/* -------------------------------------------------------------------------- */

export type EventMetadata = Record<string, unknown>;

export interface TelemetryEvent {
  /** Monotonically increasing per-store sequence. Guarantees a total order for
   *  events that share a nanosecond timestamp. */
  seq: number;
  traceId: string;
  sessionId: string;
  turnId: string | null;
  pipelineMode: PipelineMode | null;
  stage: Stage;
  event: EventName;
  /** SERVER monotonic nanoseconds. Browser-origin events are converted on
   *  arrival using the session's measured clock offset. */
  timestampNs: bigint;
  /**
   * Milliseconds since the VAD-detected PHYSICAL end of user speech for this
   * turn. Null until that anchor exists. This is the number the live monitor
   * puts on screen next to every line.
   */
  elapsedFromSpeechEndMs: number | null;
  /** Milliseconds since `turn.endpoint_detected` (the system's decision). */
  elapsedFromEndpointMs: number | null;
  /** True when the timestamp originated in the browser and was converted. */
  clientOriginated?: boolean;
  metadata: EventMetadata;
}

/** JSON-safe projection (bigint -> string) for the wire and for export. */
export interface WireEvent extends Omit<TelemetryEvent, 'timestampNs'> {
  timestampNs: string;
  timestampMs: number;
}

export function toWire(e: TelemetryEvent): WireEvent {
  const { timestampNs, ...rest } = e;
  return {
    ...rest,
    timestampNs: timestampNs.toString(),
    timestampMs: roundMs(nsToMs(timestampNs), 3),
  };
}

export function fromWire(e: WireEvent): TelemetryEvent {
  const { timestampNs, timestampMs: _ignored, ...rest } = e;
  return { ...rest, timestampNs: BigInt(timestampNs) };
}

/* -------------------------------------------------------------------------- */
/* Presentation metadata                                                       */
/* -------------------------------------------------------------------------- */

export interface EventDescriptor {
  stage: Stage;
  label: string;
  /** Milestones are rendered as headline rows in the live monitor timeline. */
  milestone?: boolean;
  /** High-frequency events are sampled/coalesced before hitting the UI. */
  highFrequency?: boolean;
  severity?: 'info' | 'warn' | 'error';
}

/**
 * Descriptor table. Every event above should appear here; `describe()` degrades
 * gracefully for any that do not, so adding an event never crashes the UI.
 */
export const EVENT_DESCRIPTORS: Partial<Record<EventName, EventDescriptor>> = {
  'session.created': { stage: 'session', label: 'Session created' },
  'session.warmup_started': { stage: 'session', label: 'Warm-up started' },
  'session.warmup_step_started': { stage: 'session', label: 'Warming up' },
  'session.warmup_step_ready': { stage: 'session', label: 'Warm-up step ready' },
  'session.warmup_step_failed': { stage: 'session', label: 'Warm-up step failed', severity: 'error' },
  'session.ready': { stage: 'session', label: 'READY', milestone: true },
  'session.clock_synced': { stage: 'session', label: 'Clock synchronised' },
  'session.closed': { stage: 'session', label: 'Session closed' },
  'session.config_updated': { stage: 'session', label: 'Configuration updated' },

  'mic.opened': { stage: 'mic', label: 'Microphone opened', milestone: true },
  'mic.frame': { stage: 'mic', label: 'PCM frame', highFrequency: true },
  'mic.stats': { stage: 'mic', label: 'Microphone stats', highFrequency: true },
  'mic.closed': { stage: 'mic', label: 'Microphone closed' },

  'vad.speech_started': { stage: 'vad', label: 'Speech started', milestone: true },
  'vad.speech_ended': { stage: 'vad', label: 'User actually stopped talking', milestone: true },
  'vad.silence_tick': { stage: 'vad', label: 'Silence', highFrequency: true },
  'vad.barge_in_detected': { stage: 'vad', label: 'BARGE-IN DETECTED', milestone: true, severity: 'warn' },
  'vad.barge_in_classified': { stage: 'vad', label: 'Barge-in verdict', milestone: true, severity: 'info' },

  'turn.endpoint_detected': { stage: 'turn', label: 'System decided user stopped', milestone: true },
  'turn.started': { stage: 'turn', label: 'Turn started', milestone: true },
  'turn.cancelled': { stage: 'turn', label: 'Turn cancelled', severity: 'warn' },
  'turn.completed': { stage: 'turn', label: 'Turn completed', milestone: true },

  'stt.connection_started': { stage: 'stt', label: 'STT connecting' },
  'stt.connected': { stage: 'stt', label: 'STT connected' },
  'stt.recognition_started': { stage: 'stt', label: 'RecognitionStarted' },
  'stt.first_audio_sent': { stage: 'stt', label: 'First audio sent to STT', milestone: true },
  'stt.audio_ack': { stage: 'stt', label: 'AudioAdded', highFrequency: true },
  'stt.first_partial': { stage: 'stt', label: 'First partial transcript', milestone: true },
  'stt.partial': { stage: 'stt', label: 'Partial transcript', highFrequency: true },
  'stt.final': { stage: 'stt', label: 'Final transcript', milestone: true },
  'stt.end_of_utterance': { stage: 'stt', label: 'EndOfUtterance', milestone: true },
  'stt.usable_transcript': { stage: 'stt', label: 'Usable transcript', milestone: true },
  'stt.error': { stage: 'stt', label: 'STT error', severity: 'error' },
  'stt.reconnect': { stage: 'stt', label: 'STT reconnect', severity: 'warn' },
  'stt.disconnected': { stage: 'stt', label: 'STT disconnected', severity: 'warn' },

  'rag.started': { stage: 'rag', label: 'Retrieval started' },
  'rag.completed': { stage: 'rag', label: 'Retrieval completed', milestone: true },
  'rag.skipped': { stage: 'rag', label: 'Retrieval skipped (RAG off)' },
  'rag.prefetch_started': { stage: 'rag', label: 'Speculative retrieval started' },
  'rag.prefetch_completed': { stage: 'rag', label: 'Speculative retrieval ready' },
  'rag.prefetch_hit': { stage: 'rag', label: 'Prefetch HIT', milestone: true },
  'rag.prefetch_miss': { stage: 'rag', label: 'Prefetch MISS', severity: 'warn' },
  'rag.prefetch_discarded': { stage: 'rag', label: 'Prefetch discarded' },
  'rag.error': { stage: 'rag', label: 'Retrieval error', severity: 'error' },

  'llm.request_started': { stage: 'llm', label: 'OpenAI request sent', milestone: true },
  'llm.response_created': { stage: 'llm', label: 'response.created' },
  'llm.first_delta': { stage: 'llm', label: 'First token', milestone: true },
  'llm.delta': { stage: 'llm', label: 'Token delta', highFrequency: true },
  'llm.completed': { stage: 'llm', label: 'LLM completed', milestone: true },
  'llm.cancelled': { stage: 'llm', label: 'LLM cancelled', severity: 'warn' },
  'llm.error': { stage: 'llm', label: 'LLM error', severity: 'error' },
  'llm.retry': { stage: 'llm', label: 'LLM RETRY', severity: 'warn' },

  'chunker.buffer_updated': { stage: 'chunker', label: 'Chunker buffer', highFrequency: true },
  'chunker.first_phrase_ready': { stage: 'chunker', label: 'First speakable phrase ready', milestone: true },
  'chunker.phrase_ready': { stage: 'chunker', label: 'Phrase ready' },
  'chunker.flush_reason': { stage: 'chunker', label: 'Flush decision', highFrequency: true },
  'chunker.completed': { stage: 'chunker', label: 'Chunker drained' },

  'tts.connect_started': { stage: 'tts', label: 'TTS connecting' },
  'tts.connected': { stage: 'tts', label: 'TTS connected' },
  'tts.voice_preload_started': { stage: 'tts', label: 'Voice preload started' },
  'tts.voice_preload_completed': { stage: 'tts', label: 'Voice preloaded' },
  'tts.voice_preload_failed': { stage: 'tts', label: 'Voice preload failed', severity: 'warn' },
  'tts.request_queued': { stage: 'tts', label: 'TTS phrase queued' },
  'tts.request_started': { stage: 'tts', label: 'TTS request sent', milestone: true },
  'tts.first_audio': { stage: 'tts', label: 'First TTS audio byte', milestone: true },
  'tts.audio_chunk': { stage: 'tts', label: 'TTS audio chunk', highFrequency: true },
  'tts.completed': { stage: 'tts', label: 'TTS phrase completed' },
  'tts.cancelled': { stage: 'tts', label: 'TTS cancelled', severity: 'warn' },
  'tts.error': { stage: 'tts', label: 'TTS error', severity: 'error' },
  'tts.retry': { stage: 'tts', label: 'TTS RETRY', severity: 'warn' },
  'tts.disconnected': { stage: 'tts', label: 'TTS disconnected', severity: 'warn' },

  'audio.first_sent': { stage: 'audio', label: 'First audio sent to browser', milestone: true },
  'audio.sent': { stage: 'audio', label: 'Audio sent', highFrequency: true },
  'audio.browser_received': { stage: 'audio', label: 'Audio received by browser', highFrequency: true },
  'audio.browser_first_received': { stage: 'audio', label: 'First audio reached browser', milestone: true },
  'audio.scheduled': { stage: 'audio', label: 'First audio scheduled', milestone: true },
  'audio.playback_started': { stage: 'audio', label: 'USER HEARS AI', milestone: true },
  'audio.playback_finished': { stage: 'audio', label: 'Playback finished' },
  'audio.queue_depth': { stage: 'audio', label: 'Playback queue depth', highFrequency: true },
  'audio.dropped_stale': { stage: 'audio', label: 'Stale audio discarded', severity: 'warn' },
  'audio.underrun': { stage: 'audio', label: 'Playback underrun', severity: 'warn' },
  'audio.flushed': { stage: 'audio', label: 'Playback flushed' },

  'pipeline.mode_selected': { stage: 'pipeline', label: 'Pipeline mode' },
  'pipeline.stage_overlap': { stage: 'pipeline', label: 'Overlap window' },
  'pipeline.speculative_started': { stage: 'pipeline', label: 'Speculative generation started', severity: 'warn' },
  'pipeline.speculative_cancelled': { stage: 'pipeline', label: 'Speculative generation cancelled', severity: 'warn' },
  'pipeline.speculative_hit': { stage: 'pipeline', label: 'Speculative HIT', milestone: true },
  'pipeline.backpressure': { stage: 'pipeline', label: 'BACKPRESSURE', severity: 'warn' },
  'pipeline.error': { stage: 'pipeline', label: 'Pipeline error', severity: 'error' },

  'bench.started': { stage: 'bench', label: 'Benchmark started' },
  'bench.step': { stage: 'bench', label: 'Benchmark step' },
  'bench.completed': { stage: 'bench', label: 'Benchmark completed' },
  'bench.failed': { stage: 'bench', label: 'Benchmark failed', severity: 'error' },
};

export function describe(event: EventName | string): EventDescriptor {
  const d = EVENT_DESCRIPTORS[event as EventName];
  if (d) return d;
  const stage = (event.split('.')[0] as Stage) ?? 'pipeline';
  return { stage: STAGES.includes(stage) ? stage : 'pipeline', label: event };
}

export function stageOf(event: EventName | string): Stage {
  return describe(event).stage;
}

export const isHighFrequency = (event: EventName | string): boolean => describe(event).highFrequency === true;
export const isMilestone = (event: EventName | string): boolean => describe(event).milestone === true;
