/**
 * Voice Latency Lab -- server entry point.
 *
 * Responsibilities:
 *   - one WebSocket per browser session, carrying JSON control frames and
 *     binary audio frames in both directions
 *   - REST endpoints for the knowledge base, benchmarks, dashboard and export
 *   - process-wide provider credentials that never reach the client
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { mkdir } from 'node:fs/promises';
import type { WebSocket } from 'ws';
import { nowNs } from '@vll/telemetry';
import {
  AUDIO_DIR_DOWNLINK,
  AUDIO_PROTOCOL_VERSION,
  decodeAudioFrame,
  encodeAudioFrame,
  fnv1a,
  type ClientMessage,
} from '@vll/core';
import { KnowledgeBase, OpenAiEmbedder } from '@vll/rag';
import { EMBEDDING_MODEL, RETRIEVER_MODE, redact, secrets, serverConfig } from './env.js';
import { Session } from './session.js';
import { registerRoutes } from './routes/index.js';
import { setClip } from './clips.js';
import { flushConfig, loadPersistedConfig } from './configStore.js';

async function main(): Promise<void> {
  await Promise.all([
    mkdir(serverConfig.kbDir, { recursive: true }),
    mkdir(serverConfig.uploadsDir, { recursive: true }),
    mkdir(serverConfig.sessionsDir, { recursive: true }),
    loadPersistedConfig(),
    mkdir(serverConfig.exportsDir, { recursive: true }),
  ]);

  const app = Fastify({
    logger: {
      level: serverConfig.logLevel,
      // Every log line passes through the redactor so a provider error echoing
      // an Authorization header can never print a key.
      serializers: {
        err: (e) => redact({ type: e.name, message: e.message, stack: e.stack }) as any,
      },
    },
    // The pipeline never blocks on the HTTP layer, but keep bodies small anyway.
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 20 } });
  await app.register(websocket, {
    options: {
      maxPayload: 8 * 1024 * 1024,
      // Compression would add latency and CPU to every 20 ms audio frame.
      perMessageDeflate: false,
    },
  });

  /* -- knowledge base ---------------------------------------------------- */
  const s = secrets.get();
  const embedder =
    RETRIEVER_MODE !== 'bm25' && s.openaiApiKey
      ? new OpenAiEmbedder({ apiKey: s.openaiApiKey, model: EMBEDDING_MODEL })
      : null;

  const kb = new KnowledgeBase({
    dataDir: serverConfig.kbDir,
    embedder,
    mode: embedder ? RETRIEVER_MODE : 'bm25',
  });
  await kb.load();
  app.log.info(
    { documents: kb.documentCount, chunks: kb.chunkCount, retriever: kb.retrieverMode },
    'knowledge base loaded',
  );

  const sessions = new Map<string, Session>();

  /* -- realtime socket --------------------------------------------------- */
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const session = new Session(
      {
        sendJson: (msg) => {
          if (socket.readyState !== socket.OPEN) return;
          try {
            socket.send(JSON.stringify(msg));
          } catch {
            /* a dead socket must never surface into the pipeline */
          }
        },
        sendAudio: (chunk) => {
          if (socket.readyState !== socket.OPEN) return;
          // Binary frame with a fixed 24-byte header. No JSON, no base64.
          const frame = encodeAudioFrame(
            {
              version: AUDIO_PROTOCOL_VERSION,
              direction: AUDIO_DIR_DOWNLINK,
              flags: chunk.isFirst ? 1 : 0,
              generation: chunk.generation,
              phraseSeq: chunk.phraseSeq,
              audioSeq: chunk.audioSeq,
              turnIdHash: fnv1a(chunk.turnId),
            },
            chunk.data,
          );
          try {
            socket.send(frame, { binary: true });
          } catch {
            /* ignore */
          }
        },
      },
      kb,
    );

    sessions.set(session.id, session);
    app.log.info({ sessionId: session.id }, 'session opened');
    session.pushStatus();

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const frame = decodeAudioFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (frame) session.onMicAudio(frame.payload);
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      handleClientMessage(session, msg, app.log).catch((e) => {
        app.log.error({ err: e, type: (msg as any)?.type }, 'client message handler failed');
      });
    });

    socket.on('close', () => {
      app.log.info({ sessionId: session.id }, 'session closed');
      sessions.delete(session.id);
      void session.close();
    });

    socket.on('error', (e) => {
      app.log.warn({ err: e, sessionId: session.id }, 'socket error');
    });
  });

  await registerRoutes(app, { kb, sessions });

  await app.listen({ host: serverConfig.host, port: serverConfig.port });
  const p = secrets.presence();
  app.log.info(
    {
      url: `http://${serverConfig.host}:${serverConfig.port}`,
      credentials: p,
      retriever: kb.retrieverMode,
      speechmaticsRegion: serverConfig.speechmaticsRegion,
    },
    'voice latency lab server ready',
  );
  if (!p.openai || !p.speechmatics || !p.hamsa) {
    app.log.warn(
      'Missing provider credentials. Copy .env.example to .env and fill in the keys, or enter them temporarily in the UI.',
    );
  }
}

async function handleClientMessage(session: Session, msg: ClientMessage, log: { error: Function }): Promise<void> {
  switch (msg.type) {
    case 'hello':
      if (msg.config) session.applyConfig(msg.config);
      session.pushStatus();
      // Hand back the effective config. Without this a reconnecting browser had
      // no idea what the server was actually running and fell back to the
      // built-in defaults, which is what made saved settings look lost.
      session.send({ type: 'config.applied', config: session.activeConfig });
      break;

    case 'clock.ping':
      session.onClockPing(msg.id, msg.t0);
      break;

    case 'clock.sample':
      session.onClockSample(msg.t0, msg.t1, msg.t2);
      break;

    case 'config.update': {
      const applied = session.applyConfig(msg.config);
      // Echo the fully-resolved config so the UI shows clamped values.
      session.send({ type: 'config.applied', config: applied });
      break;
    }

    case 'session.warmup':
      await session.warmup();
      break;

    case 'session.reset':
      session.resetConversation();
      break;

    case 'mic.opened':
      session.onMicOpened(msg.sampleRate, msg.frameSamples);
      break;

    case 'mic.stats':
      session.onMicStats(msg.framesPerSec, msg.bytesPerSec, msg.rms, msg.peak);
      break;

    case 'vad.speech_started':
      session.onSpeechStarted(msg.tClient, msg.probability);
      break;

    case 'vad.speech_ended':
      session.onSpeechEnded(msg.tClient, msg.durationMs);
      break;

    case 'vad.endpoint':
      session.onEndpoint(msg.tClient, msg.speechEndClient, msg.delayMs, msg.silenceThresholdMs);
      break;

    case 'vad.barge_in':
      session.onBargeIn(msg.tClient);
      break;

    case 'audio.received':
      session.onAudioReceived(msg.tClient, msg.generation, msg.phraseSeq, msg.audioSeq, msg.bytes);
      break;

    case 'audio.playback_started':
      session.onPlaybackStarted(msg.tClient, msg.generation, msg.phraseSeq);
      break;

    case 'audio.playback_finished':
      session.onPlaybackFinished(msg.tClient, msg.generation);
      break;

    case 'audio.queue_depth':
      session.onQueueDepth(msg.ms, msg.frames);
      break;

    case 'audio.underrun':
      session.onUnderrun(msg.count, msg.durationMs);
      break;

    case 'turn.manual_endpoint':
      session.manualEndpoint();
      break;

    case 'ab.record_start':
      session.startRecording();
      break;

    case 'ab.record_stop': {
      const clip = session.stopRecording();
      setClip(session, clip);
      break;
    }

    default:
      break;
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', redact(e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exit(1);
});
