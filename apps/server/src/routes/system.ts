/**
 * System endpoints: health, credential presence, voice catalogue, defaults,
 * and the live Speechmatics session registry.
 *
 * None of these ever returns a credential value.
 */

import type { FastifyInstance } from 'fastify';
import {
  HAMSA_DIALECTS,
  REASONING_EFFORTS,
  SERVICE_TIERS,
  SUGGESTED_LLM_MODELS,
  defaultConfig,
  DEFAULT_SYSTEM_PROMPT_AR,
  DEFAULT_SYSTEM_PROMPT_EN,
} from '@vll/core';
import { LATENCY_BUDGET, TTFS_TARGET } from '@vll/telemetry';
import { HamsaTtsProvider, liveSttSessions } from '@vll/providers';
import { secrets, serverConfig } from '../env.js';
import { loadPersistedConfig, persistError, persistedConfigPath, resetPersistedConfig } from '../configStore.js';
import { resolveSession, type RouteDeps } from './index.js';

export async function registerSystemRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    sessions: deps.sessions.size,
    credentials: secrets.presence(),
    region: serverConfig.speechmaticsRegion,
    node: process.version,
  }));

  /**
   * Which realtime STT sessions is this process holding open right now?
   *
   * Speechmatics limits CONCURRENT sessions per account, so "Concurrent Quota
   * Exceeded" on warm-up has exactly two causes: a session this process leaked,
   * or another process (an old dev server, a second browser tab) still holding
   * one. This endpoint settles which -- an empty list here means the sessions
   * are somewhere else, and killing this server will not help.
   */
  /** Discard saved overrides and return to the built-in defaults. */
  app.post('/api/config/reset', async () => {
    const config = await resetPersistedConfig();
    return { ok: true, config };
  });

  app.get('/api/stt/sessions', async () => {
    const sessions = liveSttSessions();
    return {
      count: sessions.length,
      sessions,
      note:
        sessions.length === 0
          ? 'This process holds no realtime STT sessions. A concurrency error therefore comes from another process or a still-draining session on the provider side; wait ~60s and retry.'
          : 'These sessions each count against the account concurrency limit until closed.',
    };
  });

  app.get('/api/defaults', async () => ({
    // The EFFECTIVE config, not the pristine defaults: the settings page seeds
    // its form from here, so returning defaults would show the operator stale
    // values and quietly overwrite what they had saved.
    config: (await loadPersistedConfig()) ?? defaultConfig(),
    pristine: defaultConfig(),
    configPath: persistedConfigPath(),
    configError: persistError(),
    prompts: { ar: DEFAULT_SYSTEM_PROMPT_AR, en: DEFAULT_SYSTEM_PROMPT_EN },
    dialects: HAMSA_DIALECTS,
    models: SUGGESTED_LLM_MODELS,
    reasoningEfforts: REASONING_EFFORTS,
    serviceTiers: SERVICE_TIERS,
    budget: LATENCY_BUDGET,
    ttfsTarget: TTFS_TARGET,
    credentials: secrets.presence(),
  }));

  /**
   * Temporary credential entry for testing. Values are held in process memory
   * only: never written to disk, never echoed back, never sent to the browser.
   */
  app.post<{
    Body: { openaiApiKey?: string; speechmaticsApiKey?: string; hamsaApiKey?: string; hamsaSpeakerId?: string };
  }>('/api/credentials', async (req) => {
    secrets.override(req.body ?? {});
    app.log.info({ credentials: secrets.presence() }, 'credentials updated in memory');
    return { ok: true, credentials: secrets.presence() };
  });

  /**
   * Live voice catalogue. The published docs list conflicting built-in voice
   * names across pages, so the real list is always fetched from the API.
   */
  app.get('/api/voices', async (_req, reply) => {
    const key = secrets.get().hamsaApiKey;
    if (!key) return reply.code(409).send({ error: 'HAMSA_API_KEY is not configured', voices: [] });
    try {
      const provider = new HamsaTtsProvider({ apiKey: key, transport: 'http' });
      const voices = await provider.listVoices();
      return { voices };
    } catch (e: any) {
      return reply.code(502).send({ error: e?.message ?? String(e), voices: [] });
    }
  });

  app.get('/api/status', async (req, reply) => {
    const session = resolveSession(deps, (req.query as any)?.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });
    return session.status();
  });
}
