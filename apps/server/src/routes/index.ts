import type { FastifyInstance } from 'fastify';
import type { KnowledgeBase } from '@vll/rag';
import type { Session } from '../session.js';
import { registerKbRoutes } from './kb.js';
import { registerBenchRoutes } from './bench.js';
import { registerAnalyticsRoutes } from './analytics.js';
import { registerSystemRoutes } from './system.js';
import { registerVapiLabRoutes } from './vapiLab.js';

export interface RouteDeps {
  kb: KnowledgeBase;
  sessions: Map<string, Session>;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  await registerSystemRoutes(app, deps);
  await registerKbRoutes(app, deps);
  await registerBenchRoutes(app, deps);
  await registerAnalyticsRoutes(app, deps);
  await registerVapiLabRoutes(app, deps);
}

/** Resolve the session a request targets: an explicit id, else the only one. */
export function resolveSession(deps: RouteDeps, sessionId?: string): Session | null {
  if (sessionId) return deps.sessions.get(sessionId) ?? null;
  const all = [...deps.sessions.values()];
  return all.length > 0 ? all[all.length - 1] : null;
}
