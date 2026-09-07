/**
 * Isolated benchmarks (spec section 19).
 *
 * The purpose of this module is attribution. When an end-to-end turn takes four
 * seconds, these probes answer "which component?" without guesswork, by timing
 * each provider in isolation with everything else removed.
 *
 * Every benchmark reports the SAME headline shape: the instant a request left
 * this process, and the instant the first useful byte came back. No averaging
 * is done inside a run; repetitions are reported individually so an outlier is
 * visible rather than smoothed away.
 */

import {
  ScopedEmitter,
  TelemetryBus,
  deltaMs,
  newTraceId,
  newTurnId,
  nowNs,
  roundMs,
  summarize,
  type Summary,
} from '@vll/telemetry';
import {
  STREAMING_POLICY,
  StreamingSpeechChunker,
  type LlmProvider,
  type SessionConfig,
  type SpeechPhrase,
  type TtsProvider,
} from '@vll/core';
import type { KnowledgeBase } from '@vll/rag';
import type { SpeechmaticsSttProvider } from '@vll/providers';
import { pcm16BytesForMs, pcm16DurationMs } from '@vll/audio';

export type BenchmarkId =
  | 'stt_only'
  | 'llm_only'
  | 'tts_only'
  | 'llm_to_tts'
  | 'stt_to_llm'
  | 'rag_only'
  | 'full_pipeline'
  | 'full_pipeline_rag';

export interface BenchmarkStep {
  label: string;
  /** Milliseconds from the run's t0. */
  atMs: number;
  detail?: Record<string, unknown>;
}

export interface BenchmarkRun {
  id: BenchmarkId;
  label: string;
  ok: boolean;
  error?: string;
  /** The single number this benchmark exists to produce. */
  headlineLabel: string;
  headlineMs: number | null;
  steps: BenchmarkStep[];
  detail: Record<string, unknown>;
}

export interface BenchmarkResult {
  id: BenchmarkId;
  label: string;
  description: string;
  runs: BenchmarkRun[];
  summary: Summary | null;
  config: Record<string, unknown>;
  startedAt: string;
}

export const BENCHMARK_CATALOG: Array<{ id: BenchmarkId; label: string; description: string; needsAudio?: boolean }> = [
  {
    id: 'stt_only',
    label: 'STT only',
    description:
      'Streams a recorded utterance to Speechmatics at real-time pace and measures first partial and final transcript latency. Requires a recorded clip.',
    needsAudio: true,
  },
  {
    id: 'llm_only',
    label: 'LLM only',
    description: 'Measures request sent -> first text delta (TTFT). No STT, no RAG, no TTS.',
  },
  {
    id: 'tts_only',
    label: 'TTS only',
    description: 'Sends a fixed phrase directly to Hamsa and measures request sent -> first audio byte (TTFA).',
  },
  {
    id: 'llm_to_tts',
    label: 'LLM to TTS',
    description:
      'Skips STT. Measures LLM first delta -> first speakable phrase -> first Hamsa audio byte. This is the handoff that a sentence-buffering architecture loses seconds in.',
  },
  {
    id: 'stt_to_llm',
    label: 'STT to LLM',
    description: 'Measures transcript availability -> LLM first delta, including retrieval if enabled. Requires a recorded clip.',
    needsAudio: true,
  },
  {
    id: 'rag_only',
    label: 'RAG only',
    description: 'Measures retrieval latency alone, so its contribution can be quantified exactly.',
  },
  {
    id: 'full_pipeline',
    label: 'Full pipeline (RAG off)',
    description:
      'Replays a recorded utterance through the complete server-side pipeline with retrieval disabled. Browser transport and playback are excluded.',
    needsAudio: true,
  },
  {
    id: 'full_pipeline_rag',
    label: 'Full pipeline + RAG',
    description: 'As above, with retrieval enabled. The difference between the two is exactly what RAG costs.',
    needsAudio: true,
  },
];

export interface BenchmarkDeps {
  llm: LlmProvider | null;
  tts: TtsProvider | null;
  stt: SpeechmaticsSttProvider | null;
  kb: KnowledgeBase | null;
  config: SessionConfig;
  bus: TelemetryBus;
  /** Recorded PCM16 16 kHz mono clip, if one has been captured. */
  clip?: { pcm: Uint8Array; durationMs: number } | null;
}

export interface BenchmarkOptions {
  repetitions?: number;
  /** Fixed text used by the TTS and LLM probes. */
  text?: string;
  query?: string;
  /** Pause between repetitions so provider-side caching does not dominate. */
  cooldownMs?: number;
}

const DEFAULT_TTS_PHRASE_AR = 'وعليكم السلام، أكيد أقدر أساعدك في معرفة الخدمات المتوفرة عندنا.';
const DEFAULT_TTS_PHRASE_EN = 'Hello, of course I can help you with the services we offer.';
const DEFAULT_LLM_PROMPT_AR = 'السلام عليكم، بدي أعرف شو الخدمات المتوفرة عندكم';
const DEFAULT_LLM_PROMPT_EN = 'Hello, I would like to know what services you offer.';

export class BenchmarkRunner {
  constructor(private readonly deps: BenchmarkDeps) {}

  async run(id: BenchmarkId, opts: BenchmarkOptions = {}, onProgress?: (s: string, d?: unknown) => void): Promise<BenchmarkResult> {
    const meta = BENCHMARK_CATALOG.find((b) => b.id === id);
    const reps = Math.max(1, Math.min(20, opts.repetitions ?? 3));
    const runs: BenchmarkRun[] = [];
    const startedAt = new Date().toISOString();

    this.deps.bus.emit({ event: 'bench.started', metadata: { benchmark: id, repetitions: reps } });

    for (let i = 0; i < reps; i++) {
      onProgress?.(`run ${i + 1}/${reps}`);
      let run: BenchmarkRun;
      try {
        run = await this.runOnce(id, opts);
      } catch (e: any) {
        run = {
          id,
          label: meta?.label ?? id,
          ok: false,
          error: e?.message ?? String(e),
          headlineLabel: '-',
          headlineMs: null,
          steps: [],
          detail: {},
        };
      }
      runs.push(run);
      this.deps.bus.emit({
        event: run.ok ? 'bench.step' : 'bench.failed',
        metadata: { benchmark: id, run: i + 1, headlineMs: run.headlineMs, error: run.error },
      });
      if (i < reps - 1 && (opts.cooldownMs ?? 400) > 0) {
        await sleep(opts.cooldownMs ?? 400);
      }
    }

    const values = runs.filter((r) => r.ok && r.headlineMs != null).map((r) => r.headlineMs!);
    const result: BenchmarkResult = {
      id,
      label: meta?.label ?? id,
      description: meta?.description ?? '',
      runs,
      summary: values.length > 0 ? summarize(values) : null,
      config: this.configSnapshot(id),
      startedAt,
    };
    this.deps.bus.emit({
      event: 'bench.completed',
      metadata: { benchmark: id, runs: runs.length, p50: result.summary?.p50 ?? null },
    });
    return result;
  }

  private configSnapshot(id: BenchmarkId): Record<string, unknown> {
    const c = this.deps.config;
    const base: Record<string, unknown> = {
      llmModel: c.llm.model,
      reasoningEffort: c.llm.reasoningEffort,
      verbosity: c.llm.verbosity,
      serviceTier: c.llm.serviceTier,
      maxOutputTokens: c.llm.maxOutputTokens,
      speaker: c.tts.speaker,
      dialect: c.tts.dialect,
      ttsTransport: c.tts.transport,
      sampleRate: c.tts.sampleRate,
      language: c.language,
    };
    if (id.startsWith('full') || id === 'stt_to_llm' || id === 'stt_only') {
      base.sttModel = c.stt.model;
      base.sttMaxDelay = c.stt.maxDelay;
      base.endOfUtteranceSilenceTrigger = c.stt.endOfUtteranceSilenceTrigger;
    }
    if (id.includes('rag')) {
      base.ragTopK = c.rag.topK;
      base.retriever = this.deps.kb?.retrieverMode ?? 'none';
    }
    return base;
  }

  private async runOnce(id: BenchmarkId, opts: BenchmarkOptions): Promise<BenchmarkRun> {
    switch (id) {
      case 'llm_only':
        return this.benchLlmOnly(opts);
      case 'tts_only':
        return this.benchTtsOnly(opts);
      case 'llm_to_tts':
        return this.benchLlmToTts(opts);
      case 'rag_only':
        return this.benchRagOnly(opts);
      case 'stt_only':
        return this.benchSttOnly(opts);
      case 'stt_to_llm':
        return this.benchSttToLlm(opts);
      case 'full_pipeline':
        return this.benchFull(opts, false);
      case 'full_pipeline_rag':
        return this.benchFull(opts, true);
      default:
        throw new Error(`Unknown benchmark: ${id}`);
    }
  }

  /* ---------------------------------------------------------------------- */

  private phrase(opts: BenchmarkOptions): string {
    return opts.text ?? (this.deps.config.language === 'ar' ? DEFAULT_TTS_PHRASE_AR : DEFAULT_TTS_PHRASE_EN);
  }

  private prompt(opts: BenchmarkOptions): string {
    return opts.query ?? (this.deps.config.language === 'ar' ? DEFAULT_LLM_PROMPT_AR : DEFAULT_LLM_PROMPT_EN);
  }

  /* ---- LLM only -------------------------------------------------------- */

  private async benchLlmOnly(opts: BenchmarkOptions): Promise<BenchmarkRun> {
    const llm = this.deps.llm;
    if (!llm) throw new Error('OpenAI provider is not configured');
    const c = this.deps.config;
    const steps: BenchmarkStep[] = [];
    const t0 = nowNs();

    let firstDeltaNs: bigint | null = null;
    let createdNs: bigint | null = null;
    let chars = 0;

    const handle = llm.stream(
      {
        model: c.llm.model,
        instructions: c.systemPrompt,
        input: [{ role: 'user', content: this.prompt(opts) }],
        maxOutputTokens: c.llm.maxOutputTokens,
        temperature: c.llm.temperature ?? undefined,
        reasoningEffort: c.llm.reasoningEffort,
        verbosity: c.llm.verbosity,
        serviceTier: c.llm.serviceTier,
        store: c.llm.store,
      },
      {
        onCreated: () => {
          createdNs = nowNs();
          steps.push({ label: 'response.created', atMs: roundMs(deltaMs(t0, createdNs)) });
        },
        onFirstDelta: (d) => {
          firstDeltaNs = nowNs();
          steps.push({ label: 'first text delta', atMs: roundMs(deltaMs(t0, firstDeltaNs)), detail: { delta: d } });
        },
        onDelta: (d) => {
          chars += d.length;
        },
      },
    );
    steps.unshift({ label: 'request sent', atMs: 0 });

    const out = await handle.done;
    const doneNs = nowNs();
    steps.push({ label: 'stream completed', atMs: roundMs(deltaMs(t0, doneNs)) });

    if (out.error) throw new Error(out.error.message);

    return {
      id: 'llm_only',
      label: 'LLM only',
      ok: firstDeltaNs !== null,
      headlineLabel: 'LLM TTFT (request sent -> first text delta)',
      headlineMs: firstDeltaNs ? roundMs(deltaMs(t0, firstDeltaNs)) : null,
      steps,
      detail: {
        model: c.llm.model,
        responseChars: out.text.length,
        totalMs: roundMs(deltaMs(t0, doneNs)),
        createdMs: createdNs ? roundMs(deltaMs(t0, createdNs)) : null,
        text: out.text.slice(0, 400),
      },
    };
  }

  /* ---- TTS only -------------------------------------------------------- */

  private async benchTtsOnly(opts: BenchmarkOptions): Promise<BenchmarkRun> {
    const tts = this.deps.tts;
    if (!tts) throw new Error('Hamsa provider is not configured');
    const c = this.deps.config;
    const text = this.phrase(opts);
    const steps: BenchmarkStep[] = [];

    let sentNs: bigint | null = null;
    let firstAudioNs: bigint | null = null;
    let bytes = 0;
    let chunks = 0;
    const chunkSizes: number[] = [];

    const t0 = nowNs();
    const handle = tts.synthesize(
      {
        text,
        speaker: c.tts.speaker,
        dialect: c.tts.dialect,
        languageId: c.tts.languageId,
        sampleRate: c.tts.sampleRate,
        mulaw: c.tts.mulaw,
        expressiveness: c.tts.expressiveness,
        turnId: newTurnId(),
        phraseSeq: 1,
        generation: 0,
      },
      {
        onRequestSent: () => {
          sentNs = nowNs();
          steps.push({ label: 'TTS request sent', atMs: roundMs(deltaMs(t0, sentNs)) });
        },
        onFirstAudio: (chunk) => {
          firstAudioNs = nowNs();
          steps.push({
            label: 'first binary audio received',
            atMs: roundMs(deltaMs(t0, firstAudioNs)),
            detail: { bytes: chunk.data.byteLength },
          });
        },
        onChunk: (chunk) => {
          bytes += chunk.data.byteLength;
          chunks++;
          if (chunkSizes.length < 40) chunkSizes.push(chunk.data.byteLength);
        },
      },
    );

    const out = await handle.done;
    const endNs = nowNs();
    steps.push({ label: 'stream end', atMs: roundMs(deltaMs(t0, endNs)) });
    if (out.error) throw new Error(out.error.message);

    const base = sentNs ?? t0;
    const fmt = tts.audioFormat;
    return {
      id: 'tts_only',
      label: 'TTS only',
      ok: firstAudioNs !== null,
      headlineLabel: 'TTS TTFA (request sent -> first audio byte)',
      headlineMs: firstAudioNs ? roundMs(deltaMs(base, firstAudioNs)) : null,
      steps,
      detail: {
        transport: c.tts.transport,
        speaker: c.tts.speaker,
        text,
        chars: text.length,
        bytes,
        chunks,
        chunkSizes,
        audioDurationMs: roundMs(pcm16DurationMs(bytes, fmt.sampleRate)),
        totalStreamMs: roundMs(deltaMs(base, endNs)),
        // >1 means synthesis was faster than real time, which is what makes
        // continuous streaming playback possible without underruns.
        realtimeFactor:
          bytes > 0 ? roundMs(pcm16DurationMs(bytes, fmt.sampleRate) / Math.max(1, deltaMs(base, endNs)), 2) : null,
      },
    };
  }

  /* ---- LLM -> TTS ------------------------------------------------------ */

  private async benchLlmToTts(opts: BenchmarkOptions): Promise<BenchmarkRun> {
    const llm = this.deps.llm;
    const tts = this.deps.tts;
    if (!llm) throw new Error('OpenAI provider is not configured');
    if (!tts) throw new Error('Hamsa provider is not configured');

    const c = this.deps.config;
    const mode = c.mode;
    const policy = c.chunker.B;
    const steps: BenchmarkStep[] = [];

    const t0 = nowNs();
    let firstDeltaNs: bigint | null = null;
    let firstPhraseNs: bigint | null = null;
    let ttsSentNs: bigint | null = null;
    let firstAudioNs: bigint | null = null;
    let firstPhrase: SpeechPhrase | null = null;
    let ttsStarted = false;

    const chunker = new StreamingSpeechChunker(
      policy,
      {
        onFirstPhrase: (p) => {
          firstPhraseNs = nowNs();
          firstPhrase = p;
          steps.push({
            label: 'first speakable phrase ready',
            atMs: roundMs(deltaMs(t0, firstPhraseNs)),
            detail: { text: p.text, words: p.words, reason: p.reason },
          });
          if (ttsStarted) return;
          ttsStarted = true;
          const h = tts.synthesize(
            {
              text: p.text,
              speaker: c.tts.speaker,
              dialect: c.tts.dialect,
              languageId: c.tts.languageId,
              sampleRate: c.tts.sampleRate,
              mulaw: c.tts.mulaw,
              expressiveness: c.tts.expressiveness,
              turnId: newTurnId(),
              phraseSeq: 1,
              generation: 0,
            },
            {
              onRequestSent: () => {
                ttsSentNs = nowNs();
                steps.push({ label: 'TTS request sent', atMs: roundMs(deltaMs(t0, ttsSentNs)) });
              },
              onFirstAudio: () => {
                if (firstAudioNs) return;
                firstAudioNs = nowNs();
                steps.push({ label: 'first Hamsa audio byte', atMs: roundMs(deltaMs(t0, firstAudioNs)) });
                resolveAudio();
              },
            },
          );
          void h.done;
        },
      },
      { now: nowNs, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as any) },
    );

    let resolveAudio: () => void = () => {};
    const audioPromise = new Promise<void>((r) => {
      resolveAudio = r;
    });

    steps.push({ label: 'LLM request sent', atMs: 0 });
    const handle = llm.stream(
      {
        model: c.llm.model,
        instructions: c.systemPrompt,
        input: [{ role: 'user', content: this.prompt(opts) }],
        maxOutputTokens: c.llm.maxOutputTokens,
        temperature: c.llm.temperature ?? undefined,
        reasoningEffort: c.llm.reasoningEffort,
        verbosity: c.llm.verbosity,
        serviceTier: c.llm.serviceTier,
        store: c.llm.store,
      },
      {
        // Telemetry only: onDelta fires for the first delta as well, so
        // pushing here too would duplicate the first token.
        onFirstDelta: () => {
          firstDeltaNs = nowNs();
          steps.push({ label: 'LLM first delta', atMs: roundMs(deltaMs(t0, firstDeltaNs)) });
        },
        onDelta: (d) => chunker.push(d),
      },
    );

    const out = await handle.done;
    chunker.finish();
    await Promise.race([audioPromise, sleep(15_000)]);
    if (out.error) throw new Error(out.error.message);

    const chunkDelay = firstDeltaNs && firstPhraseNs ? roundMs(deltaMs(firstDeltaNs, firstPhraseNs)) : null;

    return {
      id: 'llm_to_tts',
      label: 'LLM to TTS',
      ok: firstAudioNs !== null,
      headlineLabel: 'LLM first delta -> first Hamsa audio byte',
      headlineMs: firstDeltaNs && firstAudioNs ? roundMs(deltaMs(firstDeltaNs, firstAudioNs)) : null,
      steps,
      detail: {
        mode,
        chunkerPolicy: 'streaming phrases',
        llmTtftMs: firstDeltaNs ? roundMs(deltaMs(t0, firstDeltaNs)) : null,
        // The LLM-to-TTS handoff cost.
        textChunkingDelayMs: chunkDelay,
        ttsDispatchMs: firstPhraseNs && ttsSentNs ? roundMs(deltaMs(firstPhraseNs, ttsSentNs)) : null,
        ttsTtfaMs: ttsSentNs && firstAudioNs ? roundMs(deltaMs(ttsSentNs, firstAudioNs)) : null,
        firstPhraseText: firstPhrase ? (firstPhrase as SpeechPhrase).text : null,
        fullText: out.text.slice(0, 400),
      },
    };
  }

  /* ---- RAG only -------------------------------------------------------- */

  private async benchRagOnly(opts: BenchmarkOptions): Promise<BenchmarkRun> {
    const kb = this.deps.kb;
    if (!kb) throw new Error('No knowledge base is configured');
    const query = this.prompt(opts);
    const t0 = nowNs();
    const r = await kb.search(query, { topK: this.deps.config.rag.topK, minScore: this.deps.config.rag.minScore });
    const done = nowNs();
    return {
      id: 'rag_only',
      label: 'RAG only',
      ok: true,
      headlineLabel: 'Retrieval latency',
      headlineMs: roundMs(deltaMs(t0, done)),
      steps: [
        { label: 'search started', atMs: 0 },
        { label: 'results ready', atMs: roundMs(deltaMs(t0, done)) },
      ],
      detail: {
        query,
        retriever: kb.retrieverMode,
        documents: kb.documentCount,
        chunks: kb.chunkCount,
        hits: r.chunks.length,
        topScore: r.chunks[0]?.score ?? null,
        sources: r.chunks.map((c) => `${c.source.filename}#${c.source.chunkIndex}`),
      },
    };
  }

  /* ---- STT only -------------------------------------------------------- */

  private async benchSttOnly(_opts: BenchmarkOptions): Promise<BenchmarkRun> {
    const clip = this.deps.clip;
    if (!clip || clip.pcm.byteLength === 0) {
      throw new Error('No recorded clip. Use "Record test utterance" on the Compare page first.');
    }
    const stt = this.deps.stt;
    if (!stt) throw new Error('Speechmatics provider is not configured');

    const c = this.deps.config;
    const steps: BenchmarkStep[] = [];
    const t0 = nowNs();

    let firstPartialNs: bigint | null = null;
    let finalNs: bigint | null = null;
    let eouNs: bigint | null = null;
    let lastAudioNs: bigint | null = null;
    let partials = 0;
    let finalText = '';
    let firstPartialText = '';

    let resolveFinal: () => void = () => {};
    const finalPromise = new Promise<void>((r) => {
      resolveFinal = r;
    });

    const session = await stt.open(
      {
        language: c.stt.language,
        audioFormat: { sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le' },
        enablePartials: true,
        maxDelay: c.stt.maxDelay,
        maxDelayMode: c.stt.maxDelayMode,
        endOfUtteranceSilenceTrigger: c.stt.endOfUtteranceSilenceTrigger,
        model: c.stt.model,
        punctuationSensitivity: c.stt.punctuationSensitivity,
        additionalVocab: c.stt.additionalVocab,
        label: 'benchmark:stt_only',
      },
      {
        onPartial: (t) => {
          partials++;
          if (!firstPartialNs) {
            firstPartialNs = nowNs();
            firstPartialText = t.text;
            steps.push({
              label: 'first partial transcript',
              atMs: roundMs(deltaMs(t0, firstPartialNs)),
              detail: { text: t.text },
            });
          }
        },
        onFinal: (t) => {
          finalText = `${finalText} ${t.text}`.trim();
          finalNs = nowNs();
        },
        onEndOfUtterance: () => {
          eouNs = nowNs();
          steps.push({ label: 'EndOfUtterance', atMs: roundMs(deltaMs(t0, eouNs)) });
          resolveFinal();
        },
      },
    );

    steps.push({ label: 'recognition started', atMs: roundMs(deltaMs(t0, nowNs())) });

    try {
      // Stream at real-time pace: sending faster would give a misleadingly good
      // latency figure that no live microphone could ever reproduce.
      await this.streamAtRealtime(clip.pcm, c.audio.micFrameMs, (frame) => session.sendAudio(frame));
      lastAudioNs = nowNs();
      steps.push({ label: 'last audio frame sent', atMs: roundMs(deltaMs(t0, lastAudioNs)) });

      await Promise.race([finalPromise, sleep(5_000)]);
      if (finalNs) {
        steps.push({ label: 'final transcript', atMs: roundMs(deltaMs(t0, finalNs)), detail: { text: finalText } });
      }
    } finally {
      // Speechmatics counts CONCURRENT sessions; a throw here must not orphan one.
      try {
        await session.close();
      } catch {
        /* best effort */
      }
    }

    const base = lastAudioNs ?? t0;
    return {
      id: 'stt_only',
      label: 'STT only',
      ok: !!finalNs,
      headlineLabel: 'Last audio sent -> final transcript',
      headlineMs: finalNs ? roundMs(deltaMs(base, finalNs)) : null,
      steps,
      detail: {
        clipDurationMs: roundMs(clip.durationMs),
        model: c.stt.model,
        maxDelay: c.stt.maxDelay,
        endOfUtteranceSilenceTrigger: c.stt.endOfUtteranceSilenceTrigger,
        partialCount: partials,
        firstPartialText,
        finalText,
        // Partials are unaffected by max_delay and are what Mode B proceeds on.
        firstPartialFromStartMs: firstPartialNs ? roundMs(deltaMs(t0, firstPartialNs)) : null,
        finalAfterLastAudioMs: finalNs ? roundMs(deltaMs(base, finalNs)) : null,
        endOfUtteranceAfterLastAudioMs: eouNs ? roundMs(deltaMs(base, eouNs)) : null,
        note: 'Speechmatics documents max_delay >= 0.7s, which puts a floor under the final-transcript figure.',
      },
    };
  }

  /* ---- STT -> LLM ------------------------------------------------------ */

  private async benchSttToLlm(opts: BenchmarkOptions): Promise<BenchmarkRun> {
    const sttRun = await this.benchSttOnly(opts);
    if (!sttRun.ok) return { ...sttRun, id: 'stt_to_llm', label: 'STT to LLM' };
    const transcript = String(sttRun.detail.finalText ?? '');

    const steps = [...sttRun.steps];
    const t0 = nowNs();
    let ragMs: number | null = null;
    if (this.deps.config.rag.enabled && this.deps.kb) {
      const r0 = nowNs();
      await this.deps.kb.search(transcript, {
        topK: this.deps.config.rag.topK,
        minScore: this.deps.config.rag.minScore,
      });
      ragMs = roundMs(deltaMs(r0, nowNs()));
      steps.push({ label: 'retrieval complete', atMs: ragMs });
    }

    const llmRun = await this.benchLlmOnly({ ...opts, query: transcript });
    const ttft = llmRun.headlineMs;
    steps.push({ label: 'LLM first delta', atMs: roundMs(deltaMs(t0, nowNs())) });

    return {
      id: 'stt_to_llm',
      label: 'STT to LLM',
      ok: llmRun.ok,
      headlineLabel: 'Transcript available -> LLM first delta',
      headlineMs: ttft != null && ragMs != null ? roundMs(ttft + ragMs) : ttft,
      steps,
      detail: {
        transcript,
        ragMs,
        llmTtftMs: ttft,
        sttFinalAfterLastAudioMs: sttRun.detail.finalAfterLastAudioMs,
      },
    };
  }

  /* ---- Full pipeline --------------------------------------------------- */

  private async benchFull(opts: BenchmarkOptions, withRag: boolean): Promise<BenchmarkRun> {
    const clip = this.deps.clip;
    if (!clip || clip.pcm.byteLength === 0) {
      throw new Error('No recorded clip. Use "Record test utterance" on the Compare page first.');
    }
    const { runReplay } = await import('./replay.js');
    const r = await runReplay({
      clip,
      mode: this.deps.config.mode,
      config: { ...this.deps.config, rag: { ...this.deps.config.rag, enabled: withRag } },
      deps: {
        llm: this.deps.llm,
        tts: this.deps.tts,
        stt: this.deps.stt,
        kb: this.deps.kb,
      },
      traceId: newTraceId(),
    });

    return {
      id: withRag ? 'full_pipeline_rag' : 'full_pipeline',
      label: withRag ? 'Full pipeline + RAG' : 'Full pipeline (RAG off)',
      ok: r.ok,
      error: r.error,
      headlineLabel: 'Endpoint detected -> first audio byte ready (server-side TTFS)',
      headlineMs: r.serverTtfsMs,
      steps: r.steps,
      detail: r.detail,
    };
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Feed PCM to a consumer at wall-clock speed, in `frameMs` slices. The whole
   * benchmark is meaningless if audio is delivered faster than a microphone
   * could produce it.
   */
  private async streamAtRealtime(pcm: Uint8Array, frameMs: number, onFrame: (f: Uint8Array) => void): Promise<void> {
    const frameBytes = pcm16BytesForMs(frameMs, 16_000);
    const startNs = nowNs();
    let offset = 0;
    let index = 0;
    while (offset < pcm.byteLength) {
      const end = Math.min(offset + frameBytes, pcm.byteLength);
      onFrame(pcm.subarray(offset, end));
      offset = end;
      index++;
      const targetMs = index * frameMs;
      const elapsedMs = deltaMs(startNs, nowNs());
      const waitMs = targetMs - elapsedMs;
      if (waitMs > 1) await sleep(waitMs);
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
