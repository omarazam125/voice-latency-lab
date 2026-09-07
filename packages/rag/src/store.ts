/**
 * Knowledge base: storage, indexing and retrieval.
 *
 * Latency contract (spec section 12):
 *   - Parsing, chunking, embedding and index construction happen at UPLOAD.
 *   - `search()` touches only in-memory structures. For the default BM25
 *     retriever it performs no I/O and no network call at all.
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RetrievalResult, Retriever, RetrieveOptions } from '@vll/core';
import { Bm25Index } from './bm25.js';
import { chunkText, isSupported, parseDocument } from './parse.js';
import { dot, type Embedder } from './embeddings.js';
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions, type KbChunk, type KbDocument } from './types.js';

const nowNs = () => process.hrtime.bigint();
const msSince = (a: bigint) => Number(process.hrtime.bigint() - a) / 1e6;

export type RetrieverMode = 'bm25' | 'vector' | 'hybrid';

/**
 * Content fingerprint used to collapse duplicate chunks. Whitespace and case
 * are normalised, and only the first 400 characters are considered, so a copy
 * that differs by a trailing newline still matches.
 */
function dedupeKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 400);
}

export interface KnowledgeBaseOptions {
  dataDir: string;
  chunkOptions?: ChunkOptions;
  embedder?: Embedder | null;
  mode?: RetrieverMode;
  /** Weight of the lexical score in hybrid mode; the rest goes to the vector score. */
  hybridLexicalWeight?: number;
}

interface PersistedIndex {
  version: 2;
  documents: KbDocument[];
  chunks: Array<Omit<KbChunk, 'vector'> & { vector?: number[] }>;
  embedder?: string | null;
}

export class KnowledgeBase implements Retriever {
  readonly name: string;
  private documents = new Map<string, KbDocument>();
  private chunks: KbChunk[] = [];
  private bm25 = new Bm25Index();
  private loaded = false;
  private mode: RetrieverMode;

  constructor(private readonly opts: KnowledgeBaseOptions) {
    this.mode = opts.mode ?? (opts.embedder ? 'hybrid' : 'bm25');
    this.name = `kb:${this.mode}`;
  }

  get ready(): boolean {
    return this.loaded;
  }
  get documentCount(): number {
    return this.documents.size;
  }
  get chunkCount(): number {
    return this.chunks.length;
  }
  get retrieverMode(): RetrieverMode {
    return this.mode;
  }
  get hasEmbedder(): boolean {
    return !!this.opts.embedder;
  }

  setMode(mode: RetrieverMode): void {
    // Falling back rather than failing keeps the app usable with no OpenAI key.
    this.mode = mode === 'bm25' ? 'bm25' : this.opts.embedder ? mode : 'bm25';
  }

  private get indexPath(): string {
    return join(this.opts.dataDir, 'index.json');
  }

  async load(): Promise<void> {
    await mkdir(this.opts.dataDir, { recursive: true });
    if (existsSync(this.indexPath)) {
      try {
        const raw = await readFile(this.indexPath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedIndex;
        this.documents = new Map(parsed.documents.map((d) => [d.id, d]));
        this.chunks = parsed.chunks.map((c) => ({
          ...c,
          vector: c.vector ? Float32Array.from(c.vector) : undefined,
        }));
        this.bm25.build(this.chunks);
      } catch {
        // A corrupt index is not worth failing startup over; start empty.
        this.documents.clear();
        this.chunks = [];
        this.bm25.build([]);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const payload: PersistedIndex = {
      version: 2,
      documents: [...this.documents.values()],
      chunks: this.chunks.map((c) => ({ ...c, vector: c.vector ? Array.from(c.vector) : undefined })),
      embedder: this.opts.embedder?.name ?? null,
    };
    await mkdir(this.opts.dataDir, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(payload), 'utf8');
  }

  list(): KbDocument[] {
    return [...this.documents.values()].sort((a, b) => a.filename.localeCompare(b.filename));
  }

  chunksFor(documentId: string): KbChunk[] {
    return this.chunks.filter((c) => c.documentId === documentId);
  }

  /**
   * Ingest one document. Everything expensive happens here, deliberately, so
   * that a voice turn never pays for it.
   */
  async addDocument(filename: string, buffer: Buffer, mimeType = 'application/octet-stream'): Promise<KbDocument> {
    const started = nowNs();
    const id = `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    if (!isSupported(filename)) {
      const doc: KbDocument = {
        id,
        filename,
        mimeType,
        bytes: buffer.byteLength,
        uploadedAt: new Date().toISOString(),
        chunkCount: 0,
        charCount: 0,
        indexingMs: 0,
        error: `Unsupported file type: ${filename}`,
      };
      this.documents.set(id, doc);
      await this.persist();
      return doc;
    }

    let parsed: Awaited<ReturnType<typeof parseDocument>>;
    try {
      parsed = await parseDocument(filename, buffer);
    } catch (e: any) {
      const doc: KbDocument = {
        id,
        filename,
        mimeType,
        bytes: buffer.byteLength,
        uploadedAt: new Date().toISOString(),
        chunkCount: 0,
        charCount: 0,
        indexingMs: msSince(started),
        error: `Parse failed: ${e?.message ?? String(e)}`,
      };
      this.documents.set(id, doc);
      await this.persist();
      return doc;
    }

    const newChunks = chunkText(
      parsed.text,
      id,
      filename,
      this.opts.chunkOptions ?? DEFAULT_CHUNK_OPTIONS,
      parsed.pageBreaks,
    );

    // Embed at upload time so only the QUERY vector is computed during a turn.
    if (this.opts.embedder && newChunks.length > 0) {
      try {
        const vectors = await this.opts.embedder.embedDocuments(newChunks.map((c) => c.text));
        newChunks.forEach((c, i) => {
          c.vector = vectors[i];
        });
      } catch {
        // Retrieval degrades to lexical rather than the upload failing.
      }
    }

    this.chunks.push(...newChunks);
    this.bm25.build(this.chunks);

    const doc: KbDocument = {
      id,
      filename,
      mimeType,
      bytes: buffer.byteLength,
      uploadedAt: new Date().toISOString(),
      chunkCount: newChunks.length,
      charCount: parsed.text.length,
      indexingMs: msSince(started),
      pages: parsed.pages,
    };
    this.documents.set(id, doc);
    await this.persist();
    return doc;
  }

  async deleteDocument(id: string): Promise<boolean> {
    if (!this.documents.delete(id)) return false;
    this.chunks = this.chunks.filter((c) => c.documentId !== id);
    this.bm25.build(this.chunks);
    await this.persist();
    return true;
  }

  async clear(): Promise<void> {
    this.documents.clear();
    this.chunks = [];
    this.bm25.build([]);
    await rm(this.indexPath, { force: true });
  }

  /* ---------------------------------------------------------------------- */
  /* Retrieval -- the only part on the critical path                         */
  /* ---------------------------------------------------------------------- */

  async search(query: string, opts: RetrieveOptions): Promise<RetrievalResult> {
    const started = nowNs();
    const topK = Math.max(1, opts.topK);

    if (this.chunks.length === 0 || !query.trim()) {
      return { query, chunks: [], durationMs: msSince(started) };
    }

    // Over-fetch deliberately: duplicates are collapsed below, so asking for
    // exactly topK would return fewer than topK unique passages whenever the
    // same document has been uploaded twice.
    const lexical = this.bm25.search(query, topK * 4);

    if (this.mode === 'bm25' || !this.opts.embedder) {
      // Two gates, and only the second one really works.
      //
      // `score` is normalised against the best hit, so the top result is
      // ALWAYS 1.0 and a floor on it can never reject anything -- an off-topic
      // question still retrieved three chunks at score 1.000, which the model
      // then answered from. `coverage` is absolute: it asks how much of what
      // the caller actually said this passage accounts for.
      const kept = this.dedupe(
        lexical.filter(
          (h) => h.score >= (opts.minScore ?? 0) && h.coverage >= (opts.minCoverage ?? 0),
        ),
        topK,
      );
      return {
        query,
        chunks: kept.map((h) => this.toRetrieved(h.chunkIndex, h.score, h.duplicates, (h as { coverage?: number }).coverage)),
        durationMs: msSince(started),
      };
    }

    // Dense path: exactly ONE network call, and it is the number the RAG span
    // in the waterfall is showing.
    let qv: Float32Array | null = null;
    try {
      qv = await this.opts.embedder.embedQuery(query, opts.signal);
    } catch {
      qv = null;
    }

    if (!qv) {
      const kept = this.dedupe(lexical, topK);
      return {
        query,
        chunks: kept.map((h) => this.toRetrieved(h.chunkIndex, h.score, h.duplicates, (h as { coverage?: number }).coverage)),
        durationMs: msSince(started),
      };
    }

    const dense: Array<{ chunkIndex: number; score: number }> = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const v = this.chunks[i].vector;
      if (!v) continue;
      dense.push({ chunkIndex: i, score: dot(qv, v) });
    }
    dense.sort((a, b) => b.score - a.score);

    if (this.mode === 'vector') {
      const kept = this.dedupe(
        dense.filter((h) => h.score >= (opts.minScore ?? 0)),
        topK,
      );
      return {
        query,
        chunks: kept.map((h) => this.toRetrieved(h.chunkIndex, h.score, h.duplicates, (h as { coverage?: number }).coverage)),
        durationMs: msSince(started),
      };
    }

    // Hybrid: weighted sum of the two normalised score lists.
    const w = this.opts.hybridLexicalWeight ?? 0.4;
    const scores = new Map<number, number>();
    const denseMax = dense[0]?.score || 1;
    for (const h of lexical) scores.set(h.chunkIndex, (scores.get(h.chunkIndex) ?? 0) + w * h.score);
    for (const h of dense.slice(0, topK * 4)) {
      scores.set(h.chunkIndex, (scores.get(h.chunkIndex) ?? 0) + (1 - w) * (h.score / denseMax));
    }
    const merged = [...scores.entries()]
      .map(([chunkIndex, score]) => ({ chunkIndex, score }))
      .sort((a, b) => b.score - a.score)
      .filter((h) => h.score >= (opts.minScore ?? 0));
    const kept = this.dedupe(merged, topK);

    return {
      query,
      chunks: kept.map((h) => this.toRetrieved(h.chunkIndex, h.score, h.duplicates, (h as { coverage?: number }).coverage)),
      durationMs: msSince(started),
    };
  }

  /**
   * Collapse chunks whose text is effectively identical.
   *
   * Uploading the same document twice (`report.txt` and `report - Copy.txt`) is
   * extremely common, and without this the duplicates fill the top-K: a query
   * with topK=3 can come back with the same passage three times, so the model
   * receives one fact instead of three. That degrades answer quality in a way
   * that looks like a retrieval failure rather than a data problem.
   *
   * The first occurrence wins, so the highest-scoring copy is the one kept.
   * `sourcesMerged` records which files the duplicates came from, keeping the
   * citation honest.
   */
  // Generic so it PRESERVES whatever the retriever attached. Rebuilding a fixed
  // {chunkIndex, score, duplicates} shape here silently dropped the coverage
  // field, which made the relevance signal read as 0 everywhere it was
  // inspected -- the diagnostic and the gate disagreeing is worse than either
  // being absent.
  private dedupe<T extends { chunkIndex: number; score: number }>(
    hits: T[],
    topK: number,
  ): Array<T & { duplicates: string[] }> {
    const seen = new Map<string, T & { duplicates: string[] }>();
    for (const h of hits) {
      const c = this.chunks[h.chunkIndex];
      if (!c) continue;
      const key = dedupeKey(c.text);
      const existing = seen.get(key);
      if (existing) {
        const label = `${c.filename}#${c.chunkIndex}`;
        if (!existing.duplicates.includes(label)) existing.duplicates.push(label);
        continue;
      }
      seen.set(key, { ...h, duplicates: [] });
    }
    // Scanning the full candidate list rather than stopping at topK is what
    // lets duplicate labels attach to the entries that were kept.
    return [...seen.values()].slice(0, topK);
  }

  private toRetrieved(index: number, score: number, duplicates: string[] = [], coverage?: number) {
    const c = this.chunks[index];
    return {
      id: c.id,
      text: c.text,
      score: Math.round(score * 10_000) / 10_000,
      ...(coverage === undefined ? {} : { coverage: Math.round(coverage * 10_000) / 10_000 }),
      source: {
        documentId: c.documentId,
        filename: c.filename,
        chunkIndex: c.chunkIndex,
        page: c.page,
        // Identical copies of this chunk that were collapsed away, so the
        // citation stays honest about where the text also appears.
        ...(duplicates.length > 0 ? { duplicateOf: duplicates } : {}),
      },
    };
  }

  /**
   * Documents whose extracted text is byte-for-byte identical to another's.
   * Surfaced so the operator can delete the copies: duplicates do not break
   * retrieval (they are collapsed at query time) but they inflate the index and
   * make the document list confusing.
   */
  duplicateDocuments(): Array<{ keep: string; duplicates: string[] }> {
    const byFingerprint = new Map<string, string[]>();
    for (const doc of this.documents.values()) {
      const text = this.chunks
        .filter((c) => c.documentId === doc.id)
        .map((c) => c.text)
        .join(' ');
      if (!text) continue;
      const key = `${doc.charCount}:${dedupeKey(text)}`;
      const list = byFingerprint.get(key) ?? [];
      list.push(doc.filename);
      byFingerprint.set(key, list);
    }
    return [...byFingerprint.values()]
      .filter((names) => names.length > 1)
      .map((names) => ({ keep: names[0], duplicates: names.slice(1) }));
  }

  stats() {
    const dupes = this.duplicateDocuments();
    return {
      documents: this.documents.size,
      chunks: this.chunks.length,
      vocabulary: this.bm25.vocabulary,
      mode: this.mode,
      embedder: this.opts.embedder?.name ?? null,
      vectorised: this.chunks.filter((c) => c.vector).length,
      duplicateGroups: dupes.length,
      duplicateFiles: dupes.flatMap((d) => d.duplicates),
    };
  }
}
