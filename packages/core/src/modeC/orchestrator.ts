/**
 * ModeCOrchestrator — the Vapi-style realtime conversational scheduler.
 *
 * This is NOT `await stt(); await rag(); await llm(); await tts()`. Components
 * publish events and react to events, which is what lets them overlap:
 *
 *   - endpointing runs continuously against the live transcript, so the turn
 *     commits the moment the CONTENT looks finished rather than when a fixed
 *     timer expires;
 *   - retrieval may already be done before the turn commits;
 *   - the voice planner submits a speakable phrase while the model is still
 *     generating;
 *   - audio starts playing while later phrases are still being synthesised.
 *
 * The caller never waits for the whole pipeline. They wait only until enough
 * information exists to safely produce the FIRST natural audio.
 */

import { deltaMs, roundMs } from '@vll/telemetry';
import type { ScopedEmitter } from '@vll/telemetry';
import type {
  LlmMessage,
  LlmProvider,
  ProviderError,
  RetrievalResult,
  Retriever,
  TtsAudioChunk,
  TtsProvider,
} from '../providers.js';
import type { SessionConfig } from '../config.js';
import { queryEquivalence } from '../text/similarity.js';
import { TtsPhraseScheduler } from '../pipeline/ttsScheduler.js';
import type { TranscriptSource } from '../pipeline/turnRunner.js';
import { EndpointingManager, usefulWordCount, type EndpointDecision } from './endpointing.js';
import { VoiceChunkPlanner, type VoiceChunk } from './voiceChunkPlanner.js';
import { VoiceEventBus } from './events.js';
import { TtsCache } from './ttsCache.js';
import type { ModeCConfig } from './config.js';

/* -------------------------------------------------------------------------- */
/* Context / result                                                            */
/* -------------------------------------------------------------------------- */

export interface ModeCPrefetch {
  query: string;
  startedAtNs: bigint;
  promise: Promise<RetrievalResult | null>;
}

export interface ModeCContext {
  turnId: string;
  traceId: string;
  generation: number;
  /**
   * Supplies the acknowledgement phrase, or null when the cooldown says stay
   * quiet. Injected because the decision needs cross-turn memory and this
   * object is rebuilt every turn.
   */
  takeAcknowledgement?: () => string | null;
  config: SessionConfig;
  modeC: ModeCConfig;
  speechEndNs: bigint;
  endpointNs: bigint;
  /** The decision that committed this turn, for the trace. */
  decision: EndpointDecision | null;
  history: LlmMessage[];
  transcripts: TranscriptSource;
  prefetch?: ModeCPrefetch | null;
  telemetry: ScopedEmitter;
  bus: VoiceEventBus;
  ttsCache: TtsCache;
}

export interface ModeCDeps {
  llm: LlmProvider;
  tts: TtsProvider;
  retriever: Retriever | null;
}

export interface ModeCHooks {
  onAudio: (chunk: TtsAudioChunk) => void;
  onAssistantText?: (text: string) => void;
  onFinished?: (r: ModeCResult) => void;
}

export interface ModeCResult {
  turnId: string;
  transcript: string;
  transcriptSource: string;
  assistantText: string;
  retrieval: RetrievalResult | null;
  ragStrategy: string;
  ragSkipped: boolean;
  acknowledgementSpoken: string | null;
  cancelled: boolean;
  error?: ProviderError;
  /** Estimated input-token accounting, for the context-size investigation. */
  context: ContextAccounting;
}

/* -------------------------------------------------------------------------- */
/* Context accounting                                                          */
/* -------------------------------------------------------------------------- */

export interface ContextAccounting {
  systemPromptCharacters: number;
  estimatedSystemPromptTokens: number;
  historyMessages: number;
  estimatedHistoryTokens: number;
  ragChunks: number;
  ragCharacters: number;
  estimatedRagTokens: number;
  toolCount: number;
  estimatedToolSchemaTokens: number;
  userCharacters: number;
  totalEstimatedInputTokens: number;
  /** Characters of the stable, cacheable prefix (prompt + history). */
  staticPrefixCharacters: number;
  /** Characters of the volatile suffix (retrieved context + this question). */
  dynamicSuffixCharacters: number;
}

/**
 * Token estimate.
 *
 * Arabic is far denser per token than English under BPE tokenisers — roughly
 * 2 characters per token against ~4 for English — so a single ratio would
 * badly under-count Arabic prompts. The estimate is clearly labelled as such
 * everywhere it is displayed; exact counts come from the provider's own usage
 * report when it returns one.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let arabic = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0600 && c <= 0x06ff) arabic++;
  }
  const ratio = arabic / Math.max(1, text.length);
  const charsPerToken = 4 - ratio * 2; // 4 for pure Latin, ~2 for pure Arabic
  return Math.ceil(text.length / charsPerToken);
}

export function buildContextAccounting(args: {
  systemPrompt: string;
  history: LlmMessage[];
  ragText: string;
  ragChunks: number;
  userText: string;
  toolCount?: number;
  toolSchemaChars?: number;
}): ContextAccounting {
  const historyChars = args.history.reduce((n, m) => n + m.content.length, 0);
  const staticPrefix = args.systemPrompt.length + historyChars;
  const dynamicSuffix = args.ragText.length + args.userText.length;
  const toolTokens = estimateTokens(' '.repeat(args.toolSchemaChars ?? 0));

  return {
    systemPromptCharacters: args.systemPrompt.length,
    estimatedSystemPromptTokens: estimateTokens(args.systemPrompt),
    historyMessages: args.history.length,
    estimatedHistoryTokens: args.history.reduce((n, m) => n + estimateTokens(m.content), 0),
    ragChunks: args.ragChunks,
    ragCharacters: args.ragText.length,
    estimatedRagTokens: estimateTokens(args.ragText),
    toolCount: args.toolCount ?? 0,
    estimatedToolSchemaTokens: toolTokens,
    userCharacters: args.userText.length,
    totalEstimatedInputTokens:
      estimateTokens(args.systemPrompt) +
      args.history.reduce((n, m) => n + estimateTokens(m.content), 0) +
      estimateTokens(args.ragText) +
      estimateTokens(args.userText) +
      toolTokens,
    staticPrefixCharacters: staticPrefix,
    dynamicSuffixCharacters: dynamicSuffix,
  };
}

/* -------------------------------------------------------------------------- */
/* Retrieval decision                                                          */
/* -------------------------------------------------------------------------- */

export interface RetrievalDecision {
  retrieve: boolean;
  reason: string;
}

/**
 * Conditional retrieval: decide whether this turn needs the knowledge base at
 * all. Spending 500 ms retrieving documents to answer "سلام عليكم" is pure
 * latency for zero benefit.
 */
export function shouldRetrieve(text: string, cfg: ModeCConfig['rag']): RetrievalDecision {
  const t = text.trim().toLowerCase();
  if (!t) return { retrieve: false, reason: 'empty transcript' };

  const words = usefulWordCount(t);
  if (words < cfg.minWordsForRetrieval) {
    return { retrieve: false, reason: `only ${words} word(s); below the ${cfg.minWordsForRetrieval}-word threshold` };
  }

  // A short turn that is ENTIRELY a greeting needs nothing from the KB.
  if (words <= 4) {
    for (const p of cfg.skipPatterns) {
      const needle = p.trim().toLowerCase();
      if (needle && t.includes(needle)) {
        return { retrieve: false, reason: `conversational phrase "${p}" — no knowledge needed` };
      }
    }
  }

  for (const p of cfg.triggerPatterns) {
    const needle = p.trim().toLowerCase();
    if (needle && t.includes(needle)) {
      return { retrieve: true, reason: `matched trigger "${p}"` };
    }
  }

  // Default to retrieving: a missed retrieval produces a wrong answer, which is
  // worse than a slightly slower right one.
  return { retrieve: true, reason: 'no skip pattern matched; retrieving by default' };
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                                */
/* -------------------------------------------------------------------------- */

export class ModeCOrchestrator {
  private cancelled = false;
  private planner: VoiceChunkPlanner | null = null;
  private scheduler: TtsPhraseScheduler | null = null;
  private llmCancel: ((r?: string) => void) | null = null;
  private assistantText = '';
  private firstAudioSent = false;
  /** Audio being accumulated for the TTS cache, keyed by phrase sequence. */
  private cacheAccum = new Map<number, Uint8Array[]>();
  private cacheText = new Map<number, string>();
  private acknowledgementSpoken: string | null = null;
  private context: ContextAccounting | null = null;

  constructor(
    private readonly ctx: ModeCContext,
    private readonly deps: ModeCDeps,
    private readonly hooks: ModeCHooks,
  ) {}

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * clearCurrentVoicePipeline — the single atomic barge-in operation.
   *
   * Cancels generation, cancels synthesis, drops unsent phrases, invalidates
   * every queued audio packet and releases per-turn resources. Nothing from
   * this turn may reach the caller afterwards.
   */
  clearCurrentVoicePipeline(reason = 'barge_in'): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const t = this.ctx.telemetry;

    try {
      this.llmCancel?.(reason);
      t.emit('llm.cancelled', { reason });
    } catch {
      /* ignore */
    }
    this.planner?.cancel();
    this.scheduler?.cancel(reason);

    t.emit('turn.cancelled', { reason, mode: 'C' });
    this.ctx.bus.emit({
      type: 'PIPELINE_CLEARED',
      atNs: nowNs(),
      turnId: this.ctx.turnId,
      generation: this.ctx.generation,
    });
  }

  /** Alias kept for symmetry with the other modes. */
  cancel(reason = 'barge_in'): void {
    this.clearCurrentVoicePipeline(reason);
  }

  async run(): Promise<ModeCResult> {
    const t = this.ctx.telemetry;
    const cfg = this.ctx.config;
    const mc = this.ctx.modeC;

    t.emit('turn.started', { mode: 'C', generation: this.ctx.generation });
    t.emit('pipeline.mode_selected', {
      mode: 'C',
      endpointingStrategy: mc.endpointing.strategy,
      ragStrategy: mc.rag.strategy,
      chunkPlanEnabled: mc.chunkPlan.enabled,
    });

    /* -- transcript ------------------------------------------------------- */
    const resolved = await this.resolveTranscript();
    if (this.cancelled) return this.finish(this.result(resolved.text, resolved.source, null, 'cancelled', false, true));
    if (!resolved.text.trim()) {
      t.emit('stt.usable_transcript', { text: '', source: resolved.source, empty: true });
      t.emit('turn.completed', { reason: 'empty_transcript' });
      return this.finish(this.result('', 'none', null, 'none', false, false));
    }
    t.emit('stt.usable_transcript', {
      text: resolved.text,
      source: resolved.source,
      chars: resolved.text.length,
      provisional: resolved.source !== 'final',
      endpointReason: this.ctx.decision?.reason,
      endpointReasonCode: this.ctx.decision?.reasonCode,
      endpointConfidence: this.ctx.decision?.confidence,
    });

    /* -- retrieval -------------------------------------------------------- */
    const { retrieval, skipped, strategy } = await this.runRetrieval(resolved.text);
    if (this.cancelled) return this.finish(this.result(resolved.text, resolved.source, retrieval, strategy, skipped, true));

    /* -- generation + speech --------------------------------------------- */
    const err = await this.generateAndSpeak(resolved.text, retrieval);
    const res = this.result(resolved.text, resolved.source, retrieval, strategy, skipped, this.cancelled, err);
    if (!this.cancelled) t.emit('turn.completed', { chars: this.assistantText.length, mode: 'C' });
    return this.finish(res);
  }

  /**
   * Every exit from run() passes through here.
   *
   * The hook used to be called only on the happy path, so the three early
   * returns skipped it. Two were harmless because a cancellation clears the
   * turn by another route, but the EMPTY-TRANSCRIPT return was not: nothing
   * else clears `currentTurn`, run() resolves rather than throwing so the
   * `.catch()` never fires, and the session is left pinned to a turn that can
   * never complete. The caller keeps talking and the agent never speaks again
   * for the rest of the call.
   *
   * Guarded so a future double-call cannot fire it twice.
   */
  private finished = false;

  private finish(res: ModeCResult): ModeCResult {
    if (this.finished) return res;
    this.finished = true;
    this.hooks.onFinished?.(res);
    return res;
  }

  private result(
    transcript: string,
    transcriptSource: string,
    retrieval: RetrievalResult | null,
    ragStrategy: string,
    ragSkipped: boolean,
    cancelled: boolean,
    error?: ProviderError,
  ): ModeCResult {
    return {
      turnId: this.ctx.turnId,
      transcript,
      transcriptSource,
      assistantText: this.assistantText,
      retrieval,
      ragStrategy,
      ragSkipped,
      acknowledgementSpoken: this.acknowledgementSpoken,
      cancelled,
      error,
      context:
        this.context ??
        buildContextAccounting({
          systemPrompt: this.ctx.config.systemPrompt,
          history: [],
          ragText: '',
          ragChunks: 0,
          userText: transcript,
        }),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Transcript                                                              */
  /* ---------------------------------------------------------------------- */

  private async resolveTranscript(): Promise<{ text: string; source: string }> {
    const src = this.ctx.transcripts;
    const mc = this.ctx.modeC;

    // The endpointing engine already decided the turn is complete, and it based
    // that on the live transcript. Re-waiting for a FINAL here would throw away
    // everything the engine just bought.
    const finalAlready = src.finalSoFar();
    const latest = src.latestPartial();

    if (finalAlready.trim() && finalAlready.trim().length >= latest.trim().length * 0.8) {
      return { text: finalAlready, source: 'final' };
    }

    const stable = src.stablePartial(mc.endpointing.transcriptStabilityMs);
    if (stable && stable.text.trim()) return { text: stable.text, source: 'stable_partial' };

    if (latest.trim()) {
      // Bounded grace only: a settled FINAL that is already nearly here is worth
      // a few tens of milliseconds, a slow one is not.
      const final = await src.waitForFinal(Math.min(250, mc.endpointing.waitSeconds * 1000));
      if (final && final.trim()) return { text: final, source: 'final' };
      return { text: src.latestPartial() || latest, source: 'latest_partial' };
    }

    const final = await src.waitForFinal(1500);
    if (final && final.trim()) return { text: final, source: 'final' };
    const p = src.latestPartial();
    return { text: p, source: p ? 'latest_partial' : 'none' };
  }

  /* ---------------------------------------------------------------------- */
  /* Retrieval                                                               */
  /* ---------------------------------------------------------------------- */

  private async runRetrieval(
    query: string,
  ): Promise<{ retrieval: RetrievalResult | null; skipped: boolean; strategy: string }> {
    const t = this.ctx.telemetry;
    const cfg = this.ctx.config;
    const mc = this.ctx.modeC;
    const strategy = mc.rag.strategy;

    if (!cfg.rag.enabled || !this.deps.retriever) {
      t.emit('rag.skipped', { reason: cfg.rag.enabled ? 'no_index' : 'disabled', strategy });
      return { retrieval: null, skipped: true, strategy };
    }

    /* -- conditional: is retrieval needed at all? ------------------------ */
    if (strategy === 'conditional') {
      const d = shouldRetrieve(query, mc.rag);
      this.ctx.bus.emit({ type: 'RAG_SKIPPED', atNs: nowNs(), turnId: this.ctx.turnId, reason: d.reason });
      if (!d.retrieve) {
        t.emit('rag.skipped', { reason: d.reason, strategy, classified: true });
        return { retrieval: null, skipped: true, strategy };
      }
    }

    /* -- prefetch reuse --------------------------------------------------- */
    if (strategy === 'prefetch' && this.ctx.prefetch) {
      const pf = this.ctx.prefetch;
      const agreement = queryEquivalence(pf.query, query);
      if (agreement >= mc.rag.prefetchReuseThreshold) {
        const result = await pf.promise;
        if (result && !this.cancelled) {
          t.emit('rag.prefetch_hit', {
            agreement: Math.round(agreement * 1000) / 1000,
            prefetchQuery: pf.query,
            finalQuery: query,
            savedMs: roundMs(deltaMs(pf.startedAtNs, nowNs())),
            chunks: result.chunks.length,
            strategy,
          });
          t.emit('rag.completed', {
            durationMs: result.durationMs,
            chunks: result.chunks.length,
            prefetched: true,
            strategy,
          });
          this.ctx.bus.emit({
            type: 'RAG_READY',
            atNs: nowNs(),
            turnId: this.ctx.turnId,
            chunks: result.chunks.length,
            durationMs: result.durationMs,
            prefetched: true,
          });
          return { retrieval: { ...result, prefetched: true }, skipped: false, strategy };
        }
      }
      t.emit('rag.prefetch_miss', {
        agreement: Math.round(agreement * 1000) / 1000,
        prefetchQuery: pf.query,
        finalQuery: query,
        strategy,
      });
      // Wasted work is reported, never hidden.
      t.emit('rag.prefetch_discarded', { reason: 'query_diverged', wasted: true });
    }

    /* -- blocking retrieval ---------------------------------------------- */
    const start = nowNs();
    t.emit('rag.started', { query, topK: cfg.rag.topK, strategy });
    this.ctx.bus.emit({ type: 'RAG_STARTED', atNs: start, turnId: this.ctx.turnId, query, strategy });
    try {
      const result = await this.deps.retriever.search(query, {
        topK: cfg.rag.topK,
        minScore: cfg.rag.minScore,
        minCoverage: cfg.rag.minCoverage,
      });
      const durationMs = roundMs(deltaMs(start, nowNs()));
      t.emit('rag.completed', {
        durationMs,
        chunks: result.chunks.length,
        prefetched: false,
        strategy,
        sources: result.chunks.map((c) => c.source.filename),
      });
      this.ctx.bus.emit({
        type: 'RAG_READY',
        atNs: nowNs(),
        turnId: this.ctx.turnId,
        chunks: result.chunks.length,
        durationMs,
        prefetched: false,
      });
      return { retrieval: result, skipped: false, strategy };
    } catch (e: any) {
      t.emit('rag.error', { message: e?.message ?? String(e), strategy });
      return { retrieval: null, skipped: false, strategy };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Generation + speech                                                     */
  /* ---------------------------------------------------------------------- */

  private async generateAndSpeak(transcript: string, retrieval: RetrievalResult | null): Promise<ProviderError | undefined> {
    const t = this.ctx.telemetry;
    const cfg = this.ctx.config;
    const mc = this.ctx.modeC;

    /* -- TTS scheduler ---------------------------------------------------- */
    this.scheduler = new TtsPhraseScheduler(
      {
        provider: this.deps.tts,
        turnId: this.ctx.turnId,
        generation: this.ctx.generation,
        maxConcurrent: cfg.tts.maxConcurrentPhrases,
        voice: {
          speaker: cfg.tts.speaker,
          dialect: cfg.tts.dialect,
          languageId: cfg.tts.languageId,
          sampleRate: cfg.tts.sampleRate,
          mulaw: cfg.tts.mulaw,
          expressiveness: cfg.tts.expressiveness,
        },
        now: nowNs,
      },
      {
        onQueued: (p, depth) => t.emit('tts.request_queued', { phraseSeq: p.seq, chars: p.text.length, queueDepth: depth }),
        onRequestStarted: (p) => {
          // Open an accumulator for this phrase so its audio can be cached.
          if (mc.ttsCache.enabled && this.ctx.ttsCache.cacheable(p.text)) {
            this.cacheAccum.set(p.seq, []);
            this.cacheText.set(p.seq, p.text);
          }
          t.emit('tts.request_started', {
            phraseSeq: p.seq,
            text: p.text,
            chars: p.text.length,
            waitedInQueueMs: roundMs(deltaMs(p.queuedAtNs, nowNs())),
          });
          this.ctx.bus.emit({
            type: 'TTS_STARTED',
            atNs: nowNs(),
            turnId: this.ctx.turnId,
            phraseSeq: p.seq,
            chars: p.text.length,
            text: p.text,
          });
        },
        onFirstAudio: (chunk, p) => {
          t.emit('tts.first_audio', { phraseSeq: p.seq, bytes: chunk.data.byteLength });
          this.ctx.bus.emit({
            type: 'TTS_FIRST_AUDIO',
            atNs: nowNs(),
            turnId: this.ctx.turnId,
            phraseSeq: p.seq,
            bytes: chunk.data.byteLength,
          });
        },
        onAudio: (chunk) => {
          // Collect a copy for the cache BEFORE emitting. Nothing else in the
          // pipeline retains the audio, so without this the cache could only
          // ever be read and never written -- which is exactly what it did:
          // every lookup missed because set() had no call site at all.
          if (mc.ttsCache.enabled) {
            const acc = this.cacheAccum.get(chunk.phraseSeq);
            if (acc) acc.push(chunk.data);
          }
          this.emitAudio(chunk);
        },
        onPhraseCompleted: (p, info) => {
          t.emit('tts.completed', { phraseSeq: p.seq, ...info });
          this.storePhraseInCache(p.seq, info.bytes);
        },
        onError: (e, p) => t.emit('tts.error', { message: e.message, code: e.code, phraseSeq: p?.seq }),
        onBackpressure: (info) => t.emit('pipeline.backpressure', { where: 'modeC_tts_scheduler', ...info }),
        onDiscarded: (info) => t.emit('audio.dropped_stale', info),
      },
    );
    const scheduler = this.scheduler;

    /* -- perceived latency acknowledgement -------------------------------- */
    // Spoken BEFORE the model request when a genuinely slow operation is
    // pending, so the caller hears something while it runs. Reported as a
    // separate number: it changes perceived latency, not real latency.
    if (mc.perceivedLatency.enabled && retrieval && retrieval.durationMs >= mc.perceivedLatency.minOperationMs) {
      // Ask the session, which owns the cooldown counter and the rotation.
      // Falling back to phrases[0] keeps replays and benchmarks working, where
      // there is no session to consult.
      const phrase = this.ctx.takeAcknowledgement
        ? this.ctx.takeAcknowledgement()
        : mc.perceivedLatency.phrases[0];
      if (phrase) {
        this.acknowledgementSpoken = phrase;
        t.emit('chunker.first_phrase_ready', {
          text: phrase,
          acknowledgement: true,
          reason: 'perceived_latency',
          phraseSeq: 0,
        });
        this.ctx.bus.emit({
          type: 'ACKNOWLEDGEMENT_SPOKEN',
          atNs: nowNs(),
          turnId: this.ctx.turnId,
          text: phrase,
          reason: `retrieval took ${Math.round(retrieval.durationMs)} ms`,
        });
        scheduler.enqueue({
          seq: 0,
          text: phrase,
          reason: 'forced',
          words: usefulWordCount(phrase),
          chars: phrase.length,
          isFirst: true,
          createdAtNs: nowNs(),
          sinceFirstDeltaMs: null,
          waitedMs: 0,
          consumedChars: phrase.length,
        });
      }
    }

    /* -- voice chunk planner ---------------------------------------------- */
    this.planner = new VoiceChunkPlanner(
      mc.chunkPlan,
      {
        onFirstChunk: (c) => {
          t.emit('chunker.first_phrase_ready', {
            text: c.text,
            words: c.words,
            chars: c.chars,
            reason: c.reason,
            phraseSeq: c.seq,
            flushTriggered: c.flushTriggered,
            sinceFirstDeltaMs: c.sinceFirstDeltaMs != null ? roundMs(c.sinceFirstDeltaMs) : null,
          });
        },
        onChunk: (c) => {
          if (!c.isFirst) {
            t.emit('chunker.phrase_ready', {
              text: c.text,
              words: c.words,
              chars: c.chars,
              reason: c.reason,
              phraseSeq: c.seq,
              flushTriggered: c.flushTriggered,
            });
          }
          this.ctx.bus.emit({ type: 'VOICE_CHUNK_READY', atNs: c.createdAtNs, turnId: this.ctx.turnId, chunk: c });
          this.dispatchChunk(c, scheduler);
        },
        onFlush: (f) => {
          t.emit('chunker.flush_reason', {
            flushTriggered: true,
            flushPosition: f.position,
            text: f.text.slice(0, 120),
          });
          this.ctx.bus.emit({
            type: 'FLUSH_MARKER',
            atNs: f.atNs,
            turnId: this.ctx.turnId,
            position: f.position,
            text: f.text.slice(0, 200),
          });
        },
        onDecision: (d) =>
          t.emit('chunker.buffer_updated', {
            buffer: d.buffer.slice(-160),
            words: d.words,
            chars: d.chars,
            eligible: d.eligible,
            action: d.action,
            waitedMs: roundMs(d.waitedMs),
          }),
      },
      { now: nowNs, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as any) },
    );
    const planner = this.planner;

    /* -- prompt assembly + context accounting ----------------------------- */
    const { messages, ragText } = this.buildMessages(transcript, retrieval);
    this.context = buildContextAccounting({
      systemPrompt: cfg.systemPrompt,
      history: this.ctx.history.slice(-cfg.llm.historyTurns * 2),
      ragText,
      ragChunks: retrieval?.chunks.length ?? 0,
      userText: transcript,
    });

    const llmStart = nowNs();
    t.emit('llm.request_started', {
      model: cfg.llm.model,
      reasoningEffort: cfg.llm.reasoningEffort,
      verbosity: cfg.llm.verbosity,
      serviceTier: cfg.llm.serviceTier,
      maxOutputTokens: cfg.llm.maxOutputTokens,
      mode: 'C',
      ...this.context,
    });
    this.ctx.bus.emit({
      type: 'LLM_STARTED',
      atNs: llmStart,
      turnId: this.ctx.turnId,
      model: cfg.llm.model,
      estimatedInputTokens: this.context.totalEstimatedInputTokens,
    });

    const handle = this.deps.llm.stream(
      {
        model: cfg.llm.model,
        instructions: cfg.systemPrompt,
        input: messages,
        maxOutputTokens: cfg.llm.maxOutputTokens,
        temperature: cfg.llm.temperature ?? undefined,
        reasoningEffort: cfg.llm.reasoningEffort,
        verbosity: cfg.llm.verbosity,
        serviceTier: cfg.llm.serviceTier,
        store: cfg.llm.store,
        promptCacheKey: `vllC_${hashString(cfg.systemPrompt)}`,
      },
      {
        onCreated: (info) => t.emit('llm.response_created', { responseId: info.responseId }),
        // Telemetry only: onDelta also fires for the first delta.
        onFirstDelta: (d) => {
          const ttftMs = roundMs(deltaMs(llmStart, nowNs()));
          t.emit('llm.first_delta', { ttftMs, delta: d, chars: d.length });
          this.ctx.bus.emit({ type: 'LLM_FIRST_DELTA', atNs: nowNs(), turnId: this.ctx.turnId, delta: d, ttftMs });
        },
        onDelta: (d) => {
          t.emit('llm.delta', { chars: d.length, delta: d });
          planner.push(d);
        },
        onCompleted: (info) => {
          this.assistantText = info.text;
          t.emit('llm.completed', {
            // The full text, not just its length. Diagnosing "the agent said
            // something strange" means comparing what the model WROTE against
            // the strings actually handed to the voice engine, and `chars`
            // cannot answer that question.
            text: info.text,
            chars: info.text.length,
            totalMs: roundMs(deltaMs(llmStart, nowNs())),
            usage: info.usage,
          });
          this.hooks.onAssistantText?.(info.text);
        },
        onError: (e) => t.emit('llm.error', { message: e.message, code: e.code, retryable: e.retryable }),
      },
    );
    this.llmCancel = handle.cancel;

    const outcome = await handle.done;
    if (!this.assistantText) this.assistantText = outcome.text;

    if (outcome.cancelled || this.cancelled) {
      planner.cancel();
      scheduler.cancel('turn_cancelled');
      return outcome.error;
    }

    planner.finish();
    scheduler.markChunkerDone();
    await this.waitForDrain();
    return outcome.error;
  }

  /**
   * Hand one planned phrase to the TTS scheduler, checking the phrase cache
   * first when it is enabled.
   */
  private dispatchChunk(c: VoiceChunk, scheduler: TtsPhraseScheduler): void {
    const cfg = this.ctx.config;
    const mc = this.ctx.modeC;

    if (mc.ttsCache.enabled) {
      const parts = this.cacheKeyFor(c.text);
      const hit = this.ctx.ttsCache.get(parts);
      if (hit) {
        this.ctx.telemetry.emit('tts.first_audio', {
          phraseSeq: c.seq,
          bytes: hit.bytes,
          cacheHit: true,
          // Flagged so provider statistics can exclude it: this measures our
          // own memory, not the TTS engine.
          excludeFromProviderStats: true,
        });
        this.ctx.bus.emit({
          type: 'TTS_CACHE_HIT',
          atNs: nowNs(),
          turnId: this.ctx.turnId,
          phraseSeq: c.seq,
          bytes: hit.bytes,
          text: c.text,
        });
        this.emitAudio({
          data: hit.audio,
          turnId: this.ctx.turnId,
          phraseSeq: c.seq,
          generation: this.ctx.generation,
          audioSeq: 0,
          isFirst: true,
        });
        return;
      }
    }

    scheduler.enqueue({
      seq: c.seq,
      text: c.text,
      reason: 'forced',
      words: c.words,
      chars: c.chars,
      isFirst: c.isFirst,
      createdAtNs: c.createdAtNs,
      sinceFirstDeltaMs: c.sinceFirstDeltaMs,
      waitedMs: c.waitedMs,
      consumedChars: c.chars,
    });
  }

  private async waitForDrain(): Promise<void> {
    const scheduler = this.scheduler;
    if (!scheduler) return;
    const deadline = Date.now() + 30_000;
    while (!this.cancelled && Date.now() < deadline) {
      const s = scheduler.stats();
      if (s.finished || s.cancelled) return;
      if (s.pending === 0 && s.inFlight === 0 && s.releaseSeq > s.phrases) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** One cache key builder, so a store can never disagree with a lookup. */
  private cacheKeyFor(text: string) {
    const cfg = this.ctx.config;
    return {
      provider: this.deps.tts.name,
      speaker: cfg.tts.speaker,
      dialect: cfg.tts.dialect,
      languageId: cfg.tts.languageId,
      sampleRate: cfg.tts.sampleRate,
      mulaw: cfg.tts.mulaw,
      expressiveness: cfg.tts.expressiveness,
      text,
    };
  }

  /**
   * Write a finished phrase into the TTS cache.
   *
   * Deliberately skipped when the turn was cancelled: a barge-in truncates the
   * audio mid-word, and caching that would make every later hit play a clipped
   * phrase -- a corruption that would persist for the life of the process.
   */
  private storePhraseInCache(phraseSeq: number, expectedBytes: number): void {
    const parts = this.cacheAccum.get(phraseSeq);
    const text = this.cacheText.get(phraseSeq);
    this.cacheAccum.delete(phraseSeq);
    this.cacheText.delete(phraseSeq);
    if (!parts || !text || this.cancelled) return;

    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    // A short read means the stream ended early; storing it would cache a
    // truncated phrase.
    if (total === 0 || total < expectedBytes) return;

    const audio = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      audio.set(p, off);
      off += p.byteLength;
    }
    this.ctx.ttsCache.set(this.cacheKeyFor(text), audio, null);
  }

  private emitAudio(chunk: TtsAudioChunk): void {
    if (this.cancelled || chunk.generation !== this.ctx.generation) return;
    const t = this.ctx.telemetry;
    if (!this.firstAudioSent) {
      this.firstAudioSent = true;
      t.emit('audio.first_sent', { bytes: chunk.data.byteLength, phraseSeq: chunk.phraseSeq, mode: 'C' });
    }
    t.emit('audio.sent', { bytes: chunk.data.byteLength, phraseSeq: chunk.phraseSeq, audioSeq: chunk.audioSeq });
    this.ctx.bus.emit({
      type: 'AUDIO_SENT',
      atNs: nowNs(),
      turnId: this.ctx.turnId,
      bytes: chunk.data.byteLength,
      phraseSeq: chunk.phraseSeq,
      isFirst: chunk.isFirst,
    });
    this.hooks.onAudio(chunk);
  }

  /**
   * Prompt assembly, ordered for cache stability: the unchanging system prompt
   * and history come first, the volatile retrieved context and the new question
   * last. This does not change the semantic meaning of the prompt.
   */
  private buildMessages(transcript: string, retrieval: RetrievalResult | null): { messages: LlmMessage[]; ragText: string } {
    const cfg = this.ctx.config;
    const msgs: LlmMessage[] = [];
    const history = this.ctx.history.slice(-cfg.llm.historyTurns * 2);
    msgs.push(...history);

    let ragText = '';
    if (retrieval && retrieval.chunks.length > 0) {
      let budget = cfg.rag.maxContextChars;
      const parts: string[] = [];
      for (const c of retrieval.chunks) {
        const block = `[${c.source.filename}]\n${c.text}`;
        if (block.length > budget) {
          if (budget > 120) parts.push(block.slice(0, budget));
          break;
        }
        parts.push(block);
        budget -= block.length;
      }
      const header =
        cfg.language === 'ar'
          ? 'معلومات من قاعدة المعرفة (استخدمها للإجابة، ولا تخترع معلومات غير موجودة فيها):'
          : 'Knowledge base context (use it to answer; do not invent anything not present here):';
      ragText = `${header}\n\n${parts.join('\n\n---\n\n')}`;
      msgs.push({ role: 'developer', content: ragText });
    }

    msgs.push({ role: 'user', content: transcript });
    return { messages: msgs, ragText };
  }
}

/* -------------------------------------------------------------------------- */

function nowNs(): bigint {
  const g = globalThis as any;
  if (typeof g.process?.hrtime?.bigint === 'function') return g.process.hrtime.bigint() as bigint;
  return BigInt(Math.round((g.performance?.now?.() ?? Date.now()) * 1e6));
}

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
