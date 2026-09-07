/**
 * Benchmark and mode-comparison endpoints.
 */

import type { FastifyInstance } from 'fastify';
import { newTraceId } from '@vll/telemetry';
import type { PipelineMode } from '@vll/core';
import { BENCHMARK_CATALOG, BenchmarkRunner, type BenchmarkId } from '../benchmarks.js';
import { analyseClip, runPairComparison } from '../replay.js';
import { getClip } from '../clips.js';
import { resolveSession, type RouteDeps } from './index.js';

export async function registerBenchRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get('/api/bench/catalog', async () => {
    const session = resolveSession(deps);
    const clip = session ? getClip(session) : null;
    return {
      benchmarks: BENCHMARK_CATALOG,
      clip: clip ? { durationMs: Math.round(clip.durationMs), bytes: clip.pcm.byteLength } : null,
    };
  });

  app.post<{
    Body: { benchmark: BenchmarkId; sessionId?: string; repetitions?: number; text?: string; query?: string; cooldownMs?: number };
  }>('/api/bench/run', async (req, reply) => {
    const body = req.body ?? ({} as any);
    const session = resolveSession(deps, body.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session. Open the app in a browser first.' });

    const { llm, tts } = session.providers;
    const runner = new BenchmarkRunner({
      llm,
      tts,
      // The benchmark opens its own STT session so it cannot disturb the live one.
      stt: session.sttProvider,
      kb: deps.kb,
      config: session.activeConfig,
      bus: session.bus,
      clip: getClip(session),
    });

    try {
      const result = await runner.run(
        body.benchmark,
        {
          repetitions: body.repetitions,
          text: body.text,
          query: body.query,
          cooldownMs: body.cooldownMs,
        },
        (step, detail) => session.send({ type: 'bench.progress', benchmark: body.benchmark, step, detail }),
      );
      session.send({ type: 'bench.result', benchmark: body.benchmark, result });
      return result;
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message ?? String(e) });
    }
  });

  /* -- mode comparison --------------------------------------------------- */

  app.get('/api/compare/clip', async () => {
    const session = resolveSession(deps);
    const clip = session ? getClip(session) : null;
    if (!clip) return { clip: null };
    const cfg = session!.activeConfig;
    const analysis = analyseClip(clip.pcm, cfg.vad.silenceThresholdMs, {
      positive: cfg.vad.positiveSpeechThreshold,
      negative: cfg.vad.negativeSpeechThreshold,
      minSpeechFrames: cfg.vad.minSpeechFrames,
    });
    return {
      clip: { durationMs: Math.round(clip.durationMs), bytes: clip.pcm.byteLength },
      analysis,
    };
  });

  /** Replay one clip through two modes and attribute the difference by stage. */
  app.post<{ Body: { sessionId?: string; left?: PipelineMode; right?: PipelineMode } }>('/api/compare/run', async (req, reply) => {
    const session = resolveSession(deps, req.body?.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });
    const clip = getClip(session);
    if (!clip || clip.pcm.byteLength === 0) {
      return reply.code(400).send({ error: 'No recorded clip. Record a test utterance first.' });
    }

    const { llm, tts } = session.providers;
    try {
      const result = await runPairComparison(
        {
          clip,
          config: session.activeConfig,
          deps: { llm, tts, stt: session.sttProvider, kb: deps.kb },
          traceId: newTraceId(),
          onProgress: (step: string, detail?: unknown) =>
            session.send({ type: 'bench.progress', benchmark: 'compare', step, detail }),
        },
        req.body?.left ?? 'B',
        req.body?.right ?? 'C',
      );
      session.send({ type: 'ab.result', result });
      return result;
    } catch (e: any) {
      app.log.error({ err: e }, 'mode comparison failed');
      return reply.code(500).send({ error: e?.message ?? String(e) });
    }
  });
}
