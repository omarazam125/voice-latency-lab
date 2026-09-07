/**
 * Live conversation tracer.
 *
 * `npm run trace` (from apps/server), then make a call in the browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * The server log records only "session opened" and "session closed". When an
 * agent answers the wrong question, none of the information needed to find out
 * why is on disk: what the transcriber actually heard, which of several
 * candidate transcripts the pipeline chose to act on, what retrieval put in
 * front of the model, and what the model said back.
 *
 * A wrong answer has four quite different causes and they are indistinguishable
 * without seeing all four columns at once:
 *
 *   1. The transcriber misheard.            -> transcript is wrong
 *   2. The turn committed too early.        -> transcript is a fragment
 *   3. Retrieval injected the wrong context.-> chunks are off-topic
 *   4. The model ignored correct input.     -> everything above is right
 *
 * This attaches as an ordinary read-only client, so it observes the same
 * session the browser is driving without perturbing it.
 */

import WebSocket from 'ws';

const URL_ = process.env.TRACE_URL ?? 'ws://127.0.0.1:8787/ws';

const C = {
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  magenta: '[35m',
  cyan: '[36m',
  bold: '[1m',
  off: '[0m',
};

function ms(v: unknown): string {
  return typeof v === 'number' ? `${Math.round(v)}ms` : '—';
}

/** Arabic is RTL; a bare console print interleaves badly with latin labels. */
function quote(text: unknown): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 220 ? `${t.slice(0, 220)}…` : t;
}

let turnSeq = 0;

function main(): void {
  const ws = new WebSocket(URL_);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', clientInfo: { userAgent: 'trace-cli', sampleRate: 48000 } }));
    console.log(`${C.bold}Tracing ${URL_}${C.off}`);
    console.log(`${C.dim}Make a call in the browser. Ctrl+C to stop.${C.off}\n`);
  });

  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // binary audio frame
    }

    if (msg.type === 'session.status') {
      const s = msg.status;
      if (s?.ready !== undefined) {
        console.log(
          `${C.dim}[status] mode=${s.mode} ready=${s.ready} stt=${s.providers?.stt} llm=${s.providers?.llm} ` +
            `tts=${s.providers?.tts} kb=${s.rag?.documents}docs/${s.rag?.chunks}chunks${C.off}`,
        );
      }
      return;
    }

    const events = Array.isArray(msg.events) ? msg.events : [];
    for (const e of events) render(e);
  });

  ws.on('close', () => {
    console.log(`${C.red}socket closed${C.off}`);
    process.exit(0);
  });
  ws.on('error', (e) => {
    console.log(`${C.red}error: ${e.message}${C.off}`);
    process.exit(1);
  });
}

function render(e: any): void {
  const m = e.metadata ?? {};
  const at = e.elapsedFromSpeechEndMs;
  const t = at == null ? '' : `${C.dim}+${Math.round(at)}ms${C.off} `;

  switch (e.event) {
    case 'turn.started':
      turnSeq++;
      console.log(`\n${C.bold}${C.blue}━━━ TURN ${turnSeq} ━━━${C.off}`);
      break;

    case 'vad.speech_ended':
      console.log(`${t}${C.dim}caller stopped speaking${C.off}`);
      break;

    case 'turn.endpoint_detected':
      console.log(
        `${t}${C.cyan}endpoint${C.off} ${C.dim}(detection cost ${ms(m.endpointDetectionDelayMs)}, ` +
          `source ${m.source ?? '?'})${C.off}`,
      );
      break;

    /* -- what was heard --------------------------------------------------- */
    case 'stt.first_partial':
      console.log(`${t}${C.dim}first partial:${C.off} ${quote(m.text)}`);
      break;

    case 'stt.final':
      console.log(
        `${t}${m.late ? C.yellow : C.green}FINAL${C.off}${m.late ? ' (late)' : ''}: ${C.bold}${quote(m.text)}${C.off}`,
      );
      if (m.late && m.diverged) {
        console.log(
          `      ${C.red}${C.bold}DIVERGED${C.off} ${C.red}from what we acted on ` +
            `(agreement ${m.agreement?.toFixed?.(2) ?? '?'}) — the answer was built on the wrong words${C.off}`,
        );
      }
      break;

    /* -- what the pipeline ACTED on --------------------------------------- */
    case 'stt.usable_transcript':
      console.log(
        `${t}${C.magenta}${C.bold}ACTED ON${C.off} ${C.magenta}[${m.source}${m.provisional ? ', PROVISIONAL' : ''}]${C.off}: ` +
          `${C.bold}${quote(m.text)}${C.off}`,
      );
      break;

    /* -- what context was injected ---------------------------------------- */
    case 'rag.completed': {
      const hits = m.chunks ?? m.hits ?? m.count;
      console.log(`${t}${C.yellow}retrieval${C.off} ${C.dim}${hits ?? '?'} chunks in ${ms(m.durationMs)}${C.off}`);
      const sources = m.sources ?? m.files;
      if (Array.isArray(sources) && sources.length) {
        console.log(`      ${C.dim}from: ${sources.join(', ')}${C.off}`);
      }
      if (m.topScore != null) console.log(`      ${C.dim}top score ${m.topScore}${C.off}`);
      break;
    }

    case 'rag.skipped':
      console.log(`${t}${C.dim}retrieval skipped (${m.reason ?? '?'})${C.off}`);
      break;

    /* -- what the model got and said -------------------------------------- */
    case 'llm.request_started':
      console.log(
        `${t}${C.dim}model request: ${m.model ?? '?'}, ~${m.estimatedInputTokens ?? m.inputTokens ?? '?'} input tokens` +
          `${m.historyTurns != null ? `, ${m.historyTurns} history turns` : ''}${C.off}`,
      );
      break;

    case 'llm.first_delta':
      console.log(`${t}${C.green}first token${C.off} ${C.dim}${quote(m.text)}${C.off}`);
      break;

    case 'llm.completed':
      console.log(`${t}${C.green}${C.bold}ANSWER${C.off}: ${quote(m.text)}`);
      console.log(
        `      ${C.dim}${m.outputTokens ?? '?'} tokens, generated in ${ms(m.durationMs ?? m.completionMs)}${C.off}`,
      );
      break;

    /* -- barge-in --------------------------------------------------------- */
    case 'vad.barge_in_detected':
      console.log(`${t}${C.yellow}barge-in detected${C.off} ${C.dim}(classified: ${m.classified})${C.off}`);
      break;

    case 'vad.barge_in_classified':
      console.log(
        `${t}${m.interrupt ? C.red : C.green}barge-in verdict: ${m.interrupt ? 'INTERRUPT' : 'backchannel, keep talking'}${C.off} ` +
          `${C.dim}"${quote(m.transcript)}" — ${m.reason}${C.off}`,
      );
      break;

    /* -- audio out --------------------------------------------------------- */
    case 'tts.first_audio':
      if (m.phraseSeq === 0 || m.phraseSeq === undefined) {
        console.log(`${t}${C.green}first audio byte${C.off}${m.cacheHit ? ` ${C.dim}(cache hit)${C.off}` : ''}`);
      }
      break;

    case 'audio.first_heard':
      console.log(`${t}${C.bold}${C.green}CALLER HEARS AUDIO${C.off}`);
      break;

    /* -- anything going wrong --------------------------------------------- */
    case 'stt.error':
    case 'llm.error':
    case 'tts.error':
    case 'rag.error':
      console.log(`${t}${C.red}${C.bold}${e.event}${C.off} ${C.red}${m.message ?? ''} ${m.hint ?? ''}${C.off}`);
      break;

    case 'turn.cancelled':
      console.log(`${t}${C.yellow}turn cancelled (${m.reason ?? '?'})${C.off}`);
      break;

    default:
      break;
  }
}

main();
