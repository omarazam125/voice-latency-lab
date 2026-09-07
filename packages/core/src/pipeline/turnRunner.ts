/**
 * TurnRunner -- the streaming orchestration layer for Mode B.
 *
 * Both modes use the SAME model, prompt, voice, knowledge base, STT session and
 * input audio. Everything that differs between them is expressed in exactly
 * three decisions, all of them in this file and all of them clearly marked:
 *
 *   1. WHICH TRANSCRIPT the turn proceeds with        (resolveTranscript)
 *   2. WHEN RETRIEVAL RUNS                            (runRetrieval)
 *   3. WHEN TEXT IS CONSIDERED SPEAKABLE              (chunker policy)
 *
 * Decision 1 matters more than it looks. Speechmatics documents a hard floor of
 * max_delay >= 0.7s for FINAL transcripts, while partials typically arrive in
 * under 500ms and are unaffected by max_delay. A pipeline that waits for the
 * final transcript therefore cannot start the LLM sooner than ~700ms after the
 * last word, no matter how fast everything downstream is. Mode B proceeds from
 * the stabilised partial instead, and records what the final transcript turned
 * out to be so the accuracy cost of that choice is measured rather than hidden.
 */

import type { ScopedEmitter } from '@vll/telemetry';
import { deltaMs, nowNs, roundMs } from '@vll/telemetry';
import type {
  LlmMessage,
  LlmProvider,
  ProviderError,
  RetrievalResult,
  Retriever,
  TtsAudioChunk,
  TtsProvider,
} from '../providers.js';
import type { PipelineMode, SessionConfig } from '../config.js';
import { StreamingSpeechChunker, type SpeechPhrase } from '../text/chunker.js';
import { queryEquivalence } from '../text/similarity.js';
import { TtsPhraseScheduler, type ScheduledPhrase } from './ttsScheduler.js';

/* -------------------------------------------------------------------------- */
/* Collaborators                                                               */
/* -------------------------------------------------------------------------- */

export interface StableTranscript {
  text: string;
  /** Monotonic ns at which this text last changed. */
  stableSinceNs: bigint;
}

/**
 * Read model over the live STT stream, owned by the session. The runner never
 * talks to Speechmatics directly.
 */
export interface TranscriptSource {
  /** Most recent partial text for the current turn (may be empty). */
  latestPartial(): string;
  /** Partial text that has been unchanged for at least `minStableMs`. */
  stablePartial(minStableMs: number): StableTranscript | null;
  /** Final text accumulated for this turn so far. */
  finalSoFar(): string;
  /**
   * Resolve with the turn's final transcript once STT delivers it, or null on
   * timeout. Never rejects.
   */
  waitForFinal(timeoutMs: number): Promise<string | null>;
  /** Notified if a final lands AFTER the turn already proceeded without it. */
  onLateFinal(cb: (text: string) => void): () => void;
}

export interface RagPrefetch {
  query: string;
  startedAtNs: bigint;
  promise: Promise<RetrievalResult | null>;
}

export interface TurnRunnerDeps {
  llm: LlmProvider;
  tts: TtsProvider;
  retriever: Retriever | null;
}

export interface TurnRunnerContext {
  turnId: string;
  traceId: string;
  generation: number;
  mode: PipelineMode;
  config: SessionConfig;
  /** VAD-detected physical end of speech. */
  speechEndNs: bigint;
  /** Instant the system decided the turn was over. */
  endpointNs: bigint;
  history: LlmMessage[];
  transcripts: TranscriptSource;
  /** A speculative retrieval already in flight, if Mode B started one. */
  prefetch?: RagPrefetch | null;
  /** A speculative LLM stream already in flight (section 27). */
  speculative?: SpeculativeLlm | null;
  telemetry: ScopedEmitter;
}

export interface SpeculativeLlm {
  query: string;
  startedAtNs: bigint;
  /** Text accumulated so far by the speculative stream. */
  text(): string;
  cancel(reason: string): void;
  /** Adopt the stream: subsequent deltas are delivered to these callbacks. */
  adopt(cb: { onFirstDelta: (d: string) => void; onDelta: (d: string) => void; onDone: () => void }): void;
  firstDeltaNs(): bigint | null;
}

export interface TurnRunnerHooks {
  onAudio: (chunk: TtsAudioChunk) => void;
  onAssistantText?: (text: string) => void;
  onPhrase?: (p: SpeechPhrase, scheduled: ScheduledPhrase | null) => void;
  onFinished?: (r: TurnResult) => void;
}

export interface TurnResult {
  turnId: string;
  mode: PipelineMode;
  transcript: string;
  transcriptSource: 'final' | 'stable_partial' | 'latest_partial' | 'speculative' | 'none';
  assistantText: string;
  retrieval: RetrievalResult | null;
  cancelled: boolean;
  error?: ProviderError;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

export class TurnRunner {
  private cancelled = false;
  private chunker: StreamingSpeechChunker | null = null;
  private scheduler: TtsPhraseScheduler | null = null;
  private llmCancel: ((r?: string) => void) | null = null;
  private unsubscribeLateFinal: (() => void) | null = null;
  private assistantText = '';
  private firstAudioSent = false;

  constructor(
    private readonly ctx: TurnRunnerContext,
    private readonly deps: TurnRunnerDeps,
    private readonly hooks: TurnRunnerHooks,
  ) {}

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Barge-in / abort. Everything downstream is invalidated. */
  cancel(reason = 'barge_in'): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const t = this.ctx.telemetry;
    t.emit('turn.cancelled', { reason });
    try {
      this.llmCancel?.(reason);
      t.emit('llm.cancelled', { reason });
    } catch {
      /* ignore */
    }
    this.chunker?.cancel();
    this.scheduler?.cancel(reason);
    this.unsubscribeLateFinal?.();
  }

  async run(): Promise<TurnResult> {
    const t = this.ctx.telemetry;
    const cfg = this.ctx.config;

    t.emit('turn.started', { mode: this.ctx.mode, generation: this.ctx.generation });
    t.emit('pipeline.mode_selected', { mode: this.ctx.mode });

    /* -- 1. transcript ---------------------------------------------------- */
    const resolved = await this.resolveTranscript();
    if (this.cancelled) return this.finish(this.result(resolved.text, resolved.source, null, true));

    if (!resolved.text.trim()) {
      t.emit('stt.usable_transcript', { text: '', source: resolved.source, empty: true });
      t.emit('turn.completed', { reason: 'empty_transcript' });
      return this.finish(this.result('', 'none', null, false));
    }

    t.emit('stt.usable_transcript', {
      text: resolved.text,
      source: resolved.source,
      chars: resolved.text.length,
      // Mode B's honesty check: if this was a partial, we will report later
      // whether the final transcript disagreed.
      provisional: resolved.source !== 'final',
    });

    this.watchForLateFinal(resolved.text, resolved.source);

    /* -- 2. retrieval ----------------------------------------------------- */
    const retrieval = await this.runRetrieval(resolved.text);
    if (this.cancelled) return this.finish(this.result(resolved.text, resolved.source, retrieval, true));

    /* -- 3. generation + speech ------------------------------------------- */
    const err = await this.generateAndSpeak(resolved.text, retrieval);

    const res = this.result(resolved.text, resolved.source, retrieval, this.cancelled, err);
    if (!this.cancelled) t.emit('turn.completed', { chars: this.assistantText.length });
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

  private finish(res: TurnResult): TurnResult {
    if (this.finished) return res;
    this.finished = true;
    this.hooks.onFinished?.(res);
    return res;
  }

  private result(
    transcript: string,
    source: TurnResult['transcriptSource'],
    retrieval: RetrievalResult | null,
    cancelled: boolean,
    error?: ProviderError,
  ): TurnResult {
    return {
      turnId: this.ctx.turnId,
      mode: this.ctx.mode,
      transcript,
      transcriptSource: source,
      assistantText: this.assistantText,
      retrieval,
      cancelled,
      error,
    };
  }

  /* ====================================================================== */
  /* DECISION 1 -- which transcript to proceed with                          */
  /* ====================================================================== */

  private async resolveTranscript(): Promise<{ text: string; source: TurnResult['transcriptSource'] }> {
    const t = this.ctx.telemetry;
    const cfg = this.ctx.config;
    const src = this.ctx.transcripts;

    /* ------------------ STREAMED TRANSCRIPT RESOLUTION ---------------------
     * Do not wait for a final transcript we already effectively have. If STT
     * has produced a partial that stopped changing before the user stopped
     * speaking, that partial IS the utterance, and waiting another ~700ms for
     * the provider to bless it buys nothing the caller can hear.
     * ---------------------------------------------------------------------- */
    const finalAlready = src.finalSoFar();
    const stable = src.stablePartial(cfg.rag.partialStabilityMs);
    const latest = src.latestPartial();

    // If a final has already landed by the time we get here, always prefer it:
    // it is strictly better and costs nothing.
    if (finalAlready.trim() && finalAlready.trim().length >= (latest.trim().length || 0) * 0.8) {
      t.emit('stt.final', { alreadyAvailable: true, chars: finalAlready.length });
      return { text: finalAlready, source: 'final' };
    }

    if (stable && stable.text.trim()) {
      t.emit('stt.partial', {
        chosen: true,
        stableForMs: roundMs(deltaMs(stable.stableSinceNs, nowNs())),
        chars: stable.text.length,
      });
      return { text: stable.text, source: 'stable_partial' };
    }

    if (latest.trim()) {
      // A partial exists but has not settled. Give the provider a short,
      // bounded grace period rather than either blocking or guessing.
      const grace = Math.min(300, Math.max(80, cfg.rag.partialStabilityMs));
      const final = await src.waitForFinal(grace);
      if (final && final.trim()) {
        t.emit('stt.final', { waitedMs: grace, chars: final.length });
        return { text: final, source: 'final' };
      }
      const now = src.latestPartial();
      return { text: now || latest, source: 'latest_partial' };
    }

    // Nothing at all yet: the endpoint fired before any transcript arrived.
    const final = await src.waitForFinal(2_500);
    if (final && final.trim()) return { text: final, source: 'final' };
    const p = src.latestPartial();
    return { text: p, source: p ? 'latest_partial' : 'none' };
  }

  /**
   * Mode B proceeded on a provisional transcript. When the authoritative final
   * eventually arrives, record whether it agreed. This makes the speed/accuracy
   * tradeoff a measured number rather than an article of faith.
   */
  private watchForLateFinal(usedText: string, source: TurnResult['transcriptSource']): void {
    if (source === 'final' || source === 'none') return;
    this.unsubscribeLateFinal = this.ctx.transcripts.onLateFinal((finalText) => {
      const agreement = queryEquivalence(usedText, finalText);
      this.ctx.telemetry.emit('stt.final', {
        late: true,
        chars: finalText.length,
        text: finalText,
        usedText,
        agreement: Math.round(agreement * 1000) / 1000,
        diverged: agreement < 0.9,
      });
    });
  }

  /* ====================================================================== */
  /* DECISION 2 -- when retrieval runs                                       */
  /* ====================================================================== */

  private async runRetrieval(query: string): Promise<RetrievalResult | null> {
    const t = this.ctx.telemetry;
    const cfg = this.ctx.config;

    if (!cfg.rag.enabled || !this.deps.retriever) {
      t.emit('rag.skipped', { reason: cfg.rag.enabled ? 'no_index' : 'disabled' });
      return null;
    }

    /* -- Mode B: try to reuse a speculative prefetch ---------------------- */
    if (this.ctx.mode === 'B' && this.ctx.prefetch) {
      const pf = this.ctx.prefetch;
      const agreement = queryEquivalence(pf.query, query);
      if (agreement >= cfg.rag.prefetchReuseThreshold) {
        const result = await pf.promise;
        if (result && !this.cancelled) {
          t.emit('rag.prefetch_hit', {
            agreement: Math.round(agreement * 1000) / 1000,
            prefetchQuery: pf.query,
            finalQuery: query,
            // The whole point: retrieval finished before it was needed, so its
            // contribution to the critical path is zero.
            savedMs: roundMs(deltaMs(pf.startedAtNs, nowNs())),
            chunks: result.chunks.length,
          });
          t.emit('rag.completed', {
            durationMs: result.durationMs,
            chunks: result.chunks.length,
            prefetched: true,
            topScore: result.chunks[0]?.score ?? null,
          });
          return { ...result, prefetched: true };
        }
      }
      t.emit('rag.prefetch_miss', {
        agreement: Math.round(agreement * 1000) / 1000,
        prefetchQuery: pf.query,
        finalQuery: query,
      });
      t.emit('rag.prefetch_discarded', { reason: 'query_diverged' });
    }

    /* -- Blocking retrieval on the critical path -------------------------- */
    const start = nowNs();
    t.emit('rag.started', { query, topK: cfg.rag.topK });
    try {
      const result = await this.deps.retriever.search(query, {
        topK: cfg.rag.topK,
        minScore: cfg.rag.minScore,
        minCoverage: cfg.rag.minCoverage,
      });
      t.emit('rag.completed', {
        durationMs: roundMs(deltaMs(start, nowNs())),
        chunks: result.chunks.length,
        prefetched: false,
        topScore: result.chunks[0]?.score ?? null,
        sources: result.chunks.map((c) => c.source.filename),
      });
      return result;
    } catch (e: any) {
      t.emit('rag.error', { message: e?.message ?? String(e) });
      // Retrieval failure must never kill the turn; answer without context.
      return null;
    }
  }

  /* ====================================================================== */
  /* DECISION 3 -- when text becomes speakable                               */
  /* ====================================================================== */

  private async generateAndSpeak(transcript: string, retrieval: RetrievalResult | null): Promise<ProviderError | undefined> {
    const t = this.ctx.telemetry;
    const cfg = this.ctx.config;

    const policy = cfg.chunker.B;

    this.scheduler = new TtsPhraseScheduler(
      {
        provider: this.deps.tts,
        turnId: this.ctx.turnId,
        generation: this.ctx.generation,
        // The WebSocket transport is inherently sequential; HTTP may overlap.
        maxConcurrent: this.deps.tts.name === 'hamsa' ? cfg.tts.maxConcurrentPhrases : 1,
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
        onRequestStarted: (p) =>
          t.emit('tts.request_started', {
            phraseSeq: p.seq,
            text: p.text,
            chars: p.text.length,
            waitedInQueueMs: roundMs(deltaMs(p.queuedAtNs, nowNs())),
          }),
        onFirstAudio: (chunk, p) =>
          t.emit('tts.first_audio', { phraseSeq: p.seq, bytes: chunk.data.byteLength }),
        onAudio: (chunk) => this.emitAudio(chunk),
        onPhraseCompleted: (p, info) => t.emit('tts.completed', { phraseSeq: p.seq, ...info }),
        onAllCompleted: () => t.emit('chunker.completed', { phrases: this.chunker?.phraseCount ?? 0 }),
        onError: (e, p) => t.emit('tts.error', { message: e.message, code: e.code, phraseSeq: p?.seq }),
        onBackpressure: (info) => t.emit('pipeline.backpressure', { where: 'tts_scheduler', ...info }),
        onDiscarded: (info) => t.emit('audio.dropped_stale', info),
      },
    );

    const scheduler = this.scheduler;

    this.chunker = new StreamingSpeechChunker(
      policy,
      {
        onFirstPhrase: (p) => {
          // THE metric that separates the two architectures.
          t.emit('chunker.first_phrase_ready', {
            text: p.text,
            words: p.words,
            chars: p.chars,
            reason: p.reason,
            phraseSeq: p.seq,
            sinceFirstDeltaMs: p.sinceFirstDeltaMs != null ? roundMs(p.sinceFirstDeltaMs) : null,
          });
        },
        onPhrase: (p) => {
          if (!p.isFirst) {
            t.emit('chunker.phrase_ready', {
              text: p.text,
              words: p.words,
              chars: p.chars,
              reason: p.reason,
              phraseSeq: p.seq,
            });
          }
          const scheduled = scheduler.enqueue(p);
          this.hooks.onPhrase?.(p, scheduled);
        },
        onDecision: (d) => {
          // High-frequency; coalesced by the telemetry bus for the debug panel.
          t.emit('chunker.buffer_updated', {
            buffer: d.buffer.slice(-160),
            words: d.words,
            chars: d.chars,
            eligible: d.eligible,
            action: d.action,
            reason: d.reason,
            waitingForMs: d.waitingForMs != null ? roundMs(d.waitingForMs) : undefined,
          });
        },
      },
      { now: nowNs, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as any) },
    );

    const chunker = this.chunker;

    /* -- LLM -------------------------------------------------------------- */
    const messages = this.buildMessages(transcript, retrieval);
    const instructions = cfg.systemPrompt;

    const llmStart = nowNs();
    t.emit('llm.request_started', {
      model: cfg.llm.model,
      reasoningEffort: cfg.llm.reasoningEffort,
      verbosity: cfg.llm.verbosity,
      serviceTier: cfg.llm.serviceTier,
      maxOutputTokens: cfg.llm.maxOutputTokens,
      promptChars: instructions.length,
      inputChars: messages.reduce((n, m) => n + m.content.length, 0),
      ragChunks: retrieval?.chunks.length ?? 0,
    });

    let sawFirst = false;
    const handle = this.deps.llm.stream(
      {
        model: cfg.llm.model,
        instructions,
        input: messages,
        maxOutputTokens: cfg.llm.maxOutputTokens,
        temperature: cfg.llm.temperature ?? undefined,
        reasoningEffort: cfg.llm.reasoningEffort,
        verbosity: cfg.llm.verbosity,
        serviceTier: cfg.llm.serviceTier,
        store: cfg.llm.store,
        // A stable prefix improves cache hit rate; the prompt is identical
        // across modes so both benefit equally.
        promptCacheKey: `vll_${hashString(instructions)}`,
      },
      {
        onCreated: (info) => t.emit('llm.response_created', { responseId: info.responseId }),
        // Telemetry ONLY. `onDelta` fires for the first delta too, so pushing
        // here as well would feed the first token to the chunker twice.
        onFirstDelta: (d) => {
          sawFirst = true;
          t.emit('llm.first_delta', {
            ttftMs: roundMs(deltaMs(llmStart, nowNs())),
            delta: d,
            chars: d.length,
          });
        },
        // The single place text enters the chunker.
        onDelta: (d) => {
          t.emit('llm.delta', { chars: d.length, delta: d });
          chunker.push(d);
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
        onRaw: (type) => {
          if (type !== 'response.output_text.delta') t.emit('llm.delta', { rawEvent: type, silent: true });
        },
      },
    );
    this.llmCancel = handle.cancel;

    const outcome = await handle.done;
    if (!this.assistantText) this.assistantText = outcome.text;

    if (outcome.cancelled || this.cancelled) {
      chunker.cancel();
      scheduler.cancel('turn_cancelled');
      return outcome.error;
    }

    // Flush the tail so the last words are spoken, then wait for audio to drain.
    chunker.finish();
    scheduler.markChunkerDone();

    await this.waitForSpeechDrain();
    return outcome.error;
  }

  private async waitForSpeechDrain(): Promise<void> {
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

  /* -- audio out --------------------------------------------------------- */

  private emitAudio(chunk: TtsAudioChunk): void {
    if (this.cancelled || chunk.generation !== this.ctx.generation) return;
    const t = this.ctx.telemetry;
    if (!this.firstAudioSent) {
      this.firstAudioSent = true;
      t.emit('audio.first_sent', { bytes: chunk.data.byteLength, phraseSeq: chunk.phraseSeq });
    }
    t.emit('audio.sent', { bytes: chunk.data.byteLength, phraseSeq: chunk.phraseSeq, audioSeq: chunk.audioSeq });
    this.hooks.onAudio(chunk);
  }

  /* -- prompt assembly --------------------------------------------------- */

  private buildMessages(transcript: string, retrieval: RetrievalResult | null): LlmMessage[] {
    const cfg = this.ctx.config;
    const msgs: LlmMessage[] = [];

    // History first, so the cacheable prefix stays stable and the dynamic parts
    // (retrieved context, the new question) sit at the end -- the ordering
    // OpenAI's latency guidance recommends for prompt caching.
    const history = this.ctx.history.slice(-cfg.llm.historyTurns * 2);
    msgs.push(...history);

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
      msgs.push({ role: 'developer', content: `${header}\n\n${parts.join('\n\n---\n\n')}` });
    }

    msgs.push({ role: 'user', content: transcript });
    return msgs;
  }
}

/** Small, stable, non-cryptographic hash used only for a prompt cache key. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
