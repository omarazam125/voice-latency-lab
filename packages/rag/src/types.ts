export interface KbDocument {
  id: string;
  filename: string;
  mimeType: string;
  bytes: number;
  /** Wall-clock ISO timestamp of upload. Display only. */
  uploadedAt: string;
  chunkCount: number;
  charCount: number;
  /** Milliseconds spent parsing + chunking + indexing at UPLOAD time. */
  indexingMs: number;
  pages?: number;
  error?: string;
}

export interface KbChunk {
  id: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  page?: number;
  /** Character offsets in the extracted document text. */
  start: number;
  end: number;
  /** Optional dense vector, present only when an embedder is configured. */
  vector?: Float32Array;
}

export interface ParsedDocument {
  text: string;
  pages?: number;
  /** Character offset -> page number, for citation. */
  pageBreaks?: number[];
}

export interface ChunkOptions {
  /** Target characters per chunk. */
  size: number;
  /** Characters of overlap between neighbours, to avoid cutting an answer. */
  overlap: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { size: 900, overlap: 150 };
