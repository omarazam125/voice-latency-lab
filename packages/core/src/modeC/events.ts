/**
 * Typed event bus for the Mode C orchestrator.
 *
 * Mode C is a realtime conversational SCHEDULER, not a chain of awaited calls.
 * Components publish and subscribe here; none of them calls another directly.
 * That is what makes overlap possible: the LLM does not "wait for" retrieval,
 * it simply starts when a `RAG_READY` or `TURN_COMMITTED` event says it may.
 *
 * The bus is synchronous by design. Dispatch is a bounded loop over a
 * subscriber array with no allocation and no `await`, so publishing from the
 * audio path costs the same as a function call. Anything slow that a handler
 * needs to do, it schedules itself.
 */

import type { EndpointDecision, InterruptionDecision } from './endpointing.js';
import type { VoiceChunk } from './voiceChunkPlanner.js';

export type VoiceEventType =
  | 'AUDIO_FRAME'
  | 'VAD_SPEECH_START'
  | 'VAD_SPEECH_END'
  | 'STT_PARTIAL'
  | 'STT_FINAL'
  | 'ENDPOINT_EVALUATED'
  | 'TURN_COMMITTED'
  | 'RAG_SKIPPED'
  | 'RAG_STARTED'
  | 'RAG_PREFETCH_STARTED'
  | 'RAG_PREFETCH_READY'
  | 'RAG_READY'
  | 'LLM_STARTED'
  | 'LLM_FIRST_DELTA'
  | 'LLM_DELTA'
  | 'LLM_COMPLETED'
  | 'FLUSH_MARKER'
  | 'VOICE_CHUNK_READY'
  | 'TTS_STARTED'
  | 'TTS_FIRST_AUDIO'
  | 'TTS_AUDIO'
  | 'TTS_CACHE_HIT'
  | 'TTS_COMPLETED'
  | 'AUDIO_SENT'
  | 'PLAYBACK_STARTED'
  | 'ACKNOWLEDGEMENT_SPOKEN'
  | 'BARGE_IN'
  | 'INTERRUPTION_EVALUATED'
  | 'TURN_CANCELLED'
  | 'TURN_FINISHED'
  | 'PIPELINE_CLEARED'
  | 'ERROR';

export interface VoiceEventBase {
  type: VoiceEventType;
  /** Monotonic nanoseconds at which the event actually occurred. */
  atNs: bigint;
  turnId: string | null;
}

export type VoiceEvent =
  | (VoiceEventBase & { type: 'AUDIO_FRAME'; bytes: number })
  | (VoiceEventBase & { type: 'VAD_SPEECH_START'; probability: number })
  | (VoiceEventBase & { type: 'VAD_SPEECH_END'; durationMs: number })
  | (VoiceEventBase & { type: 'STT_PARTIAL'; text: string; previous: string; revisions: number })
  | (VoiceEventBase & { type: 'STT_FINAL'; text: string })
  | (VoiceEventBase & { type: 'ENDPOINT_EVALUATED'; decision: EndpointDecision })
  | (VoiceEventBase & { type: 'TURN_COMMITTED'; decision: EndpointDecision; transcript: string; source: string })
  | (VoiceEventBase & { type: 'RAG_SKIPPED'; reason: string })
  | (VoiceEventBase & { type: 'RAG_STARTED'; query: string; strategy: string })
  | (VoiceEventBase & { type: 'RAG_PREFETCH_STARTED'; query: string })
  | (VoiceEventBase & { type: 'RAG_PREFETCH_READY'; query: string; chunks: number; durationMs: number })
  | (VoiceEventBase & { type: 'RAG_READY'; chunks: number; durationMs: number; prefetched: boolean })
  | (VoiceEventBase & { type: 'LLM_STARTED'; model: string; estimatedInputTokens: number })
  | (VoiceEventBase & { type: 'LLM_FIRST_DELTA'; delta: string; ttftMs: number })
  | (VoiceEventBase & { type: 'LLM_DELTA'; delta: string })
  | (VoiceEventBase & { type: 'LLM_COMPLETED'; chars: number; totalMs: number })
  | (VoiceEventBase & { type: 'FLUSH_MARKER'; position: number; text: string })
  | (VoiceEventBase & { type: 'VOICE_CHUNK_READY'; chunk: VoiceChunk })
  | (VoiceEventBase & { type: 'TTS_STARTED'; phraseSeq: number; chars: number; text: string })
  | (VoiceEventBase & { type: 'TTS_FIRST_AUDIO'; phraseSeq: number; bytes: number })
  | (VoiceEventBase & { type: 'TTS_AUDIO'; phraseSeq: number; bytes: number })
  | (VoiceEventBase & { type: 'TTS_CACHE_HIT'; phraseSeq: number; bytes: number; text: string })
  | (VoiceEventBase & { type: 'TTS_COMPLETED'; phraseSeq: number; bytes: number })
  | (VoiceEventBase & { type: 'AUDIO_SENT'; bytes: number; phraseSeq: number; isFirst: boolean })
  | (VoiceEventBase & { type: 'PLAYBACK_STARTED' })
  | (VoiceEventBase & { type: 'ACKNOWLEDGEMENT_SPOKEN'; text: string; reason: string })
  | (VoiceEventBase & { type: 'BARGE_IN'; decision: InterruptionDecision })
  | (VoiceEventBase & { type: 'INTERRUPTION_EVALUATED'; decision: InterruptionDecision })
  | (VoiceEventBase & { type: 'TURN_CANCELLED'; reason: string })
  | (VoiceEventBase & { type: 'TURN_FINISHED'; assistantText: string })
  | (VoiceEventBase & { type: 'PIPELINE_CLEARED'; turnId: string; generation: number })
  | (VoiceEventBase & { type: 'ERROR'; stage: string; message: string });

export type VoiceEventOf<T extends VoiceEventType> = Extract<VoiceEvent, { type: T }>;

type Handler = (e: VoiceEvent) => void;

/**
 * Minimal synchronous pub/sub.
 *
 * A throwing subscriber is isolated: one broken observer must never stop audio
 * from flowing, which is the whole reason components are decoupled here.
 */
export class VoiceEventBus {
  private handlers = new Map<VoiceEventType | '*', Handler[]>();
  private history: VoiceEvent[] = [];
  private readonly keep: number;
  private dispatching = 0;

  constructor(keep = 2000) {
    this.keep = keep;
  }

  on<T extends VoiceEventType>(type: T, fn: (e: VoiceEventOf<T>) => void): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn as Handler);
    this.handlers.set(type, list);
    return () => this.off(type, fn as Handler);
  }

  onAny(fn: Handler): () => void {
    const list = this.handlers.get('*') ?? [];
    list.push(fn);
    this.handlers.set('*', list);
    return () => this.off('*', fn);
  }

  private off(type: VoiceEventType | '*', fn: Handler): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(e: VoiceEvent): void {
    this.history.push(e);
    if (this.history.length > this.keep) this.history.shift();

    // Guard against a handler that re-emits without bound.
    if (this.dispatching > 32) return;
    this.dispatching++;
    try {
      for (const fn of this.handlers.get(e.type) ?? []) {
        try {
          fn(e);
        } catch {
          /* an observer must never break the pipeline */
        }
      }
      for (const fn of this.handlers.get('*') ?? []) {
        try {
          fn(e);
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.dispatching--;
    }
  }

  /** Every event seen, for the turn trace. */
  events(): readonly VoiceEvent[] {
    return this.history;
  }

  eventsFor(turnId: string): VoiceEvent[] {
    return this.history.filter((e) => e.turnId === turnId);
  }

  clear(): void {
    this.history = [];
  }

  dispose(): void {
    this.handlers.clear();
    this.history = [];
  }
}
