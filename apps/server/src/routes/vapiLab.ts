/**
 * Mode C endpoints: mode comparison, the GPT-4.1 context
 * investigation, the raw-provider benchmark and the live endpointing snapshot.
 */

import type { FastifyInstance } from 'fastify';
import { newTraceId } from '@vll/telemetry';
import { MODE_C_PRESETS, defaultModeCConfig, type PipelineMode } from '@vll/core';
import { fillerCacheSize, renderFillers } from '../fillerAudio.js';
import { OpenAiResponsesProvider } from '@vll/providers';
import { LLM_PROBE_CATALOG, LlmLab, rawApiBenchmark, type LlmProbeId } from '../llmLab.js';
import { runModeComparison } from '../replay.js';
import { getClip } from '../clips.js';
import { secrets } from '../env.js';
import { resolveSession, type RouteDeps } from './index.js';

/**
 * The LLM lab measures the provider directly, so it does not need the session's
 * warmed connection. Falling back to a fresh client means the probes work
 * before warm-up has run -- and the first request's connection setup shows up
 * honestly in the results rather than being hidden by a pre-warmed socket.
 */
function labLlm(session: { providers: { llm: unknown } } | null) {
  const existing = session?.providers.llm as OpenAiResponsesProvider | null | undefined;
  if (existing) return existing;
  const key = secrets.get().openaiApiKey;
  return key ? new OpenAiResponsesProvider({ apiKey: key, requestTimeoutMs: 60_000 }) : null;
}

export async function registerVapiLabRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  /* -- presets and defaults -------------------------------------------- */
  app.get('/api/modec/presets', async () => ({
    presets: MODE_C_PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
    defaults: defaultModeCConfig(),
    probes: LLM_PROBE_CATALOG,
  }));

  app.post<{ Body: { presetId: string; sessionId?: string } }>('/api/modec/preset', async (req, reply) => {
    const session = resolveSession(deps, req.body?.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });
    const preset = MODE_C_PRESETS.find((p) => p.id === req.body?.presetId);
    if (!preset) return reply.code(400).send({ error: `Unknown preset: ${req.body?.presetId}` });
    const applied = session.applyConfig({ modeC: preset.apply(session.activeConfig.modeC) } as any);
    session.send({ type: 'config.applied', config: applied });
    return { ok: true, preset: preset.id, modeC: applied.modeC };
  });

  /* -- background audio -------------------------------------------------- */

  /**
   * Pre-render the hesitation sounds in the session's own Hamsa voice.
   *
   * Called during warm-up so that playing one later costs no network at all.
   * Failures here are reported, not thrown: a missing filler simply degrades
   * to silence, which is how the pipeline behaved before the feature existed.
   */
  app.post<{ Body: { sessionId?: string } }>('/api/modec/fillers/render', async (req, reply) => {
    const session = resolveSession(deps, req.body?.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });

    const tts = session.providers.tts;
    if (!tts) {
      // Distinguish the two causes: pointing at a missing key when the key is
      // present just sends the operator hunting for a config bug there isn't.
      return reply.code(409).send({
        error: secrets.get().hamsaApiKey
          ? 'This session has not been warmed up yet. Run warm-up first: the fillers are rendered through the TTS connection it opens.'
          : 'HAMSA_API_KEY is not configured',
      });
    }

    const bg = session.activeConfig.modeC.backgroundAudio;
    const phrases = [...bg.filler.phrases, ...bg.backchannel.phrases];
    if (phrases.length === 0) return { fillers: [], failed: [], totalMs: 0, voice: '' };

    const result = await renderFillers(tts, session.activeConfig, phrases, (step) =>
      session.send({ type: 'bench.progress', benchmark: 'fillers', step }),
    );
    return { ...result, cached: fillerCacheSize() };
  });

  /** Live endpointing view for the Mode C monitor lane. */
  app.get('/api/modec/snapshot', async (req, reply) => {
    const session = resolveSession(deps, (req.query as any)?.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });
    return session.modeCSnapshot();
  });

  /* -- mode comparison --------------------------------------------------- */
  app.post<{ Body: { sessionId?: string; modes?: PipelineMode[] } }>('/api/modec/compare', async (req, reply) => {
    const session = resolveSession(deps, req.body?.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });
    const clip = getClip(session);
    if (!clip || clip.pcm.byteLength === 0) {
      return reply.code(400).send({ error: 'No recorded clip. Record a test utterance on the Compare page first.' });
    }

    const { llm, tts } = session.providers;
    const modes = (req.body?.modes?.length ? req.body.modes : (['B', 'C'] as PipelineMode[])).filter((m) =>
      ['B', 'C'].includes(m),
    );

    try {
      const result = await runModeComparison(
        {
          clip,
          config: session.activeConfig,
          deps: { llm, tts, stt: session.sttProvider, kb: deps.kb },
          traceId: newTraceId(),
          onProgress: (step, detail) => session.send({ type: 'bench.progress', benchmark: 'modes', step, detail }),
        },
        modes,
      );
      session.send({ type: 'bench.result', benchmark: 'mode_comparison', result });
      return result;
    } catch (e: any) {
      app.log.error({ err: e }, 'mode comparison failed');
      return reply.code(500).send({ error: e?.message ?? String(e) });
    }
  });

  /* -- GPT context investigation ---------------------------------------- */
  app.post<{ Body: { probe: LlmProbeId; repetitions?: number; sessionId?: string } }>(
    '/api/llmlab/probe',
    async (req, reply) => {
      const session = resolveSession(deps, req.body?.sessionId);
      if (!session) return reply.code(409).send({ error: 'No active session' });
      const llm = labLlm(session);
      if (!llm) return reply.code(409).send({ error: 'OPENAI_API_KEY is not configured' });

      const lab = new LlmLab({ llm, kb: deps.kb, config: session.activeConfig });
      try {
        const result = await lab.run(req.body.probe, req.body.repetitions ?? 5, (s) =>
          session.send({ type: 'bench.progress', benchmark: 'llmlab', step: s }),
        );
        session.send({ type: 'bench.result', benchmark: `llmlab:${req.body.probe}`, result });
        return result;
      } catch (e: any) {
        return reply.code(500).send({ error: e?.message ?? String(e) });
      }
    },
  );

  /** Run every context probe in sequence, so the four rows are directly comparable. */
  app.post<{ Body: { repetitions?: number; sessionId?: string } }>('/api/llmlab/all', async (req, reply) => {
    const session = resolveSession(deps, req.body?.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });
    const llm = labLlm(session);
    if (!llm) return reply.code(409).send({ error: 'OPENAI_API_KEY is not configured' });

    const lab = new LlmLab({ llm, kb: deps.kb, config: session.activeConfig });
    const results = [];
    for (const p of LLM_PROBE_CATALOG) {
      results.push(
        await lab.run(p.id, req.body?.repetitions ?? 3, (s) =>
          session.send({ type: 'bench.progress', benchmark: 'llmlab', step: s }),
        ),
      );
    }
    session.send({ type: 'bench.result', benchmark: 'llmlab:all', result: { results } });
    return { results, model: session.activeConfig.llm.model };
  });

  /** Input tokens vs TTFT. */
  app.post<{ Body: { targets?: number[]; repetitions?: number; sessionId?: string } }>(
    '/api/llmlab/context-sweep',
    async (req, reply) => {
      const session = resolveSession(deps, req.body?.sessionId);
      if (!session) return reply.code(409).send({ error: 'No active session' });
      const llm = labLlm(session);
      if (!llm) return reply.code(409).send({ error: 'OPENAI_API_KEY is not configured' });

      const targets = req.body?.targets?.length ? req.body.targets : [500, 1000, 2000, 5000, 10000, 20000];
      const lab = new LlmLab({ llm, kb: deps.kb, config: session.activeConfig });
      try {
        const points = await lab.contextSweep(targets, req.body?.repetitions ?? 3, (s) =>
          session.send({ type: 'bench.progress', benchmark: 'context-sweep', step: s }),
        );
        const result = { points, model: session.activeConfig.llm.model };
        session.send({ type: 'bench.result', benchmark: 'context_sweep', result });
        return result;
      } catch (e: any) {
        return reply.code(500).send({ error: e?.message ?? String(e) });
      }
    },
  );

  /* -- raw provider benchmark ------------------------------------------- */
  app.post<{ Body: { requests?: number; model?: string; sessionId?: string } }>(
    '/api/llmlab/raw',
    async (req, reply) => {
      const key = secrets.get().openaiApiKey;
      if (!key) return reply.code(409).send({ error: 'OPENAI_API_KEY is not configured' });
      const session = resolveSession(deps, req.body?.sessionId);
      const cfg = session?.activeConfig;

      try {
        const result = await rawApiBenchmark({
          apiKey: key,
          model: req.body?.model ?? cfg?.llm.model ?? 'gpt-4.1',
          requests: req.body?.requests ?? 10,
          reasoningEffort: cfg?.llm.reasoningEffort ?? null,
          onProgress: (s) => session?.send({ type: 'bench.progress', benchmark: 'raw-api', step: s }),
        });
        session?.send({ type: 'bench.result', benchmark: 'raw_api', result });
        return result;
      } catch (e: any) {
        return reply.code(500).send({ error: e?.message ?? String(e) });
      }
    },
  );

  /* -- RAG breakdown (spec section 38) ----------------------------------- */
  app.post<{ Body: { query?: string; repetitions?: number } }>('/api/llmlab/rag-breakdown', async (req) => {
    const query = req.body?.query ?? 'شو الخدمات المتوفرة عندكم؟';
    const reps = Math.max(1, Math.min(50, req.body?.repetitions ?? 10));
    const kb = deps.kb;

    const timings: Array<{ searchMs: number; assemblyMs: number; totalMs: number; hits: number }> = [];
    for (let i = 0; i < reps; i++) {
      const t0 = process.hrtime.bigint();
      const r = await kb.search(query, { topK: 3, minScore: 0 });
      const searched = process.hrtime.bigint();
      // Prompt assembly is part of the "RAG cost" a caller experiences, so it is
      // measured separately rather than folded into search time.
      const assembled = r.chunks.map((c) => `[${c.source.filename}]\n${c.text}`).join('\n\n---\n\n');
      const done = process.hrtime.bigint();
      timings.push({
        searchMs: Number(searched - t0) / 1e6,
        assemblyMs: Number(done - searched) / 1e6,
        totalMs: Number(done - t0) / 1e6,
        hits: r.chunks.length,
      });
      void assembled;
    }

    const avg = (f: (t: (typeof timings)[number]) => number) =>
      Math.round((timings.reduce((n, t) => n + f(t), 0) / timings.length) * 1000) / 1000;

    return {
      query,
      repetitions: reps,
      retriever: kb.retrieverMode,
      embedder: kb.stats().embedder,
      documents: kb.documentCount,
      chunks: kb.chunkCount,
      breakdown: {
        // With the default lexical retriever there is no embedding call at all,
        // which is exactly why a reported "500 ms RAG" needs decomposing.
        embeddingMs: kb.retrieverMode === 'bm25' ? 0 : null,
        searchMs: avg((t) => t.searchMs),
        promptAssemblyMs: avg((t) => t.assemblyMs),
        totalMs: avg((t) => t.totalMs),
      },
      samples: timings,
      note:
        kb.retrieverMode === 'bm25'
          ? 'BM25 runs in-process with no network call. If production reports ~500 ms for retrieval, the time is being spent in a remote vector store, an embedding call, or prompt assembly — not in search itself.'
          : 'Dense retrieval includes one embedding round trip per query, which is usually the dominant term.',
    };
  });
}
