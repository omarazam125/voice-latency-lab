/**
 * Browser <-> server WebSocket protocol.
 *
 * Two channels share one socket:
 *
 *   TEXT frames   JSON control messages (this file).
 *   BINARY frames Audio, with a compact fixed-size header. Audio is NEVER
 *                 base64-encoded or wrapped in JSON: that would inflate every
 *                 frame by ~33%, add two serialisation passes per 20 ms of
 *                 speech, and is explicitly called out as an anti-pattern in
 *                 the specification.
 */

import type { DeepPartial, PipelineMode, SessionConfig } from './config.js';

/* ========================================================================== */
/* Binary audio framing                                                       */
/* ========================================================================== */

/**
 * Binary frame layout (little-endian), 24 bytes of header then raw PCM:
 *
 *   0  u32  magic  'VLLA' (0x414C4C56)
 *   4  u8   version
 *   5  u8   direction  0 = mic uplink, 1 = tts downlink
 *   6  u16  flags      bit0 = isFirstOfPhrase
 *   8  u32  generation
 *  12  u32  phraseSeq
 *  16  u32  audioSeq
 *  20  u32  turnIdHash  (fnv1a of the turn id; full id travels in JSON)
 *  24  ...  payload
 *
 * A fixed header keeps parsing to a handful of DataView reads with no
 * allocation, which matters at 50 frames/second in each direction.
 */
export const AUDIO_MAGIC = 0x414c4c56;
export const AUDIO_HEADER_BYTES = 24;
export const AUDIO_PROTOCOL_VERSION = 1;

export const AUDIO_DIR_UPLINK = 0;
export const AUDIO_DIR_DOWNLINK = 1;
export const AUDIO_FLAG_FIRST_OF_PHRASE = 1 << 0;

export interface AudioFrameHeader {
  version: number;
  direction: 0 | 1;
  flags: number;
  generation: number;
  phraseSeq: number;
  audioSeq: number;
  turnIdHash: number;
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function encodeAudioFrame(header: AudioFrameHeader, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_BYTES + payload.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, AUDIO_MAGIC, true);
  dv.setUint8(4, header.version);
  dv.setUint8(5, header.direction);
  dv.setUint16(6, header.flags, true);
  dv.setUint32(8, header.generation, true);
  dv.setUint32(12, header.phraseSeq, true);
  dv.setUint32(16, header.audioSeq, true);
  dv.setUint32(20, header.turnIdHash, true);
  out.set(payload, AUDIO_HEADER_BYTES);
  return out;
}

export function decodeAudioFrame(buf: Uint8Array): { header: AudioFrameHeader; payload: Uint8Array } | null {
  if (buf.byteLength < AUDIO_HEADER_BYTES) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== AUDIO_MAGIC) return null;
  return {
    header: {
      version: dv.getUint8(4),
      direction: dv.getUint8(5) as 0 | 1,
      flags: dv.getUint16(6, true),
      generation: dv.getUint32(8, true),
      phraseSeq: dv.getUint32(12, true),
      audioSeq: dv.getUint32(16, true),
      turnIdHash: dv.getUint32(20, true),
    },
    // Subarray, not slice: no copy on the hot path.
    payload: buf.subarray(AUDIO_HEADER_BYTES),
  };
}

/* ========================================================================== */
/* Control messages: browser -> server                                        */
/* ========================================================================== */

export type ClientMessage =
  | { type: 'hello'; clientInfo: { userAgent: string; sampleRate: number }; config?: DeepPartial<SessionConfig> }
  | { type: 'clock.ping'; id: number; t0: string }
  /**
   * The browser computes the round trip locally and reports the full triple, so
   * the SERVER can build its own offset estimate and convert browser-origin
   * timestamps into its own monotonic timebase.
   */
  | { type: 'clock.sample'; t0: string; t1: string; t2: string }
  | { type: 'config.update'; config: DeepPartial<SessionConfig> }
  | { type: 'session.warmup' }
  | { type: 'session.reset' }
  | { type: 'mic.opened'; sampleRate: number; frameSamples: number }
  | { type: 'mic.closed' }
  | { type: 'mic.stats'; framesPerSec: number; bytesPerSec: number; rms: number; peak: number }
  /** VAD runs in the browser next to the microphone; results stream up here. */
  | { type: 'vad.frame'; probability: number; rms: number; tClient: string }
  | { type: 'vad.speech_started'; tClient: string; probability: number }
  | { type: 'vad.speech_ended'; tClient: string; durationMs: number }
  | { type: 'vad.endpoint'; tClient: string; speechEndClient: string; delayMs: number; silenceThresholdMs: number }
  | { type: 'vad.barge_in'; tClient: string }
  /** Browser acknowledgement that audio actually reached it / was heard. */
  | { type: 'audio.received'; tClient: string; generation: number; phraseSeq: number; audioSeq: number; bytes: number }
  | { type: 'audio.playback_started'; tClient: string; generation: number; phraseSeq: number }
  | { type: 'audio.playback_finished'; tClient: string; generation: number }
  | { type: 'audio.queue_depth'; ms: number; frames: number }
  | { type: 'audio.underrun'; count: number; durationMs: number }
  | { type: 'turn.manual_endpoint' }
  | { type: 'bench.run'; benchmark: string; options?: Record<string, unknown> }
  | { type: 'ab.record_start' }
  | { type: 'ab.record_stop' }
  | { type: 'ab.run'; clipId?: string };

/* ========================================================================== */
/* Control messages: server -> browser                                        */
/* ========================================================================== */

export interface WarmupStep {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
  durationMs?: number;
  detail?: string;
}

export interface SessionStatus {
  sessionId: string;
  traceId: string;
  ready: boolean;
  mode: PipelineMode;
  steps: WarmupStep[];
  audioFormat: { sampleRate: number; channels: number; encoding: string };
  clock: { offsetMs: number; uncertaintyMs: number; minRttMs: number; samples: number } | null;
  providers: { stt: string; llm: string; tts: string; ttsTransport: string };
  rag: { ready: boolean; documents: number; chunks: number; retriever: string };
  /** Presence flags only. Credential VALUES are never sent to the browser. */
  secrets?: { openai: boolean; speechmatics: boolean; hamsa: boolean; hamsaSpeaker: boolean };
  /** Live Mode C endpointing snapshot; null in Modes A and B. */
  modeC?: unknown;
}

export type ServerMessage =
  | { type: 'session.status'; status: SessionStatus }
  | { type: 'clock.pong'; id: number; t0: string; t1: string }
  | { type: 'config.applied'; config: SessionConfig }
  /**
   * Verdict on a provisional barge-in.
   *
   * The browser detects a barge-in from ~80ms of acoustic energy, long before
   * any word exists, so it cannot tell an interruption from a backchannel. In
   * Mode C with a stopSpeaking plan it therefore DUCKS rather than cancels, and
   * waits for this message to say whether the caller actually meant to take the
   * turn. `interrupt: false` means "that was just 'مم', keep talking".
   */
  | {
      type: 'bargein.resolved';
      interrupt: boolean;
      reason: string;
      transcript: string;
      generation: number;
    }
  /** Batched telemetry for the live monitor. Never sent per-event. */
  | { type: 'telemetry.batch'; events: unknown[] }
  | { type: 'turn.metrics'; metrics: unknown }
  | { type: 'turn.transcript'; turnId: string; text: string; source: string; isFinal: boolean }
  | { type: 'turn.assistant_text'; turnId: string; text: string; partial: boolean }
  | { type: 'stt.partial'; text: string }
  | { type: 'stt.final'; text: string }
  | { type: 'audio.format'; sampleRate: number; channels: number; encoding: string; generation: number }
  | { type: 'audio.flush'; generation: number; reason: string }
  | { type: 'bench.result'; benchmark: string; result: unknown }
  | { type: 'bench.progress'; benchmark: string; step: string; detail?: unknown }
  | { type: 'ab.result'; result: unknown }
  | { type: 'ab.recording'; state: 'started' | 'stopped'; clipId?: string; durationMs?: number }
  | { type: 'debug.raw'; source: string; direction: 'in' | 'out'; payload: unknown; tServer: string }
  | { type: 'error'; scope: string; message: string; retryable?: boolean };
