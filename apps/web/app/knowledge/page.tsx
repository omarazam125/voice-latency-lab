'use client';

import { useEffect, useRef, useState } from 'react';
import { serverUrl } from '../../lib/store';

export default function KnowledgePage() {
  const [docs, setDocs] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [supported, setSupported] = useState<string[]>([]);
  const [hasEmbedder, setHasEmbedder] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<any>(null);
  const [chunks, setChunks] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const r = await fetch(`${serverUrl()}/api/kb`);
      const d = await r.json();
      setDocs(d.documents ?? []);
      setStats(d.stats ?? null);
      setSupported(d.supported ?? []);
      setHasEmbedder(!!d.hasEmbedder);
      setErr(null);
    } catch (e: any) {
      setErr(`Cannot reach the server: ${e?.message ?? e}`);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f, i) => fd.append(`file${i}`, f));
      const r = await fetch(`${serverUrl()}/api/kb/upload`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? 'Upload failed');
      await load();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    try {
      const r = await fetch(`${serverUrl()}/api/kb/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ query, topK: 5 }),
      });
      setResult(await r.json());
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  const remove = async (id: string) => {
    await fetch(`${serverUrl()}/api/kb/${id}`, { method: 'DELETE' });
    await load();
    setChunks(null);
  };

  const viewChunks = async (id: string) => {
    const r = await fetch(`${serverUrl()}/api/kb/${id}/chunks`);
    setChunks(r.ok ? { id, ...(await r.json()) } : null);
  };

  const setMode = async (mode: string) => {
    await fetch(`${serverUrl()}/api/kb/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    await load();
  };

  return (
    <>
      <h1>Knowledge base</h1>
      <p className="sub">
        Documents are parsed, chunked and indexed at UPLOAD time. Nothing in this pipeline runs during a voice turn — a
        retrieval on the critical path is a pure in-memory lookup, and the timing shown below is the same code path a
        live turn takes.
      </p>

      {err && <div className="banner error">{err}</div>}

      {stats?.duplicateGroups > 0 && (
        <div className="banner warn">
          <strong>{stats.duplicateGroups} duplicate document group(s) detected.</strong> These files have identical
          extracted text: <span className="mono">{(stats.duplicateFiles ?? []).join(', ')}</span>.
          <br />
          Retrieval already collapses them, so answers are unaffected — a hit that merged copies is labelled{' '}
          <span className="mono">merged</span> in the search results below. Deleting the copies will still shrink the
          index and make this list easier to read.
        </div>
      )}

      <div className="split" style={{ marginBottom: 12 }}>
        <div className="card">
          <h2>Upload</h2>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={supported.join(',')}
            onChange={(e) => void upload(e.target.files)}
            disabled={uploading}
            style={{ marginBottom: 8 }}
          />
          <p className="hint">
            Supported: {supported.join(', ') || 'loading…'}. Sample documents are in{' '}
            <code>data/kb-samples/</code>.
          </p>
          {uploading && <div className="banner info">Parsing, chunking and indexing…</div>}

          {stats && (
            <>
              <h3>Index</h3>
              <dl className="kv">
                <dt>documents</dt>
                <dd>{stats.documents}</dd>
                <dt>chunks</dt>
                <dd>{stats.chunks}</dd>
                <dt>vocabulary</dt>
                <dd>{stats.vocabulary}</dd>
                <dt>retriever</dt>
                <dd>{stats.mode}</dd>
                <dt>embedder</dt>
                <dd>{stats.embedder ?? 'none'}</dd>
                <dt>vectorised chunks</dt>
                <dd>{stats.vectorised}</dd>
              </dl>
              <div className="row tight" style={{ marginTop: 10 }}>
                <span className="faint" style={{ fontSize: 12 }}>RETRIEVER</span>
                {['bm25', 'vector', 'hybrid'].map((m) => (
                  <button
                    key={m}
                    className={`sm ${stats.mode === m ? 'primary' : ''}`}
                    disabled={m !== 'bm25' && !hasEmbedder}
                    onClick={() => void setMode(m)}
                    title={m !== 'bm25' && !hasEmbedder ? 'Set RETRIEVER_MODE and an OpenAI key to enable' : ''}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <p className="hint">
                BM25 is in-process and costs microseconds. Vector and hybrid add one embedding round trip per query —
                switch between them and watch the RAG bar on the monitor to see exactly what that costs.
              </p>
            </>
          )}
        </div>

        <div className="card">
          <h2>Test retrieval</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <input
              type="text"
              dir="auto"
              placeholder="شو الخدمات المتوفرة عندكم"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void search()}
            />
            <button className="primary" onClick={() => void search()}>
              Search
            </button>
          </div>

          {result && (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <span className="badge ok">{result.durationMs} ms</span>
                <span className="badge">{result.chunks.length} hits</span>
                <span className="badge">{result.retriever}</span>
              </div>
              {result.chunks.map((c: any) => (
                <div key={c.id} className="card tight" style={{ marginBottom: 8, background: 'var(--bg-2)' }}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <span className="badge">{c.score.toFixed(3)}</span>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {c.source.filename} · chunk {c.source.chunkIndex}
                      {c.source.page ? ` · page ${c.source.page}` : ''}
                    </span>
                    {c.source.duplicateOf?.length > 0 && (
                      <span className="badge warn" title={`Identical copies collapsed: ${c.source.duplicateOf.join(', ')}`}>
                        merged {c.source.duplicateOf.length}
                      </span>
                    )}
                  </div>
                  <div dir="auto" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--fg-dim)' }}>
                    {c.text.slice(0, 400)}
                    {c.text.length > 400 && '…'}
                  </div>
                </div>
              ))}
              {result.chunks.length === 0 && <div className="empty">No matches.</div>}
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h2>Documents</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th className="num">Size</th>
                <th className="num">Chars</th>
                <th className="num">Chunks</th>
                <th className="num">Pages</th>
                <th className="num">Index time</th>
                <th>Uploaded</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">No documents. Upload the samples from data/kb-samples/ to get started.</div>
                  </td>
                </tr>
              )}
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.filename}
                    {d.error && <div style={{ color: 'var(--bad)', fontSize: 11 }}>{d.error}</div>}
                  </td>
                  <td className="num">{(d.bytes / 1024).toFixed(1)} KB</td>
                  <td className="num">{d.charCount}</td>
                  <td className="num">{d.chunkCount}</td>
                  <td className="num">{d.pages ?? '—'}</td>
                  <td className="num" style={{ color: 'var(--ok)' }}>
                    {d.indexingMs.toFixed(1)} ms
                  </td>
                  <td className="faint" style={{ fontSize: 11 }}>
                    {new Date(d.uploadedAt).toLocaleString()}
                  </td>
                  <td>
                    <div className="row tight">
                      <button className="sm ghost" onClick={() => void viewChunks(d.id)}>
                        chunks
                      </button>
                      <button className="sm danger" onClick={() => void remove(d.id)}>
                        delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Index time is wall-clock time spent parsing, chunking and indexing at upload — it is deliberately paid here so
          it can never appear in a turn measurement.
        </p>
      </div>

      {chunks && (
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Chunks ({chunks.chunks.length})</h2>
            <div className="spacer" />
            <button className="sm ghost" onClick={() => setChunks(null)}>
              close
            </button>
          </div>
          <div className="scroll" style={{ maxHeight: 420 }}>
            {chunks.chunks.map((c: any) => (
              <div key={c.id} className="card tight" style={{ marginBottom: 8, background: 'var(--bg-2)' }}>
                <div className="faint" style={{ fontSize: 11, marginBottom: 5 }}>
                  #{c.chunkIndex} · {c.chars} chars{c.page ? ` · page ${c.page}` : ''}
                  {c.hasVector ? ' · vectorised' : ''}
                </div>
                <div dir="auto" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--fg-dim)', whiteSpace: 'pre-wrap' }}>
                  {c.text}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
