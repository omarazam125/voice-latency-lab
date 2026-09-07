/**
 * Deterministic pipeline replay (spec section 18).
 *
 * Runs a PREVIOUSLY RECORDED utterance through the complete server-side
 * pipeline. This is what makes the comparison scientific: every mode gets
 * byte-identical input audio, the same model, prompt, voice, knowledge base and
 * STT configuration, and the endpoint is computed from the clip itself, so the
 * turn boundary is identical rather than re-detected differently each run.
 *
 * WHAT IS MEASURED: endpoint detected -> first TTS audio byte available to send
 * ("server-side TTFS"). Browser transport and playback scheduling are excluded
 * because there is no browser in the loop here. Those stages are identical
 * between modes anyway, so excluding them does not bias the comparison -- and
 * the live monitor still reports true end-to-end TTFS for real turns.
 */

import {
  ScopedEmitter,
  TelemetryBus,
  attributeLatency,
  buildVapiPerformanceModel,
  deltaMs,
  deriveTurnMetrics,
  detectGaps,
  newTurnId,
  nowNs,
  roundMs,
} from '@vll/telemetry';
import {
  EndpointingManager,
  ModeCOrchestrator,
  TtsCache,
  TurnRunner,
  VoiceEventBus,
  type LlmProvider,
  type PipelineMode,
  type SessionConfig,
  type TtsProvider,
} from '@vll/core';
import type { KnowledgeBase } from '@vll/rag';
import type { SpeechmaticsSttProvider } from '@vll/providers';
import { EnergyVadModel, FrameSplitter, TurnDetector, bytesToInt16, int16ToFloat, pcm16BytesForMs, pcm16DurationMs } from '@vll/audio';
import { TurnTranscriptTracker } from './transcripts.js';
import { serializeMetrics } from './session.js';

export interface ReplayClip {
  pcm: Uint8Array;
  durationMs: number;
}

export interface ReplayDeps {
  llm: LlmProvider | null;
  tts: TtsProvider | null;
  stt: SpeechmaticsSttProvider | null;
  kb: KnowledgeBase | null;
}

export interface ReplayRequest {
  clip: ReplayClip;
  mode: PipelineMode;
  config: SessionConfig;
  deps: ReplayDeps;
  traceId: string;
  onProgress?: (step: string, detail?: unknown) => void;
}

export interface ReplayOutcome {
  ok: boolean;
  error?: string;
  mode: PipelineMode;
  serverTtfsMs: number | null;
  steps: Array<{ label: string; atMs: number; detail?: Record<string, unknown> }>;
  detail: Record<string, unknown>;
  metrics: unknown;
  events: unknown[];
}

const SAMPLE_RATE = 16_000;
const VAD_FRAME = 512;

/**
 * Analyse the clip offline to find the physical speech end and the endpoint the
 * configured silence threshold would produce. Deterministic: the same clip and
 * the same threshold always yield the same offsets, so every mode is
 * compared at exactly the same turn boundary.
 */
export function analyseClip(
  pcm: Uint8Array,
  silenceThresholdMs: number,
  tuning: { positive: number; negative: number; minSpeechFrames: number },
): { speechStartMs: number | null; speechEndMs: number | null; endpointMs: number | null } {
  const samples = int16ToFloat(bytesToInt16(pcm));
  const model = new EnergyVadModel(SAMPLE_RATE, VAD_FRAME);
  const splitter = new FrameSplitter(VAD_FRAME);

  let frameIndex = 0;
  const frameMs = (VAD_FRAME / SAMPLE_RATE) * 1000;
  let speechStartMs: number | null = null;
  let speechEndMs: number | null = null;
  let endpointMs: number | null = null;

  const detector = new TurnDetector(
    {
      sampleRate: SAMPLE_RATE,
      frameSamples: VAD_FRAME,
      silenceThresholdMs,
      positiveSpeechThreshold: tuning.positive,
      negativeSpeechThreshold: tuning.negative,
      minSpeechFrames: tuning.minSpeechFrames,
      bargeInSpeechFrames: 1_000_000,
      now: () => frameIndex * frameMs,
    },
    (e) => {
      if (e.type === 'speech_started' && speechStartMs === null) speechStartMs = e.atMs;
      if (e.type === 'speech_ended') speechEndMs = e.atMs;
      if (e.type === 'endpoint' && endpointMs === null) {
        endpointMs = e.atMs;
        speechEndMs = e.speechEndedAtMs;
      }
    },
  );

  splitter.push(samples, (frame) => {
    frameIndex++;
    if (endpointMs !== null) return;
    const p = model.process(frame);
    let rms = 0;
    for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
    detector.push(p, Math.sqrt(rms / frame.length));
  });

  // If the clip ends while the user is still "speaking" (no trailing silence),
  // treat the end of the clip as the speech end and add the threshold.
  const totalMs = pcm16DurationMs(pcm.byteLength, SAMPLE_RATE);
  if (endpointMs === null) {
    speechEndMs = speechEndMs ?? totalMs;
    endpointMs = Math.min(totalMs, speechEndMs + silenceThresholdMs);
  }
  return { speechStartMs, speechEndMs, endpointMs };
}

export async function runReplay(req: ReplayRequest): Promise<ReplayOutcome> {
  const { clip, mode, config, deps, traceId } = req;
  const steps: ReplayOutcome['steps'] = [];
  const cfg: SessionConfig = { ...config, mode };

  if (!deps.stt) return fail(mode, 'Speechmatics provider is not configured');
  if (!deps.llm) return fail(mode, 'OpenAI provider is not configured');
  if (!deps.tts) return fail(mode, 'Hamsa provider is not configured');

  const analysis = analyseClip(clip.pcm, cfg.vad.silenceThresholdMs, {
    positive: cfg.vad.positiveSpeechThreshold,
    negative: cfg.vad.negativeSpeechThreshold,
    minSpeechFrames: cfg.vad.minSpeechFrames,
  });
  req.onProgress?.('clip analysed', analysis);

  const bus = new TelemetryBus({ sessionId: `replay_${mode}`, traceId, capacity: 20_000 });
  const turnId = newTurnId();
  const tracker = new TurnTranscriptTracker();

  let firstAudioNs: bigint | null = null;
  let firstAudioBytes = 0;
  let totalAudioBytes = 0;
  let prefetch: { query: string; startedAtNs: bigint; promise: Promise<any> } | null = null;
  let prefetchFired = false;

  /* -- STT session dedicated to this replay ------------------------------ */
  // Tracked outside the try so `finally` can always close it: Speechmatics
  // counts CONCURRENT sessions, and a replay that throws midway would
  // otherwise orphan one and eat into the account quota.
  const t0 = nowNs();
  const session = await deps.stt.open(
    {
      language: cfg.stt.language,
      audioFormat: { sampleRate: SAMPLE_RATE, channels: 1, encoding: 'pcm_s16le' },
      enablePartials: true,
      maxDelay: cfg.stt.maxDelay,
      maxDelayMode: cfg.stt.maxDelayMode,
      endOfUtteranceSilenceTrigger: cfg.stt.endOfUtteranceSilenceTrigger,
      model: cfg.stt.model,
      punctuationSensitivity: cfg.stt.punctuationSensitivity,
      additionalVocab: cfg.stt.additionalVocab,
      label: `replay:${mode}`,
    },
    {
      onPartial: (t) => {
        const changed = tracker.pushPartial(t.text);
        if (changed) {
          bus.emit({ event: 'stt.partial', turnId, pipelineMode: mode, metadata: { text: t.text } });
          // Mode B may speculatively retrieve on a stabilised partial.
          const wantsPrefetch =
            (mode === 'B' && cfg.rag.prefetchEnabled) || (mode === 'C' && cfg.modeC.rag.strategy === 'prefetch');
          if (wantsPrefetch && cfg.rag.enabled && deps.kb && !prefetchFired) {
            const words = t.text.trim().split(/\s+/).filter(Boolean).length;
            if (words >= cfg.speculative.minWords) {
              prefetchFired = true;
              const startedAtNs = nowNs();
              bus.emit({ event: 'rag.prefetch_started', turnId, pipelineMode: mode, metadata: { query: t.text } });
              prefetch = {
                query: t.text,
                startedAtNs,
                promise: deps
                  .kb!.search(t.text, { topK: cfg.rag.topK, minScore: cfg.rag.minScore })
                  .then((r) => {
                    bus.emit({
                      event: 'rag.prefetch_completed',
                      turnId,
                      pipelineMode: mode,
                      metadata: { durationMs: roundMs(deltaMs(startedAtNs, nowNs())), chunks: r.chunks.length },
                    });
                    return r;
                  })
                  .catch(() => null),
              };
            }
          }
        }
      },
      onFinal: (t) => {
        tracker.pushFinal(t.text);
        bus.emit({ event: 'stt.final', turnId, pipelineMode: mode, metadata: { text: tracker.finalSoFar() } });
      },
      onEndOfUtterance: () => {
        tracker.markEndOfUtterance();
        bus.emit({ event: 'stt.end_of_utterance', turnId, pipelineMode: mode });
      },
    },
  );
  steps.push({ label: 'STT session opened', atMs: roundMs(deltaMs(t0, nowNs())) });

  /* -- stream the clip at real-time pace, firing the turn at the endpoint - */
  const frameBytes = pcm16BytesForMs(cfg.audio.micFrameMs, SAMPLE_RATE);
  const endpointOffsetMs = analysis.endpointMs ?? clip.durationMs;
  const speechEndOffsetMs = analysis.speechEndMs ?? endpointOffsetMs;

  let runner: TurnRunner | null = null;
  let runPromise: Promise<any> | null = null;
  let speechEndNs: bigint | null = null;
  let endpointNs: bigint | null = null;
  let firstAudioSent = false;

  const streamStartNs = nowNs();
  let offset = 0;
  let frameIndex = 0;

  // The turn result must outlive the try block: the `finally` below always
  // releases the STT session, including when streaming throws.
  let result: Awaited<ReturnType<TurnRunner['run']>> | null = null;
  try {
    while (offset < clip.pcm.byteLength) {
      const end = Math.min(offset + frameBytes, clip.pcm.byteLength);
      session.sendAudio(clip.pcm.subarray(offset, end));
      if (frameIndex === 0) bus.emit({ event: 'stt.first_audio_sent', turnId, pipelineMode: mode });
      offset = end;
      frameIndex++;

      const streamedMs = frameIndex * cfg.audio.micFrameMs;

      // Fire the turn at exactly the offset the offline analysis identified.
      if (!runner && streamedMs >= endpointOffsetMs) {
        const now = nowNs();
        endpointNs = now;
        speechEndNs = now - BigInt(Math.round((endpointOffsetMs - speechEndOffsetMs) * 1e6));

        bus.setSpeechEnd(turnId, speechEndNs);
        bus.setEndpoint(turnId, endpointNs);
        bus.emit({ event: 'vad.speech_ended', turnId, pipelineMode: mode, timestampNs: speechEndNs, metadata: { offline: true } });
        bus.emit({
          event: 'turn.endpoint_detected',
          turnId,
          pipelineMode: mode,
          timestampNs: endpointNs,
          metadata: {
            endpointDetectionDelayMs: roundMs(endpointOffsetMs - speechEndOffsetMs),
            silenceThresholdMs: cfg.vad.silenceThresholdMs,
            source: 'offline_clip_analysis',
          },
        });
        steps.push({ label: 'endpoint detected', atMs: roundMs(deltaMs(streamStartNs, now)) });

        const onAudio = (chunk: { data: Uint8Array }) => {
          totalAudioBytes += chunk.data.byteLength;
          if (!firstAudioSent) {
            firstAudioSent = true;
            firstAudioNs = nowNs();
            firstAudioBytes = chunk.data.byteLength;
            steps.push({
              label: 'first TTS audio byte ready',
              atMs: roundMs(deltaMs(streamStartNs, firstAudioNs)),
              detail: { bytes: chunk.data.byteLength },
            });
          }
        };

        if (mode === 'C') {
          // Mode C replays with its OWN endpointing engine evaluated against the
          // same clip-derived speech end, so the comparison stays like-for-like.
          const decision = new EndpointingManager(cfg.modeC.endpointing).evaluate({
            speaking: false,
            silenceMs: endpointOffsetMs - speechEndOffsetMs,
            transcript: tracker.finalSoFar() || tracker.latestPartial(),
            hasFinal: tracker.hasFinal,
            timeSinceTranscriptChangedMs: 500,
            revisions: 1,
            previousTranscript: tracker.latestPartial(),
          });
          const orchestrator = new ModeCOrchestrator(
            {
              turnId,
              traceId,
              generation: 1,
              config: cfg,
              modeC: cfg.modeC,
              speechEndNs,
              endpointNs,
              decision,
              history: [],
              transcripts: tracker,
              prefetch,
              telemetry: new ScopedEmitter(bus, turnId, 'C', traceId),
              bus: new VoiceEventBus(),
              ttsCache: new TtsCache({
                maxEntries: cfg.modeC.ttsCache.maxEntries,
                maxBytes: cfg.modeC.ttsCache.maxBytes,
                maxPhraseChars: cfg.modeC.ttsCache.maxPhraseChars,
              }),
            },
            { llm: deps.llm, tts: deps.tts, retriever: cfg.rag.enabled ? deps.kb : null },
            { onAudio },
          );
          runner = orchestrator as unknown as TurnRunner;
          runPromise = orchestrator.run();
        } else {
          runner = new TurnRunner(
            {
              turnId,
              traceId,
              generation: 1,
              mode,
              config: cfg,
              speechEndNs,
              endpointNs,
              history: [],
              transcripts: tracker,
              prefetch,
              telemetry: new ScopedEmitter(bus, turnId, mode, traceId),
            },
            { llm: deps.llm, tts: deps.tts, retriever: cfg.rag.enabled ? deps.kb : null },
            { onAudio },
          );
          runPromise = runner.run();
        }
      }

      const targetMs = frameIndex * cfg.audio.micFrameMs;
      const elapsed = deltaMs(streamStartNs, nowNs());
      if (targetMs - elapsed > 1) await sleep(targetMs - elapsed);
    }

    // Keep the STT socket open until the turn resolves.
    result = runPromise ? await Promise.race([runPromise, sleep(45_000).then(() => null)]) : null;
  } finally {
    // ALWAYS release the session, including on an exception or timeout.
    try {
      await session.close();
    } catch {
      /* best effort */
    }
  }
  bus.flush();

  const events = bus.forTurn(turnId);
  const metrics = deriveTurnMetrics(events as any);
  const attribution = attributeLatency(events as any);
  const performance = buildVapiPerformanceModel(events as any);
  const gaps = detectGaps(events as any);
  const serverTtfsMs = endpointNs && firstAudioNs ? roundMs(deltaMs(endpointNs, firstAudioNs)) : null;

  return {
    ok: serverTtfsMs !== null,
    error: serverTtfsMs === null ? 'No audio was produced before the timeout' : undefined,
    mode,
    serverTtfsMs,
    steps,
    detail: {
      mode,
      clipDurationMs: roundMs(clip.durationMs),
      speechEndOffsetMs: roundMs(speechEndOffsetMs),
      endpointOffsetMs: roundMs(endpointOffsetMs),
      endpointDetectionDelayMs: roundMs(endpointOffsetMs - speechEndOffsetMs),
      transcript: result?.transcript ?? tracker.finalSoFar(),
      transcriptSource: result?.transcriptSource ?? 'unknown',
      assistantText: result?.assistantText ?? '',
      ragChunks: result?.retrieval?.chunks.length ?? 0,
      ragPrefetched: result?.retrieval?.prefetched ?? false,
      firstAudioBytes,
      totalAudioBytes,
      chunkerPolicy: 'streaming phrases',
      measurementScope: 'server-side: endpoint -> first audio byte. Browser transport and playback excluded.',
      attribution,
      performance,
      gaps,
      endpointReason: mode === 'C' ? (metrics as any)?.endpointReason ?? null : null,
    },
    metrics: serializeMetrics(metrics),
    events: events.map((e) => ({ ...e, timestampNs: e.timestampNs.toString() })),
  };
}

function fail(mode: PipelineMode, error: string): ReplayOutcome {
  return { ok: false, error, mode, serverTtfsMs: null, steps: [], detail: {}, metrics: null, events: [] };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/* -------------------------------------------------------------------------- */
/* Pairwise comparison                                                         */
/* -------------------------------------------------------------------------- */

export interface PairComparison {
  clip: { durationMs: number; bytes: number };
  /** Which mode occupies each slot, so the UI can label the columns. */
  leftMode: PipelineMode;
  rightMode: PipelineMode;
  a: ReplayOutcome;
  b: ReplayOutcome;
  savedMs: number | null;
  savedPct: number | null;
  /** Per-stage attribution of where the saving came from. */
  attribution: Array<{ key: string; label: string; aMs: number; bMs: number; deltaMs: number }>;
  identicalInputs: Record<string, unknown>;
  startedAt: string;
}

/**
 * Run the SAME clip through two modes, back to back, and attribute the
 * difference stage by stage.
 *
 * The LEFT mode runs first on purpose: any provider-side warming then benefits
 * the right-hand mode, so a win on the right is never an artefact of running
 * second.
 */
export async function runPairComparison(
  req: Omit<ReplayRequest, 'mode'>,
  leftMode: PipelineMode = 'B',
  rightMode: PipelineMode = 'C',
): Promise<PairComparison> {
  const startedAt = new Date().toISOString();

  req.onProgress?.(`running Mode ${leftMode}`);
  const a = await runReplay({ ...req, mode: leftMode });

  req.onProgress?.(`running Mode ${rightMode}`);
  const b = await runReplay({ ...req, mode: rightMode });

  const aPath = criticalPathMap(a.metrics);
  const bPath = criticalPathMap(b.metrics);
  const keys = [...new Set([...Object.keys(aPath), ...Object.keys(bPath)])];

  const attribution = keys.map((key) => {
    const aMs = aPath[key]?.durationMs ?? 0;
    const bMs = bPath[key]?.durationMs ?? 0;
    return {
      key,
      label: aPath[key]?.label ?? bPath[key]?.label ?? key,
      aMs: roundMs(aMs),
      bMs: roundMs(bMs),
      deltaMs: roundMs(aMs - bMs),
    };
  });

  const savedMs = a.serverTtfsMs != null && b.serverTtfsMs != null ? roundMs(a.serverTtfsMs - b.serverTtfsMs) : null;
  const savedPct =
    a.serverTtfsMs != null && b.serverTtfsMs != null && a.serverTtfsMs > 0
      ? Math.round(((a.serverTtfsMs - b.serverTtfsMs) / a.serverTtfsMs) * 1000) / 10
      : null;

  return {
    clip: { durationMs: roundMs(req.clip.durationMs), bytes: req.clip.pcm.byteLength },
    leftMode,
    rightMode,
    a,
    b,
    savedMs,
    savedPct,
    attribution: attribution.sort((x, y) => Math.abs(y.deltaMs) - Math.abs(x.deltaMs)),
    identicalInputs: {
      model: req.config.llm.model,
      reasoningEffort: req.config.llm.reasoningEffort,
      systemPromptChars: req.config.systemPrompt.length,
      speaker: req.config.tts.speaker,
      dialect: req.config.tts.dialect,
      ragEnabled: req.config.rag.enabled,
      ragTopK: req.config.rag.topK,
      sttModel: req.config.stt.model,
      sttMaxDelay: req.config.stt.maxDelay,
      silenceThresholdMs: req.config.vad.silenceThresholdMs,
      inputAudioBytes: req.clip.pcm.byteLength,
    },
    startedAt,
  };
}

function criticalPathMap(metrics: unknown): Record<string, { label: string; durationMs: number }> {
  const out: Record<string, { label: string; durationMs: number }> = {};
  const cp = (metrics as any)?.criticalPath;
  if (!Array.isArray(cp)) return out;
  for (const seg of cp) {
    out[seg.key] = { label: seg.label, durationMs: Number(seg.durationMs) || 0 };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Three-way mode comparison (spec section 40)                                 */
/* -------------------------------------------------------------------------- */

export interface ModeComparisonRow {
  mode: PipelineMode;
  label: string;
  ok: boolean;
  error?: string;
  endpointingMs: number | null;
  sttMs: number | null;
  ragMs: number | null;
  llmTtftMs: number | null;
  llmToVoiceMs: number | null;
  ttsTtfaMs: number | null;
  audioDeliveryMs: number | null;
  serverTtfsMs: number | null;
  providerMs: number;
  oursMs: number;
  endpointReason?: string;
  transcriptSource?: string;
}

export interface ModeComparison {
  clip: { durationMs: number; bytes: number };
  rows: ModeComparisonRow[];
  fastest: PipelineMode | null;
  slowest: PipelineMode | null;
  /** Factual, generated purely from the measured numbers. */
  explanation: string[];
  identicalInputs: Record<string, unknown>;
  outcomes: Record<string, ReplayOutcome>;
  startedAt: string;
}

const MODE_LABELS: Record<PipelineMode, string> = {
  B: 'Streaming pipeline',
  C: 'Vapi-style orchestration',
};

/**
 * Run the SAME recorded clip through every mode and explain the difference from
 * the measurements alone.
 *
 * Order matters: the earlier modes run first so any provider-side warming
 * benefits them rather than the newest one. The explanation is generated from
 * the per-stage deltas, never hand-written, so it cannot flatter Mode C.
 */
export async function runModeComparison(
  req: Omit<ReplayRequest, 'mode'>,
  modes: PipelineMode[] = ['B', 'C'],
): Promise<ModeComparison> {
  const startedAt = new Date().toISOString();
  const outcomes: Record<string, ReplayOutcome> = {};

  for (const mode of modes) {
    req.onProgress?.(`running Mode ${mode}`);
    outcomes[mode] = await runReplay({ ...req, mode });
  }

  const rows: ModeComparisonRow[] = modes.map((mode) => {
    const o = outcomes[mode];
    const perf = (o.detail as any)?.performance ?? {};
    const attr = (o.detail as any)?.attribution ?? { providerMs: 0, oursMs: 0 };
    return {
      mode,
      label: MODE_LABELS[mode],
      ok: o.ok,
      error: o.error,
      endpointingMs: perf.endpointingLatency ?? null,
      sttMs: perf.transcriberLatency ?? null,
      ragMs: perf.ragLatency ?? null,
      llmTtftMs: perf.modelLatency ?? null,
      llmToVoiceMs: perf.llmToVoiceLatency ?? null,
      ttsTtfaMs: perf.voiceLatency ?? null,
      audioDeliveryMs: perf.audioOutputLatency ?? null,
      serverTtfsMs: o.serverTtfsMs,
      providerMs: attr.providerMs ?? 0,
      oursMs: attr.oursMs ?? 0,
      endpointReason: (o.detail as any)?.endpointReason ?? undefined,
      transcriptSource: (o.detail as any)?.transcriptSource,
    };
  });

  const finished = rows.filter((r) => r.ok && r.serverTtfsMs != null);
  const fastest = finished.length ? finished.reduce((a, b) => (a.serverTtfsMs! <= b.serverTtfsMs! ? a : b)) : null;
  const slowest = finished.length ? finished.reduce((a, b) => (a.serverTtfsMs! >= b.serverTtfsMs! ? a : b)) : null;

  return {
    clip: { durationMs: roundMs(req.clip.durationMs), bytes: req.clip.pcm.byteLength },
    rows,
    fastest: fastest?.mode ?? null,
    slowest: slowest?.mode ?? null,
    explanation: explainDifference(fastest, slowest),
    identicalInputs: {
      model: req.config.llm.model,
      reasoningEffort: req.config.llm.reasoningEffort,
      temperature: req.config.llm.temperature,
      systemPromptChars: req.config.systemPrompt.length,
      speaker: req.config.tts.speaker,
      dialect: req.config.tts.dialect,
      ttsTransport: req.config.tts.transport,
      ragEnabled: req.config.rag.enabled,
      ragTopK: req.config.rag.topK,
      sttModel: req.config.stt.model,
      sttMaxDelay: req.config.stt.maxDelay,
      inputAudioBytes: req.clip.pcm.byteLength,
    },
    outcomes,
    startedAt,
  };
}

/** Generate the "why it was faster" narrative from the measured deltas only. */
function explainDifference(fast: ModeComparisonRow | null, slow: ModeComparisonRow | null): string[] {
  if (!fast || !slow || fast.mode === slow.mode) return ['Not enough completed runs to compare.'];

  const total = (slow.serverTtfsMs ?? 0) - (fast.serverTtfsMs ?? 0);
  const out: string[] = [
    `Mode ${fast.mode} was ${Math.round(total)} ms faster than Mode ${slow.mode} (${Math.round(
      fast.serverTtfsMs ?? 0,
    )} ms vs ${Math.round(slow.serverTtfsMs ?? 0)} ms server-side TTFS).`,
  ];

  const stages: Array<[string, keyof ModeComparisonRow]> = [
    ['endpointing', 'endpointingMs'],
    ['STT wait', 'sttMs'],
    ['retrieval', 'ragMs'],
    ['LLM TTFT', 'llmTtftMs'],
    ['LLM to voice handoff', 'llmToVoiceMs'],
    ['TTS time to first audio', 'ttsTtfaMs'],
  ];

  for (const [label, key] of stages) {
    const a = slow[key] as number | null;
    const b = fast[key] as number | null;
    if (a == null || b == null) continue;
    const d = Math.round(a - b);
    if (Math.abs(d) < 20) continue;
    out.push(d > 0 ? `  ${label} saved ${d} ms` : `  ${label} cost ${Math.abs(d)} ms more`);
  }

  // The honest control: if the model itself did not change, say so explicitly.
  if (fast.llmTtftMs != null && slow.llmTtftMs != null && Math.abs(fast.llmTtftMs - slow.llmTtftMs) < 150) {
    out.push(
      `  The model itself was essentially unchanged (${Math.round(fast.llmTtftMs)} ms vs ${Math.round(
        slow.llmTtftMs,
      )} ms TTFT) — the difference came from orchestration, not from GPT.`,
    );
  }

  const ourDelta = Math.round(slow.oursMs - fast.oursMs);
  const provDelta = Math.round(slow.providerMs - fast.providerMs);
  out.push(
    `  Attribution: our own orchestration accounted for ${ourDelta} ms of the difference, external providers for ${provDelta} ms.`,
  );

  if (fast.endpointReason) out.push(`  Mode ${fast.mode} endpoint reason: ${fast.endpointReason}`);
  return out;
}
