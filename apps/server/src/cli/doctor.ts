/**
 * Connectivity and latency doctor.
 *
 * Verifies each provider independently and reports a real measured latency for
 * each, so a misconfiguration is obvious before any conversation is attempted.
 * Run with: npm run doctor
 */

import { deltaMs, nowNs, roundMs } from '@vll/telemetry';
import { defaultConfig } from '@vll/core';
import { HamsaTtsProvider, OpenAiResponsesProvider, SpeechmaticsSttProvider } from '@vll/providers';
import { KnowledgeBase } from '@vll/rag';
import { secrets, serverConfig } from '../env.js';

const ok = (s: string) => `  [32m✓[0m ${s}`;
const bad = (s: string) => `  [31m✗[0m ${s}`;
const warn = (s: string) => `  [33m![0m ${s}`;
const head = (s: string) => `\n[1m${s}[0m`;

async function main(): Promise<void> {
  const cfg = defaultConfig();
  const s = secrets.get();
  let failures = 0;

  console.log(head('Voice Latency Lab — doctor'));
  console.log(`  node ${process.version} · region ${serverConfig.speechmaticsRegion}`);

  /* -- credentials ------------------------------------------------------- */
  console.log(head('Credentials'));
  for (const [name, value] of [
    ['OPENAI_API_KEY', s.openaiApiKey],
    ['SPEECHMATICS_API_KEY', s.speechmaticsApiKey],
    ['HAMSA_API_KEY', s.hamsaApiKey],
    ['HAMSA_SPEAKER_ID', s.hamsaSpeakerId],
  ] as const) {
    if (value) console.log(ok(`${name} present (${value.length} chars)`));
    else {
      console.log(bad(`${name} is not set`));
      failures++;
    }
  }

  /* -- knowledge base ---------------------------------------------------- */
  console.log(head('Knowledge base'));
  try {
    const kb = new KnowledgeBase({ dataDir: serverConfig.kbDir });
    await kb.load();
    const t0 = nowNs();
    const r = await kb.search('test query', { topK: 3 });
    console.log(ok(`${kb.documentCount} documents, ${kb.chunkCount} chunks, ${kb.retrieverMode}`));
    console.log(ok(`retrieval round trip ${roundMs(deltaMs(t0, nowNs()), 2)} ms (${r.chunks.length} hits)`));
    if (kb.chunkCount === 0) console.log(warn('index is empty — upload documents on the Knowledge Base page'));
  } catch (e: any) {
    console.log(bad(`knowledge base: ${e?.message ?? e}`));
    failures++;
  }

  /* -- OpenAI ------------------------------------------------------------ */
  console.log(head(`OpenAI — ${cfg.llm.model}`));
  if (!s.openaiApiKey) {
    console.log(warn('skipped (no key)'));
  } else {
    try {
      const llm = new OpenAiResponsesProvider({ apiKey: s.openaiApiKey, requestTimeoutMs: 30_000 });
      const t0 = nowNs();
      await llm.warmup(cfg.llm.model);
      console.log(ok(`connection primed in ${roundMs(deltaMs(t0, nowNs()))} ms`));

      const start = nowNs();
      let firstDeltaNs: bigint | null = null;
      const h = llm.stream(
        {
          model: cfg.llm.model,
          instructions: 'Reply with exactly one short word.',
          input: [{ role: 'user', content: 'Say hello.' }],
          maxOutputTokens: 24,
          reasoningEffort: cfg.llm.reasoningEffort,
          store: false,
        },
        { onFirstDelta: () => (firstDeltaNs = nowNs()) },
      );
      const out = await h.done;
      if (out.error) {
        console.log(bad(`LLM error: ${out.error.message}`));
        console.log(warn(`If the model rejects reasoning.effort="${cfg.llm.reasoningEffort}", change it in Settings.`));
        failures++;
      } else {
        console.log(ok(`TTFT ${firstDeltaNs ? roundMs(deltaMs(start, firstDeltaNs)) : '—'} ms`));
        console.log(ok(`total ${roundMs(deltaMs(start, nowNs()))} ms · "${out.text.trim().slice(0, 60)}"`));
      }
    } catch (e: any) {
      console.log(bad(`OpenAI: ${e?.message ?? e}`));
      failures++;
    }
  }

  /* -- Speechmatics ------------------------------------------------------ */
  console.log(head('Speechmatics realtime'));
  if (!s.speechmaticsApiKey) {
    console.log(warn('skipped (no key)'));
  } else {
    try {
      const stt = new SpeechmaticsSttProvider({
        apiKey: s.speechmaticsApiKey,
        region: serverConfig.speechmaticsRegion,
      });
      const t0 = nowNs();
      const session = await stt.open(
        {
          language: cfg.stt.language,
          audioFormat: { sampleRate: 16_000, channels: 1, encoding: 'pcm_s16le' },
          enablePartials: true,
          maxDelay: cfg.stt.maxDelay,
          maxDelayMode: cfg.stt.maxDelayMode,
          endOfUtteranceSilenceTrigger: cfg.stt.endOfUtteranceSilenceTrigger,
          model: cfg.stt.model,
          label: 'doctor',
        },
        {},
      );
      console.log(ok(`RecognitionStarted in ${roundMs(deltaMs(t0, nowNs()))} ms`));
      console.log(ok(`language=${cfg.stt.language} model=${cfg.stt.model} max_delay=${cfg.stt.maxDelay}s`));
      // 200 ms of silence, purely to prove the audio channel accepts frames.
      const silence = new Uint8Array(16_000 * 2 * 0.2);
      session.sendAudio(silence);
      await new Promise((r) => setTimeout(r, 400));
      console.log(ok(`audio channel accepted ${silence.byteLength} bytes`));
      await session.close();
    } catch (e: any) {
      console.log(bad(`Speechmatics: ${e?.message ?? e}`));
      failures++;
    }
  }

  /* -- Hamsa ------------------------------------------------------------- */
  console.log(head('Hamsa realtime TTS'));
  if (!s.hamsaApiKey) {
    console.log(warn('skipped (no key)'));
  } else {
    for (const transport of ['websocket', 'http'] as const) {
      try {
        const tts = new HamsaTtsProvider({
          apiKey: s.hamsaApiKey,
          transport,
          sampleRate: cfg.tts.sampleRate,
          mulaw: cfg.tts.mulaw,
          firstAudioTimeoutMs: 20_000,
        });

        const speaker = s.hamsaSpeakerId || cfg.tts.speaker;
        const pre = nowNs();
        const p = await tts.preloadVoice(speaker);
        console.log(
          p.preloaded
            ? ok(`[${transport}] voice preload: ${p.message} (${roundMs(deltaMs(pre, nowNs()))} ms)`)
            : p.required
              ? bad(`[${transport}] voice preload FAILED: ${p.message}`)
              : ok(`[${transport}] voice preload: ${p.message}`),
        );

        const c0 = nowNs();
        await tts.connect();
        console.log(ok(`[${transport}] connected in ${roundMs(deltaMs(c0, nowNs()))} ms`));

        const text = 'وعليكم السلام، أكيد أقدر أساعدك.';
        let sentNs: bigint | null = null;
        let firstNs: bigint | null = null;
        let bytes = 0;
        const h = tts.synthesize(
          {
            text,
            speaker,
            dialect: cfg.tts.dialect,
            languageId: cfg.tts.languageId,
            sampleRate: cfg.tts.sampleRate,
            mulaw: cfg.tts.mulaw,
            turnId: 'doctor',
            phraseSeq: 1,
            generation: 0,
          },
          {
            onRequestSent: () => (sentNs = nowNs()),
            onFirstAudio: () => (firstNs = nowNs()),
            onChunk: (c) => (bytes += c.data.byteLength),
          },
        );
        const r = await h.done;
        if (r.error) {
          console.log(bad(`[${transport}] TTS error: ${r.error.message}`));
          failures++;
        } else {
          const ttfa = sentNs && firstNs ? roundMs(deltaMs(sentNs, firstNs)) : null;
          console.log(ok(`[${transport}] TTFA ${ttfa ?? '—'} ms · ${bytes} bytes · ${r.chunks} chunks`));
          const fmt = tts.audioFormat;
          console.log(
            ok(
              `[${transport}] audio ${fmt.encoding} ${fmt.sampleRate} Hz · ${roundMs(
                (bytes / 2 / fmt.sampleRate) * 1000,
              )} ms of speech`,
            ),
          );
        }
        await tts.close();
      } catch (e: any) {
        console.log(bad(`Hamsa [${transport}]: ${e?.message ?? e}`));
        failures++;
      }
    }
  }

  console.log(head(failures === 0 ? '[32mAll checks passed.[0m' : `[31m${failures} check(s) failed.[0m`));
  console.log('');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('doctor failed:', e);
  process.exit(1);
});
