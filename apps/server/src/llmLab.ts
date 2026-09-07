/**
 * GPT-4.1 investigation suite (spec sections 8, 34-38).
 *
 * Exists to answer one question with data: when the same model is fast in one
 * system and slow in another, is it the MODEL or the CONTEXT we hand it?
 *
 * Every probe measures TIME TO FIRST TEXT DELTA and nothing else. Total
 * generation time is recorded alongside it but never substituted for it —
 * conflating the two is the most common way a latency investigation goes wrong.
 */

import { deltaMs, nowNs, roundMs, summarize, type Summary } from '@vll/telemetry';
import { estimateTokens, type LlmProvider, type SessionConfig } from '@vll/core';
import type { KnowledgeBase } from '@vll/rag';

export interface LlmProbeRun {
  ok: boolean;
  error?: string;
  /** Request sent -> first text delta. THE metric. */
  ttftMs: number | null;
  /** Request sent -> response.created. */
  createdMs: number | null;
  /** Request sent -> stream finished. Reported separately, never as TTFT. */
  completionMs: number | null;
  outputChars: number;
  estimatedInputTokens: number;
  /** Exact counts from the provider's own usage report, when it returns one. */
  usage?: unknown;
  sample: string;
}

export interface LlmProbeResult {
  id: string;
  label: string;
  description: string;
  runs: LlmProbeRun[];
  ttft: Summary | null;
  completion: Summary | null;
  estimatedInputTokens: number;
  systemPromptChars: number;
  ragChars: number;
  historyChars: number;
  userChars: number;
  /** Cacheable prefix vs volatile suffix, for the prompt-caching analysis. */
  staticPrefixChars: number;
  dynamicSuffixChars: number;
}

export interface LlmLabDeps {
  llm: LlmProvider;
  kb: KnowledgeBase | null;
  config: SessionConfig;
}

const MINIMAL_PROMPT = 'You are a helpful assistant.';
const MINIMAL_USER = 'Say hello.';
const AR_USER = 'شو الخدمات المتوفرة عندكم؟';

export type LlmProbeId =
  | 'minimal'
  | 'production_prompt'
  | 'production_plus_rag'
  | 'production_plus_rag_history'
  | 'no_rag';

export const LLM_PROBE_CATALOG: Array<{ id: LlmProbeId; label: string; description: string }> = [
  {
    id: 'minimal',
    label: 'Minimal prompt',
    description: 'A 29-character system prompt and a three-word question. The model\'s floor on this network.',
  },
  {
    id: 'no_rag',
    label: 'Production prompt, no RAG',
    description: 'Your real agent prompt with a real question, but no retrieved context.',
  },
  {
    id: 'production_prompt',
    label: 'Production prompt only',
    description: 'The production system prompt with the short user question. Isolates prompt-length cost.',
  },
  {
    id: 'production_plus_rag',
    label: 'Production prompt + RAG',
    description: 'Adds real retrieved knowledge-base context. The difference from the previous row is what context costs.',
  },
  {
    id: 'production_plus_rag_history',
    label: 'Production + RAG + history',
    description: 'Full production shape, including conversation history.',
  },
];

export class LlmLab {
  constructor(private readonly deps: LlmLabDeps) {}

  private async buildRag(query: string): Promise<string> {
    const { kb, config } = this.deps;
    if (!kb || !config.rag.enabled) return '';
    const r = await kb.search(query, { topK: config.rag.topK, minScore: config.rag.minScore });
    if (r.chunks.length === 0) return '';
    const header =
      config.language === 'ar'
        ? 'معلومات من قاعدة المعرفة:'
        : 'Knowledge base context:';
    return `${header}\n\n${r.chunks.map((c) => `[${c.source.filename}]\n${c.text}`).join('\n\n---\n\n')}`.slice(
      0,
      config.rag.maxContextChars,
    );
  }

  private fakeHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [
      { role: 'user', content: 'السلام عليكم' },
      { role: 'assistant', content: 'وعليكم السلام، كيف أقدر أساعدك؟' },
      { role: 'user', content: 'بدي أسأل عن شغلة' },
      { role: 'assistant', content: 'تفضل، أنا أسمعك.' },
    ];
  }

  async run(id: LlmProbeId, repetitions = 5, onProgress?: (s: string) => void): Promise<LlmProbeResult> {
    const meta = LLM_PROBE_CATALOG.find((p) => p.id === id)!;
    const cfg = this.deps.config;

    const useProduction = id !== 'minimal';
    const systemPrompt = useProduction ? cfg.systemPrompt : MINIMAL_PROMPT;
    const userText = useProduction ? AR_USER : MINIMAL_USER;
    const ragText =
      id === 'production_plus_rag' || id === 'production_plus_rag_history' ? await this.buildRag(userText) : '';
    const history = id === 'production_plus_rag_history' ? this.fakeHistory() : [];

    const historyChars = history.reduce((n, m) => n + m.content.length, 0);
    const estimatedInputTokens =
      estimateTokens(systemPrompt) + estimateTokens(ragText) + estimateTokens(userText) + estimateTokens(history.map((h) => h.content).join(' '));

    const runs: LlmProbeRun[] = [];
    for (let i = 0; i < repetitions; i++) {
      onProgress?.(`${meta.label} ${i + 1}/${repetitions}`);
      runs.push(await this.once(systemPrompt, history, ragText, userText, estimatedInputTokens));
      // Space the requests so provider-side warming does not dominate.
      if (i < repetitions - 1) await sleep(250);
    }

    const ok = runs.filter((r) => r.ok);
    return {
      id,
      label: meta.label,
      description: meta.description,
      runs,
      ttft: ok.length ? summarize(ok.map((r) => r.ttftMs!).filter((v) => v != null)) : null,
      completion: ok.length ? summarize(ok.map((r) => r.completionMs!).filter((v) => v != null)) : null,
      estimatedInputTokens,
      systemPromptChars: systemPrompt.length,
      ragChars: ragText.length,
      historyChars,
      userChars: userText.length,
      // Static prefix first, dynamic suffix last: the ordering that gives a
      // provider prompt cache something stable to match on.
      staticPrefixChars: systemPrompt.length + historyChars,
      dynamicSuffixChars: ragText.length + userText.length,
    };
  }

  private async once(
    systemPrompt: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    ragText: string,
    userText: string,
    estimatedInputTokens: number,
  ): Promise<LlmProbeRun> {
    const cfg = this.deps.config;
    const input: Array<{ role: any; content: string }> = [...history];
    if (ragText) input.push({ role: 'developer', content: ragText });
    input.push({ role: 'user', content: userText });

    const t0 = nowNs();
    let createdNs: bigint | null = null;
    let firstNs: bigint | null = null;
    let usage: unknown;

    const h = this.deps.llm.stream(
      {
        model: cfg.llm.model,
        instructions: systemPrompt,
        input,
        maxOutputTokens: cfg.llm.maxOutputTokens,
        temperature: cfg.llm.temperature ?? undefined,
        reasoningEffort: cfg.llm.reasoningEffort,
        verbosity: cfg.llm.verbosity,
        serviceTier: cfg.llm.serviceTier,
        store: false,
        promptCacheKey: `vll_lab_${systemPrompt.length}`,
      },
      {
        onCreated: () => (createdNs = nowNs()),
        onFirstDelta: () => (firstNs = nowNs()),
        onCompleted: (i) => (usage = i.usage),
      },
    );

    const out = await h.done;
    const doneNs = nowNs();

    return {
      ok: !out.error && firstNs !== null,
      error: out.error?.message,
      ttftMs: firstNs ? roundMs(deltaMs(t0, firstNs)) : null,
      createdMs: createdNs ? roundMs(deltaMs(t0, createdNs)) : null,
      completionMs: roundMs(deltaMs(t0, doneNs)),
      outputChars: out.text.length,
      estimatedInputTokens,
      usage,
      sample: out.text.trim().slice(0, 120),
    };
  }

  /**
   * Context-size sweep: pad the prompt to a series of target token counts and
   * measure TTFT at each. Answers directly whether prompt PREFILL is what makes
   * the same model slow in production.
   */
  async contextSweep(
    targets: number[],
    repetitions = 3,
    onProgress?: (s: string) => void,
  ): Promise<Array<{ targetTokens: number; estimatedTokens: number; promptChars: number; ttft: Summary | null }>> {
    const cfg = this.deps.config;
    const out: Array<{ targetTokens: number; estimatedTokens: number; promptChars: number; ttft: Summary | null }> = [];

    for (const target of targets) {
      onProgress?.(`context sweep ${target} tokens`);
      // Filler is neutral, repetitive prose: it changes prompt LENGTH without
      // changing the task, which is the variable under test.
      const filler = buildFiller(target, cfg.systemPrompt);
      const values: number[] = [];
      for (let i = 0; i < repetitions; i++) {
        const t0 = nowNs();
        let firstNs: bigint | null = null;
        const h = this.deps.llm.stream(
          {
            model: cfg.llm.model,
            instructions: filler,
            input: [{ role: 'user', content: AR_USER }],
            maxOutputTokens: 60,
            temperature: cfg.llm.temperature ?? undefined,
            reasoningEffort: cfg.llm.reasoningEffort,
            verbosity: cfg.llm.verbosity,
            store: false,
          },
          { onFirstDelta: () => (firstNs = nowNs()) },
        );
        const r = await h.done;
        if (!r.error && firstNs) values.push(roundMs(deltaMs(t0, firstNs)));
        await sleep(200);
      }
      out.push({
        targetTokens: target,
        estimatedTokens: estimateTokens(filler),
        promptChars: filler.length,
        ttft: values.length ? summarize(values) : null,
      });
    }
    return out;
  }
}

function buildFiller(targetTokens: number, seed: string): string {
  const base = seed || 'You are a helpful call-centre assistant.';
  const unit =
    '\nسياسة إضافية: يجب على الموظف الالتزام بالإجراءات المعتمدة وتوثيق كل طلب في النظام قبل إغلاقه.';
  let out = base;
  // estimateTokens is the same estimator used everywhere else, so the sweep's
  // x-axis is consistent with the token numbers shown elsewhere in the UI.
  let guard = 0;
  while (estimateTokens(out) < targetTokens && guard++ < 20_000) out += unit;
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/* -------------------------------------------------------------------------- */
/* Raw provider benchmark (spec section 35)                                    */
/* -------------------------------------------------------------------------- */

export interface RawApiRun {
  ok: boolean;
  error?: string;
  /** Request issued -> response headers received. */
  headersMs: number | null;
  /** Request issued -> first SSE event of any kind. */
  firstEventMs: number | null;
  /** Request issued -> first TEXT delta. The number that matters. */
  firstTextMs: number | null;
  completeMs: number | null;
  events: number;
  outputChars: number;
}

export interface RawApiResult {
  model: string;
  requests: number;
  runs: RawApiRun[];
  headers: Summary | null;
  firstEvent: Summary | null;
  firstText: Summary | null;
  complete: Summary | null;
  note: string;
}

/**
 * Bare HTTP benchmark against the provider, bypassing every part of our own
 * pipeline.
 *
 * The team reported "the LLM takes 2-3 seconds even via curl". `curl`'s total
 * time is the wrong measurement — it includes generating the ENTIRE response.
 * This separates header arrival, first SSE event and first TEXT delta, which is
 * what a voice pipeline actually waits for.
 */
export async function rawApiBenchmark(args: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  requests?: number;
  instructions?: string;
  userText?: string;
  maxOutputTokens?: number;
  reasoningEffort?: string | null;
  onProgress?: (s: string) => void;
}): Promise<RawApiResult> {
  const base = (args.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const n = Math.max(1, Math.min(50, args.requests ?? 10));
  const runs: RawApiRun[] = [];

  for (let i = 0; i < n; i++) {
    args.onProgress?.(`raw request ${i + 1}/${n}`);
    const t0 = nowNs();
    let headersNs: bigint | null = null;
    let firstEventNs: bigint | null = null;
    let firstTextNs: bigint | null = null;
    let events = 0;
    let chars = 0;

    try {
      const body: Record<string, unknown> = {
        model: args.model,
        instructions: args.instructions ?? 'Reply in one short sentence.',
        input: [{ role: 'user', content: args.userText ?? AR_USER }],
        stream: true,
        stream_options: { include_obfuscation: false },
        max_output_tokens: args.maxOutputTokens ?? 60,
        store: false,
      };
      if (args.reasoningEffort) body.reasoning = { effort: args.reasoningEffort };

      const res = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
      headersNs = nowNs();

      if (!res.ok || !res.body) {
        const raw = await res.text().catch(() => '');
        runs.push({
          ok: false,
          error: `HTTP ${res.status}: ${raw.slice(0, 200)}`,
          headersMs: roundMs(deltaMs(t0, headersNs)),
          firstEventMs: null,
          firstTextMs: null,
          completeMs: null,
          events: 0,
          outputChars: 0,
        });
        continue;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstEventNs === null) firstEventNs = nowNs();
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          events++;
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const ev = JSON.parse(data);
            if (ev.type === 'response.output_text.delta' && ev.delta) {
              if (firstTextNs === null) firstTextNs = nowNs();
              chars += String(ev.delta).length;
            }
          } catch {
            /* ignore malformed frame */
          }
        }
      }

      const doneNs = nowNs();
      runs.push({
        ok: firstTextNs !== null,
        headersMs: roundMs(deltaMs(t0, headersNs)),
        firstEventMs: firstEventNs ? roundMs(deltaMs(t0, firstEventNs)) : null,
        firstTextMs: firstTextNs ? roundMs(deltaMs(t0, firstTextNs)) : null,
        completeMs: roundMs(deltaMs(t0, doneNs)),
        events,
        outputChars: chars,
      });
    } catch (e: any) {
      runs.push({
        ok: false,
        error: e?.message ?? String(e),
        headersMs: null,
        firstEventMs: null,
        firstTextMs: null,
        completeMs: null,
        events,
        outputChars: chars,
      });
    }
    await sleep(200);
  }

  const pick = (f: (r: RawApiRun) => number | null) =>
    runs.map(f).filter((v): v is number => v != null && Number.isFinite(v));
  const s = (vals: number[]) => (vals.length ? summarize(vals) : null);

  return {
    model: args.model,
    requests: n,
    runs,
    headers: s(pick((r) => r.headersMs)),
    firstEvent: s(pick((r) => r.firstEventMs)),
    firstText: s(pick((r) => r.firstTextMs)),
    complete: s(pick((r) => r.completeMs)),
    note:
      'The first request in a batch usually includes TLS and connection setup. Compare run 1 against later runs to see cold-start networking cost separately from model latency.',
  };
}
