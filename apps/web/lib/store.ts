'use client';

/**
 * Client session store.
 *
 * Owns the WebSocket, the capture pipeline, the player and all derived UI
 * state. Two performance rules shape the design:
 *
 *   1. Telemetry arrives in batches (the server flushes on a 40 ms timer) and is
 *      appended to a plain array held outside React. A version counter is what
 *      actually changes, so components re-render at most once per batch instead
 *      of once per event.
 *
 *   2. Audio never passes through React at all. Binary frames go straight from
 *      the socket to the player worklet.
 */

import { create } from 'zustand';
import {
  AUDIO_DIR_UPLINK,
  AUDIO_PROTOCOL_VERSION,
  decodeAudioFrame,
  encodeAudioFrame,
  fnv1a,
  type SessionConfig,
  type SessionStatus,
  type DeepPartial,
} from '@vll/core';
import { ClockSync, nowNs, NS_PER_MS } from './clock';
import { MicrophoneCapture, type CaptureStats } from './capture';
import { StreamingPlayer, type PlayerStats } from './player';
import { AmbienceEngine } from './ambience';
import { BackgroundAudioScheduler } from '@vll/core';
import type { VadEvent } from './vadTypes';

export interface WireEventLite {
  seq: number;
  turnId: string | null;
  pipelineMode: 'B' | 'C' | null;
  stage: string;
  event: string;
  timestampNs: string;
  timestampMs: number;
  elapsedFromSpeechEndMs: number | null;
  elapsedFromEndpointMs: number | null;
  clientOriginated?: boolean;
  metadata: Record<string, any>;
}

export interface DebugEntry {
  id: number;
  atMs: number;
  source: string;
  direction: 'in' | 'out';
  payload: unknown;
}

export interface LaneState {
  status: string;
  detail?: string;
  atMs?: number | null;
  tone?: 'idle' | 'active' | 'ok' | 'warn' | 'error';
}

const SERVER_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://127.0.0.1:8787')
    : 'http://127.0.0.1:8787';

const MAX_EVENTS = 20_000;
const MAX_DEBUG = 800;

/* -------------------------------------------------------------------------- */
/* Non-reactive buffers                                                        */
/* -------------------------------------------------------------------------- */

export const eventBuffer: WireEventLite[] = [];
export const debugBuffer: DebugEntry[] = [];
let debugId = 0;

export interface TurnMetricsLite {
  turnId: string;
  pipelineMode: 'B' | 'C' | null;
  ttfsMs: number | null;
  trueE2EFromPhysicalSpeechEndMs: number | null;
  endpointDetectionDelayMs: number | null;
  llmTtftMs: number | null;
  llmToTtsBufferDelayMs: number | null;
  ttsTtfaMs: number | null;
  ragLatencyMs: number | null;
  audioDeliveryLatencyMs: number | null;
  bottleneck: string | null;
  bottleneckMs: number | null;
  criticalPath: Array<{ key: string; label: string; stage: string; durationMs: number; hidden: boolean; missing: boolean; note?: string }>;
  spans: Array<{ key: string; label: string; stage: string; startMs: number; endMs: number; durationMs: number; children?: any[]; metadata?: any }>;
  [k: string]: any;
}

/* -------------------------------------------------------------------------- */

interface AppState {
  /* connection */
  connected: boolean;
  connecting: boolean;
  status: SessionStatus | null;
  config: SessionConfig | null;
  error: string | null;

  /* live */
  micOn: boolean;
  micStats: CaptureStats | null;
  playerStats: PlayerStats | null;
  partial: string;
  finalText: string;
  assistantText: string;
  lanes: Record<string, LaneState>;
  clock: { offsetMs: number; uncertaintyMs: number; minRttMs: number; samples: number } | null;

  /* data */
  eventVersion: number;
  debugVersion: number;
  turns: TurnMetricsLite[];
  currentTurnId: string | null;
  recording: boolean;
  clipDurationMs: number | null;

  /* results */
  benchResults: Record<string, any>;
  benchProgress: string | null;
  compareResult: any | null;

  /* actions */
  connect: () => void;
  disconnect: () => void;
  warmup: () => void;
  updateConfig: (patch: DeepPartial<SessionConfig>) => void;
  startMic: () => Promise<void>;
  stopMic: () => Promise<void>;
  manualEndpoint: () => void;
  resetConversation: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  clearEvents: () => void;
  send: (msg: unknown) => void;
}

let ws: WebSocket | null = null;
let capture: MicrophoneCapture | null = null;
let player: StreamingPlayer | null = null;

/* -- provisional barge-in ------------------------------------------------- */
/** How far to duck while the server decides. Audible, but still recoverable. */
const DUCK_LEVEL = 0.18;
/**
 * Longest the agent may keep talking while a verdict is pending. Speechmatics
 * documents a 0.7s floor on its final transcript, so anything under ~800ms
 * would time out before a decision could physically arrive.
 */
const BARGE_VERDICT_TIMEOUT_MS = 1100;
let pendingBargeIn: { generation: number; atMs: number } | null = null;
let bargeTimer: ReturnType<typeof setTimeout> | null = null;

/* -- Mode C background audio ---------------------------------------------- */
/**
 * Rendering + scheduling for ambience, keyboard and hesitation sounds.
 *
 * Held at module scope alongside the player because they share its
 * AudioContext. Everything here is perceptual: none of it is ever reported as
 * `tts.first_audio`, and none of it enters the TTFS critical path.
 */
let ambience: AmbienceEngine | null = null;
let bgScheduler: BackgroundAudioScheduler | null = null;
let bgTimer: ReturnType<typeof setInterval> | null = null;
const bg = {
  callerSpeaking: false,
  agentSpeaking: false,
  working: false,
  workingSinceMs: 0,
  callerSinceMs: 0,
  turnIndex: 0,
};

/** performance.now() — monotonic, never a wall clock. */
const bgNow = () => (typeof performance !== 'undefined' ? performance.now() : 0);

function bgApply(cues: ReturnType<BackgroundAudioScheduler['evaluate']>): void {
  if (!ambience) return;
  for (const c of cues) ambience.apply(c);
}

/**
 * Sampled at 60 ms: fast enough that a keyboard threshold of 350 ms is honoured
 * to within a fifth of its value, cheap enough to be irrelevant next to the
 * audio callback. The scheduler is idempotent, so an extra tick emits nothing.
 */
function bgTick(): void {
  if (!bgScheduler || !ambience) return;
  const now = bgNow();
  bgApply(
    bgScheduler.evaluate({
      nowMs: now,
      callerSpeaking: bg.callerSpeaking,
      agentSpeaking: bg.agentSpeaking,
      working: bg.working,
      workingForMs: bg.working ? now - bg.workingSinceMs : 0,
      callerSpeakingForMs: bg.callerSpeaking ? now - bg.callerSinceMs : 0,
      turnIndex: bg.turnIndex,
    }),
  );
}

/** Real answer audio is audible: every perceptual sound stops at once. */
function bgOnRealAudio(): void {
  bg.agentSpeaking = true;
  bg.working = false;
  if (bgScheduler) bgApply(bgScheduler.onRealAudio());
}

/**
 * Bring up ambience for Mode C.
 *
 * Fillers are fetched here, at mic start, rather than on first use: the whole
 * point of a hesitation sound is that it is already in memory when the wait
 * begins. A failure to fetch them is not fatal — the bed and keyboard need no
 * assets, and a missing filler degrades to the silence we had before.
 */
async function startBackgroundAudio(get: () => AppState, set: (p: any) => void): Promise<void> {
  const cfg = get().config;
  const bgCfg = cfg?.modeC?.backgroundAudio;
  const ctx = player?.audioContext;
  if (!bgCfg || !ctx) return;

  // Mode C only. In A and B the pipeline must be heard exactly as it performs.
  if (get().status?.mode !== 'C' || !bgCfg.enabled) return;

  ambience = new AmbienceEngine(ctx, {
    onError: (m) => set({ error: m }),
  });
  bgScheduler = new BackgroundAudioScheduler(bgCfg);
  Object.assign(bg, {
    callerSpeaking: false,
    agentSpeaking: false,
    working: false,
    workingSinceMs: 0,
    callerSinceMs: 0,
    turnIndex: 0,
  });

  await ambience.prepare(bgCfg.bed.source, bgCfg.bed.url);

  // START TICKING NOW.
  //
  // bgTick is the only thing that ever calls the scheduler, so nothing at all
  // is audible until this interval exists. It used to sit after the filler
  // fetch below, which meant the bed and the keyboard - neither of which needs
  // any asset or any network - stayed silent for however long Hamsa took to
  // synthesise seven phrases serially, and forever if that request hung.
  if (bgTimer) clearInterval(bgTimer);
  bgTimer = setInterval(bgTick, 60);

  if (bgCfg.filler.enabled || bgCfg.backchannel.enabled) {
    // Detached: the hesitation sounds arrive when they arrive. The scheduler is
    // idempotent, setFillerSample installs them late without disturbing
    // anything, and playSample already skips a phrase that has not landed yet.
    void (async () => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const res = await fetch(`${serverUrl()}/api/modec/fillers/render`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: get().status?.sessionId }),
          signal: ctrl.signal,
        });
        const data = await res.json();
        // The engine may have been torn down while this was in flight.
        if (!ambience) return;
        for (const f of data.fillers ?? []) {
          const bytes = Uint8Array.from(atob(f.pcmBase64), (c) => c.charCodeAt(0));
          ambience.setFillerSample(
            f.phrase,
            new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
            f.sampleRate,
          );
        }
        if (data.failed?.length) {
          set({ error: `Some hesitation sounds could not be rendered: ${data.failed.map((x: any) => x.phrase).join(', ')}` });
        }
      } catch {
        // Non-fatal by design: the bed and keyboard are already playing.
      } finally {
        clearTimeout(timeout);
      }
    })();
  }
}

/**
 * Reconcile the running ambience with the current mode and settings.
 *
 * Called whenever the mode or config changes, so the toggle behaves like a
 * switch rather than like something that needs a mic restart to apply.
 */
async function syncBackgroundAudio(get: () => AppState, set: (p: any) => void): Promise<void> {
  const wanted = get().status?.mode === 'C' && !!get().config?.modeC?.backgroundAudio?.enabled && !!player;
  if (wanted && !ambience) {
    await startBackgroundAudio(get, set);
    return;
  }
  if (!wanted && ambience) {
    stopBackgroundAudio();
    return;
  }
  // Already running: push the new numbers into the live scheduler so a gain or
  // threshold edit is audible immediately.
  const cfg = get().config?.modeC?.backgroundAudio;
  if (ambience && bgScheduler && cfg) bgScheduler.update(cfg);
}

function stopBackgroundAudio(): void {
  if (bgTimer) {
    clearInterval(bgTimer);
    bgTimer = null;
  }
  ambience?.dispose();
  ambience = null;
  bgScheduler = null;
}

export function getAmbience(): AmbienceEngine | null {
  return ambience;
}
const clockSync = new ClockSync();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let pendingSpeechEndNs: bigint | null = null;
let currentGeneration = 0;

const INITIAL_LANES: Record<string, LaneState> = {
  mic: { status: 'Idle', tone: 'idle' },
  vad: { status: 'Idle', tone: 'idle' },
  stt: { status: 'Not connected', tone: 'idle' },
  rag: { status: 'Idle', tone: 'idle' },
  llm: { status: 'Idle', tone: 'idle' },
  chunker: { status: 'Idle', tone: 'idle' },
  tts: { status: 'Not connected', tone: 'idle' },
  audio: { status: 'Idle', tone: 'idle' },
};

export const useStore = create<AppState>((set, get) => ({
  connected: false,
  connecting: false,
  status: null,
  config: null,
  error: null,

  micOn: false,
  micStats: null,
  playerStats: null,
  partial: '',
  finalText: '',
  assistantText: '',
  lanes: { ...INITIAL_LANES },
  clock: null,

  eventVersion: 0,
  debugVersion: 0,
  turns: [],
  currentTurnId: null,
  recording: false,
  clipDurationMs: null,

  benchResults: {},
  benchProgress: null,
  compareResult: null,

  send: (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  },

  connect: () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    set({ connecting: true, error: null });

    const url = SERVER_URL.replace(/^http/, 'ws') + '/ws';
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      set({ connected: true, connecting: false, error: null });
      get().send({
        type: 'hello',
        clientInfo: { userAgent: navigator.userAgent, sampleRate: 16000 },
      });
      startClockSync(get);
    };

    ws.onclose = () => {
      set({ connected: false, connecting: false, lanes: { ...INITIAL_LANES } });
      if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    };

    ws.onerror = () => set({ error: `Cannot reach the server at ${SERVER_URL}. Is it running?`, connecting: false });

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handleBinary(ev.data, get);
        return;
      }
      try {
        handleJson(JSON.parse(ev.data as string), set, get);
      } catch {
        /* ignore malformed frame */
      }
    };
  },

  disconnect: () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    set({ connected: false });
  },

  warmup: () => get().send({ type: 'session.warmup' }),

  updateConfig: (patch) => {
    get().send({ type: 'config.update', config: patch });
    // Apply locally where the browser owns the behaviour, so tuning is instant.
    const cfg = get().config;
    if (cfg) {
      const v = (patch as any).vad;
      if (v) capture?.updateTuning(v);
      // Jitter buffer: Mode C's transport value wins while Mode C is active, so
      // editing either control does the expected thing instead of one silently
      // clobbering the other.
      const inModeC = get().status?.mode === 'C';
      const modeCJitter = (patch as any).modeC?.transport?.jitterBufferMs;
      const audioJitter = (patch as any).audio?.jitterBufferMs;
      if (inModeC && modeCJitter != null) {
        player?.configure({ jitterMs: modeCJitter });
      } else if (audioJitter != null && !(inModeC && cfg.modeC?.transport?.jitterBufferMs != null)) {
        player?.configure({ jitterMs: audioJitter });
      }
    }
  },

  startMic: async () => {
    if (capture?.active) return;
    const cfg = get().config;
    try {
      player = new StreamingPlayer(
        {
          // Mode C carries its own jitter target, and it must win when Mode C
          // is the mode being measured -- otherwise the Mode C transport
          // setting is inert and the lab silently benchmarks the shared value.
          jitterMs:
            (get().status?.mode === 'C' ? cfg?.modeC?.transport?.jitterBufferMs : null) ??
            cfg?.audio.jitterBufferMs ??
            80,
          maxQueueMs: cfg?.audio.maxQueueMs ?? 6000,
          sourceRate: get().status?.audioFormat.sampleRate ?? 16000,
        },
        {
          onPlaybackStarted: (info) => {
            get().send({
              type: 'audio.playback_started',
              tClient: info.atNs.toString(),
              generation: info.generation,
              phraseSeq: info.phraseSeq,
            });
            capture?.setAssistantSpeaking(true);
            bgOnRealAudio();
            set((s) => ({
              lanes: {
                ...s.lanes,
                audio: { status: 'USER HEARS AI', detail: `buffered ${Math.round(info.bufferedMs)} ms`, tone: 'ok' },
              },
            }));
          },
          onPlaybackFinished: (info) => {
            get().send({ type: 'audio.playback_finished', tClient: info.atNs.toString(), generation: info.generation });
            capture?.setAssistantSpeaking(false);
            bg.agentSpeaking = false;
            set((s) => ({ lanes: { ...s.lanes, audio: { status: 'Playback finished', tone: 'idle' } } }));
          },
          onStats: (s) => {
            set({ playerStats: s });
            get().send({ type: 'audio.queue_depth', ms: s.bufferedMs, frames: s.frames });
          },
          onUnderrun: (i) => get().send({ type: 'audio.underrun', count: i.count, durationMs: i.durationMs }),
          onError: (m) => set({ error: m }),
        },
      );
      await player.start();
      await startBackgroundAudio(get, set);

      capture = new MicrophoneCapture(
        {
          frameMs: cfg?.audio.micFrameMs ?? 20,
          tuning: {
            silenceThresholdMs: cfg?.vad.silenceThresholdMs ?? 350,
            positiveSpeechThreshold: cfg?.vad.positiveSpeechThreshold ?? 0.5,
            negativeSpeechThreshold: cfg?.vad.negativeSpeechThreshold ?? 0.35,
            minSpeechFrames: cfg?.vad.minSpeechFrames ?? 3,
            bargeInSpeechFrames: cfg?.vad.bargeInSpeechFrames ?? 4,
            bargeInEnabled: cfg?.vad.bargeInEnabled ?? true,
          },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          preferSilero: true,
        },
        {
          onAudioFrame: (pcm) => sendAudioFrame(pcm),
          onVadEvent: (e) => handleVadEvent(e, get, set),
          onStats: (s) => {
            set({ micStats: s });
            get().send({
              type: 'mic.stats',
              framesPerSec: s.framesPerSec,
              bytesPerSec: s.bytesPerSec,
              rms: s.rms,
              peak: s.peak,
            });
            set((st) => ({
              lanes: {
                ...st.lanes,
                mic: {
                  status: 'Streaming PCM',
                  detail: `frame #${s.frameCount} · ${s.framesPerSec}/s · ${(s.bytesPerSec / 1024).toFixed(1)} KB/s`,
                  tone: 'active',
                },
                vad: {
                  status: s.isSpeech ? 'SPEECH' : 'silence',
                  detail: `p=${s.probability.toFixed(2)} rms=${s.rms.toFixed(3)}${s.silenceMs > 0 ? ` · silence ${Math.round(s.silenceMs)} ms` : ''} · ${s.vadModel}`,
                  tone: s.isSpeech ? 'active' : 'idle',
                },
              },
            }));
          },
          onError: (m) => set({ error: m }),
        },
      );
      await capture.start();

      get().send({ type: 'mic.opened', sampleRate: 16000, frameSamples: Math.round(((cfg?.audio.micFrameMs ?? 20) / 1000) * 16000) });
      set({ micOn: true, error: null });
    } catch (e: any) {
      set({ error: `Microphone error: ${e?.message ?? e}`, micOn: false });
    }
  },

  stopMic: async () => {
    stopBackgroundAudio();
    await capture?.stop();
    await player?.stop();
    capture = null;
    player = null;
    get().send({ type: 'mic.closed' });
    set({ micOn: false, micStats: null, playerStats: null, lanes: { ...INITIAL_LANES } });
  },

  manualEndpoint: () => get().send({ type: 'turn.manual_endpoint' }),

  resetConversation: () => {
    get().send({ type: 'session.reset' });
    set({ partial: '', finalText: '', assistantText: '' });
  },

  startRecording: () => {
    get().send({ type: 'ab.record_start' });
    set({ recording: true });
  },

  stopRecording: () => {
    get().send({ type: 'ab.record_stop' });
    set({ recording: false });
  },

  clearEvents: () => {
    eventBuffer.length = 0;
    debugBuffer.length = 0;
    set((s) => ({ eventVersion: s.eventVersion + 1, debugVersion: s.debugVersion + 1, turns: [] }));
  },
}));

/* -------------------------------------------------------------------------- */
/* Wire handling                                                               */
/* -------------------------------------------------------------------------- */

function sendAudioFrame(pcm: Int16Array): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Binary frame with a fixed header. No JSON, no base64: at 50 frames per
  // second in each direction, that overhead would be self-inflicted latency.
  const frame = encodeAudioFrame(
    {
      version: AUDIO_PROTOCOL_VERSION,
      direction: AUDIO_DIR_UPLINK,
      flags: 0,
      generation: currentGeneration,
      phraseSeq: 0,
      audioSeq: 0,
      turnIdHash: 0,
    },
    new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
  );
  ws.send(frame);
}

function handleBinary(data: ArrayBuffer, get: () => AppState): void {
  const decoded = decodeAudioFrame(new Uint8Array(data));
  if (!decoded) return;
  const { header, payload } = decoded;

  // Acknowledge arrival so the server can measure real transport latency.
  get().send({
    type: 'audio.received',
    tClient: nowNs().toString(),
    generation: header.generation,
    phraseSeq: header.phraseSeq,
    audioSeq: header.audioSeq,
    bytes: payload.byteLength,
  });

  // Copy out of the socket frame so the buffer can be transferred to the worklet.
  const copy = payload.slice().buffer;
  player?.push(copy, header.generation, header.phraseSeq, header.audioSeq);
}

function handleVadEvent(e: VadEvent, get: () => AppState, set: (p: any) => void): void {
  const send = get().send;
  const toNs = (ms: number) => BigInt(Math.round(ms * NS_PER_MS)).toString();

  switch (e.type) {
    case 'speech_started':
      bg.callerSpeaking = true;
      bg.callerSinceMs = bgNow();
      // The caller talking over the agent is a barge-in: perceptual sound must
      // go immediately, or it competes with the caller's own voice in the mic.
      if (bg.agentSpeaking && bgScheduler) bgApply(bgScheduler.onBargeIn());
      send({ type: 'vad.speech_started', tClient: toNs(e.atMs), probability: e.probability });
      set((s: AppState) => ({
        lanes: { ...s.lanes, vad: { status: 'SPEECH STARTED', tone: 'active' } },
        assistantText: '',
      }));
      break;

    case 'speech_ended':
      bg.callerSpeaking = false;
      pendingSpeechEndNs = BigInt(Math.round(e.atMs * NS_PER_MS));
      send({ type: 'vad.speech_ended', tClient: toNs(e.atMs), durationMs: e.durationMs });
      set((s: AppState) => ({
        lanes: {
          ...s.lanes,
          vad: { status: 'User actually stopped talking', detail: `spoke for ${Math.round(e.durationMs)} ms`, tone: 'warn' },
        },
      }));
      break;

    case 'endpoint': {
      // From here until the first real audio byte there is nothing to hear.
      // That gap is exactly what the keyboard and the bed exist to cover.
      bg.working = true;
      bg.workingSinceMs = bgNow();
      bg.turnIndex++;
      const cfg = get().config;
      send({
        type: 'vad.endpoint',
        tClient: toNs(e.atMs),
        speechEndClient: toNs(e.speechEndedAtMs),
        delayMs: e.delayMs,
        silenceThresholdMs: cfg?.vad.silenceThresholdMs ?? 350,
      });
      set((s: AppState) => ({
        lanes: {
          ...s.lanes,
          vad: {
            status: 'SYSTEM decided user stopped',
            detail: `endpoint delay ${Math.round(e.delayMs)} ms`,
            tone: 'ok',
          },
        },
      }));
      break;
    }

    case 'barge_in': {
      send({ type: 'vad.barge_in', tClient: toNs(e.atMs) });

      // A barge-in is detected from roughly 80 ms of acoustic energy, which is
      // far too early for any word to have been transcribed. So there are two
      // possible responses, and which one is right depends on configuration:
      //
      //   CANCEL (modes A and B, and Mode C with no stopSpeaking plan)
      //     Kill the audio locally and immediately. Correct when every
      //     interruption is meant as one, and it costs no round trip.
      //
      //   DUCK (Mode C with a stopSpeaking plan)
      //     Drop the volume so the caller hears instantly that they were
      //     noticed, but KEEP the queue, because a lone "مم" is a backchannel
      //     and the agent should carry on. The server decides once it has
      //     words, and answers with bargein.resolved. Flushing here would make
      //     resuming impossible, since discarded audio cannot be recovered.
      const st = get();
      const classify = st.status?.mode === 'C' && st.config?.modeC?.stopSpeaking?.enabled === true;

      if (!classify) {
        currentGeneration += 1;
        player?.flush(currentGeneration);
        set((s: AppState) => ({
          lanes: {
            ...s.lanes,
            vad: { status: 'BARGE-IN DETECTED', tone: 'warn' },
            audio: { status: 'Flushed (barge-in)', tone: 'warn' },
          },
        }));
        break;
      }

      pendingBargeIn = { generation: currentGeneration, atMs: e.atMs };
      player?.duck(DUCK_LEVEL);
      set((s: AppState) => ({
        lanes: {
          ...s.lanes,
          vad: { status: 'BARGE-IN? (classifying)', tone: 'warn' },
          audio: { status: 'Ducked, awaiting verdict', tone: 'warn' },
        },
      }));

      // Safety net: if the verdict never arrives, treat it as a real
      // interruption. Talking over a caller who genuinely wants the turn is a
      // far worse failure than cutting off one who did not.
      if (bargeTimer) clearTimeout(bargeTimer);
      bargeTimer = setTimeout(() => {
        bargeTimer = null;
        if (!pendingBargeIn) return;
        pendingBargeIn = null;
        currentGeneration += 1;
        player?.flush(currentGeneration);
        player?.duck(1, 0);
        set((s: AppState) => ({
          lanes: {
            ...s.lanes,
            audio: { status: 'Flushed (no verdict in time)', tone: 'warn' },
          },
        }));
      }, BARGE_VERDICT_TIMEOUT_MS);
      break;
    }
  }
}

function handleJson(msg: any, set: (p: any) => void, get: () => AppState): void {
  switch (msg.type) {
    case 'session.status':
      set({ status: msg.status });
      if (msg.status?.clock) set({ clock: msg.status.clock });
      applyStatusLanes(msg.status, set);
      // Switching into or out of Mode C mid-session must take effect now,
      // not at the next mic restart.
      void syncBackgroundAudio(get, set);
      break;

    case 'config.applied':
      set({ config: msg.config });
      void syncBackgroundAudio(get, set);
      break;

    case 'bargein.resolved': {
      if (bargeTimer) {
        clearTimeout(bargeTimer);
        bargeTimer = null;
      }
      // A verdict for a barge-in we already resolved (or never had) is stale.
      if (!pendingBargeIn) break;
      pendingBargeIn = null;

      if (msg.interrupt) {
        currentGeneration += 1;
        player?.flush(currentGeneration);
        player?.duck(1, 0);
        set((s: AppState) => ({
          lanes: {
            ...s.lanes,
            vad: { status: 'BARGE-IN CONFIRMED', tone: 'warn' },
            audio: { status: `Flushed (${msg.reason})`, tone: 'warn' },
          },
        }));
      } else {
        // Backchannel: bring the voice back up and keep going.
        player?.duck(1, 140);
        set((s: AppState) => ({
          lanes: {
            ...s.lanes,
            vad: { status: `Backchannel ignored: "${msg.transcript}"`, tone: 'ok' },
            audio: { status: 'Resumed', tone: 'ok' },
          },
        }));
      }
      break;
    }

    case 'clock.pong': {
      const sample = clockSync.handlePong(msg.id, msg.t0, msg.t1);
      if (sample) {
        get().send({ type: 'clock.sample', ...sample });
        const est = clockSync.get();
        if (est) {
          set({
            clock: {
              offsetMs: Number(est.offsetNs) / NS_PER_MS,
              uncertaintyMs: est.uncertaintyMs,
              minRttMs: est.minRttMs,
              samples: est.samples,
            },
          });
        }
      }
      break;
    }

    case 'telemetry.batch': {
      for (const e of msg.events as WireEventLite[]) {
        eventBuffer.push(e);
        applyEventToLanes(e, set, get);
      }
      if (eventBuffer.length > MAX_EVENTS) eventBuffer.splice(0, eventBuffer.length - MAX_EVENTS);
      set((s: AppState) => ({ eventVersion: s.eventVersion + 1 }));
      break;
    }

    case 'turn.metrics':
      set((s: AppState) => ({ turns: [...s.turns, msg.metrics].slice(-200) }));
      break;

    case 'stt.partial':
      set({ partial: msg.text });
      break;

    case 'stt.final':
      set({ finalText: msg.text, partial: '' });
      break;

    case 'turn.assistant_text':
      set({ assistantText: msg.text });
      break;

    case 'audio.format':
      currentGeneration = msg.generation;
      player?.configure({ sourceRate: msg.sampleRate });
      player?.setGeneration(msg.generation);
      break;

    case 'audio.flush':
      currentGeneration = msg.generation;
      player?.flush(msg.generation);
      break;

    case 'debug.raw':
      debugBuffer.push({
        id: ++debugId,
        atMs: performance.now(),
        source: msg.source,
        direction: msg.direction,
        payload: msg.payload,
      });
      if (debugBuffer.length > MAX_DEBUG) debugBuffer.splice(0, debugBuffer.length - MAX_DEBUG);
      set((s: AppState) => ({ debugVersion: s.debugVersion + 1 }));
      break;

    case 'bench.progress':
      set({ benchProgress: `${msg.benchmark}: ${msg.step}` });
      break;

    case 'bench.result':
      set((s: AppState) => ({ benchResults: { ...s.benchResults, [msg.benchmark]: msg.result }, benchProgress: null }));
      break;

    case 'ab.result':
      set({ compareResult: msg.result, benchProgress: null });
      break;

    case 'ab.recording':
      set({ recording: msg.state === 'started', clipDurationMs: msg.durationMs ?? get().clipDurationMs });
      break;

    case 'error':
      set({ error: `${msg.scope}: ${msg.message}` });
      break;

    default:
      break;
  }
}

function applyStatusLanes(status: SessionStatus, set: (p: any) => void): void {
  const step = (k: string) => status.steps?.find((s) => s.key === k);
  set((s: AppState) => ({
    lanes: {
      ...s.lanes,
      stt: laneFromStep(step('stt'), 'Speechmatics'),
      tts: laneFromStep(step('tts'), 'Hamsa'),
      rag: laneFromStep(step('rag'), 'Knowledge base'),
      llm: laneFromStep(step('llm'), 'OpenAI'),
    },
  }));
}

function laneFromStep(step: any, label: string): LaneState {
  if (!step) return { status: 'Idle', tone: 'idle' };
  const tone = step.state === 'ready' ? 'ok' : step.state === 'failed' ? 'error' : step.state === 'running' ? 'active' : 'idle';
  const status =
    step.state === 'ready'
      ? `${label} ready`
      : step.state === 'failed'
        ? `${label} failed`
        : step.state === 'running'
          ? `${label} connecting...`
          : step.state === 'skipped'
            ? `${label} skipped`
            : 'Idle';
  return { status, detail: step.detail, tone: tone as LaneState['tone'] };
}

/** Translate telemetry into the live lane cards on the monitor page. */
function applyEventToLanes(e: WireEventLite, set: (p: any) => void, get: () => AppState): void {
  const m = e.metadata ?? {};
  const at = e.elapsedFromSpeechEndMs;
  const patch = (lane: string, value: LaneState) =>
    set((s: AppState) => ({ lanes: { ...s.lanes, [lane]: { ...value, atMs: at } } }));

  switch (e.event) {
    case 'turn.started':
      set({ currentTurnId: e.turnId });
      break;
    case 'stt.first_partial':
    case 'stt.partial':
      patch('stt', { status: 'Partial', detail: String(m.text ?? ''), tone: 'active' });
      break;
    case 'stt.final':
      if (!m.late) patch('stt', { status: 'Final', detail: String(m.text ?? ''), tone: 'ok' });
      break;
    case 'stt.usable_transcript':
      patch('stt', {
        status: `Usable transcript (${m.source})`,
        detail: String(m.text ?? ''),
        tone: m.provisional ? 'warn' : 'ok',
      });
      break;
    case 'rag.prefetch_started':
      patch('rag', { status: 'Speculative retrieval...', detail: String(m.query ?? ''), tone: 'active' });
      break;
    case 'rag.started':
      patch('rag', { status: 'Searching...', detail: String(m.query ?? ''), tone: 'active' });
      break;
    case 'rag.prefetch_hit':
      patch('rag', { status: 'PREFETCH HIT', detail: `saved ${Math.round(Number(m.savedMs) || 0)} ms of critical path`, tone: 'ok' });
      break;
    case 'rag.completed':
      patch('rag', {
        status: `Top ${m.chunks} results ready`,
        detail: `${Math.round(Number(m.durationMs) || 0)} ms${m.prefetched ? ' (prefetched)' : ''}`,
        tone: 'ok',
      });
      break;
    case 'rag.skipped':
      patch('rag', { status: 'Skipped', detail: String(m.reason ?? ''), tone: 'idle' });
      break;
    case 'llm.request_started':
      patch('llm', { status: 'Request sent', detail: String(m.model ?? ''), tone: 'active' });
      break;
    case 'llm.first_delta':
      patch('llm', { status: 'First token received', detail: `TTFT ${Math.round(Number(m.ttftMs) || 0)} ms`, tone: 'ok' });
      set((s: AppState) => ({ assistantText: s.assistantText + String(m.delta ?? '') }));
      break;
    case 'llm.delta':
      if (m.delta && !m.silent) set((s: AppState) => ({ assistantText: s.assistantText + String(m.delta) }));
      break;
    case 'llm.completed':
      patch('llm', { status: 'Completed', detail: `${m.chars} chars in ${Math.round(Number(m.totalMs) || 0)} ms`, tone: 'ok' });
      break;
    case 'chunker.first_phrase_ready':
      patch('chunker', {
        status: 'Chunk #1 ready',
        detail: `"${m.text}" · ${Math.round(Number(m.sinceFirstDeltaMs) || 0)} ms after first token (${m.reason})`,
        tone: 'ok',
      });
      break;
    case 'chunker.phrase_ready':
      patch('chunker', { status: `Chunk #${m.phraseSeq} ready`, detail: `"${m.text}" (${m.reason})`, tone: 'active' });
      break;
    case 'tts.request_started':
      patch('tts', { status: `TTS request #${m.phraseSeq} sent`, detail: String(m.text ?? ''), tone: 'active' });
      break;
    case 'tts.first_audio':
      patch('tts', { status: 'First audio received', detail: `phrase #${m.phraseSeq} · ${m.bytes} bytes`, tone: 'ok' });
      break;
    case 'audio.first_sent':
      patch('audio', { status: 'First audio sent to browser', tone: 'active' });
      break;
    case 'vad.barge_in_detected':
      patch('vad', { status: 'BARGE-IN DETECTED', tone: 'warn' });
      break;
    case 'turn.completed':
      set({ currentTurnId: null });
      break;
    default:
      break;
  }
}

function startClockSync(get: () => AppState): void {
  if (clockTimer) clearInterval(clockTimer);
  const ping = () => get().send({ type: 'clock.ping', ...clockSync.createPing() });
  // A quick burst to converge, then a slow trickle to track drift.
  let burst = 0;
  const fast = setInterval(() => {
    ping();
    if (++burst >= 12) {
      clearInterval(fast);
      clockTimer = setInterval(ping, 15_000);
    }
  }, 120);
}

export function getPlayer(): StreamingPlayer | null {
  return player;
}
export function getCapture(): MicrophoneCapture | null {
  return capture;
}
export function serverUrl(): string {
  return SERVER_URL;
}
