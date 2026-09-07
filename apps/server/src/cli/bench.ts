/**
 * Headless benchmark runner.
 *
 * Runs the isolated probes from the command line, with no browser involved, and
 * prints a summary table. Useful for CI, for comparing models, and for
 * capturing a baseline before a change.
 *
 *   npm run bench                          # llm, tts and llm→tts probes
 *   npm run bench -- --only tts_only -n 10
 *   npm run bench -- --model gpt-5.6-luna --effort none
 *   npm run bench -- --json > results.json
 */

import { writeFileSync } from 'node:fs';
import { TelemetryBus, newTraceId, roundSummary } from '@vll/telemetry';
import { defaultConfig, type SessionConfig } from '@vll/core';
import { HamsaTtsProvider, OpenAiResponsesProvider, SpeechmaticsSttProvider } from '@vll/providers';
import { KnowledgeBase } from '@vll/rag';
import { BENCHMARK_CATALOG, BenchmarkRunner, type BenchmarkId } from '../benchmarks.js';
import { secrets, serverConfig } from '../env.js';

interface Args {
  only: BenchmarkId[];
  reps: number;
  json: boolean;
  out?: string;
  model?: string;
  effort?: string;
  transport?: 'websocket' | 'http';
  speaker?: string;
  text?: string;
  mode?: 'B' | 'C';
}

function parseArgs(argv: string[]): Args {
  const a: Args = { only: [], reps: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--only':
        a.only = v.split(',').map((s) => s.trim()) as BenchmarkId[];
        i++;
        break;
      case '-n':
      case '--reps':
        a.reps = Number(v) || 3;
        i++;
        break;
      case '--json':
        a.json = true;
        break;
      case '--out':
        a.out = v;
        i++;
        break;
      case '--model':
        a.model = v;
        i++;
        break;
      case '--effort':
        a.effort = v;
        i++;
        break;
      case '--transport':
        a.transport = v as 'websocket' | 'http';
        i++;
        break;
      case '--speaker':
        a.speaker = v;
        i++;
        break;
      case '--text':
        a.text = v;
        i++;
        break;
      case '--mode':
        a.mode = v.toUpperCase() as 'B' | 'C';
        i++;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`
Voice Latency Lab — headless benchmark runner

  --only <ids>       comma separated: ${BENCHMARK_CATALOG.map((b) => b.id).join(', ')}
  -n, --reps <n>     repetitions per benchmark (default 3)
  --model <id>       override the OpenAI model
  --effort <v>       override reasoning effort (none|low|medium|high|xhigh|max)
  --mode <B|C>       pipeline mode: B = streaming pipeline,
                     C = Vapi-style orchestration
  --transport <t>    hamsa transport: websocket | http
  --speaker <s>      hamsa voice name or cloned voice UUID
  --text <s>         fixed phrase for the TTS and LLM probes
  --json             print raw JSON instead of a table
  --out <file>       also write the JSON result to a file

Probes needing recorded audio (stt_only, stt_to_llm, full_pipeline*) are skipped
here — record a clip in the browser on the Compare page and run them there.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const s = secrets.get();

  const config: SessionConfig = defaultConfig();
  if (args.model) config.llm.model = args.model;
  if (args.effort) config.llm.reasoningEffort = args.effort === 'null' ? null : args.effort;
  if (args.mode) config.mode = args.mode;
  if (args.transport) config.tts.transport = args.transport;
  if (args.speaker) config.tts.speaker = args.speaker;
  else if (s.hamsaSpeakerId) config.tts.speaker = s.hamsaSpeakerId;

  const llm = s.openaiApiKey ? new OpenAiResponsesProvider({ apiKey: s.openaiApiKey }) : null;
  const tts = s.hamsaApiKey
    ? new HamsaTtsProvider({
        apiKey: s.hamsaApiKey,
        transport: config.tts.transport,
        sampleRate: config.tts.sampleRate,
        mulaw: config.tts.mulaw,
      })
    : null;
  const stt = s.speechmaticsApiKey
    ? new SpeechmaticsSttProvider({ apiKey: s.speechmaticsApiKey, region: serverConfig.speechmaticsRegion })
    : null;

  const kb = new KnowledgeBase({ dataDir: serverConfig.kbDir });
  await kb.load();

  if (tts) {
    await tts.preloadVoice(config.tts.speaker);
    await tts.connect();
  }
  if (llm) await llm.warmup(config.llm.model);

  const bus = new TelemetryBus({ sessionId: 'cli', traceId: newTraceId(), capacity: 20_000 });
  const runner = new BenchmarkRunner({ llm, tts, stt, kb, config, bus, clip: null });

  // Without a recorded clip, audio-driven probes cannot run headlessly.
  const requested = args.only.length > 0 ? args.only : (['llm_only', 'tts_only', 'llm_to_tts', 'rag_only'] as BenchmarkId[]);
  const runnable = requested.filter((id) => {
    const meta = BENCHMARK_CATALOG.find((b) => b.id === id);
    if (meta?.needsAudio) {
      console.error(`skipping ${id}: needs a recorded clip (record one on the Compare page)`);
      return false;
    }
    return true;
  });

  const results = [];
  for (const id of runnable) {
    process.stderr.write(`running ${id}… `);
    const r = await runner.run(id, { repetitions: args.reps, text: args.text, query: args.text });
    process.stderr.write(`${r.summary ? `${Math.round(r.summary.p50)} ms p50` : 'failed'}\n`);
    results.push(r);
  }

  const payload = {
    ranAt: new Date().toISOString(),
    config: {
      mode: config.mode,
      model: config.llm.model,
      reasoningEffort: config.llm.reasoningEffort,
      verbosity: config.llm.verbosity,
      serviceTier: config.llm.serviceTier,
      speaker: config.tts.speaker,
      dialect: config.tts.dialect,
      transport: config.tts.transport,
      sampleRate: config.tts.sampleRate,
      retriever: kb.retrieverMode,
    },
    results,
  };

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(payload, null, 2), 'utf8');
    console.error(`wrote ${args.out}`);
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('');
    console.log(
      `Model: ${config.llm.model}  effort=${config.llm.reasoningEffort ?? '-'}  voice=${config.tts.speaker}  transport=${config.tts.transport}  mode=${config.mode}`,
    );
    console.log('');
    const w = [26, 7, 8, 8, 8, 8, 8];
    const row = (c: string[]) => c.map((v, i) => v.padEnd(w[i])).join('');
    console.log(row(['BENCHMARK', 'n', 'min', 'P50', 'P90', 'max', 'ok']));
    console.log('-'.repeat(w.reduce((a, b) => a + b, 0)));
    for (const r of results) {
      const s2 = r.summary ? roundSummary(r.summary, 0) : null;
      const okCount = r.runs.filter((x) => x.ok).length;
      console.log(
        row([
          r.label,
          String(r.runs.length),
          s2 ? String(s2.min) : '—',
          s2 ? String(s2.p50) : '—',
          s2 ? String(s2.p90) : '—',
          s2 ? String(s2.max) : '—',
          `${okCount}/${r.runs.length}`,
        ]),
      );
      const failed = r.runs.find((x) => !x.ok);
      if (failed) console.log(`  ${' '.repeat(2)}error: ${failed.error}`);
    }
    console.log('');
    console.log('All values in milliseconds. Headline metric per benchmark:');
    for (const r of results) console.log(`  ${r.label}: ${r.runs[0]?.headlineLabel ?? '—'}`);
    console.log('');
  }

  await tts?.close();
  bus.dispose();
  process.exit(0);
}

main().catch((e) => {
  console.error('bench failed:', e);
  process.exit(1);
});
