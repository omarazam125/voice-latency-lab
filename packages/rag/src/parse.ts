/**
 * Document text extraction.
 *
 * Runs ONLY at upload time (spec section 12: "Do not block the critical path
 * with document parsing or indexing"). Nothing in this file may ever be reached
 * from a voice turn.
 */

import { extname } from 'node:path';
import type { ChunkOptions, KbChunk, ParsedDocument } from './types.js';
import { DEFAULT_CHUNK_OPTIONS } from './types.js';

export type SupportedExtension = '.txt' | '.md' | '.markdown' | '.pdf' | '.docx' | '.json' | '.csv' | '.html';

export const SUPPORTED_EXTENSIONS: SupportedExtension[] = [
  '.txt',
  '.md',
  '.markdown',
  '.pdf',
  '.docx',
  '.json',
  '.csv',
  '.html',
];

export function isSupported(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extname(filename).toLowerCase() as SupportedExtension);
}

export async function parseDocument(filename: string, buffer: Buffer): Promise<ParsedDocument> {
  const ext = extname(filename).toLowerCase();

  switch (ext) {
    case '.pdf':
      return parsePdf(buffer);
    case '.docx':
      return parseDocx(buffer);
    case '.html':
      return { text: stripHtml(buffer.toString('utf8')) };
    case '.json':
      return { text: flattenJson(buffer.toString('utf8')) };
    case '.csv':
      return { text: buffer.toString('utf8') };
    case '.txt':
    case '.md':
    case '.markdown':
    default:
      return { text: buffer.toString('utf8') };
  }
}

async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  // `unpdf` bundles a serverless-friendly build of pdf.js and needs no worker
  // configuration, which keeps this dependency-light and Windows-friendly.
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];

  const pageBreaks: number[] = [];
  let combined = '';
  for (const p of pages) {
    pageBreaks.push(combined.length);
    combined += `${p}\n\n`;
  }
  return { text: combined, pages: totalPages ?? pages.length, pageBreaks };
}

async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function flattenJson(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const lines: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (v === null || v === undefined) return;
      if (Array.isArray(v)) {
        v.forEach((item, i) => walk(item, `${path}[${i}]`));
      } else if (typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) walk(val, path ? `${path}.${k}` : k);
      } else {
        lines.push(`${path}: ${String(v)}`);
      }
    };
    walk(data, '');
    return lines.join('\n');
  } catch {
    return raw;
  }
}

/* -------------------------------------------------------------------------- */
/* Chunking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Split on paragraph, then sentence, then word boundaries, keeping chunks near
 * the target size with a small overlap. Overlap matters for a call-centre KB:
 * an answer that straddles a boundary would otherwise be retrievable only in
 * halves.
 */
export function chunkText(
  text: string,
  documentId: string,
  filename: string,
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  pageBreaks?: number[],
): KbChunk[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];

  const pageOf = (offset: number): number | undefined => {
    if (!pageBreaks || pageBreaks.length === 0) return undefined;
    let page = 1;
    for (let i = 0; i < pageBreaks.length; i++) {
      if (offset >= pageBreaks[i]) page = i + 1;
      else break;
    }
    return page;
  };

  const chunks: KbChunk[] = [];
  const paragraphs = splitWithOffsets(clean, /\n\s*\n/);

  let buf = '';
  let bufStart = 0;
  let index = 0;

  const flush = (end: number) => {
    const t = buf.trim();
    if (t.length === 0) return;
    chunks.push({
      id: `${documentId}:${index}`,
      documentId,
      filename,
      chunkIndex: index,
      text: t,
      start: bufStart,
      end,
      page: pageOf(bufStart),
    });
    index++;
  };

  for (const para of paragraphs) {
    // A single paragraph larger than the target gets split on sentences.
    if (para.text.length > opts.size) {
      if (buf) {
        flush(para.start);
        buf = '';
      }
      for (const piece of splitLarge(para.text, opts.size)) {
        chunks.push({
          id: `${documentId}:${index}`,
          documentId,
          filename,
          chunkIndex: index,
          text: piece.text.trim(),
          start: para.start + piece.offset,
          end: para.start + piece.offset + piece.text.length,
          page: pageOf(para.start + piece.offset),
        });
        index++;
      }
      continue;
    }

    if (buf.length + para.text.length + 2 > opts.size && buf.length > 0) {
      flush(para.start);
      // Carry the tail forward so context spans the boundary — but SNAP IT TO
      // A WORD BOUNDARY first.
      //
      // A raw character slice lands mid-word, and that fragment becomes the
      // first token of the next chunk. Observed in the live index: chunks
      // beginning "قعات" (the tail of التوقعات), "رة" (المعايرة) and "لتي"
      // (التي). Such a fragment matches nothing at retrieval time, and both
      // halves of the split word are lost — the chunk becomes unfindable by
      // the very term it is about.
      const rawTail = buf.slice(Math.max(0, buf.length - opts.overlap));
      const firstSpace = rawTail.search(/\s/);
      const tail = firstSpace >= 0 ? rawTail.slice(firstSpace + 1) : '';
      buf = tail ? `${tail}\n\n${para.text}` : para.text;
      bufStart = Math.max(0, para.start - tail.length);
    } else {
      if (buf.length === 0) bufStart = para.start;
      buf = buf ? `${buf}\n\n${para.text}` : para.text;
    }
  }
  flush(clean.length);

  return chunks;
}

interface Piece {
  text: string;
  start: number;
}

function splitWithOffsets(text: string, re: RegExp): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), start: last });
    last = m.index + m[0].length;
    if (m[0].length === 0) global.lastIndex++;
  }
  if (last < text.length) out.push({ text: text.slice(last), start: last });
  return out.filter((p) => p.text.trim().length > 0);
}

function splitLarge(text: string, size: number): Array<{ text: string; offset: number }> {
  // Sentence boundaries including the Arabic full stop and question mark.
  const parts: Array<{ text: string; offset: number }> = [];
  const sentenceRe = /[^.!?؟۔\n]+[.!?؟۔\n]*/gu;
  let buf = '';
  let bufOffset = 0;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(text)) !== null) {
    const s = m[0];
    if (buf.length + s.length > size && buf.length > 0) {
      parts.push({ text: buf, offset: bufOffset });
      buf = s;
      bufOffset = m.index;
    } else {
      if (buf.length === 0) bufOffset = m.index;
      buf += s;
    }
    if (s.length === 0) sentenceRe.lastIndex++;
  }
  if (buf.trim()) parts.push({ text: buf, offset: bufOffset });

  // Anything still oversized (no punctuation at all) is hard-split on words.
  const out: Array<{ text: string; offset: number }> = [];
  for (const p of parts) {
    if (p.text.length <= size * 1.5) {
      out.push(p);
      continue;
    }
    let pos = 0;
    while (pos < p.text.length) {
      let end = Math.min(pos + size, p.text.length);
      if (end < p.text.length) {
        // Search back for any WHITESPACE, not just a literal space.
        //
        // `lastIndexOf(' ', end)` missed newlines, and Arabic FAQ documents
        // separate their list items with '\n' rather than spaces. When the
        // nearest preceding space lay more than half a chunk back the guard
        // rejected it and the text was hard-split mid-word, producing real
        // indexed chunks that begin "قعات" (التوقعات), "رة" (المعايرة) and
        // "لتي" (التي) — fragments that occur nowhere else in the corpus and so
        // match nothing, losing both halves of the word for retrieval.
        let cut = -1;
        for (let k = end; k > pos; k--) {
          const ch = p.text.charCodeAt(k);
          if (ch === 32 || ch === 10 || ch === 13 || ch === 9) {
            cut = k;
            break;
          }
        }
        if (cut > pos + size * 0.5) end = cut;
      }
      out.push({ text: p.text.slice(pos, end), offset: p.offset + pos });
      pos = end;
    }
  }
  return out;
}
