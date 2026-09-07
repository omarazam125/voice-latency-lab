/**
 * Provider interfaces.
 *
 * The orchestration layer (packages/core/src/pipeline) talks ONLY to these
 * interfaces. No adapter is allowed to know about the pipeline, and the pipeline
 * is not allowed to know about Speechmatics, OpenAI or Hamsa. Swapping a vendor
 * therefore means writing one file in packages/providers and changing one line
 * of the factory -- never touching the latency-critical orchestration.
 *
 * Callbacks are plain function bags rather than an EventEmitter: fewer
 * allocations per audio frame, and a caller cannot accidentally subscribe twice.
 */

/* ========================================================================== */
/* Shared                                                                     */
/* ========================================================================== */

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  encoding: 'pcm_s16le' | 'pcm_f32le' | 'mulaw';
}

export const PCM16_16K: AudioFormat = { sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le' };

export interface ProviderError {
  provider: string;
  code?: string | number;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error';

/* ========================================================================== */
/* Speech to text                                                             */
/* ========================================================================== */

export interface TranscriptWord {
  content: string;
  startTime: number;
  endTime: number;
  confidence?: number;
  isEos?: boolean;
}

export interface Transcript {
  /** The full text of this segment. */
  text: string;
  /** Audio-stream-relative times, in seconds, as reported by the provider. */
  startTime: number;
  endTime: number;
  words?: TranscriptWord[];
  isPartial: boolean;
}

export interface SttOpenOptions {
  language: string;
  audioFormat: AudioFormat;
  enablePartials: boolean;
  /**
   * Seconds between the end of a spoken word and the FINAL transcript.
   * Speechmatics enforces a floor of 0.7s here, which is itself a headline
   * finding for this benchmark.
   */
  maxDelay: number;
  maxDelayMode: 'flexible' | 'fixed';
  /** Provider-side endpointing. 0 disables. */
  endOfUtteranceSilenceTrigger: number;
  /** Accuracy/latency tier. */
  model: 'standard' | 'enhanced';
  punctuationSensitivity?: number;
  additionalVocab?: string[];
  /**
   * Diagnostic tag for the live-session registry, e.g. 'live' or 'replay:B'.
   * Speechmatics enforces a CONCURRENT session limit per account, so when a
   * warm-up fails with "Concurrent Quota Exceeded" the first question is which
   * sessions this process is still holding open. Not sent to the provider.
   */
  label?: string;
}

export interface SttCallbacks {
  onOpen?: (info: { sessionId?: string; raw?: unknown }) => void;
  onReady?: (info: { raw?: unknown }) => void;
  onPartial?: (t: Transcript, raw?: unknown) => void;
  onFinal?: (t: Transcript, raw?: unknown) => void;
  /** Provider-side end-of-utterance detection, when enabled. */
  onEndOfUtterance?: (info: { time: number; raw?: unknown }) => void;
  onAck?: (seqNo: number) => void;
  onError?: (e: ProviderError) => void;
  onClose?: (info: { code?: number; reason?: string }) => void;
  /** Every raw provider frame, for the debug panel. Must be cheap. */
  onRaw?: (direction: 'in' | 'out', payload: unknown) => void;
}

export interface SttSession {
  readonly state: ConnectionState;
  /** Bytes of PCM already accepted. */
  readonly bytesSent: number;
  /** Push one audio frame. MUST NOT block or allocate excessively. */
  sendAudio(frame: Uint8Array): void;
  /** Finalise the current utterance without ending the session, if supported. */
  forceEndOfUtterance(): boolean;
  /** Terminal. After this the session cannot accept more audio. */
  close(): Promise<void>;
}

export interface SttProvider {
  readonly name: string;
  /**
   * Open ONE long-lived recognition session. The pipeline keeps this alive for
   * the whole conversation and never reopens it per turn.
   */
  open(opts: SttOpenOptions, cb: SttCallbacks): Promise<SttSession>;
}

/* ========================================================================== */
/* Large language model                                                       */
/* ========================================================================== */

export interface LlmMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

export interface LlmRequest {
  model: string;
  /** System/developer instruction. Identical across pipeline modes by design. */
  instructions: string;
  input: LlmMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** none | minimal | low | medium | high | xhigh | max -- model dependent. */
  reasoningEffort?: string | null;
  verbosity?: 'low' | 'medium' | 'high' | null;
  /** e.g. 'auto' | 'default' | 'fast' | 'priority' | 'flex' | 'scale'. */
  serviceTier?: string | null;
  store?: boolean;
  /** Stable prefix key to improve prompt-cache hit rate. */
  promptCacheKey?: string;
}

export interface LlmCallbacks {
  onCreated?: (info: { responseId?: string; raw?: unknown }) => void;
  /**
   * Notification that the FIRST text delta arrived. Fires in addition to
   * `onDelta`, never instead of it.
   *
   * Use it for telemetry only. Accumulating text here as well as in `onDelta`
   * duplicates the first token, which is easy to miss because it corrupts only
   * the very beginning of the response.
   */
  onFirstDelta?: (delta: string) => void;
  /** Fires for EVERY text delta, including the first. Concatenating these
   *  yields the complete response. */
  onDelta?: (delta: string) => void;
  onCompleted?: (info: { text: string; usage?: unknown; raw?: unknown }) => void;
  onError?: (e: ProviderError) => void;
  /** Raw SSE event names, for the debug panel. */
  onRaw?: (eventType: string, payload: unknown) => void;
}

export interface LlmStreamHandle {
  /** Abort the HTTP stream. Safe to call more than once. */
  cancel(reason?: string): void;
  readonly cancelled: boolean;
  /** Resolves when the stream finished or was cancelled. Never rejects. */
  done: Promise<{ text: string; cancelled: boolean; error?: ProviderError }>;
}

export interface LlmProvider {
  readonly name: string;
  stream(req: LlmRequest, cb: LlmCallbacks): LlmStreamHandle;
  /** Cheap call that establishes TLS/HTTP2 so the first real request is warm. */
  warmup(model: string): Promise<void>;
}

/* ========================================================================== */
/* Text to speech                                                             */
/* ========================================================================== */

export interface TtsVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string | null;
  isCustom?: boolean;
}

export interface TtsSynthesisRequest {
  text: string;
  /** Voice name (built-in) or UUID (cloned). */
  speaker: string;
  dialect?: string;
  languageId?: string;
  sampleRate?: '8k' | '16k';
  mulaw?: boolean;
  expressiveness?: number;
  /** Ordering + invalidation identity. Carried through to every audio frame. */
  turnId: string;
  phraseSeq: number;
  generation: number;
}

export interface TtsAudioChunk {
  data: Uint8Array;
  turnId: string;
  phraseSeq: number;
  generation: number;
  audioSeq: number;
  isFirst: boolean;
}

export interface TtsCallbacks {
  onRequestSent?: (info: { phraseSeq: number; chars: number }) => void;
  onAck?: (raw?: unknown) => void;
  onFirstAudio?: (chunk: TtsAudioChunk) => void;
  onChunk?: (chunk: TtsAudioChunk) => void;
  onEnd?: (info: { phraseSeq: number; bytes: number; chunks: number }) => void;
  onError?: (e: ProviderError) => void;
  onRaw?: (direction: 'in' | 'out', payload: unknown) => void;
}

export interface TtsHandle {
  cancel(reason?: string): void;
  readonly cancelled: boolean;
  done: Promise<{ bytes: number; chunks: number; cancelled: boolean; error?: ProviderError }>;
}

export interface TtsProvider {
  readonly name: string;
  readonly state: ConnectionState;
  /** PCM format the provider emits. Used to configure the browser player. */
  readonly audioFormat: AudioFormat;
  /**
   * True when a synthesis request can be issued with no connection setup cost.
   * The UI refuses to report READY until this is true.
   */
  readonly warm: boolean;
  /** Establish the connection ahead of time. Idempotent. */
  connect(): Promise<void>;
  /**
   * Load a cloned voice at startup so the first turn does not pay for it.
   *
   * `required: false` means this voice needs no preload (a built-in), which is
   * a normal outcome and must NOT be reported as a failure. A genuine failure
   * is `required: true` with `preloaded: false`.
   */
  preloadVoice(voiceId: string): Promise<{ preloaded: boolean; required: boolean; message?: string }>;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(req: TtsSynthesisRequest, cb: TtsCallbacks): TtsHandle;
  close(): Promise<void>;
}

/* ========================================================================== */
/* Retrieval                                                                  */
/* ========================================================================== */

export interface RetrievedChunk {
  id: string;
  text: string;
  /** Normalised against the best hit: the top result is always 1.0. Display only. */
  score: number;
  /**
   * Share of the query's IDF mass this chunk matched, in [0,1]. Unlike `score`
   * this is absolute, so it is the number to threshold on and the number to
   * look at when the agent answers a question that was never asked.
   */
  coverage?: number;
  source: {
    documentId: string;
    filename: string;
    chunkIndex: number;
    page?: number;
    /** Identical copies collapsed into this hit, as "file#chunk" labels. */
    duplicateOf?: string[];
  };
}

export interface RetrievalResult {
  query: string;
  chunks: RetrievedChunk[];
  durationMs: number;
  /** True when this result was served from a speculative prefetch. */
  prefetched?: boolean;
}

export interface RetrieveOptions {
  topK: number;
  minScore?: number;
  /** Floor on query-term coverage. The gate that actually rejects off-topic hits. */
  minCoverage?: number;
  signal?: AbortSignal;
}

export interface Retriever {
  readonly name: string;
  readonly ready: boolean;
  readonly documentCount: number;
  readonly chunkCount: number;
  search(query: string, opts: RetrieveOptions): Promise<RetrievalResult>;
}
