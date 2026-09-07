/**
 * Dashboard and export endpoints (spec sections 17 and 25).
 */

import type { FastifyInstance } from 'fastify';
import { LATENCY_BUDGET, TTFS_TARGET } from '@vll/telemetry';
import { buildDashboard, buildExport, toCsv, type TurnMetricsLike } from '../analytics.js';
import { resolveSession, type RouteDeps } from './index.js';

export async function registerAnalyticsRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get<{ Querystring: { window?: string; sessionId?: string } }>('/api/dashboard', async (req, reply) => {
    const session = resolveSession(deps, req.query.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });
    const window = clampWindow(Number.parseInt(req.query.window ?? '20', 10));
    const turns = session.metricsHistory as TurnMetricsLike[];
    return {
      dashboard: buildDashboard(turns, window),
      budget: LATENCY_BUDGET,
      ttfsTarget: TTFS_TARGET,
      windows: [10, 20, 50, 100],
    };
  });

  app.get<{ Querystring: { sessionId?: string; limit?: string } }>('/api/turns', async (req, reply) => {
    const session = resolveSession(deps, req.query.sessionId);
    if (!session) return reply.code(409).send({ error: 'No active session' });
    const limit = Math.max(1, Math.min(500, Number.parseInt(req.query.limit ?? '50', 10) || 50));
    const turns = session.metricsHistory.slice(-limit);
    return { turns };
  });

  app.get<{ Querystring: { format?: string; sessionId?: string; events?: string; window?: string } }>(
    '/api/export',
    async (req, reply) => {
      const session = resolveSession(deps, req.query.sessionId);
      if (!session) return reply.code(409).send({ error: 'No active session' });

      const turns = session.metricsHistory as TurnMetricsLike[];
      const format = (req.query.format ?? 'json').toLowerCase();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');

      if (format === 'csv') {
        const csv = toCsv(turns, session.activeConfig);
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="vll-turns-${stamp}.csv"`)
          .send(csv);
      }

      const includeEvents = req.query.events === 'true' || req.query.events === '1';
      const bundle = buildExport({
        sessionId: session.id,
        traceId: session.traceId,
        config: session.activeConfig,
        turns,
        window: clampWindow(Number.parseInt(req.query.window ?? '100', 10)),
        ragInfo: deps.kb.stats(),
        events: includeEvents
          ? session.bus.all().map((e) => ({ ...e, timestampNs: e.timestampNs.toString() }))
          : undefined,
      });

      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="vll-session-${stamp}.json"`)
        .send(bundle);
    },
  );
}

function clampWindow(n: number): number {
  const allowed = [10, 20, 50, 100];
  if (!Number.isFinite(n)) return 20;
  return allowed.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best), 20);
}
