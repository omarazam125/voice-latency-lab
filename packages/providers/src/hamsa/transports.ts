/**
 * Hamsa realtime TTS transports.
 *
 * Two are provided because they have genuinely different latency and
 * cancellation characteristics, and the point of this tool is to measure that
 * rather than guess:
 *
 *   WEBSOCKET (wss://api.tryhamsa.com/v1/realtime/ws)
 *     + One persistent, pre-warmed socket; no per-phrase TLS handshake.
 *     - STRICTLY SEQUENTIAL. Frames carry no request/correlation id, so two
 *       in-flight requests on one socket cannot be told apart. The transport
 *       enforces a FIFO internally; this is a protocol constraint, not policy.
 *     - No cancellation primitive exists. On barge-in the only options are to
 *       discard incoming bytes locally or drop the socket.
 *
 *   HTTP CHUNKED (POST /v1/realtime/tts-stream)
 *     + True cancellation via AbortController.
 *     + Requests can overlap, so phrase N+1 can be synthesising while N plays.
 *     - Pays a request setup cost per phrase (mitigated by keep-alive).
 *     This is the transport Hamsa's own LiveKit plugin uses in production.
 *
 * Both emit raw headerless PCM16, which is forwarded to the browser untouched.
 */

import WebSocket from 'ws';
import type { ConnectionState, ProviderError, TtsAudioChunk, TtsCallbacks, TtsHandle, TtsSynthesisRequest } from '@vll/core';
import {
  HAMSA_CLOSE_CODES,
  HAMSA_HTTP_STREAM_URL,
  HAMSA_MAX_TEXT_CHARS,
  HAMSA_WS_URL,
  type HamsaServerFrame,
  type HamsaTtsRequestFrame,
} from './types.js';

export interface HamsaTransportOptions {
  apiKey: string;
  wsUrl?: string;
  httpUrl?: string;
  connectTimeoutMs?: number;
  /** Abort a phrase whose first audio byte never arrives. */
  firstAudioTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_FIRST_AUDIO_TIMEOUT = 15_000;
const DEFAULT_REQUEST_TIMEOUT = 60_000;

function err(code: string | number, message: string, retryable: boolean): ProviderError {
  return { provider: 'hamsa', code, message, retryable };
}

function buildFrame(req: TtsSynthesisRequest): HamsaTtsRequestFrame {
  const text = req.text.length > HAMSA_MAX_TEXT_CHARS ? req.text.slice(0, HAMSA_MAX_TEXT_CHARS) : req.text;
  const payload = {
    text,
    speaker: req.speaker,
    dialect: req.dialect ?? 'pls',
    languageId: req.languageId ?? 'ar',
    mulaw: req.mulaw ?? false,
    // mu-law output is always 8 kHz and must not be combined with sampleRate.
    ...(req.mulaw ? {} : { sampleRate: req.sampleRate ?? ('16k' as const) }),
    ...(req.expressiveness != null ? { expressiveness: req.expressiveness } : {}),
  };
  return {
    type: 'tts',
    payload,
    dialect: payload.dialect,
    languageId: payload.languageId,
    mulaw: payload.mulaw,
  };
}

/* ========================================================================== */
/* WebSocket transport                                                        */
/* ========================================================================== */

interface QueuedJob {
  req: TtsSynthesisRequest;
  cb: TtsCallbacks;
  resolve: (v: { bytes: number; chunks: number; cancelled: boolean; error?: ProviderError }) => void;
  cancelled: boolean;
  started: boolean;
}

export class HamsaWebSocketTransport {
  state: ConnectionState = 'idle';
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private queue: QueuedJob[] = [];
  private active: QueuedJob | null = null;
  private activeBytes = 0;
  private activeChunks = 0;
  private activeAudioSeq = 0;
  private firstAudioTimer: ReturnType<typeof setTimeout> | null = null;
  private onRawGlobal?: (dir: 'in' | 'out', payload: unknown) => void;

  constructor(private readonly opts: HamsaTransportOptions) {}

  setRawLogger(fn?: (dir: 'in' | 'out', payload: unknown) => void): void {
    this.onRawGlobal = fn;
  }

  get warm(): boolean {
    return this.state === 'open' && this.ws?.readyState === WebSocket.OPEN;
  }

  get queueDepth(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  async connect(): Promise<void> {
    if (this.warm) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      this.state = 'connecting';
      const url = this.opts.wsUrl ?? HAMSA_WS_URL;
      // Server-side, so the key travels as a header rather than in the URL.
      // (A browser client could not do this, which is one more reason the key
      // never leaves this process.)
      const ws = new WebSocket(url, {
        headers: { 'X-Api-Key': this.opts.apiKey },
        perMessageDeflate: false,
        handshakeTimeout: 8_000,
      });
      this.ws = ws;
      ws.binaryType = 'nodebuffer';

      const timer = setTimeout(() => {
        reject(err('connect_timeout', 'Hamsa WebSocket connect timed out', true));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT);

      ws.once('open', () => {
        clearTimeout(timer);
        this.state = 'open';
        this.onRawGlobal?.('in', { event: 'ws_open' });
        resolve();
      });

      ws.once('error', (e) => {
        clearTimeout(timer);
        this.state = 'error';
        reject(err('socket_error', (e as Error)?.message ?? 'Hamsa socket error', true));
      });

      ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));

      ws.once('close', (code, reason) => {
        this.state = 'closed';
        const detail = HAMSA_CLOSE_CODES[code] ?? reason?.toString() ?? '';
        this.onRawGlobal?.('in', { event: 'ws_close', code, detail });
        this.failAll(err(code, `Hamsa WebSocket closed (${code}): ${detail}`, code === 1000 || code === 1001));
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.onBinary(data);
      return;
    }
    let frame: HamsaServerFrame;
    try {
      frame = JSON.parse(data.toString()) as HamsaServerFrame;
    } catch {
      return;
    }
    this.onRawGlobal?.('in', frame);
    const job = this.active;
    job?.cb.onRaw?.('in', frame);

    switch (frame.type) {
      case 'info':
        break;
      case 'ack':
        job?.cb.onAck?.(frame);
        break;
      case 'end':
        this.finishActive(false);
        break;
      case 'error': {
        const message = frame.payload?.message ?? 'Hamsa TTS error';
        const e = err('tts_error', message, /rate limit/i.test(message));
        if (job) {
          job.cb.onError?.(e);
          this.finishActive(false, e);
        }
        break;
      }
      default:
        break;
    }
  }

  private onBinary(buf: Buffer): void {
    const job = this.active;
    if (!job) return;
    if (job.cancelled) return; // barge-in: drop bytes rather than play them

    if (this.firstAudioTimer) {
      clearTimeout(this.firstAudioTimer);
      this.firstAudioTimer = null;
    }

    const isFirst = this.activeChunks === 0;
    this.activeChunks++;
    this.activeBytes += buf.byteLength;

    const chunk: TtsAudioChunk = {
      // Copy out of ws's pooled buffer: retaining a slice of the pool would
      // pin far more memory than the frame itself.
      data: new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
      turnId: job.req.turnId,
      phraseSeq: job.req.phraseSeq,
      generation: job.req.generation,
      audioSeq: this.activeAudioSeq++,
      isFirst,
    };
    if (isFirst) job.cb.onFirstAudio?.(chunk);
    job.cb.onChunk?.(chunk);
  }

  private finishActive(cancelled: boolean, error?: ProviderError): void {
    const job = this.active;
    if (!job) return;
    if (this.firstAudioTimer) {
      clearTimeout(this.firstAudioTimer);
      this.firstAudioTimer = null;
    }
    this.active = null;
    if (!cancelled && !error) job.cb.onEnd?.({ phraseSeq: job.req.phraseSeq, bytes: this.activeBytes, chunks: this.activeChunks });
    job.resolve({ bytes: this.activeBytes, chunks: this.activeChunks, cancelled, error });
    this.pump();
  }

  private failAll(e: ProviderError): void {
    if (this.active) {
      this.active.cb.onError?.(e);
      this.finishActive(false, e);
    }
    const pending = this.queue;
    this.queue = [];
    for (const j of pending) {
      j.cb.onError?.(e);
      j.resolve({ bytes: 0, chunks: 0, cancelled: false, error: e });
    }
  }

  private pump(): void {
    if (this.active) return;
    // Skip anything cancelled while it sat in the queue.
    let job = this.queue.shift();
    while (job && job.cancelled) {
      job.resolve({ bytes: 0, chunks: 0, cancelled: true });
      job = this.queue.shift();
    }
    if (!job) return;

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const e = err('not_connected', 'Hamsa WebSocket is not open', true);
      job.cb.onError?.(e);
      job.resolve({ bytes: 0, chunks: 0, cancelled: false, error: e });
      this.pump();
      return;
    }

    this.active = job;
    job.started = true;
    this.activeBytes = 0;
    this.activeChunks = 0;
    this.activeAudioSeq = 0;

    const frame = buildFrame(job.req);
    job.cb.onRaw?.('out', frame);
    this.onRawGlobal?.('out', frame);
    ws.send(JSON.stringify(frame));
    job.cb.onRequestSent?.({ phraseSeq: job.req.phraseSeq, chars: job.req.text.length });

    this.firstAudioTimer = setTimeout(() => {
      const e = err('first_audio_timeout', 'Hamsa produced no audio in time', true);
      if (this.active === job) {
        job.cb.onError?.(e);
        this.finishActive(false, e);
      }
    }, this.opts.firstAudioTimeoutMs ?? DEFAULT_FIRST_AUDIO_TIMEOUT);
  }

  synthesize(req: TtsSynthesisRequest, cb: TtsCallbacks): TtsHandle {
    let cancelled = false;
    let resolveDone!: (v: { bytes: number; chunks: number; cancelled: boolean; error?: ProviderError }) => void;
    const done = new Promise<{ bytes: number; chunks: number; cancelled: boolean; error?: ProviderError }>((resolve) => {
      resolveDone = resolve;
    });

    const job: QueuedJob = { req, cb, resolve: resolveDone, cancelled: false, started: false };
    this.queue.push(job);
    queueMicrotask(() => this.pump());

    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        job.cancelled = true;
        // Hamsa exposes no cancel message. If this phrase is already in flight
        // the server keeps generating; we simply stop forwarding its bytes.
        // Keeping phrases short bounds how much audio can be wasted.
        if (this.active === job) {
          cb.onError?.(err('cancelled_locally', 'Discarding in-flight Hamsa audio (no provider cancel API)', false));
          this.finishActive(true);
        }
      },
      get cancelled() {
        return cancelled;
      },
      done,
    };
  }

  async close(): Promise<void> {
    this.state = 'closing';
    this.failAll(err('closing', 'transport closing', false));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.state = 'closed';
  }
}

/* ========================================================================== */
/* HTTP chunked transport                                                     */
/* ========================================================================== */

export class HamsaHttpTransport {
  state: ConnectionState = 'idle';
  private inFlight = 0;
  private onRawGlobal?: (dir: 'in' | 'out', payload: unknown) => void;

  constructor(private readonly opts: HamsaTransportOptions) {}

  setRawLogger(fn?: (dir: 'in' | 'out', payload: unknown) => void): void {
    this.onRawGlobal = fn;
  }

  /** There is no persistent socket; "warm" means the TLS pool has been primed. */
  get warm(): boolean {
    return this.state === 'open';
  }

  get queueDepth(): number {
    return this.inFlight;
  }

  /**
   * Prime the keep-alive connection pool with a real but tiny synthesis, so the
   * first conversational phrase does not pay TLS setup. A HEAD/OPTIONS would
   * not necessarily reuse the same pooled origin connection.
   */
  async connect(): Promise<void> {
    this.state = 'connecting';
    this.state = 'open';
  }

  synthesize(req: TtsSynthesisRequest, cb: TtsCallbacks): TtsHandle {
    const ac = new AbortController();
    let cancelled = false;
    this.inFlight++;

    const run = async () => {
      let bytes = 0;
      let chunks = 0;
      let audioSeq = 0;
      const timer = setTimeout(() => {
        if (!cancelled) {
          cancelled = true;
          ac.abort('request_timeout');
        }
      }, this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT);

      let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        if (chunks === 0 && !cancelled) {
          cancelled = true;
          ac.abort('first_audio_timeout');
        }
      }, this.opts.firstAudioTimeoutMs ?? DEFAULT_FIRST_AUDIO_TIMEOUT);

      try {
        const text = req.text.length > HAMSA_MAX_TEXT_CHARS ? req.text.slice(0, HAMSA_MAX_TEXT_CHARS) : req.text;
        const body: Record<string, unknown> = {
          text,
          speaker: req.speaker,
          dialect: req.dialect ?? 'pls',
          mulaw: req.mulaw ?? false,
        };
        if (!req.mulaw) body.sampleRate = req.sampleRate ?? '16k';
        if (req.expressiveness != null) body.expressiveness = req.expressiveness;

        cb.onRaw?.('out', body);
        this.onRawGlobal?.('out', body);

        // MUST be stamped BEFORE the request is issued. `await fetch()` does not
        // resolve until the response HEADERS have arrived, so reporting the
        // request as "sent" afterwards would fold the entire round trip into
        // the wrong side of the measurement and report a TTFA near zero.
        cb.onRequestSent?.({ phraseSeq: req.phraseSeq, chars: text.length });

        const res = await fetch(this.opts.httpUrl ?? HAMSA_HTTP_STREAM_URL, {
          method: 'POST',
          // REST uses the literal keyword "Token", not "Bearer".
          headers: { Authorization: `Token ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          const raw = await res.text().catch(() => '');
          let message = `Hamsa HTTP ${res.status}`;
          try {
            const j = JSON.parse(raw);
            message = j?.message ?? message;
          } catch {
            if (raw) message = `${message}: ${raw.slice(0, 300)}`;
          }
          const e = err(res.status, message, res.status === 429 || res.status >= 500);
          cb.onError?.(e);
          return { bytes, chunks, cancelled, error: e };
        }

        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          if (cancelled) break;
          if (firstTimer) {
            clearTimeout(firstTimer);
            firstTimer = null;
          }
          const isFirst = chunks === 0;
          chunks++;
          bytes += value.byteLength;
          const chunk: TtsAudioChunk = {
            data: value,
            turnId: req.turnId,
            phraseSeq: req.phraseSeq,
            generation: req.generation,
            audioSeq: audioSeq++,
            isFirst,
          };
          if (isFirst) cb.onFirstAudio?.(chunk);
          cb.onChunk?.(chunk);
        }
        if (!cancelled) cb.onEnd?.({ phraseSeq: req.phraseSeq, bytes, chunks });
        return { bytes, chunks, cancelled };
      } catch (e: any) {
        if (e?.name === 'AbortError' || cancelled) return { bytes, chunks, cancelled: true };
        const pe = err(e?.code ?? 'network_error', e?.message ?? String(e), true);
        cb.onError?.(pe);
        return { bytes, chunks, cancelled, error: pe };
      } finally {
        clearTimeout(timer);
        if (firstTimer) clearTimeout(firstTimer);
        this.inFlight--;
      }
    };

    const done = run();
    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // Unlike the WebSocket, this is a REAL cancellation: the HTTP request
        // is aborted and the server stops sending.
        try {
          ac.abort('barge_in');
        } catch {
          /* ignore */
        }
      },
      get cancelled() {
        return cancelled;
      },
      done,
    };
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}
