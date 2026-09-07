/**
 * Hamsa realtime TTS wire types.
 *
 * Sourced from the published AsyncAPI 3.0.0 spec for the realtime WebSocket
 * (docs.tryhamsa.com/websocket/asyncapi-tts.json), the OpenAPI spec, and
 * Hamsa's own official LiveKit plugin, which is the ground truth for how the
 * HTTP streaming endpoint actually behaves.
 */

export const HAMSA_WS_URL = 'wss://api.tryhamsa.com/v1/realtime/ws';
export const HAMSA_HTTP_STREAM_URL = 'https://api.tryhamsa.com/v1/realtime/tts-stream';
export const HAMSA_HTTP_SYNC_URL = 'https://api.tryhamsa.com/v1/realtime/tts';
export const HAMSA_PRELOAD_URL = 'https://api.tryhamsa.com/v2/tts/voices/custom/preload';
export const HAMSA_VOICES_CATALOG_URL = 'https://api.tryhamsa.com/v2/tts/voices/catalog';

/**
 * The realtime stream is raw, HEADERLESS little-endian PCM. The HTTP endpoint
 * advertises `Content-Type: audio/wav` but its own documentation says you must
 * add the WAV header yourself, and Hamsa's LiveKit plugin decodes it as
 * `audio/pcm` at 16 kHz mono. We treat both transports as raw PCM16.
 *
 * This is excellent for latency: no MP3/Opus decode step is needed in the
 * browser, so bytes can go straight into an AudioWorklet ring buffer.
 */
export const HAMSA_PCM_SAMPLE_RATE_16K = 16_000;
export const HAMSA_PCM_SAMPLE_RATE_8K = 8_000;
export const HAMSA_MULAW_SAMPLE_RATE = 8_000;

export interface HamsaTtsPayload {
  text: string;
  /** Built-in voice NAME (e.g. "Amjad") or a cloned voice UUID. */
  speaker: string;
  dialect?: string;
  languageId?: string;
  mulaw?: boolean;
  /** PCM only; ignored/invalid when mulaw is true (mu-law is always 8 kHz). */
  sampleRate?: '8k' | '16k';
  /** 0 = flat, 1 = natural (default), 2 = highly expressive. */
  expressiveness?: number;
}

export interface HamsaTtsRequestFrame {
  type: 'tts';
  payload: HamsaTtsPayload;
  /**
   * The published AsyncAPI `required` array mistakenly lists these at the top
   * level as well as inside `payload`. We send them in both places, which
   * satisfies either interpretation and is harmless if the server ignores the
   * duplicates.
   */
  dialect?: string;
  languageId?: string;
  mulaw?: boolean;
}

export type HamsaServerFrameType = 'info' | 'ack' | 'end' | 'error' | 'response';

export interface HamsaServerFrame {
  type: HamsaServerFrameType;
  payload?: { message?: string; [k: string]: unknown };
}

/** Documented WebSocket close codes. */
export const HAMSA_CLOSE_CODES: Record<number, string> = {
  1000: 'Closed due to inactivity (60 minute timeout)',
  1001: 'Server shutting down',
  4001: 'Authentication failed - invalid or missing API key',
  4003: 'Insufficient funds - project wallet balance is depleted',
  4500: 'Internal authentication error',
};

/** Hamsa's documented hard limit on a single synthesis request. */
export const HAMSA_MAX_TEXT_CHARS = 2000;

/** A cloned voice is referenced by UUID; built-ins by name. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isClonedVoiceId = (speaker: string): boolean => UUID_RE.test(speaker.trim());

export interface HamsaVoiceCatalogEntry {
  id: string;
  name: string;
  language?: string;
  gender?: string | null;
}

export interface HamsaVoiceCatalogResponse {
  voices?: HamsaVoiceCatalogEntry[];
}
