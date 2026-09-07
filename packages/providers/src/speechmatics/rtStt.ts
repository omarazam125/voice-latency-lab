/**
 * Speechmatics Realtime STT adapter.
 *
 * Key protocol facts this implementation depends on, all from the official
 * realtime documentation and AsyncAPI spec:
 *
 *   - ONE StartRecognition per connection, exactly once, and you must wait for
 *     RecognitionStarted before sending audio.
 *   - Audio is sent as PLAIN BINARY WebSocket frames. There is no AddAudio JSON
 *     wrapper and the client attaches no sequence number; the server counts
 *     frames and echoes the count in AudioAdded.seq_no.
 *   - EndOfStream is TERMINAL, not a turn boundary. The documented warning
 *     `add_audio_after_eos` states that audio sent after EndOfStream is ignored.
 *     We therefore NEVER send it between conversational turns -- only on close.
 *     The turn primitive is EndOfUtterance / ForceEndOfUtterance.
 *   - max_delay has a hard documented floor of 0.7s, which puts a floor under
 *     how quickly a FINAL transcript can possibly arrive. Partials typically
 *     land in under 500ms and are unaffected by max_delay. That asymmetry is
 *     precisely what Mode B exploits.
 */

import WebSocket from 'ws';
import type {
  ConnectionState,
  ProviderError,
  SttCallbacks,
  SttOpenOptions,
  SttProvider,
  SttSession,
  Transcript,
} from '@vll/core';
import {
  SM_ENDPOINTS,
  SM_RETRYABLE_ERROR_TYPES,
  type SmRegion,
  type SmServerMessage,
  type SmStartRecognition,
  type SmTranscriptMessage,
} from './types.js';

export interface SpeechmaticsOptions {
  apiKey: string;
  region?: SmRegion;
  /** Full override, e.g. for a self-hosted container. */
  url?: string;
  /** Milliseconds to wait for RecognitionStarted before failing. */
  startTimeoutMs?: number;
  /**
   * Bytes of WebSocket send buffer above which we consider the socket congested
   * and start dropping frames rather than growing memory without bound. The
   * Speechmatics docs explicitly warn about filling TCP buffers here.
   */
  maxBufferedBytes?: number;
}

const DEFAULT_START_TIMEOUT = 10_000;
const DEFAULT_MAX_BUFFERED = 1_000_000; // ~31 s of 16 kHz PCM16

function toTranscript(m: SmTranscriptMessage, isPartial: boolean): Transcript {
  return {
    text: m.metadata?.transcript ?? '',
    startTime: m.metadata?.start_time ?? 0,
    endTime: m.metadata?.end_time ?? 0,
    isPartial,
    words: (m.results ?? [])
      .filter((r) => r.type === 'word' || r.type === 'entity')
      .map((r) => ({
        content: r.alternatives?.[0]?.content ?? '',
        startTime: r.start_time,
        endTime: r.end_time,
        confidence: r.alternatives?.[0]?.confidence,
        isEos: r.is_eos,
      })),
  };
}

/* ========================================================================== */
/* Live-session registry                                                      */
/* ========================================================================== */

/**
 * Speechmatics bills and limits CONCURRENT realtime sessions per account. A
 * leaked session stays open and counts against that limit until the socket
 * times out, so the next warm-up fails with "Concurrent Quota Exceeded" for
 * reasons that are invisible from the outside.
 *
 * Registering here -- inside the provider rather than at each call site --
 * means every path that opens a session (live warm-up, replay, benchmarks) is
 * accounted for automatically, and a new call site cannot forget to enrol.
 */
export interface LiveSttSession {
  id: string;
  label: string;
  state: ConnectionState;
  openedAtMs: number;
  ageMs: number;
  bytesSent: number;
}

const LIVE = new Map<string, SpeechmaticsSession>();
let sessionSeq = 0;

/** Snapshot of the realtime sessions this process currently holds open. */
export function liveSttSessions(): LiveSttSession[] {
  const now = Date.now();
  return [...LIVE.values()]
    .map((s) => s.describe(now))
    .sort((a, b) => a.openedAtMs - b.openedAtMs);
}

class SpeechmaticsSession implements SttSession {
  state: ConnectionState = 'idle';
  bytesSent = 0;

  readonly id = `sm-${++sessionSeq}`;
  /** Wall clock, for a human-readable age only -- never for latency maths. */
  readonly openedAtMs = Date.now();

  private ws: WebSocket | null = null;
  private lastSeqNo = 0;
  private started = false;
  private closed = false;
  private droppedFrames = 0;
  private readonly maxBuffered: number;

  constructor(
    private readonly opts: SpeechmaticsOptions,
    private readonly cfg: SttOpenOptions,
    private readonly cb: SttCallbacks,
  ) {
    this.maxBuffered = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED;
  }

  async open(): Promise<void> {
    const url = this.opts.url ?? SM_ENDPOINTS[this.opts.region ?? 'eu'];
    this.state = 'connecting';

    const ws = new WebSocket(url, {
      // Server-side connection: the API key goes in a header and never reaches
      // the browser. The ?jwt= query-param flow exists for browser clients and
      // is deliberately unused here.
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      perMessageDeflate: false, // compression would add latency to audio frames
      handshakeTimeout: 8_000,
    });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';
    LIVE.set(this.id, this);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(this.err('start_timeout', `RecognitionStarted not received in ${this.startTimeout}ms`, true));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, this.startTimeout);

      const fail = (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      ws.once('error', (e) => {
        this.state = 'error';
        fail(this.err('socket_error', (e as Error)?.message ?? 'socket error', true));
      });

      ws.once('open', () => {
        this.state = 'open';
        this.cb.onOpen?.({});
        const start: SmStartRecognition = {
          message: 'StartRecognition',
          audio_format: {
            type: 'raw',
            encoding: this.cfg.audioFormat.encoding as 'pcm_s16le',
            sample_rate: this.cfg.audioFormat.sampleRate,
          },
          transcription_config: {
            language: this.cfg.language,
            model: this.cfg.model,
            enable_partials: this.cfg.enablePartials,
            max_delay: this.cfg.maxDelay,
            max_delay_mode: this.cfg.maxDelayMode,
            enable_entities: true,
            punctuation_overrides:
              this.cfg.punctuationSensitivity != null
                ? { sensitivity: this.cfg.punctuationSensitivity }
                : undefined,
            // 0 disables provider-side endpointing. We keep our own VAD as the
            // trigger, but ask for this too so the two can be compared.
            conversation_config:
              this.cfg.endOfUtteranceSilenceTrigger > 0
                ? { end_of_utterance_silence_trigger: this.cfg.endOfUtteranceSilenceTrigger }
                : undefined,
            additional_vocab: this.cfg.additionalVocab?.length ? this.cfg.additionalVocab : undefined,
          },
        };
        this.send(start);
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) return; // the server never sends binary on this API
        let msg: SmServerMessage;
        try {
          msg = JSON.parse(data.toString()) as SmServerMessage;
        } catch {
          return;
        }
        this.cb.onRaw?.('in', msg);

        switch (msg.message) {
          case 'RecognitionStarted':
            clearTimeout(timer);
            this.started = true;
            this.cb.onReady?.({ raw: msg });
            resolve();
            break;

          case 'AudioAdded':
            this.lastSeqNo = msg.seq_no;
            this.cb.onAck?.(msg.seq_no);
            break;

          case 'AddPartialTranscript':
            this.cb.onPartial?.(toTranscript(msg, true), msg);
            break;

          case 'AddTranscript':
            this.cb.onFinal?.(toTranscript(msg, false), msg);
            break;

          case 'EndOfUtterance':
            this.cb.onEndOfUtterance?.({ time: msg.metadata?.end_time ?? 0, raw: msg });
            break;

          case 'Error': {
            const e = this.err(
              msg.type ?? 'error',
              msg.reason ?? 'Speechmatics error',
              SM_RETRYABLE_ERROR_TYPES.has(msg.type ?? ''),
            );
            clearTimeout(timer);
            this.state = 'error';
            this.cb.onError?.(e);
            if (!this.started) reject(e);
            break;
          }

          case 'Warning':
            this.cb.onError?.(this.err(msg.type ?? 'warning', `warning: ${msg.reason ?? ''}`, false));
            break;

          case 'Info':
          case 'EndOfTranscript':
          default:
            break;
        }
      });

      ws.once('close', (code, reason) => {
        this.state = 'closed';
        this.closed = true;
        LIVE.delete(this.id);
        clearTimeout(timer);
        this.cb.onClose?.({ code, reason: reason?.toString() });
        if (!this.started) reject(this.err('closed', `socket closed before start: ${code}`, true));
      });
    });
  }

  private get startTimeout(): number {
    return this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT;
  }

  private err(code: string, message: string, retryable: boolean): ProviderError & Error {
    const e = new Error(message) as ProviderError & Error;
    e.provider = 'speechmatics';
    e.code = code;
    e.retryable = retryable;
    return e;
  }

  private send(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.cb.onRaw?.('out', obj);
    this.ws.send(JSON.stringify(obj));
  }

  /* ---------------------------------------------------------------------- */

  sendAudio(frame: Uint8Array): void {
    const ws = this.ws;
    if (!ws || !this.started || this.closed || ws.readyState !== WebSocket.OPEN) return;

    // Documented backpressure hazard: if we outrun the server's read, TCP
    // buffers fill and the connection is closed "with prejudice". Dropping a
    // frame is strictly better than losing the session mid-benchmark, and the
    // drop is reported rather than hidden.
    if (ws.bufferedAmount > this.maxBuffered) {
      this.droppedFrames++;
      if (this.droppedFrames === 1 || this.droppedFrames % 50 === 0) {
        this.cb.onError?.({
          provider: 'speechmatics',
          code: 'backpressure',
          message: `STT socket congested (${ws.bufferedAmount} bytes buffered); dropped ${this.droppedFrames} frames`,
          retryable: false,
        });
      }
      return;
    }

    ws.send(frame, { binary: true });
    this.bytesSent += frame.byteLength;
  }

  /**
   * Finalise the current utterance WITHOUT ending the session. This is the
   * correct turn boundary; EndOfStream would kill the connection.
   */
  forceEndOfUtterance(): boolean {
    if (!this.ws || !this.started || this.ws.readyState !== WebSocket.OPEN) return false;
    this.send({ message: 'ForceEndOfUtterance' });
    return true;
  }

  describe(nowMs: number): LiveSttSession {
    return {
      id: this.id,
      label: this.cfg.label ?? 'unlabelled',
      state: this.state,
      openedAtMs: this.openedAtMs,
      ageMs: nowMs - this.openedAtMs,
      bytesSent: this.bytesSent,
    };
  }

  async close(): Promise<void> {
    // Deregister unconditionally: an already-closed session must not linger in
    // the registry just because this call is a no-op.
    LIVE.delete(this.id);
    if (this.closed || !this.ws) return;
    this.state = 'closing';
    this.closed = true;
    try {
      if (this.ws.readyState === WebSocket.OPEN && this.started) {
        // Only here, at genuine session teardown, is EndOfStream correct.
        this.send({ message: 'EndOfStream', last_seq_no: this.lastSeqNo });
        await new Promise<void>((r) => setTimeout(r, 120));
      }
    } catch {
      /* ignore */
    }
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.state = 'closed';
  }
}

export class SpeechmaticsSttProvider implements SttProvider {
  readonly name = 'speechmatics';

  constructor(private readonly opts: SpeechmaticsOptions) {
    if (!opts.apiKey) throw new Error('SPEECHMATICS_API_KEY is required');
  }

  async open(cfg: SttOpenOptions, cb: SttCallbacks): Promise<SttSession> {
    const s = new SpeechmaticsSession(this.opts, cfg, cb);
    try {
      await s.open();
    } catch (e) {
      // A handshake that never completed still opened a socket: close it so a
      // failed attempt cannot hold a slot against the concurrent-session quota.
      await s.close().catch(() => undefined);
      throw e;
    }
    return s;
  }
}
