/**
 * Optional dense-vector retrieval.
 *
 * This exists so the latency cost of embedding-based RAG can be MEASURED rather
 * than argued about. An embedding call on the query path adds a real network
 * round trip (typically 60-250 ms) to every turn, which is why BM25 is the
 * default; switch this on to see exactly what that trade buys in recall.
 *
 * Document vectors are computed once at upload. Only the QUERY vector is
 * computed during a turn, and that single call is what the RAG span measures.
 */

export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  /** Batch-embed document chunks. Called at upload time only. */
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  /** Embed one query. This IS on the critical path. */
  embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>;
}

export interface OpenAiEmbedderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  batchSize?: number;
}

export class OpenAiEmbedder implements Embedder {
  readonly name: string;
  readonly dimensions = 1536;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;

  constructor(private readonly opts: OpenAiEmbedderOptions) {
    this.model = opts.model ?? 'text-embedding-3-small';
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.batchSize = opts.batchSize ?? 96;
    this.name = `openai:${this.model}`;
  }

  private async call(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input }),
      signal,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new Error(`Embedding request failed (HTTP ${res.status}): ${raw.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    const out: Float32Array[] = new Array(input.length);
    for (const d of json.data) out[d.index] = normalize(Float32Array.from(d.embedding));
    return out;
  }

  async embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => t.slice(0, 8000));
      out.push(...(await this.call(batch, signal)));
    }
    return out;
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
    const [v] = await this.call([text.slice(0, 8000)], signal);
    return v;
  }
}

/** L2-normalise so cosine similarity reduces to a dot product. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const n = Math.sqrt(sum);
  if (n === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Dot product of two already-normalised vectors == cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
