/**
 * OpenAI Responses API adapter with SSE streaming.
 *
 * Implementation notes tied to documented behaviour:
 *
 *   - POST /v1/responses with `stream: true`. The Responses API uses `input`
 *     (not `messages`), `instructions` (not a system message) and
 *     `max_output_tokens` (not `max_tokens`).
 *   - Text arrives on `response.output_text.delta`. We act on the FIRST delta
 *     immediately and never wait for `response.completed`.
 *   - `stream_options.include_obfuscation: false` removes padding bytes that
 *     are on by default; a small but free bandwidth win on the hot path.
 *   - Retries are DISABLED. Spec section 23 forbids hidden retries on the
 *     latency-critical path; a failure is surfaced and recorded instead.
 *   - Cancellation uses AbortController. The HTTP /cancel endpoint only works
 *     for `background: true` responses, which we never use because background
 *     mode is documented to WORSEN time-to-first-token.
 */

import type {
  LlmCallbacks,
  LlmProvider,
  LlmRequest,
  LlmStreamHandle,
  ProviderError,
} from '@vll/core';
import { SseParser } from './sse.js';

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  /** Hard ceiling on a single streamed response. */
  requestTimeoutMs?: number;
  /** Fail the turn if no first token arrives within this window. */
  firstTokenTimeoutMs?: number;
}

const DEFAULT_BASE = 'https://api.openai.com/v1';

interface StreamEvent {
  type?: string;
  delta?: string;
  response?: { id?: string; usage?: unknown; status?: string; error?: unknown; incomplete_details?: unknown };
  sequence_number?: number;
  item_id?: string;
  error?: { message?: string; type?: string; code?: string };
  message?: string;
}

export class OpenAiResponsesProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenAiOptions) {
    if (!opts.apiKey) throw new Error('OPENAI_API_KEY is required');
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (this.opts.organization) h['OpenAI-Organization'] = this.opts.organization;
    if (this.opts.project) h['OpenAI-Project'] = this.opts.project;
    return h;
  }

  /**
   * Establish the TLS/HTTP connection so the first real turn does not pay for
   * the handshake. Deliberately a cheap GET, not a model call.
   */
  async warmup(_model: string): Promise<void> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5_000);
    try {
      await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        signal: ac.signal,
      }).then((r) => r.arrayBuffer().catch(() => undefined));
    } catch {
      // Warm-up is best effort; a failure here must not block the session.
    } finally {
      clearTimeout(t);
    }
  }

  buildBody(req: LlmRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.instructions,
      input: req.input.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      // Padding bytes are on by default and cost bandwidth on every delta.
      stream_options: { include_obfuscation: false },
      max_output_tokens: req.maxOutputTokens,
      store: req.store ?? false,
    };
    // Only send optional fields when set: reasoning models reject some of them,
    // and an unexpected null is an easy way to get an opaque 400 mid-benchmark.
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
    if (req.verbosity) body.text = { verbosity: req.verbosity };
    if (req.serviceTier && req.serviceTier !== 'auto') body.service_tier = req.serviceTier;
    if (req.promptCacheKey) body.prompt_cache_key = req.promptCacheKey;
    return body;
  }

  stream(req: LlmRequest, cb: LlmCallbacks): LlmStreamHandle {
    const ac = new AbortController();
    let cancelled = false;
    let text = '';
    let sawFirst = false;

    const handle: LlmStreamHandle = {
      cancel: (reason?: string) => {
        if (cancelled) return;
        cancelled = true;
        try {
          ac.abort(reason ?? 'cancelled');
        } catch {
          /* ignore */
        }
      },
      get cancelled() {
        return cancelled;
      },
      done: Promise.resolve({ text: '', cancelled: false }),
    };

    const run = async (): Promise<{ text: string; cancelled: boolean; error?: ProviderError }> => {
      const overall = setTimeout(() => {
        if (!cancelled) {
          cancelled = true;
          ac.abort('request_timeout');
        }
      }, this.opts.requestTimeoutMs ?? 60_000);

      let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
      if (this.opts.firstTokenTimeoutMs) {
        firstTokenTimer = setTimeout(() => {
          if (!sawFirst && !cancelled) {
            cancelled = true;
            ac.abort('first_token_timeout');
          }
        }, this.opts.firstTokenTimeoutMs);
      }

      try {
        const body = this.buildBody(req);
        cb.onRaw?.('request', body);

        const res = await fetch(`${this.baseUrl}/responses`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          const raw = await res.text().catch(() => '');
          let message = `OpenAI HTTP ${res.status}`;
          let code: string | undefined;
          try {
            const j = JSON.parse(raw);
            message = j?.error?.message ?? message;
            code = j?.error?.code ?? j?.error?.type;
          } catch {
            if (raw) message = `${message}: ${raw.slice(0, 400)}`;
          }
          const e: ProviderError = {
            provider: 'openai',
            code: code ?? res.status,
            message,
            // 429 and 5xx could succeed on retry, but we never retry silently:
            // the caller decides, and the retry is recorded on the monitor.
            retryable: res.status === 429 || res.status >= 500,
          };
          cb.onError?.(e);
          return { text, cancelled, error: e };
        }

        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const messages = parser.push(decoder.decode(value, { stream: true }));
          for (const m of messages) {
            if (m.data === '[DONE]') continue;
            let ev: StreamEvent;
            try {
              ev = JSON.parse(m.data) as StreamEvent;
            } catch {
              continue;
            }
            const type = ev.type ?? m.event ?? 'unknown';
            cb.onRaw?.(type, ev);

            switch (type) {
              case 'response.created':
                cb.onCreated?.({ responseId: ev.response?.id, raw: ev });
                break;

              case 'response.output_text.delta': {
                const d = ev.delta ?? '';
                if (!d) break;
                text += d;
                if (!sawFirst) {
                  sawFirst = true;
                  if (firstTokenTimer) clearTimeout(firstTokenTimer);
                  cb.onFirstDelta?.(d);
                }
                cb.onDelta?.(d);
                break;
              }

              case 'response.completed':
                cb.onCompleted?.({ text, usage: ev.response?.usage, raw: ev });
                break;

              case 'response.failed':
              case 'response.incomplete': {
                const e: ProviderError = {
                  provider: 'openai',
                  code: type,
                  message:
                    (ev.response?.error as any)?.message ??
                    JSON.stringify(ev.response?.incomplete_details ?? {}) ??
                    type,
                  retryable: false,
                };
                cb.onError?.(e);
                return { text, cancelled, error: e };
              }

              case 'error': {
                const e: ProviderError = {
                  provider: 'openai',
                  code: ev.error?.code ?? ev.error?.type ?? 'error',
                  message: ev.error?.message ?? ev.message ?? 'stream error',
                  retryable: false,
                };
                cb.onError?.(e);
                return { text, cancelled, error: e };
              }

              default:
                // Reasoning deltas, item lifecycle, tool events: recorded via
                // onRaw for the debug panel but not on the speech path.
                break;
            }
          }
        }
        for (const m of parser.finish()) {
          if (m.data && m.data !== '[DONE]') cb.onRaw?.('trailing', m.data);
        }
        return { text, cancelled };
      } catch (err: any) {
        if (err?.name === 'AbortError' || cancelled) return { text, cancelled: true };
        const e: ProviderError = {
          provider: 'openai',
          code: err?.code ?? 'network_error',
          message: err?.message ?? String(err),
          retryable: true,
          cause: err,
        };
        cb.onError?.(e);
        return { text, cancelled, error: e };
      } finally {
        clearTimeout(overall);
        if (firstTokenTimer) clearTimeout(firstTokenTimer);
      }
    };

    handle.done = run();
    return handle;
  }
}
