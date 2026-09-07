/**
 * BM25 lexical index.
 *
 * Chosen as the DEFAULT retriever for latency reasons: it runs entirely in
 * process, so a query costs microseconds rather than the 80-250 ms round trip
 * an embedding API adds to the critical path. For a call-centre knowledge base
 * of policies and FAQs -- where callers use the same domain vocabulary as the
 * documents -- lexical retrieval is also genuinely competitive.
 *
 * The vector retriever remains available for comparison; the whole point of
 * this tool is that the difference can be measured rather than assumed.
 *
 * All index construction happens at UPLOAD time. `search()` performs no
 * parsing, no allocation of the corpus, and no I/O.
 */

import type { KbChunk } from './types.js';
import { tokenize } from './tokenize.js';

export interface Bm25Params {
  /** Term-frequency saturation. 1.2-2.0 is the usual range. */
  k1: number;
  /** Length normalisation. 0 = none, 1 = full. */
  b: number;
}

export const DEFAULT_BM25: Bm25Params = { k1: 1.5, b: 0.75 };

interface Posting {
  chunk: number;
  tf: number;
}

export interface Bm25Hit {
  chunkIndex: number;
  /** Normalised to [0,1] against the best hit. For DISPLAY and ranking only. */
  score: number;
  /** Absolute BM25 score, comparable across chunks but not across corpora. */
  rawScore: number;
  /**
   * Fraction of the query's IDF mass this chunk actually matched, in [0,1].
   *
   * This is the only relevance signal here that survives a bad query, and it
   * exists because `score` cannot be used as a threshold: it is divided by the
   * top hit, so the best result is ALWAYS exactly 1.0 even when it is garbage.
   * A floor on `score` therefore filters nothing, which let an off-topic
   * question ("how is the weather?") retrieve three confident-looking chunks
   * about disciplinary penalties -- which the model then answered from.
   *
   * Weighting by IDF rather than counting terms is what makes it meaningful:
   * matching only a common word like "اليوم" contributes almost nothing, while
   * matching a rare, query-defining term contributes almost everything. Query
   * terms absent from the corpus entirely still count towards the denominator,
   * so a question about something the corpus has never heard of scores near 0.
   */
  coverage: number;
}

export class Bm25Index {
  private postings = new Map<string, Posting[]>();
  private docLengths: number[] = [];
  private avgLength = 0;
  private docCount = 0;

  constructor(private readonly params: Bm25Params = DEFAULT_BM25) {}

  get size(): number {
    return this.docCount;
  }
  get vocabulary(): number {
    return this.postings.size;
  }

  /** Rebuild from scratch. Called on upload/delete, never during a voice turn. */
  build(chunks: KbChunk[]): void {
    this.postings.clear();
    this.docLengths = new Array(chunks.length).fill(0);
    this.docCount = chunks.length;

    let totalLength = 0;
    for (let i = 0; i < chunks.length; i++) {
      const tokens = tokenize(chunks[i].text);
      this.docLengths[i] = tokens.length;
      totalLength += tokens.length;

      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [term, count] of tf) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push({ chunk: i, tf: count });
      }
    }
    this.avgLength = chunks.length > 0 ? totalLength / chunks.length : 0;
  }

  search(query: string, topK: number): Bm25Hit[] {
    if (this.docCount === 0) return [];
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const { k1, b } = this.params;
    const scores = new Float64Array(this.docCount);
    const N = this.docCount;

    // Deduplicate query terms but keep their multiplicity as a weight.
    const qtf = new Map<string, number>();
    for (const t of terms) qtf.set(t, (qtf.get(t) ?? 0) + 1);

    // IDF mass the query asks for, and how much of it each chunk supplies.
    const matchedIdf = new Float64Array(this.docCount);
    let queryIdf = 0;

    for (const [term, weight] of qtf) {
      const list = this.postings.get(term);
      const df = list?.length ?? 0;
      // Robertson/Sparck-Jones IDF with the +1 guard, so a term appearing in
      // every document scores ~0 rather than going negative.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      // Counted even when the term is absent from the corpus. A question full
      // of words the corpus has never seen SHOULD score near-zero coverage
      // rather than being judged only on the one common word it happened to
      // share with an unrelated passage.
      queryIdf += idf;
      if (!list || list.length === 0) continue;

      for (const p of list) {
        const dl = this.docLengths[p.chunk] || 1;
        const norm = 1 - b + b * (dl / (this.avgLength || 1));
        scores[p.chunk] += weight * idf * ((p.tf * (k1 + 1)) / (p.tf + k1 * norm));
        matchedIdf[p.chunk] += idf;
      }
    }

    // Partial selection rather than a full sort: the corpus can be large and
    // topK is single digits.
    const hits: Array<{ chunkIndex: number; score: number }> = [];
    for (let i = 0; i < N; i++) if (scores[i] > 0) hits.push({ chunkIndex: i, score: scores[i]! });
    hits.sort((a, b2) => b2.score - a.score);
    const top = hits.slice(0, topK);

    // Normalise to [0,1] against the best hit so scores are comparable across
    // queries in the UI. Relative ordering is unchanged.
    const max = top[0]?.score ?? 1;
    return top.map((h) => ({
      chunkIndex: h.chunkIndex,
      score: max > 0 ? h.score / max : 0,
      rawScore: h.score,
      coverage: queryIdf > 0 ? Math.min(1, (matchedIdf[h.chunkIndex] ?? 0) / queryIdf) : 0,
    }));
  }
}
