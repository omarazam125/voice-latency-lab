/**
 * Knowledge base REST API.
 *
 * All parsing, chunking, embedding and index construction happens HERE, at
 * upload time. Nothing in this file is reachable from a voice turn.
 */

import type { FastifyInstance } from 'fastify';
import { SUPPORTED_EXTENSIONS } from '@vll/rag';
import type { RouteDeps } from './index.js';

export async function registerKbRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { kb } = deps;

  app.get('/api/kb', async () => ({
    documents: kb.list(),
    stats: kb.stats(),
    supported: SUPPORTED_EXTENSIONS,
    hasEmbedder: kb.hasEmbedder,
  }));

  app.post('/api/kb/upload', async (req, reply) => {
    const parts = req.parts();
    const results = [];
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const buffer = await part.toBuffer();
      const started = process.hrtime.bigint();
      const doc = await kb.addDocument(part.filename, buffer, part.mimetype);
      app.log.info(
        {
          filename: part.filename,
          bytes: buffer.byteLength,
          chunks: doc.chunkCount,
          indexingMs: doc.indexingMs,
          wallMs: Number(process.hrtime.bigint() - started) / 1e6,
        },
        'document indexed at upload time',
      );
      results.push(doc);
    }
    if (results.length === 0) {
      return reply.code(400).send({ error: 'No files were provided' });
    }
    return { documents: results, stats: kb.stats() };
  });

  app.get<{ Params: { id: string } }>('/api/kb/:id/chunks', async (req, reply) => {
    const chunks = kb.chunksFor(req.params.id);
    if (chunks.length === 0) return reply.code(404).send({ error: 'Document not found or has no chunks' });
    return {
      chunks: chunks.map((c) => ({
        id: c.id,
        chunkIndex: c.chunkIndex,
        page: c.page,
        chars: c.text.length,
        text: c.text,
        hasVector: !!c.vector,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/kb/:id', async (req, reply) => {
    const ok = await kb.deleteDocument(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'Document not found' });
    return { ok: true, stats: kb.stats() };
  });

  app.post('/api/kb/clear', async () => {
    await kb.clear();
    return { ok: true, stats: kb.stats() };
  });

  /** Manual retrieval probe: same code path a turn uses, with timing. */
  app.post<{ Body: { query: string; topK?: number; minScore?: number; minCoverage?: number; mode?: 'bm25' | 'vector' | 'hybrid' } }>(
    '/api/kb/search',
    async (req, reply) => {
      const { query, topK = 5, minScore = 0, minCoverage = 0, mode } = req.body ?? ({} as any);
      if (!query || typeof query !== 'string') {
        return reply.code(400).send({ error: 'query is required' });
      }
      const previous = kb.retrieverMode;
      if (mode) kb.setMode(mode);
      const started = process.hrtime.bigint();
      const result = await kb.search(query, { topK, minScore, minCoverage });
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (mode) kb.setMode(previous);
      return { ...result, durationMs: Math.round(durationMs * 100) / 100, retriever: mode ?? previous };
    },
  );

  app.post<{ Body: { mode: 'bm25' | 'vector' | 'hybrid' } }>('/api/kb/mode', async (req, reply) => {
    const mode = req.body?.mode;
    if (!mode) return reply.code(400).send({ error: 'mode is required' });
    kb.setMode(mode);
    return { ok: true, stats: kb.stats() };
  });
}
