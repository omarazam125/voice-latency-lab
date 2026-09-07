/**
 * Session: one browser connection, one long-lived conversation.
 *
 * Owns the provider connections and the turn lifecycle. Two invariants matter
 * most here:
 *
 *   1. CONNECTIONS ARE OPENED ONCE. Speechmatics gets exactly one
 *      StartRecognition for the whole conversation; the Hamsa socket is warmed
 *      before the user speaks. Reconnecting per turn is an explicit
 *      anti-pattern (section 28), and setup cost is measured separately so it
 *      cannot contaminate per-turn TTFS (section 20).
 *
 *   2. NOTHING BLOCKS AUDIO. Telemetry goes to an in-memory ring buffer and is
 *      flushed to subscribers on a timer; audio frames are forwarded with a
 *      subarray, never a copy-plus-JSON round trip.
 */

import {
  ClockSynchronizer,
  ScopedEmitter,
  TelemetryBus,
  attributeLatency,
  buildVapiPerformanceModel,
  deriveTurnMetrics,
  detectGaps,
  deltaMs,
  newSessionId,
  newTraceId,
  newTurnId,
  nowNs,
  roundMs,
  type TelemetryEvent,
  type WireEvent,
} from '@vll/telemetry';
import {
  ModeCOrchestrator,
  TurnRunner,
  type EndpointDecision,
  defaultConfig,
  mergeConfig,
  type DeepPartial,
  type LlmMessage,
  type LlmProvider,
  type RagPrefetch,
  type RetrievalResult,
  type SessionConfig,
  type SttSession,
  type TtsAudioChunk,
  type TurnResult,
  type WarmupStep,
} from '@vll/core';
import { HamsaTtsProvider, OpenAiResponsesProvider, SpeechmaticsSttProvider } from '@vll/providers';
import type { KnowledgeBase } from '@vll/rag';
import { pcm16DurationMs } from '@vll/audio';
import { TurnTranscriptTracker } from './transcripts.js';
import { ModeCRuntime, currentTranscriptOf } from './modeCRuntime.js';
import { secrets, serverConfig } from './env.js';
import { persistConfig, persistedConfigSync } from './configStore.js';
import { CallRecorder } from './callRecorder.js';

export interface SessionHooks {
  sendJson: (msg: unknown) => void;
  sendAudio: (chunk: TtsAudioChunk) => void;
}

interface TurnState {
  turnId: string;
  runner: { cancel: (reason?: string) => void };
  tracker: TurnTranscriptTracker;
  generation: number;
  startedNs: bigint;
  emitter: ScopedEmitter;
  /** Last-resort release; see armTurnWatchdog. */
  watchdog?: ReturnType<typeof setTimeout>;
}

const WARMUP_STEPS: Array<{ key: string; label: string }> = [
  { key: 'clock', label: 'Clock synchronisation' },
  { key: 'rag', label: 'Knowledge base index' },
  { key: 'llm', label: 'OpenAI client' },
  { key: 'tts_voice', label: 'Hamsa voice preload' },
  { key: 'tts', label: 'Hamsa realtime connection' },
  { key: 'stt', label: 'Speechmatics realtime session' },
];

/**
 * Turn a raw Speechmatics error into something the operator can act on.
 * A bare "Concurrent Quota Exceeded" reads like a billing problem when it is
 * almost always a session that was never closed.
 */
function sttErrorHint(message: string): string | undefined {
  const m = (message ?? '').toLowerCase();
  if (m.includes('concurrent') && m.includes('quota')) {
    return 'الحساب وصل حدّ الجلسات المتزامنة. أغلق التبويبات الأخرى وأي خادم قديم، ثم أعد المحاولة بعد دقيقة. GET /api/stt/sessions يعرض الجلسات المفتوحة في هذه العملية.';
  }
  if (m.includes('quota') || m.includes('limit')) {
    return 'حدّ من حدود الحساب. راجع لوحة Speechmatics.';
  }
  if (m.includes('auth') || m.includes('401') || m.includes('403')) {
    return 'مفتاح Speechmatics غير صالح أو منتهي.';
  }
  return undefined;
}

export class Session {
  readonly id = newSessionId();
  readonly traceId = newTraceId();
  readonly bus: TelemetryBus;
  readonly clock = new ClockSynchronizer();

  /**
   * Seeded from the persisted config, not from the bare defaults.
   *
   * A Session is created per WebSocket connection, so without this every page
   * reload and every tsx-watch restart silently threw away the operator's
   * settings -- which is exactly what "the prompt won't save" looked like.
   */
  config: SessionConfig = persistedConfigSync() ?? defaultConfig();

  private stt: SpeechmaticsSttProvider | null = null;
  private sttSession: SttSession | null = null;
  private llm: OpenAiResponsesProvider | null = null;
  private tts: HamsaTtsProvider | null = null;

  private steps = new Map<string, WarmupStep>();
  private ready = false;
  private warmingUp = false;
  private closed = false;

  private generation = 0;
  private currentTurn: TurnState | null = null;
  /** Tracker for the utterance currently being spoken by the user. */
  private liveTracker = new TurnTranscriptTracker();
  private history: LlmMessage[] = [];
  private turnMetrics: unknown[] = [];

  /** Mode C session-scoped runtime: endpointing engine, phrase cache, event bus. */
  private modeC: ModeCRuntime;

  /**
   * A barge-in the browser has flagged but nobody has classified yet.
   *
   * The browser detects one from acoustic energy alone, ~80ms in, when no word
   * exists yet. In Mode C with a stopSpeaking plan it ducks instead of
   * cancelling and waits here for a verdict, which can only be reached once the
   * transcriber has produced something to read.
   */
  private pendingBargeIn: { atNs: bigint; turnId: string | null; timer: ReturnType<typeof setTimeout> } | null = null;

  private prefetch: RagPrefetch | null = null;
  private prefetchQuerySeen = '';
  private firstAudioToStt = false;
  private assistantSpeaking = false;

  /** Rolling capture of user audio, for the fixed-clip mode comparison. */
  private recording: { active: boolean; frames: Uint8Array[]; bytes: number } = {
    active: false,
    frames: [],
    bytes: 0,
  };

  private unsubscribeTelemetry: (() => void) | null = null;
  /**
   * Writes the call to disk so a bad turn can be diagnosed after the fact.
   * Always on: a fault that only shows up occasionally is exactly the one that
   * is never being recorded when it happens.
   */
  readonly recorder: CallRecorder;
  private debugRawEnabled = true;

  constructor(
    private readonly hooks: SessionHooks,
    private readonly kb: KnowledgeBase | null,
  ) {
    this.bus = new TelemetryBus({
      sessionId: this.id,
      traceId: this.traceId,
      capacity: 60_000,
      // Coalesce chatty events so the monitor stays readable and the socket
      // is not flooded with per-frame noise.
      highFrequencyCoalesceMs: 60,
    });
    for (const s of WARMUP_STEPS) this.steps.set(s.key, { ...s, state: 'pending' });

    // Before the first emit, for the same reason the live monitor subscribes
    // early: the bus only delivers to subscribers that already exist.
    this.recorder = new CallRecorder(this.id, this.bus);
    this.recorder.start();

    // Subscribe BEFORE the first emit. The bus only delivers to subscribers
    // that exist at emit time, so attaching afterwards would silently lose
    // session.created from the live stream (it would still reach the ring
    // buffer and the export, which makes the omission easy to miss).
    this.unsubscribeTelemetry = this.bus.subscribe((events: WireEvent[]) => {
      this.hooks.sendJson({ type: 'telemetry.batch', events });
    });

    this.modeC = new ModeCRuntime(this.config.modeC, {
      onEvaluated: (d) => {
        // High-frequency: coalesced by the bus so the monitor stays readable.
        this.bus.emit({
          event: 'vad.silence_tick',
          turnId: this.currentTurn?.turnId ?? null,
          metadata: {
            endpointing: true,
            reason: d.reason,
            reasonCode: d.reasonCode,
            requiredSilenceMs: roundMs(d.requiredSilenceMs),
            observedSilenceMs: roundMs(d.observedSilenceMs),
            contentClass: d.contentClass,
            stabilityScore: d.stabilityScore,
            confidence: d.confidence,
            words: d.words,
          },
        });
      },
      onCommit: (d, speechEndNs, commitNs) => this.onModeCCommit(d, speechEndNs, commitNs),
    });

    this.bus.emit({ event: 'session.created', metadata: { sessionId: this.id } });
  }

  /* ====================================================================== */
  /* Configuration                                                           */
  /* ====================================================================== */

  applyConfig(patch: DeepPartial<SessionConfig>): SessionConfig {
    const before = this.config;
    this.config = mergeConfig(this.config, patch);
    // Survive the socket. The write itself is debounced inside the store so no
    // disk I/O ever lands on the thread that timestamps audio.
    persistConfig(this.config);
    this.bus.emit({ event: 'session.config_updated', metadata: { keys: Object.keys(patch) } });

    if (this.tts) {
      this.tts.updateFormat(this.config.tts.sampleRate, this.config.tts.mulaw);
      if (before.tts.transport !== this.config.tts.transport) {
        void this.tts.setTransport(this.config.tts.transport).then(() => this.pushStatus());
      }
    }

    // STT settings are fixed for the life of a recognition session, so changing
    // them requires a reconnect. We say so rather than silently ignoring it.
    const sttChanged =
      before.stt.language !== this.config.stt.language ||
      before.stt.model !== this.config.stt.model ||
      before.stt.maxDelay !== this.config.stt.maxDelay ||
      before.stt.maxDelayMode !== this.config.stt.maxDelayMode ||
      before.stt.endOfUtteranceSilenceTrigger !== this.config.stt.endOfUtteranceSilenceTrigger ||
      before.stt.enablePartials !== this.config.stt.enablePartials;

    this.modeC.updateConfig(this.config.modeC);

    if (sttChanged && this.sttSession) {
      void this.restartStt();
    }
    this.pushStatus();
    return this.config;
  }

  /* ====================================================================== */
  /* Warm-up (spec section 20)                                               */
  /* ====================================================================== */

  private setStep(key: string, state: WarmupStep['state'], detail?: string, durationMs?: number): void {
    const s = this.steps.get(key);
    if (!s) return;
    s.state = state;
    if (detail !== undefined) s.detail = detail;
    if (durationMs !== undefined) s.durationMs = roundMs(durationMs);
    this.bus.emit({
      event:
        state === 'ready'
          ? 'session.warmup_step_ready'
          : state === 'failed'
            ? 'session.warmup_step_failed'
            : 'session.warmup_step_started',
      metadata: { step: key, label: s.label, state, detail, durationMs: s.durationMs },
    });
    this.pushStatus();
  }

  async warmup(): Promise<void> {
    if (this.warmingUp) return;
    this.warmingUp = true;
    this.ready = false;
    const t0 = nowNs();
    this.bus.emit({ event: 'session.warmup_started' });

    const s = secrets.get();

    // Clock sync is driven by the browser; mark it from whatever we have.
    this.setStep('clock', this.clock.ready ? 'ready' : 'running', this.clock.ready ? undefined : 'awaiting pings');

    /* -- knowledge base --------------------------------------------------- */
    this.setStep('rag', 'running');
    if (this.kb) {
      const started = nowNs();
      if (!this.kb.ready) await this.kb.load();
      this.setStep(
        'rag',
        'ready',
        `${this.kb.documentCount} documents, ${this.kb.chunkCount} chunks (${this.kb.retrieverMode})`,
        deltaMs(started, nowNs()),
      );
    } else {
      this.setStep('rag', 'skipped', 'no knowledge base configured');
    }

    /* -- LLM -------------------------------------------------------------- */
    this.setStep('llm', 'running');
    if (!s.openaiApiKey) {
      this.setStep('llm', 'failed', 'OPENAI_API_KEY is not set');
    } else {
      const started = nowNs();
      this.llm = new OpenAiResponsesProvider({
        apiKey: s.openaiApiKey,
        requestTimeoutMs: 60_000,
        firstTokenTimeoutMs: 20_000,
      });
      await this.llm.warmup(this.config.llm.model);
      this.setStep('llm', 'ready', `connection primed`, deltaMs(started, nowNs()));
    }

    /* -- TTS -------------------------------------------------------------- */
    if (!s.hamsaApiKey) {
      this.setStep('tts_voice', 'failed', 'HAMSA_API_KEY is not set');
      this.setStep('tts', 'failed', 'HAMSA_API_KEY is not set');
    } else {
      this.tts = new HamsaTtsProvider({
        apiKey: s.hamsaApiKey,
        transport: this.config.tts.transport,
        sampleRate: this.config.tts.sampleRate,
        mulaw: this.config.tts.mulaw,
        firstAudioTimeoutMs: 15_000,
      });
      if (this.debugRawEnabled) {
        this.tts.setRawLogger((direction, payload) => this.sendDebug('hamsa', direction, payload));
      }

      // Preload BEFORE connecting, at startup, exactly as Hamsa documents. If a
      // cloned voice were loaded lazily the first turn would carry the model
      // load time and every measurement after it would look artificially good.
      const speaker = this.config.tts.speaker || s.hamsaSpeakerId;
      if (speaker) {
        this.setStep('tts_voice', 'running');
        const started = nowNs();
        this.bus.emit({ event: 'tts.voice_preload_started', metadata: { speaker } });
        const r = await this.tts.preloadVoice(speaker);
        const ms = deltaMs(started, nowNs());
        // Only a voice that NEEDED preloading and did not get it is a failure.
        // A built-in voice reporting "not required" is the normal path and must
        // not show up as a red line on the monitor.
        const failed = r.required && !r.preloaded;
        this.bus.emit({
          event: failed ? 'tts.voice_preload_failed' : 'tts.voice_preload_completed',
          metadata: { speaker, message: r.message, required: r.required, durationMs: roundMs(ms) },
        });
        this.setStep('tts_voice', failed ? 'failed' : r.preloaded ? 'ready' : 'skipped', r.message, ms);
      } else {
        this.setStep('tts_voice', 'skipped', 'no speaker configured');
      }

      this.setStep('tts', 'running');
      const started = nowNs();
      this.bus.emit({ event: 'tts.connect_started', metadata: { transport: this.config.tts.transport } });
      try {
        await this.tts.connect();
        const ms = deltaMs(started, nowNs());
        this.bus.emit({ event: 'tts.connected', metadata: { durationMs: roundMs(ms) } });
        this.setStep('tts', 'ready', `${this.config.tts.transport} transport`, ms);
      } catch (e: any) {
        this.bus.emit({ event: 'tts.error', metadata: { message: e?.message ?? String(e) } });
        this.setStep('tts', 'failed', e?.message ?? String(e));
      }
    }

    /* -- STT -------------------------------------------------------------- */
    await this.openStt();

    const totalMs = deltaMs(t0, nowNs());
    this.ready = [...this.steps.values()].every((x) => x.state === 'ready' || x.state === 'skipped');
    this.bus.emit({
      event: 'session.ready',
      metadata: {
        ready: this.ready,
        warmupMs: roundMs(totalMs),
        // Recorded separately so it can never be mistaken for turn latency.
        excludedFromTurnMetrics: true,
        failed: [...this.steps.values()].filter((x) => x.state === 'failed').map((x) => x.key),
      },
    });
    this.warmingUp = false;
    this.pushStatus();
  }

  private async openStt(): Promise<void> {
    const s = secrets.get();
    if (!s.speechmaticsApiKey) {
      this.setStep('stt', 'failed', 'SPEECHMATICS_API_KEY is not set');
      return;
    }

    // CLOSE THE PREVIOUS SESSION FIRST.
    //
    // Speechmatics enforces a CONCURRENT session limit per account. Replacing
    // `this.sttSession` without closing the old one orphans a live connection
    // that keeps counting against that limit until the process exits -- so
    // pressing "Warm up" a few times is enough to exhaust the quota, and the
    // resulting error looks like a billing problem rather than a leak.
    if (this.sttSession) {
      const previous = this.sttSession;
      this.sttSession = null;
      this.bus.emit({ event: 'stt.disconnected', metadata: { reason: 'replaced_by_new_session' } });
      try {
        await previous.close();
      } catch {
        /* best effort; we are replacing it regardless */
      }
    }

    this.setStep('stt', 'running');
    const started = nowNs();
    this.bus.emit({ event: 'stt.connection_started', metadata: { region: serverConfig.speechmaticsRegion } });

    this.stt = new SpeechmaticsSttProvider({
      apiKey: s.speechmaticsApiKey,
      region: serverConfig.speechmaticsRegion,
    });

    try {
      this.sttSession = await this.stt.open(
        {
          language: this.config.stt.language,
          audioFormat: { sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le' },
          enablePartials: this.config.stt.enablePartials,
          maxDelay: this.config.stt.maxDelay,
          maxDelayMode: this.config.stt.maxDelayMode,
          endOfUtteranceSilenceTrigger: this.config.stt.endOfUtteranceSilenceTrigger,
          model: this.config.stt.model,
          punctuationSensitivity: this.config.stt.punctuationSensitivity,
          additionalVocab: this.config.stt.additionalVocab,
          label: `live:${this.id}`,
        },
        {
          onOpen: () => this.bus.emit({ event: 'stt.connected' }),
          onReady: (i) => this.bus.emit({ event: 'stt.recognition_started', metadata: { raw: i.raw } }),
          onPartial: (t) => this.onSttPartial(t.text),
          onFinal: (t) => this.onSttFinal(t.text),
          onEndOfUtterance: (i) => this.onSttEndOfUtterance(i.time),
          onAck: (seq) => this.bus.emit({ event: 'stt.audio_ack', turnId: this.currentTurn?.turnId, metadata: { seq } }),
          onError: (e) =>
            this.bus.emit({
              event: 'stt.error',
              turnId: this.currentTurn?.turnId,
              metadata: { message: e.message, code: e.code, retryable: e.retryable, hint: sttErrorHint(e.message) },
            }),
          onClose: (i) => {
            this.bus.emit({ event: 'stt.disconnected', metadata: i });
            this.sttSession = null;
          },
          onRaw: (dir, payload) => this.sendDebug('speechmatics', dir, payload),
        },
      );
      const ms = deltaMs(started, nowNs());
      this.setStep('stt', 'ready', `${serverConfig.speechmaticsRegion} region`, ms);
    } catch (e: any) {
      const message = e?.message ?? String(e);
      const hint = sttErrorHint(message);
      this.bus.emit({ event: 'stt.error', metadata: { message, hint, fatal: true } });
      // Put the remedy in the warm-up step itself: this string is what the
      // operator actually reads on the Console page.
      this.setStep('stt', 'failed', hint ? `${message} — ${hint}` : message);
    }
  }

  private async restartStt(): Promise<void> {
    this.bus.emit({ event: 'stt.reconnect', metadata: { reason: 'configuration_changed', visible: true } });
    const old = this.sttSession;
    this.sttSession = null;
    this.firstAudioToStt = false;
    try {
      await old?.close();
    } catch {
      /* ignore */
    }
    await this.openStt();
    this.pushStatus();
  }

  /* ====================================================================== */
  /* STT events                                                              */
  /* ====================================================================== */

  private onSttPartial(text: string): void {
    const changed = this.liveTracker.pushPartial(text);
    if (!changed) return;

    const turnId = this.currentTurn?.turnId ?? null;
    const isFirst = !this.sawPartialThisUtterance;
    if (isFirst) {
      this.sawPartialThisUtterance = true;
      this.bus.emit({ event: 'stt.first_partial', turnId, metadata: { text, chars: text.length } });
    } else {
      this.bus.emit({ event: 'stt.partial', turnId, metadata: { text, chars: text.length } });
    }
    this.hooks.sendJson({ type: 'stt.partial', text });

    // A pending barge-in is waiting for exactly this: the first words spoken
    // over the agent. Resolving on the partial rather than the final matters —
    // Speechmatics documents a 0.7s floor on finals, which is longer than any
    // caller will tolerate being talked over.
    if (this.pendingBargeIn) this.resolveBargeIn('partial_transcript');

    // Mode C's endpointing engine reads the live transcript, so a punctuation
    // mark can shorten the required silence the instant it appears rather than
    // on the next timer tick.
    if (this.config.mode === 'C') {
      this.modeC.onTranscriptChanged(currentTranscriptOf(this.liveTracker));
      this.modeC.evaluateNow();
    }

    this.maybePrefetch(text);
  }

  private sawPartialThisUtterance = false;

  private onSttFinal(text: string): void {
    this.liveTracker.pushFinal(text);
    const full = this.liveTracker.finalSoFar();
    this.bus.emit({
      event: 'stt.final',
      turnId: this.currentTurn?.turnId ?? null,
      metadata: { segment: text, text: full, chars: full.length },
    });
    this.hooks.sendJson({ type: 'stt.final', text: full });

    if (this.config.mode === 'C') {
      this.modeC.onTranscriptChanged(currentTranscriptOf(this.liveTracker));
      this.modeC.setHasFinal(true);
    }
  }

  private onSttEndOfUtterance(time: number): void {
    this.liveTracker.markEndOfUtterance();
    this.bus.emit({
      event: 'stt.end_of_utterance',
      turnId: this.currentTurn?.turnId ?? null,
      metadata: { providerTime: time, source: 'speechmatics' },
    });
  }

  /* ====================================================================== */
  /* Speculative retrieval (Mode B, section 12)                              */
  /* ====================================================================== */

  private maybePrefetch(partial: string): void {
    const cfg = this.config;
    if (!cfg.rag.enabled || !this.kb) return;

    // Mode B uses the global prefetch switch; Mode C uses its own retrieval
    // strategy, so "prefetch" has to be selected there explicitly.
    const wants =
      cfg.mode === 'B'
        ? cfg.rag.prefetchEnabled
        : cfg.mode === 'C'
          ? cfg.modeC.rag.strategy === 'prefetch'
          : false;
    if (!wants) return;
    if (this.currentTurn) return; // a turn is already running
    const words = partial.trim().split(/\s+/).filter(Boolean).length;
    if (words < cfg.speculative.minWords) return;
    if (partial === this.prefetchQuerySeen) return;

    // Only prefetch once the partial has stopped moving, otherwise we would
    // fire a retrieval on every keystroke-like revision and waste the budget.
    const stable = this.liveTracker.stablePartial(cfg.rag.partialStabilityMs);
    if (!stable) {
      // Schedule a re-check when the stability window would elapse.
      setTimeout(() => {
        if (!this.currentTurn && this.liveTracker.latestPartial() === partial) this.maybePrefetch(partial);
      }, cfg.rag.partialStabilityMs + 10);
      return;
    }

    this.prefetchQuerySeen = partial;
    const startedAtNs = nowNs();
    this.bus.emit({ event: 'rag.prefetch_started', metadata: { query: partial, words } });

    const promise = this.kb
      .search(partial, { topK: cfg.rag.topK, minScore: cfg.rag.minScore })
      .then((r: RetrievalResult) => {
        this.bus.emit({
          event: 'rag.prefetch_completed',
          metadata: {
            durationMs: roundMs(deltaMs(startedAtNs, nowNs())),
            chunks: r.chunks.length,
            query: partial,
          },
        });
        return r;
      })
      .catch(() => null);

    this.prefetch = { query: partial, startedAtNs, promise };
  }

  /* ====================================================================== */
  /* Audio uplink                                                            */
  /* ====================================================================== */

  /** Forward one PCM16 frame from the browser to STT. Hot path: keep it small. */
  onMicAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    const stt = this.sttSession;
    if (stt) {
      if (!this.firstAudioToStt) {
        this.firstAudioToStt = true;
        this.bus.emit({ event: 'stt.first_audio_sent', metadata: { bytes: pcm.byteLength } });
      }
      stt.sendAudio(pcm);
    }
    if (this.recording.active) {
      // The recorder copies, because the socket buffer is reused.
      this.recording.frames.push(new Uint8Array(pcm));
      this.recording.bytes += pcm.byteLength;
    }
  }

  /* ====================================================================== */
  /* VAD events from the browser                                             */
  /* ====================================================================== */

  private toServerNs(clientNs: string): bigint {
    return this.clock.clientToServer(BigInt(clientNs));
  }

  onSpeechStarted(clientNs: string, probability: number): void {
    const ts = this.toServerNs(clientNs);
    this.sawPartialThisUtterance = false;
    if (this.config.mode === 'C') this.modeC.onSpeechStarted();
    this.bus.emit({
      event: 'vad.speech_started',
      turnId: null,
      timestampNs: ts,
      clientOriginated: true,
      metadata: { probability },
    });
  }

  onSpeechEnded(clientNs: string, durationMs: number): void {
    const ts = this.toServerNs(clientNs);
    this.pendingSpeechEndNs = ts;
    // In Mode C the physical speech end STARTS the decision process; the
    // endpointing engine decides how long that silence must last given what the
    // caller actually said. The browser's own fixed timer is ignored.
    if (this.config.mode === 'C' && !this.currentTurn) this.modeC.onSpeechEnded(ts);
    this.bus.emit({
      event: 'vad.speech_ended',
      turnId: null,
      timestampNs: ts,
      clientOriginated: true,
      metadata: { durationMs: roundMs(durationMs), note: 'physical end of user speech' },
    });
  }

  private pendingSpeechEndNs: bigint | null = null;

  /**
   * The browser's VAD decided the turn is over. This is where a turn begins.
   */
  onEndpoint(clientNs: string, speechEndClientNs: string, delayMs: number, silenceThresholdMs: number): void {
    if (this.closed) return;
    const endpointNs = this.toServerNs(clientNs);
    const speechEndNs = this.pendingSpeechEndNs ?? this.toServerNs(speechEndClientNs);

    if (this.currentTurn) return; // already running; ignore duplicate endpoints

    // Mode C owns the endpoint decision on the server, because it depends on
    // the transcript. Accepting the browser's fixed-timer endpoint here would
    // bypass the whole engine.
    if (this.config.mode === 'C') return;

    const turnId = newTurnId();
    this.generation++;

    // Anchor the turn BEFORE emitting, so every subsequent event carries a
    // correct elapsed-from-speech-end value.
    this.bus.setSpeechEnd(turnId, speechEndNs);
    this.bus.setEndpoint(turnId, endpointNs);

    // Re-emit the VAD anchors against this turn so the waterfall is complete.
    this.bus.emit({
      event: 'vad.speech_ended',
      turnId,
      timestampNs: speechEndNs,
      clientOriginated: true,
      metadata: { anchor: true },
    });
    this.bus.emit({
      event: 'turn.endpoint_detected',
      turnId,
      timestampNs: endpointNs,
      clientOriginated: true,
      metadata: {
        // The number the whole application exists to expose.
        endpointDetectionDelayMs: roundMs(delayMs),
        silenceThresholdMs,
        source: 'browser_vad',
      },
    });

    this.startTurn(turnId, speechEndNs, endpointNs);
  }

  onBargeIn(clientNs: string): void {
    const ts = this.toServerNs(clientNs);
    const turnId = this.currentTurn?.turnId ?? null;
    const classify = this.config.mode === 'C' && this.config.modeC.stopSpeaking.enabled;

    this.bus.emit({
      event: 'vad.barge_in_detected',
      turnId,
      timestampNs: ts,
      clientOriginated: true,
      metadata: { hadActiveTurn: !!this.currentTurn, classified: classify },
    });

    if (!classify) {
      this.cancelCurrentTurn('barge_in');
      return;
    }

    // Hold the turn open and start the clock. The verdict needs words, and
    // words need the transcriber; if none arrive we must default to
    // interrupting, because talking over a caller who genuinely wants the turn
    // is a worse failure than cutting off one who did not.
    this.modeC.noteAssistantOverlapStart(ts);
    if (this.pendingBargeIn) clearTimeout(this.pendingBargeIn.timer);
    this.pendingBargeIn = {
      atNs: ts,
      turnId,
      timer: setTimeout(() => this.resolveBargeIn('timeout_no_transcript'), 900),
    };
  }

  /**
   * Decide whether a pending barge-in was a real interruption.
   *
   * This is where stopSpeaking.acknowledgementPhrases, numWords, voiceSeconds
   * and backoffSeconds finally take effect: before this existed, every one of
   * them was dead config and a lone "اه" always stopped the agent.
   */
  private resolveBargeIn(trigger: string): void {
    const pending = this.pendingBargeIn;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingBargeIn = null;

    const transcript = currentTranscriptOf(this.liveTracker);
    const voiceMs = this.modeC.overlapMs();

    // No words at all: assume the caller meant it. Silence here would leave the
    // agent talking over someone the microphone clearly heard.
    const decision =
      transcript.trim().length === 0
        ? { interrupt: true, reason: trigger === 'timeout_no_transcript' ? 'no_transcript_in_time' : 'no_transcript', words: 0, matchedPhrase: null }
        : this.modeC.classifyBargeIn(transcript, voiceMs);

    this.bus.emit({
      event: 'vad.barge_in_classified',
      turnId: pending.turnId,
      metadata: {
        interrupt: decision.interrupt,
        reason: decision.reason,
        transcript,
        voiceMs: roundMs(voiceMs),
        trigger,
      },
    });

    this.hooks.sendJson({
      type: 'bargein.resolved',
      interrupt: decision.interrupt,
      reason: decision.reason,
      transcript,
      generation: this.generation,
    });

    if (decision.interrupt) {
      this.cancelCurrentTurn('barge_in');
    } else {
      // Backchannel: the agent keeps the turn, and the words are discarded so
      // they cannot leak into the caller's NEXT question.
      this.modeC.clearOverlap();
      // Discard the backchannel words so they cannot leak into the caller's
      // NEXT question. A fresh tracker is how a turn boundary is expressed
      // everywhere else in this file.
      this.liveTracker = new TurnTranscriptTracker();
      this.sawPartialThisUtterance = false;
    }
  }

  /* ====================================================================== */
  /* Turn lifecycle                                                          */
  /* ====================================================================== */

  /* ====================================================================== */
  /* Mode C                                                                  */
  /* ====================================================================== */

  /**
   * The Mode C endpointing engine committed the turn. Unlike Modes A and B this
   * instant is chosen from the CONTENT of the transcript, so it carries a reason
   * that goes straight into the trace.
   */
  private onModeCCommit(decision: EndpointDecision, speechEndNs: bigint, commitNs: bigint): void {
    if (this.closed || this.currentTurn) return;
    if (!this.llm || !this.tts) {
      this.bus.emit({ event: 'pipeline.error', metadata: { message: 'providers are not ready; run warm-up first' } });
      return;
    }

    const turnId = newTurnId();
    this.generation++;

    this.bus.setSpeechEnd(turnId, speechEndNs);
    this.bus.setEndpoint(turnId, commitNs);

    this.bus.emit({
      event: 'vad.speech_ended',
      turnId,
      timestampNs: speechEndNs,
      clientOriginated: true,
      metadata: { anchor: true },
    });
    this.bus.emit({
      event: 'turn.endpoint_detected',
      turnId,
      timestampNs: commitNs,
      pipelineMode: 'C',
      metadata: {
        endpointDetectionDelayMs: roundMs(deltaMs(speechEndNs, commitNs)),
        source: 'modeC_endpointing_engine',
        // The whole point: WHY the turn started, not just when.
        reason: decision.reason,
        reasonCode: decision.reasonCode,
        contentClass: decision.contentClass,
        confidence: decision.confidence,
        stabilityScore: decision.stabilityScore,
        requiredSilenceMs: roundMs(decision.requiredSilenceMs),
        observedSilenceMs: roundMs(decision.observedSilenceMs),
        strategy: decision.strategy,
        ruleName: decision.ruleName,
        words: decision.words,
      },
    });

    const emitter = new ScopedEmitter(this.bus, turnId, 'C', this.traceId);
    const tracker = this.liveTracker;
    this.liveTracker = new TurnTranscriptTracker();

    this.modeC.noteTurnStarted();
    const orchestrator = new ModeCOrchestrator(
      {
        turnId,
        traceId: this.traceId,
        generation: this.generation,
        takeAcknowledgement: () => this.modeC.takeAcknowledgement(),
        config: this.config,
        modeC: this.config.modeC,
        speechEndNs,
        endpointNs: commitNs,
        decision,
        history: this.history,
        transcripts: tracker,
        prefetch: this.prefetch,
        telemetry: emitter,
        bus: this.modeC.bus,
        ttsCache: this.modeC.cache,
      },
      { llm: this.llm, tts: this.tts, retriever: this.config.rag.enabled ? this.kb : null },
      {
        onAudio: (chunk) => {
          this.assistantSpeaking = true;
          this.hooks.sendAudio(chunk);
        },
        onAssistantText: (text) => this.hooks.sendJson({ type: 'turn.assistant_text', turnId, text, partial: false }),
        onFinished: (r) =>
          this.finishTurn(turnId, {
            turnId,
            mode: 'C',
            transcript: r.transcript,
            transcriptSource: r.transcriptSource as any,
            assistantText: r.assistantText,
            retrieval: r.retrieval,
            cancelled: r.cancelled,
            error: r.error,
          }),
      },
    );

    this.currentTurn = { turnId, runner: orchestrator, tracker, generation: this.generation, startedNs: nowNs(), emitter };
    this.armTurnWatchdog(turnId);
    this.prefetch = null;
    this.prefetchQuerySeen = '';
    this.modeC.reset();

    this.hooks.sendJson({ type: 'audio.format', ...this.tts.audioFormat, generation: this.generation });

    void orchestrator.run().catch((e) => {
      this.bus.emit({ event: 'pipeline.error', turnId, metadata: { message: e?.message ?? String(e) } });
      this.finishTurn(turnId, null);
    });
  }

  /** Live endpointing snapshot for the Mode C monitor lane. */
  modeCSnapshot() {
    return this.modeC.snapshot();
  }

  private startTurn(turnId: string, speechEndNs: bigint, endpointNs: bigint): void {
    if (!this.llm || !this.tts) {
      this.bus.emit({
        event: 'pipeline.error',
        turnId,
        metadata: { message: 'providers are not ready; run warm-up first' },
      });
      return;
    }

    const mode = this.config.mode;
    const emitter = new ScopedEmitter(this.bus, turnId, mode, this.traceId);
    const tracker = this.liveTracker;

    // Hand this utterance's tracker to the turn and start a fresh one for the
    // next utterance, so a late final from turn N cannot pollute turn N+1.
    this.liveTracker = new TurnTranscriptTracker();

    const runner = new TurnRunner(
      {
        turnId,
        traceId: this.traceId,
        generation: this.generation,
        mode,
        config: this.config,
        speechEndNs,
        endpointNs,
        history: this.history,
        transcripts: tracker,
        prefetch: this.prefetch,
        telemetry: emitter,
      },
      { llm: this.llm, tts: this.tts, retriever: this.config.rag.enabled ? this.kb : null },
      {
        onAudio: (chunk) => {
          this.assistantSpeaking = true;
          this.hooks.sendAudio(chunk);
        },
        onAssistantText: (text) => {
          this.hooks.sendJson({ type: 'turn.assistant_text', turnId, text, partial: false });
        },
        onFinished: (r) => this.finishTurn(turnId, r),
      },
    );

    this.currentTurn = { turnId, runner, tracker, generation: this.generation, startedNs: nowNs(), emitter };
    this.armTurnWatchdog(turnId);
    this.prefetch = null;
    this.prefetchQuerySeen = '';

    this.hooks.sendJson({
      type: 'audio.format',
      ...this.tts.audioFormat,
      generation: this.generation,
    });

    void runner.run().catch((e) => {
      this.bus.emit({ event: 'pipeline.error', turnId, metadata: { message: e?.message ?? String(e) } });
      this.finishTurn(turnId, null);
    });
  }

  /**
   * Release the turn if nothing else ever does.
   *
   * A turn that never finishes pins `currentTurn` forever, and every later
   * utterance is then ignored — the agent goes silent for the rest of the call
   * with no error anywhere. That exact wedge was reachable through an early
   * return that skipped the completion hook; it is fixed at the source, but a
   * silent permanent failure is severe enough to deserve a backstop, and the
   * backstop is cheap.
   *
   * Generous on purpose: it must never cut a slow-but-healthy turn short. It is
   * a deadlock breaker, not a timeout.
   */
  private armTurnWatchdog(turnId: string): void {
    if (!this.currentTurn || this.currentTurn.turnId !== turnId) return;
    this.currentTurn.watchdog = setTimeout(() => {
      if (this.currentTurn?.turnId !== turnId) return;
      this.bus.emit({
        event: 'pipeline.error',
        turnId,
        metadata: {
          message: 'Turn never completed; released by watchdog. The session would otherwise be stuck.',
          elapsedMs: roundMs(deltaMs(this.currentTurn.startedNs, nowNs())),
        },
      });
      this.finishTurn(turnId, null);
    }, 90_000);
  }

  private finishTurn(turnId: string, result: TurnResult | null): void {
    if (this.currentTurn?.turnId !== turnId) return;
    const state = this.currentTurn;
    if (state.watchdog) clearTimeout(state.watchdog);
    this.currentTurn = null;
    this.assistantSpeaking = false;

    if (result && result.transcript) {
      this.history.push({ role: 'user', content: result.transcript });
      if (result.assistantText) this.history.push({ role: 'assistant', content: result.assistantText });
      const keep = this.config.llm.historyTurns * 2;
      if (this.history.length > keep) this.history = this.history.slice(-keep);

      this.hooks.sendJson({
        type: 'turn.transcript',
        turnId,
        text: result.transcript,
        source: result.transcriptSource,
        isFinal: result.transcriptSource === 'final',
      });
    }

    state.tracker.dispose();

    // Derive metrics on a macrotask: the turn is over, but the socket may still
    // be draining audio, and this walk is O(events).
    setTimeout(() => this.publishTurnMetrics(turnId), 120);
  }

  private publishTurnMetrics(turnId: string): void {
    const events = this.bus.forTurn(turnId);
    if (events.length === 0) return;
    const metrics = deriveTurnMetrics(events as TelemetryEvent[]);
    if (!metrics) return;
    const json = serializeMetrics(metrics) as Record<string, unknown>;
    // Attach the Vapi-style performance model, the provider/ours split and the
    // gap findings so every view works from one payload.
    json.performance = buildVapiPerformanceModel(events as TelemetryEvent[]);
    json.attribution = attributeLatency(events as TelemetryEvent[]);
    json.gaps = detectGaps(events as TelemetryEvent[]);
    this.turnMetrics.push(json);
    if (this.turnMetrics.length > 500) this.turnMetrics.shift();
    this.hooks.sendJson({ type: 'turn.metrics', metrics: json });
  }

  cancelCurrentTurn(reason: string): void {
    const t = this.currentTurn;
    if (!t) return;
    // Bump the generation FIRST so any audio still in flight is already stale
    // by the time it reaches the emitter.
    this.generation++;
    t.runner.cancel(reason);
    this.hooks.sendJson({ type: 'audio.flush', generation: this.generation, reason });
    // The turn is released here, so its deadlock backstop must go with it or a
    // stray timer fires 90 s later against an unrelated turn id.
    if (t.watchdog) clearTimeout(t.watchdog);
    this.currentTurn = null;
    this.assistantSpeaking = false;
    setTimeout(() => this.publishTurnMetrics(t.turnId), 120);
  }

  /** Manual endpoint trigger from the UI (useful when testing without a mic). */
  manualEndpoint(): void {
    const now = nowNs();
    const speechEnd = this.pendingSpeechEndNs ?? now;
    if (this.currentTurn) return;
    const turnId = newTurnId();
    this.generation++;
    this.bus.setSpeechEnd(turnId, speechEnd);
    this.bus.setEndpoint(turnId, now);
    this.bus.emit({
      event: 'turn.endpoint_detected',
      turnId,
      timestampNs: now,
      metadata: { source: 'manual', endpointDetectionDelayMs: roundMs(deltaMs(speechEnd, now)) },
    });
    this.startTurn(turnId, speechEnd, now);
  }

  /* ====================================================================== */
  /* Audio downlink acknowledgements (spec section 10)                       */
  /* ====================================================================== */

  private firstBrowserAckSeen = new Set<string>();

  onAudioReceived(clientNs: string, generation: number, phraseSeq: number, audioSeq: number, bytes: number): void {
    const ts = this.toServerNs(clientNs);
    const turnId = this.currentTurn?.turnId ?? this.lastTurnIdForGeneration(generation);
    const key = `${turnId}:recv`;
    if (!this.firstBrowserAckSeen.has(key)) {
      this.firstBrowserAckSeen.add(key);
      this.bus.emit({
        event: 'audio.browser_first_received',
        turnId,
        timestampNs: ts,
        clientOriginated: true,
        metadata: { generation, phraseSeq, audioSeq, bytes, clockUncertaintyMs: this.clockUncertaintyMs() },
      });
    }
    this.bus.emit({
      event: 'audio.browser_received',
      turnId,
      timestampNs: ts,
      clientOriginated: true,
      metadata: { bytes, phraseSeq, audioSeq },
    });
  }

  onPlaybackStarted(clientNs: string, generation: number, phraseSeq: number): void {
    const ts = this.toServerNs(clientNs);
    const turnId = this.currentTurn?.turnId ?? this.lastTurnIdForGeneration(generation);
    const key = `${turnId}:play`;
    if (this.firstBrowserAckSeen.has(key)) return;
    this.firstBrowserAckSeen.add(key);
    this.bus.emit({
      event: 'audio.playback_started',
      turnId,
      timestampNs: ts,
      clientOriginated: true,
      metadata: {
        generation,
        phraseSeq,
        clockUncertaintyMs: this.clockUncertaintyMs(),
        note: 'measured with AudioContext.getOutputTimestamp, so device output latency is included',
      },
    });
  }

  onPlaybackFinished(clientNs: string, generation: number): void {
    const turnId = this.currentTurn?.turnId ?? this.lastTurnIdForGeneration(generation);
    this.assistantSpeaking = false;
    this.bus.emit({
      event: 'audio.playback_finished',
      turnId,
      timestampNs: this.toServerNs(clientNs),
      clientOriginated: true,
      metadata: { generation },
    });
  }

  onQueueDepth(ms: number, frames: number): void {
    this.bus.emit({
      event: 'audio.queue_depth',
      turnId: this.currentTurn?.turnId ?? null,
      metadata: { ms: roundMs(ms), frames },
    });
  }

  onUnderrun(count: number, durationMs: number): void {
    this.bus.emit({
      event: 'audio.underrun',
      turnId: this.currentTurn?.turnId ?? null,
      metadata: { count, durationMs: roundMs(durationMs) },
    });
  }

  private lastGenerationTurn = new Map<number, string>();

  private lastTurnIdForGeneration(generation: number): string | null {
    if (this.currentTurn && this.currentTurn.generation === generation) return this.currentTurn.turnId;
    return this.lastGenerationTurn.get(generation) ?? null;
  }

  private clockUncertaintyMs(): number | null {
    const c = this.clock.get();
    return c ? roundMs(Number(c.uncertaintyNs) / 1e6, 3) : null;
  }

  /* ====================================================================== */
  /* Mic + clock                                                             */
  /* ====================================================================== */

  onMicOpened(sampleRate: number, frameSamples: number): void {
    this.bus.emit({ event: 'mic.opened', metadata: { sampleRate, frameSamples } });
  }

  onMicStats(framesPerSec: number, bytesPerSec: number, rms: number, peak: number): void {
    this.bus.emit({
      event: 'mic.stats',
      turnId: this.currentTurn?.turnId ?? null,
      metadata: { framesPerSec, bytesPerSec, rms: Math.round(rms * 1000) / 1000, peak: Math.round(peak * 1000) / 1000 },
    });
  }

  onClockPing(id: number, t0: string): void {
    this.hooks.sendJson({ type: 'clock.pong', id, t0, t1: nowNs().toString() });
  }

  onClockSample(t0: string, t1: string, t2: string): void {
    this.clock.addSample(BigInt(t0), BigInt(t1), BigInt(t2));
    if (this.clock.ready && this.steps.get('clock')?.state !== 'ready') {
      this.setStep('clock', 'ready', `offset ${this.clock.toJSON()?.offsetMs ?? 0} ms`);
      this.bus.emit({ event: 'session.clock_synced', metadata: this.clock.toJSON() ?? {} });
    }
  }

  /* ====================================================================== */
  /* Fixed-clip recording                                                    */
  /* ====================================================================== */

  startRecording(): void {
    this.recording = { active: true, frames: [], bytes: 0 };
    this.hooks.sendJson({ type: 'ab.recording', state: 'started' });
  }

  stopRecording(): { pcm: Uint8Array; durationMs: number } {
    this.recording.active = false;
    const total = this.recording.bytes;
    const pcm = new Uint8Array(total);
    let off = 0;
    for (const f of this.recording.frames) {
      pcm.set(f, off);
      off += f.byteLength;
    }
    this.recording.frames = [];
    const durationMs = pcm16DurationMs(total, 16_000);
    this.hooks.sendJson({ type: 'ab.recording', state: 'stopped', durationMs: roundMs(durationMs) });
    return { pcm, durationMs };
  }

  /* ====================================================================== */
  /* Status / debug / teardown                                               */
  /* ====================================================================== */

  private sendDebug(source: string, direction: 'in' | 'out', payload: unknown): void {
    if (!this.debugRawEnabled) return;
    this.hooks.sendJson({ type: 'debug.raw', source, direction, payload, tServer: nowNs().toString() });
  }

  setDebugRaw(enabled: boolean): void {
    this.debugRawEnabled = enabled;
  }

  status() {
    return {
      sessionId: this.id,
      traceId: this.traceId,
      ready: this.ready,
      mode: this.config.mode,
      steps: [...this.steps.values()],
      audioFormat: this.tts?.audioFormat ?? { sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le' },
      clock: this.clock.toJSON(),
      providers: {
        stt: 'speechmatics',
        llm: 'openai',
        tts: 'hamsa',
        ttsTransport: this.config.tts.transport,
      },
      rag: {
        ready: this.kb?.ready ?? false,
        documents: this.kb?.documentCount ?? 0,
        chunks: this.kb?.chunkCount ?? 0,
        retriever: this.kb?.retrieverMode ?? 'none',
      },
      secrets: secrets.presence(),
      // Live endpointing view. Only meaningful in Mode C, but always present so
      // the UI can render the lane without a second round trip.
      modeC: this.config.mode === 'C' ? this.modeC.snapshot() : null,
    };
  }

  pushStatus(): void {
    this.hooks.sendJson({ type: 'session.status', status: this.status() });
  }

  /** Send an arbitrary control message on this session's socket. */
  send(msg: unknown): void {
    this.hooks.sendJson(msg);
  }

  get metricsHistory(): unknown[] {
    return this.turnMetrics;
  }

  get providers() {
    return { llm: this.llm, tts: this.tts, kb: this.kb };
  }

  /**
   * The Speechmatics PROVIDER (not the live session). Benchmarks and replays
   * use it to open their own short-lived recognition sessions, so they can
   * never disturb the conversation's long-lived one.
   */
  get sttProvider(): SpeechmaticsSttProvider | null {
    return this.stt;
  }

  get activeConfig(): SessionConfig {
    return this.config;
  }

  resetConversation(): void {
    this.cancelCurrentTurn('session_reset');
    this.modeC.reset();
    this.history = [];
    this.liveTracker.dispose();
    this.liveTracker = new TurnTranscriptTracker();
    this.prefetch = null;
    this.bus.emit({ event: 'session.config_updated', metadata: { reset: true } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelCurrentTurn('session_closed');
    // Flush the recording BEFORE tearing the bus down, so the final events of
    // the call are not the ones that get lost.
    await this.recorder.stop().catch(() => undefined);
    this.unsubscribeTelemetry?.();
    this.modeC.dispose();
    this.bus.emit({ event: 'session.closed' });
    try {
      await this.sttSession?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.tts?.close();
    } catch {
      /* ignore */
    }
    this.bus.dispose();
  }
}

/** bigint-safe projection of derived metrics for the wire. */
export function serializeMetrics(m: ReturnType<typeof deriveTurnMetrics>): unknown {
  if (!m) return null;
  const conv = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) o[k] = conv(val);
      return o;
    }
    return v;
  };
  return conv(m);
}
