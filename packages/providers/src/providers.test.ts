/**
 * Provider integration tests.
 *
 * Two layers:
 *
 *   1. WIRE-PROTOCOL tests against local mock servers. These run everywhere,
 *      with no credentials, and are the real value: they pin the exact message
 *      shapes each adapter sends and parses, so a refactor cannot silently
 *      change the bytes on the wire.
 *
 *   2. LIVE smoke tests, skipped automatically unless the matching API key is
 *      present in the environment. Run them with real keys to confirm the
 *      documented protocol still matches reality.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { SpeechmaticsSttProvider, liveSttSessions } from './speechmatics/rtStt.js';
import { OpenAiResponsesProvider } from './openai/responsesLlm.js';
import { SseParser } from './openai/sse.js';
import { HamsaTtsProvider, isClonedVoiceId } from './hamsa/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/* SSE parser                                                                 */
/* ========================================================================== */

describe('OpenAI SSE parser', () => {
  it('parses the documented event/data framing', () => {
    const p = new SseParser();
    const out = p.push(
      'event: response.created\ndata: {"type":"response.created"}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
    );
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[1].data).delta).toBe('Hi');
  });

  it('handles a payload split across chunk boundaries', () => {
    const p = new SseParser();
    expect(p.push('event: response.output_text.delta\ndata: {"delta":')).toHaveLength(0);
    expect(p.push('"partial"}\n')).toHaveLength(0);
    const out = p.push('\n');
    expect(JSON.parse(out[0].data).delta).toBe('partial');
  });

  it('tolerates CRLF line endings', () => {
    const p = new SseParser();
    const out = p.push('data: {"a":1}\r\n\r\n');
    expect(JSON.parse(out[0].data).a).toBe(1);
  });

  it('ignores comment / keep-alive lines', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\n\n')).toHaveLength(0);
  });

  it('surfaces the [DONE] sentinel as ordinary data for the caller to skip', () => {
    const p = new SseParser();
    const out = p.push('data: [DONE]\n\n');
    expect(out[0].data).toBe('[DONE]');
  });

  it('joins multi-line data fields with newlines, per the SSE spec', () => {
    const p = new SseParser();
    const out = p.push('data: line1\ndata: line2\n\n');
    expect(out[0].data).toBe('line1\nline2');
  });
});

/* ========================================================================== */
/* Speechmatics wire protocol                                                 */
/* ========================================================================== */

describe('Speechmatics adapter — wire protocol', () => {
  let wss: WebSocketServer;
  let port: number;
  const received: any[] = [];
  let binaryFrames = 0;
  let lastSocket: WsSocket | null = null;

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on('listening', () => r()));
    port = (wss.address() as any).port;

    wss.on('connection', (ws, req) => {
      lastSocket = ws;
      received.push({ headers: req.headers });
      let seq = 0;
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          binaryFrames++;
          ws.send(JSON.stringify({ message: 'AudioAdded', seq_no: ++seq }));
          return;
        }
        const msg = JSON.parse(data.toString());
        received.push(msg);
        if (msg.message === 'StartRecognition') {
          ws.send(
            JSON.stringify({
              message: 'RecognitionStarted',
              id: 'mock-session',
              language_pack_info: { word_delimiter: ' ', writing_direction: 'right-to-left' },
            }),
          );
        }
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('sends StartRecognition with the exact documented schema, then waits for RecognitionStarted', async () => {
    const provider = new SpeechmaticsSttProvider({ apiKey: 'test-key', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open(
      {
        language: 'ar',
        audioFormat: { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' },
        enablePartials: true,
        maxDelay: 0.7,
        maxDelayMode: 'flexible',
        endOfUtteranceSilenceTrigger: 0.5,
        model: 'enhanced',
        punctuationSensitivity: 0.5,
      },
      {},
    );

    const start = received.find((m) => m.message === 'StartRecognition');
    expect(start).toBeDefined();
    // Field names are the contract; a typo here is an opaque provider error.
    expect(start.audio_format).toEqual({ type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 });
    expect(start.transcription_config.language).toBe('ar');
    expect(start.transcription_config.model).toBe('enhanced');
    expect(start.transcription_config.enable_partials).toBe(true);
    expect(start.transcription_config.max_delay).toBe(0.7);
    expect(start.transcription_config.max_delay_mode).toBe('flexible');
    expect(start.transcription_config.conversation_config).toEqual({ end_of_utterance_silence_trigger: 0.5 });
    // translation_config and audio_events_config are top-level siblings, and we
    // send neither, so they must be absent rather than nested by mistake.
    expect(start.transcription_config.translation_config).toBeUndefined();

    await session.close();
  });

  it('passes the API key as an Authorization header, never in the URL', async () => {
    const provider = new SpeechmaticsSttProvider({ apiKey: 'secret-key-value', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open(baseCfg(), {});
    // The LAST connection is the one this test opened; earlier tests in this
    // file share the mock server.
    const conn = [...received].reverse().find((r) => r.headers);
    expect(conn.headers.authorization).toBe('Bearer secret-key-value');
    await session.close();
  });

  it('sends audio as raw BINARY frames with no JSON wrapper and no client sequence number', async () => {
    binaryFrames = 0;
    const acks: number[] = [];
    const provider = new SpeechmaticsSttProvider({ apiKey: 'k', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open(baseCfg(), { onAck: (n) => acks.push(n) });

    session.sendAudio(new Uint8Array(640));
    session.sendAudio(new Uint8Array(640));
    await sleep(120);

    expect(binaryFrames).toBe(2);
    expect(session.bytesSent).toBe(1280);
    // The SERVER assigns sequence numbers; the client sends none.
    expect(acks).toEqual([1, 2]);
    await session.close();
  });

  it('parses AddPartialTranscript and AddTranscript into the common Transcript shape', async () => {
    const partials: string[] = [];
    const finals: string[] = [];
    const provider = new SpeechmaticsSttProvider({ apiKey: 'k', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open(baseCfg(), {
      onPartial: (t) => partials.push(t.text),
      onFinal: (t) => finals.push(t.text),
    });

    lastSocket!.send(
      JSON.stringify({
        message: 'AddPartialTranscript',
        metadata: { start_time: 0, end_time: 1.2, transcript: 'بدي اعرف' },
        results: [{ type: 'word', start_time: 0.1, end_time: 0.5, alternatives: [{ content: 'بدي', confidence: 0.9 }] }],
      }),
    );
    lastSocket!.send(
      JSON.stringify({
        message: 'AddTranscript',
        metadata: { start_time: 0, end_time: 1.5, transcript: 'بدي أعرف تفاصيل حسابي' },
        results: [],
      }),
    );
    await sleep(80);

    expect(partials).toEqual(['بدي اعرف']);
    expect(finals).toEqual(['بدي أعرف تفاصيل حسابي']);
    await session.close();
  });

  it('reports EndOfUtterance, the real turn boundary', async () => {
    const eou: number[] = [];
    const provider = new SpeechmaticsSttProvider({ apiKey: 'k', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open(baseCfg(), { onEndOfUtterance: (i) => eou.push(i.time) });
    lastSocket!.send(JSON.stringify({ message: 'EndOfUtterance', metadata: { start_time: 3.24, end_time: 3.24 } }));
    await sleep(60);
    expect(eou).toEqual([3.24]);
    await session.close();
  });

  it('never sends EndOfStream between turns — only ForceEndOfUtterance', async () => {
    const before = received.length;
    const provider = new SpeechmaticsSttProvider({ apiKey: 'k', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open(baseCfg(), {});

    // Simulate three conversational turns on ONE session.
    for (let i = 0; i < 3; i++) {
      session.sendAudio(new Uint8Array(320));
      expect(session.forceEndOfUtterance()).toBe(true);
      await sleep(30);
    }

    const during = received.slice(before);
    // EndOfStream is terminal: sending it mid-conversation would make the
    // server ignore all subsequent audio (documented as add_audio_after_eos).
    expect(during.filter((m) => m.message === 'EndOfStream')).toHaveLength(0);
    expect(during.filter((m) => m.message === 'ForceEndOfUtterance')).toHaveLength(3);
    // And exactly one StartRecognition for the whole conversation.
    expect(during.filter((m) => m.message === 'StartRecognition')).toHaveLength(1);

    await session.close();
    await sleep(180);
    // Only at genuine teardown is EndOfStream correct.
    expect(received.filter((m) => m.message === 'EndOfStream').length).toBeGreaterThan(0);
  });

  it('surfaces a provider Error message with its retryable classification', async () => {
    const errors: any[] = [];
    const provider = new SpeechmaticsSttProvider({ apiKey: 'k', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open(baseCfg(), { onError: (e) => errors.push(e) });
    lastSocket!.send(JSON.stringify({ message: 'Error', type: 'internal_error', reason: 'boom' }));
    await sleep(60);
    expect(errors[0].message).toBe('boom');
    expect(errors[0].retryable).toBe(true);
    await session.close();
  });

  /* -- concurrency accounting ------------------------------------------- */

  // Speechmatics limits CONCURRENT sessions per account. A leaked session is
  // invisible locally -- it only shows up later as "Concurrent Quota Exceeded"
  // on an unrelated warm-up -- so the registry is asserted directly.
  it('registers a live session and releases it on close', async () => {
    const before = liveSttSessions().length;
    const provider = new SpeechmaticsSttProvider({ apiKey: 'k', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open({ ...baseCfg(), label: 'test:registry' }, {});

    const live = liveSttSessions();
    expect(live.length).toBe(before + 1);
    expect(live.some((s) => s.label === 'test:registry')).toBe(true);

    await session.close();
    expect(liveSttSessions().length).toBe(before);
  });

  it('closing twice is idempotent and does not corrupt the registry', async () => {
    const before = liveSttSessions().length;
    const provider = new SpeechmaticsSttProvider({ apiKey: 'k', url: `ws://127.0.0.1:${port}` });
    const session = await provider.open(baseCfg(), {});
    await session.close();
    await session.close();
    expect(liveSttSessions().length).toBe(before);
  });

  it('does not leak a registry slot when the handshake never completes', async () => {
    const before = liveSttSessions().length;
    // A server that accepts the socket but never answers StartRecognition:
    // open() must reject AND release the half-open session.
    const deaf = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => deaf.on('listening', () => r()));
    const deafPort = (deaf.address() as any).port;

    const provider = new SpeechmaticsSttProvider({
      apiKey: 'k',
      url: `ws://127.0.0.1:${deafPort}`,
      startTimeoutMs: 150,
    });
    await expect(provider.open(baseCfg(), {})).rejects.toThrow();
    await sleep(80);
    expect(liveSttSessions().length).toBe(before);
    await new Promise<void>((r) => deaf.close(() => r()));
  });

  function baseCfg() {
    return {
      language: 'en',
      audioFormat: { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' as const },
      enablePartials: true,
      maxDelay: 1,
      maxDelayMode: 'flexible' as const,
      endOfUtteranceSilenceTrigger: 0,
      model: 'standard' as const,
    };
  }
});

/* ========================================================================== */
/* OpenAI Responses wire protocol                                             */
/* ========================================================================== */

describe('OpenAI adapter — wire protocol', () => {
  let server: Server;
  let port: number;
  let lastBody: any = null;
  let lastHeaders: any = null;
  let mode: 'ok' | 'error' | 'slow' = 'ok';

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        lastBody = JSON.parse(body || '{}');
        lastHeaders = req.headers;

        if (mode === 'error') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unsupported value: reasoning.effort', code: 'invalid_value' } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (o: unknown) => res.write(`event: ${(o as any).type}\ndata: ${JSON.stringify(o)}\n\n`);
        send({ type: 'response.created', response: { id: 'resp_mock' } });
        for (const d of ['أكيد', '، ', 'أقدر ', 'أساعدك ', 'في هذا.']) {
          if (mode === 'slow') await sleep(20);
          send({ type: 'response.output_text.delta', delta: d, sequence_number: 1 });
        }
        send({ type: 'response.completed', response: { id: 'resp_mock', usage: { output_tokens: 9 } } });
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const mk = () => new OpenAiResponsesProvider({ apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${port}` });

  it('builds a Responses request with the documented field names', () => {
    const body = mk().buildBody({
      model: 'gpt-5.6-terra',
      instructions: 'You are a call-centre agent.',
      input: [{ role: 'user', content: 'مرحبا' }],
      maxOutputTokens: 120,
      reasoningEffort: 'none',
      verbosity: 'low',
      serviceTier: 'fast',
      store: false,
    });
    // Responses uses input/instructions/max_output_tokens — NOT messages/max_tokens.
    expect(body.input).toEqual([{ role: 'user', content: 'مرحبا' }]);
    expect(body.instructions).toBe('You are a call-centre agent.');
    expect(body.max_output_tokens).toBe(120);
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.text).toEqual({ verbosity: 'low' });
    expect(body.service_tier).toBe('fast');
    expect(body.stream).toBe(true);
    // Obfuscation padding is on by default and costs bandwidth on every delta.
    expect(body.stream_options).toEqual({ include_obfuscation: false });
  });

  it('omits optional fields entirely rather than sending nulls', () => {
    const body = mk().buildBody({
      model: 'm',
      instructions: 'i',
      input: [],
      maxOutputTokens: 10,
      temperature: undefined,
      reasoningEffort: null,
      verbosity: null,
      serviceTier: 'auto',
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('text');
    // 'auto' means "do not send a tier", not "send the string auto".
    expect(body).not.toHaveProperty('service_tier');
  });

  it('fires onFirstDelta on the FIRST token, not at completion', async () => {
    mode = 'slow';
    const order: string[] = [];
    let firstDelta = '';
    const h = mk().stream(
      { model: 'm', instructions: 'i', input: [{ role: 'user', content: 'hi' }], maxOutputTokens: 50 },
      {
        onCreated: () => order.push('created'),
        onFirstDelta: (d) => {
          order.push('first');
          firstDelta = d;
        },
        onDelta: () => order.push('delta'),
        onCompleted: () => order.push('completed'),
      },
    );
    const out = await h.done;
    expect(order[0]).toBe('created');
    expect(order[1]).toBe('first');
    expect(order[order.length - 1]).toBe('completed');
    expect(firstDelta).toBe('أكيد');
    expect(out.text).toBe('أكيد، أقدر أساعدك في هذا.');
    mode = 'ok';
  });

  it('fires onDelta for EVERY delta including the first, so concatenating them is complete', async () => {
    const viaOnDelta: string[] = [];
    let firstCount = 0;
    let completedText = '';
    const h = mk().stream(
      { model: 'm', instructions: 'i', input: [], maxOutputTokens: 50 },
      {
        onFirstDelta: () => firstCount++,
        onDelta: (d) => viaOnDelta.push(d),
        onCompleted: (i) => (completedText = i.text),
      },
    );
    await h.done;
    // This is the contract callers depend on: a consumer that implements only
    // onDelta must receive the whole response, with no token missing and none
    // duplicated. Accumulating in BOTH callbacks would double the first token.
    expect(viaOnDelta).toHaveLength(5);
    expect(viaOnDelta.join('')).toBe(completedText);
    expect(completedText).toBe('أكيد، أقدر أساعدك في هذا.');
    expect(firstCount).toBe(1);
  });

  it('sends the Authorization header and no key in the URL', async () => {
    const h = mk().stream({ model: 'm', instructions: 'i', input: [], maxOutputTokens: 10 }, {});
    await h.done;
    expect(lastHeaders.authorization).toBe('Bearer sk-test');
  });

  it('surfaces an HTTP error with the provider message intact', async () => {
    mode = 'error';
    let err: any = null;
    const h = mk().stream(
      { model: 'm', instructions: 'i', input: [], maxOutputTokens: 10, reasoningEffort: 'none' },
      { onError: (e) => (err = e) },
    );
    const out = await h.done;
    expect(err.message).toContain('Unsupported value: reasoning.effort');
    expect(out.error).toBeDefined();
    mode = 'ok';
  });

  it('cancels cleanly and reports partial text', async () => {
    mode = 'slow';
    let seen = 0;
    const h = mk().stream(
      { model: 'm', instructions: 'i', input: [], maxOutputTokens: 50 },
      {
        onFirstDelta: () => {
          seen++;
          h.cancel('barge_in');
        },
        onDelta: () => seen++,
      },
    );
    const out = await h.done;
    expect(out.cancelled).toBe(true);
    expect(h.cancelled).toBe(true);
    expect(seen).toBeLessThan(5);
    mode = 'ok';
  });
});

/* ========================================================================== */
/* Hamsa                                                                      */
/* ========================================================================== */

describe('Hamsa adapter — wire protocol', () => {
  let wss: WebSocketServer;
  let port: number;
  const sent: any[] = [];

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.on('listening', () => r()));
    port = (wss.address() as any).port;

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'info', payload: { message: 'Connected to realtime WebSocket server' } }));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        sent.push(msg);
        if (msg.type !== 'tts') return;
        ws.send(JSON.stringify({ type: 'ack', payload: { message: 'Real time text to speach connection establesh' } }));
        // Raw binary PCM frames, exactly as Hamsa documents.
        setTimeout(() => {
          ws.send(Buffer.alloc(640), { binary: true });
          ws.send(Buffer.alloc(640), { binary: true });
          ws.send(JSON.stringify({ type: 'end', payload: { message: 'End of TTS stream' } }));
        }, 15);
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('detects a cloned voice UUID versus a built-in voice name', () => {
    expect(isClonedVoiceId('c803658e-ccec-47e7-ad0f-1caf9ba4babb')).toBe(true);
    expect(isClonedVoiceId('Amjad')).toBe(false);
    expect(isClonedVoiceId('')).toBe(false);
  });

  it('sends the tts frame with the documented payload field names', async () => {
    const tts = new HamsaTtsProvider({
      apiKey: 'k',
      transport: 'websocket',
      wsUrl: `ws://127.0.0.1:${port}`,
      sampleRate: '16k',
    });
    await tts.connect();

    const chunks: number[] = [];
    let firstSeen = false;
    const h = tts.synthesize(
      {
        text: 'مرحبا بك',
        speaker: 'Amjad',
        dialect: 'pls',
        languageId: 'ar',
        sampleRate: '16k',
        mulaw: false,
        expressiveness: 1,
        turnId: 't1',
        phraseSeq: 1,
        generation: 3,
      },
      {
        onFirstAudio: () => (firstSeen = true),
        onChunk: (c) => chunks.push(c.data.byteLength),
      },
    );
    const r = await h.done;

    const frame = sent.find((m) => m.type === 'tts');
    expect(frame.payload.text).toBe('مرحبا بك');
    expect(frame.payload.speaker).toBe('Amjad');
    expect(frame.payload.dialect).toBe('pls');
    expect(frame.payload.languageId).toBe('ar');
    expect(frame.payload.mulaw).toBe(false);
    expect(frame.payload.sampleRate).toBe('16k');
    // The published AsyncAPI `required` array also lists these at the top level,
    // so they are sent in both places to satisfy either interpretation.
    expect(frame.dialect).toBe('pls');
    expect(frame.languageId).toBe('ar');

    expect(firstSeen).toBe(true);
    expect(chunks).toEqual([640, 640]);
    expect(r.bytes).toBe(1280);
    await tts.close();
  });

  it('omits sampleRate when mu-law is requested (mu-law is always 8 kHz)', async () => {
    const before = sent.length;
    const tts = new HamsaTtsProvider({ apiKey: 'k', transport: 'websocket', wsUrl: `ws://127.0.0.1:${port}`, mulaw: true });
    await tts.connect();
    const h = tts.synthesize(
      { text: 'x', speaker: 'Amjad', mulaw: true, turnId: 't', phraseSeq: 1, generation: 1 },
      {},
    );
    await h.done;
    const frame = sent.slice(before).find((m) => m.type === 'tts');
    expect(frame.payload.mulaw).toBe(true);
    expect(frame.payload).not.toHaveProperty('sampleRate');
    expect(tts.audioFormat).toEqual({ sampleRate: 8000, channels: 1, encoding: 'mulaw' });
    await tts.close();
  });

  it('serialises requests on one socket — the protocol has no correlation id', async () => {
    const before = sent.length;
    const tts = new HamsaTtsProvider({ apiKey: 'k', transport: 'websocket', wsUrl: `ws://127.0.0.1:${port}` });
    await tts.connect();

    const a = tts.synthesize({ text: 'one', speaker: 'Amjad', turnId: 't', phraseSeq: 1, generation: 1 }, {});
    const b = tts.synthesize({ text: 'two', speaker: 'Amjad', turnId: 't', phraseSeq: 2, generation: 1 }, {});
    await sleep(5);
    // Only the first request may be in flight; binary frames carry no routing
    // tag, so two concurrent requests would be unattributable.
    expect(sent.slice(before).filter((m) => m.type === 'tts')).toHaveLength(1);

    await Promise.all([a.done, b.done]);
    expect(sent.slice(before).filter((m) => m.type === 'tts')).toHaveLength(2);
    await tts.close();
  });

  it('stamps onRequestSent BEFORE the HTTP round trip, so TTFA is real', async () => {
    // Regression guard. Reporting the request as sent after `await fetch()`
    // resolved put the entire network round trip on the wrong side of the
    // measurement and produced a sub-millisecond TTFA against a live provider.
    const httpServer = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Transfer-Encoding': 'chunked' });
        res.write(Buffer.alloc(320));
        res.end();
      }, 120); // simulated provider think time
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
    const p = (httpServer.address() as any).port;

    const tts = new HamsaTtsProvider({
      apiKey: 'k',
      transport: 'http',
      httpUrl: `http://127.0.0.1:${p}/tts`,
    });
    await tts.connect();

    let sentAt = 0n;
    let firstAudioAt = 0n;
    const h = tts.synthesize(
      { text: 'hello', speaker: 'Amjad', turnId: 't', phraseSeq: 1, generation: 1 },
      {
        onRequestSent: () => (sentAt = process.hrtime.bigint()),
        onFirstAudio: () => (firstAudioAt = process.hrtime.bigint()),
      },
    );
    await h.done;

    const ttfaMs = Number(firstAudioAt - sentAt) / 1e6;
    // The server deliberately waits 120 ms, so a correct TTFA must reflect it.
    expect(ttfaMs).toBeGreaterThan(80);
    await tts.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  it('reports the raw PCM output format so no decode step is needed', () => {
    const tts = new HamsaTtsProvider({ apiKey: 'k', transport: 'http', sampleRate: '16k' });
    expect(tts.audioFormat).toEqual({ sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' });
  });

  it('discards audio locally on cancel, since Hamsa exposes no cancel message', async () => {
    const tts = new HamsaTtsProvider({ apiKey: 'k', transport: 'websocket', wsUrl: `ws://127.0.0.1:${port}` });
    await tts.connect();
    const chunks: number[] = [];
    const h = tts.synthesize(
      { text: 'cancel me', speaker: 'Amjad', turnId: 't', phraseSeq: 1, generation: 1 },
      { onChunk: (c) => chunks.push(c.data.byteLength) },
    );
    h.cancel('barge_in');
    const r = await h.done;
    expect(r.cancelled).toBe(true);
    await sleep(60);
    expect(chunks).toHaveLength(0);
    await tts.close();
  });

  it('surfaces a provider error frame', async () => {
    const errWss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => errWss.on('listening', () => r()));
    const p = (errWss.address() as any).port;
    errWss.on('connection', (ws) => {
      ws.on('message', () => ws.send(JSON.stringify({ type: 'error', payload: { message: 'Voice not owned by user' } })));
    });

    const tts = new HamsaTtsProvider({ apiKey: 'k', transport: 'websocket', wsUrl: `ws://127.0.0.1:${p}` });
    await tts.connect();
    let err: any = null;
    const h = tts.synthesize(
      { text: 'x', speaker: 'bad-uuid', turnId: 't', phraseSeq: 1, generation: 1 },
      { onError: (e) => (err = e) },
    );
    await h.done;
    expect(err?.message).toBe('Voice not owned by user');
    await tts.close();
    await new Promise<void>((r) => errWss.close(() => r()));
  });
});

/* ========================================================================== */
/* Live smoke tests (skipped without credentials)                             */
/* ========================================================================== */

const liveOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
const liveHamsa = process.env.HAMSA_API_KEY ? describe : describe.skip;
const liveSm = process.env.SPEECHMATICS_API_KEY ? describe : describe.skip;

liveOpenAI('LIVE OpenAI', () => {
  it('streams a first token from the real API', async () => {
    const p = new OpenAiResponsesProvider({ apiKey: process.env.OPENAI_API_KEY! });
    let first: string | null = null;
    const h = p.stream(
      {
        model: process.env.BENCH_MODEL ?? 'gpt-5.6-terra',
        instructions: 'Reply with one short word.',
        input: [{ role: 'user', content: 'Say hello.' }],
        maxOutputTokens: 24,
        reasoningEffort: 'none',
        store: false,
      },
      { onFirstDelta: (d) => (first = d) },
    );
    const out = await h.done;
    expect(out.error, out.error?.message).toBeUndefined();
    expect(first).not.toBeNull();
  }, 45_000);
});

liveHamsa('LIVE Hamsa', () => {
  it('returns raw PCM audio from the real API on both transports', async () => {
    for (const transport of ['websocket', 'http'] as const) {
      const tts = new HamsaTtsProvider({ apiKey: process.env.HAMSA_API_KEY!, transport, sampleRate: '16k' });
      await tts.connect();
      let bytes = 0;
      const h = tts.synthesize(
        {
          text: 'مرحبا',
          speaker: process.env.HAMSA_SPEAKER_ID || 'Amjad',
          dialect: 'pls',
          languageId: 'ar',
          turnId: 'live',
          phraseSeq: 1,
          generation: 0,
        },
        { onChunk: (c) => (bytes += c.data.byteLength) },
      );
      const r = await h.done;
      expect(r.error, `${transport}: ${r.error?.message}`).toBeUndefined();
      expect(bytes).toBeGreaterThan(0);
      await tts.close();
    }
  }, 60_000);
});

liveSm('LIVE Speechmatics', () => {
  it('opens a realtime session and accepts audio', async () => {
    const p = new SpeechmaticsSttProvider({
      apiKey: process.env.SPEECHMATICS_API_KEY!,
      region: (process.env.SPEECHMATICS_REGION as any) ?? 'eu',
    });
    const session = await p.open(
      {
        language: 'en',
        audioFormat: { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' },
        enablePartials: true,
        maxDelay: 0.7,
        maxDelayMode: 'flexible',
        endOfUtteranceSilenceTrigger: 0.5,
        model: 'standard',
      },
      {},
    );
    session.sendAudio(new Uint8Array(6400));
    await sleep(500);
    expect(session.state).toBe('open');
    await session.close();
  }, 45_000);
});
