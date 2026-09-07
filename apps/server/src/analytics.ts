/**
 * Performance dashboard aggregation (spec section 17) and session export
 * (section 25).
 *
 * Runs entirely off the realtime path, on already-derived per-turn metrics.
 */

import { roundSummary, summarizeBy, type Summary } from '@vll/telemetry';
import type { SessionConfig } from '@vll/core';

export interface TurnMetricsLike {
  turnId: string;
  pipelineMode: 'B' | 'C' | null;
  ttfsMs: number | null;
  trueE2EFromPhysicalSpeechEndMs: number | null;
  serverTtfsMs: number | null;
  endpointDetectionDelayMs: number | null;
  sttUsableTranscriptLatencyMs: number | null;
  sttFirstPartialLatencyMs: number | null;
  sttFinalLatencyMs: number | null;
  ragLatencyMs: number | null;
  ragCriticalPathMs: number | null;
  llmTtftMs: number | null;
  llmToTtsBufferDelayMs: number | null;
  ttsTtfaMs: number | null;
  audioDeliveryLatencyMs: number | null;
  playbackScheduleMs: number | null;
  totalResponseDurationMs: number | null;
  bottleneck: string | null;
  bottleneckMs: number | null;
  cancelled: boolean;
  criticalPath?: Array<{ key: string; label: string; durationMs: number }>;
  [k: string]: unknown;
}

export const DASHBOARD_METRICS = [
  { key: 'ttfsMs', label: 'TTFS (endpoint to first audio heard)', headline: true },
  { key: 'trueE2EFromPhysicalSpeechEndMs', label: 'True E2E (physical speech end to audio)' },
  { key: 'endpointDetectionDelayMs', label: 'Endpoint detection' },
  { key: 'sttUsableTranscriptLatencyMs', label: 'STT usable transcript' },
  { key: 'sttFinalLatencyMs', label: 'STT final transcript' },
  { key: 'ragLatencyMs', label: 'RAG retrieval' },
  { key: 'llmTtftMs', label: 'LLM TTFT' },
  { key: 'llmToTtsBufferDelayMs', label: 'LLM to TTS handoff' },
  { key: 'ttsTtfaMs', label: 'TTS TTFA' },
  { key: 'audioDeliveryLatencyMs', label: 'Server to browser transport' },
  { key: 'playbackScheduleMs', label: 'Jitter buffer and playback' },
  { key: 'totalResponseDurationMs', label: 'Total response duration' },
] as const;

export interface DashboardStats {
  window: number;
  turns: number;
  byMode: Record<'B' | 'C' | 'all', Record<string, Summary>>;
  bottlenecks: Array<{ key: string; label: string; count: number; avgMs: number }>;
  modeCounts: { B: number; C: number };
  /** Mean critical-path breakdown, so "where the time went" is visible in aggregate. */
  averageBreakdown: Record<'B' | 'C' | 'all', Array<{ key: string; label: string; avgMs: number; share: number }>>;
}

export function buildDashboard(all: TurnMetricsLike[], window: number): DashboardStats {
  const turns = all.filter((t) => !t.cancelled).slice(-window);
  const modeB = turns.filter((t) => t.pipelineMode === 'B');
  const modeC = turns.filter((t) => t.pipelineMode === 'C');

  const summarizeSet = (set: TurnMetricsLike[]) => {
    const out: Record<string, Summary> = {};
    for (const m of DASHBOARD_METRICS) {
      out[m.key] = roundSummary(summarizeBy(set, (t) => t[m.key] as number | null));
    }
    return out;
  };

  // Bottleneck frequency: which stage dominated the critical path most often.
  const counts = new Map<string, { label: string; count: number; total: number }>();
  for (const t of turns) {
    if (!t.bottleneck) continue;
    const seg = t.criticalPath?.find((s) => s.key === t.bottleneck);
    const entry = counts.get(t.bottleneck) ?? { label: seg?.label ?? t.bottleneck, count: 0, total: 0 };
    entry.count++;
    entry.total += t.bottleneckMs ?? 0;
    counts.set(t.bottleneck, entry);
  }

  const averageBreakdownFor = (set: TurnMetricsLike[]) => {
    const acc = new Map<string, { label: string; total: number; n: number }>();
    for (const t of set) {
      for (const seg of t.criticalPath ?? []) {
        const e = acc.get(seg.key) ?? { label: seg.label, total: 0, n: 0 };
        e.total += seg.durationMs || 0;
        e.n++;
        acc.set(seg.key, e);
      }
    }
    const rows = [...acc.entries()].map(([key, v]) => ({
      key,
      label: v.label,
      avgMs: v.n > 0 ? Math.round((v.total / v.n) * 10) / 10 : 0,
    }));
    const sum = rows.reduce((n, r) => n + r.avgMs, 0) || 1;
    return rows.map((r) => ({ ...r, share: Math.round((r.avgMs / sum) * 1000) / 10 }));
  };

  return {
    window,
    turns: turns.length,
    modeCounts: { B: modeB.length, C: modeC.length },
    byMode: { B: summarizeSet(modeB), C: summarizeSet(modeC), all: summarizeSet(turns) },
    bottlenecks: [...counts.entries()]
      .map(([key, v]) => ({ key, label: v.label, count: v.count, avgMs: Math.round((v.total / v.count) * 10) / 10 }))
      .sort((a, b) => b.count - a.count),
    averageBreakdown: {
      B: averageBreakdownFor(modeB),
      C: averageBreakdownFor(modeC),
      all: averageBreakdownFor(turns),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

export interface ExportBundle {
  meta: {
    exportedAt: string;
    tool: string;
    version: string;
    sessionId: string;
    traceId: string;
  };
  /** Provider settings, WITHOUT any credential. */
  configuration: Record<string, unknown>;
  turns: TurnMetricsLike[];
  events?: unknown[];
  dashboard: DashboardStats;
}

/**
 * A stable, non-reversible fingerprint of the system prompt, so two exports can
 * be compared for "same prompt?" without the prompt text leaving the machine.
 */
export function promptHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildExport(args: {
  sessionId: string;
  traceId: string;
  config: SessionConfig;
  turns: TurnMetricsLike[];
  events?: unknown[];
  ragInfo?: Record<string, unknown>;
  window?: number;
}): ExportBundle {
  const { sessionId, traceId, config, turns, events } = args;
  return {
    meta: {
      exportedAt: new Date().toISOString(),
      tool: 'voice-latency-lab',
      version: '1.0.0',
      sessionId,
      traceId,
    },
    configuration: {
      // Explicitly enumerated rather than spread, so a future credential field
      // added to the config can never leak into an export by accident.
      pipelineMode: config.mode,
      language: config.language,
      promptHash: promptHash(config.systemPrompt),
      promptChars: config.systemPrompt.length,
      llm: {
        model: config.llm.model,
        maxOutputTokens: config.llm.maxOutputTokens,
        temperature: config.llm.temperature,
        reasoningEffort: config.llm.reasoningEffort,
        verbosity: config.llm.verbosity,
        serviceTier: config.llm.serviceTier,
        store: config.llm.store,
        historyTurns: config.llm.historyTurns,
      },
      stt: { ...config.stt },
      tts: {
        speaker: config.tts.speaker,
        dialect: config.tts.dialect,
        languageId: config.tts.languageId,
        sampleRate: config.tts.sampleRate,
        mulaw: config.tts.mulaw,
        expressiveness: config.tts.expressiveness,
        transport: config.tts.transport,
        maxConcurrentPhrases: config.tts.maxConcurrentPhrases,
      },
      vad: { ...config.vad },
      rag: { ...config.rag, ...(args.ragInfo ?? {}) },
      audio: { ...config.audio },
      speculative: { ...config.speculative },
      chunker: config.chunker,
    },
    turns,
    events,
    dashboard: buildDashboard(turns, args.window ?? 100),
  };
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

const CSV_COLUMNS: Array<{ key: string; header: string }> = [
  { key: 'turnId', header: 'turn_id' },
  { key: 'pipelineMode', header: 'pipeline_mode' },
  { key: 'ttfsMs', header: 'ttfs_ms' },
  { key: 'trueE2EFromPhysicalSpeechEndMs', header: 'true_e2e_from_physical_speech_end_ms' },
  { key: 'serverTtfsMs', header: 'server_ttfs_ms' },
  { key: 'endpointDetectionDelayMs', header: 'endpoint_detection_delay_ms' },
  { key: 'userSpeechDurationMs', header: 'user_speech_duration_ms' },
  { key: 'silenceThresholdMs', header: 'silence_threshold_ms' },
  { key: 'sttFirstPartialLatencyMs', header: 'stt_first_partial_latency_ms' },
  { key: 'sttUsableTranscriptLatencyMs', header: 'stt_usable_transcript_latency_ms' },
  { key: 'sttFinalLatencyMs', header: 'stt_final_latency_ms' },
  { key: 'sttPartialCount', header: 'stt_partial_count' },
  { key: 'ragLatencyMs', header: 'rag_latency_ms' },
  { key: 'ragCriticalPathMs', header: 'rag_critical_path_ms' },
  { key: 'ragPrefetchHit', header: 'rag_prefetch_hit' },
  { key: 'ragEnabled', header: 'rag_enabled' },
  { key: 'llmQueueMs', header: 'llm_queue_ms' },
  { key: 'llmTtftMs', header: 'llm_ttft_ms' },
  { key: 'llmTotalMs', header: 'llm_total_ms' },
  { key: 'llmToTtsBufferDelayMs', header: 'llm_to_tts_buffer_delay_ms' },
  { key: 'textChunkingDelayMs', header: 'text_chunking_delay_ms' },
  { key: 'ttsDispatchMs', header: 'tts_dispatch_ms' },
  { key: 'ttsTtfaMs', header: 'tts_ttfa_ms' },
  { key: 'ttsPhraseCount', header: 'tts_phrase_count' },
  { key: 'serverRelayMs', header: 'server_relay_ms' },
  { key: 'audioDeliveryLatencyMs', header: 'audio_delivery_latency_ms' },
  { key: 'playbackScheduleMs', header: 'playback_schedule_ms' },
  { key: 'totalResponseDurationMs', header: 'total_response_duration_ms' },
  { key: 'bottleneck', header: 'bottleneck' },
  { key: 'bottleneckMs', header: 'bottleneck_ms' },
  { key: 'cancelled', header: 'cancelled' },
  { key: 'bargedIn', header: 'barged_in' },
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(turns: TurnMetricsLike[], config: SessionConfig): string {
  const staticCols = [
    { header: 'llm_model', value: config.llm.model },
    { header: 'reasoning_effort', value: config.llm.reasoningEffort ?? '' },
    { header: 'tts_speaker', value: config.tts.speaker },
    { header: 'tts_transport', value: config.tts.transport },
    { header: 'stt_model', value: config.stt.model },
    { header: 'stt_max_delay', value: config.stt.maxDelay },
    { header: 'prompt_hash', value: promptHash(config.systemPrompt) },
  ];

  const header = [...CSV_COLUMNS.map((c) => c.header), ...staticCols.map((c) => c.header)].join(',');
  const rows = turns.map((t) =>
    [...CSV_COLUMNS.map((c) => csvCell(t[c.key])), ...staticCols.map((c) => csvCell(c.value))].join(','),
  );
  return [header, ...rows].join('\n');
}
