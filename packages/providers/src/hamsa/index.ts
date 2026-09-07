/**
 * Hamsa TTS provider facade.
 *
 * Owns transport selection, the cloned-voice preload (which must happen at
 * application startup, never on the first conversational turn) and the voice
 * catalogue lookup.
 */

import type {
  AudioFormat,
  ConnectionState,
  TtsCallbacks,
  TtsHandle,
  TtsProvider,
  TtsSynthesisRequest,
  TtsVoice,
} from '@vll/core';
import { HamsaHttpTransport, HamsaWebSocketTransport, type HamsaTransportOptions } from './transports.js';
import {
  HAMSA_MULAW_SAMPLE_RATE,
  HAMSA_PCM_SAMPLE_RATE_16K,
  HAMSA_PCM_SAMPLE_RATE_8K,
  HAMSA_PRELOAD_URL,
  HAMSA_VOICES_CATALOG_URL,
  isClonedVoiceId,
  type HamsaVoiceCatalogResponse,
} from './types.js';

export * from './types.js';
export * from './transports.js';

export interface HamsaProviderOptions extends HamsaTransportOptions {
  transport: 'websocket' | 'http';
  /** Output format the transports were asked to produce. */
  sampleRate?: '8k' | '16k';
  mulaw?: boolean;
}

export class HamsaTtsProvider implements TtsProvider {
  readonly name = 'hamsa';
  private ws: HamsaWebSocketTransport | null = null;
  private http: HamsaHttpTransport | null = null;
  private preloaded = new Set<string>();
  private rawLogger?: (dir: 'in' | 'out', payload: unknown) => void;

  constructor(private opts: HamsaProviderOptions) {
    if (!opts.apiKey) throw new Error('HAMSA_API_KEY is required');
    this.buildTransport();
  }

  private buildTransport(): void {
    if (this.opts.transport === 'websocket') {
      this.ws = new HamsaWebSocketTransport(this.opts);
      this.ws.setRawLogger(this.rawLogger);
      this.http = null;
    } else {
      this.http = new HamsaHttpTransport(this.opts);
      this.http.setRawLogger(this.rawLogger);
      this.ws = null;
    }
  }

  setRawLogger(fn?: (dir: 'in' | 'out', payload: unknown) => void): void {
    this.rawLogger = fn;
    this.ws?.setRawLogger(fn);
    this.http?.setRawLogger(fn);
  }

  /** Switch transport at runtime so both can be benchmarked in one session. */
  async setTransport(t: 'websocket' | 'http'): Promise<void> {
    if (t === this.opts.transport) return;
    await this.close();
    this.opts = { ...this.opts, transport: t };
    this.buildTransport();
    await this.connect();
  }

  updateFormat(sampleRate: '8k' | '16k', mulaw: boolean): void {
    this.opts = { ...this.opts, sampleRate, mulaw };
  }

  get transport(): 'websocket' | 'http' {
    return this.opts.transport;
  }

  get state(): ConnectionState {
    return (this.ws ?? this.http)?.state ?? 'idle';
  }

  get warm(): boolean {
    return (this.ws ?? this.http)?.warm ?? false;
  }

  get queueDepth(): number {
    return (this.ws ?? this.http)?.queueDepth ?? 0;
  }

  get audioFormat(): AudioFormat {
    if (this.opts.mulaw) {
      return { sampleRate: HAMSA_MULAW_SAMPLE_RATE, channels: 1, encoding: 'mulaw' };
    }
    return {
      sampleRate: this.opts.sampleRate === '8k' ? HAMSA_PCM_SAMPLE_RATE_8K : HAMSA_PCM_SAMPLE_RATE_16K,
      channels: 1,
      encoding: 'pcm_s16le',
    };
  }

  async connect(): Promise<void> {
    await (this.ws ?? this.http)!.connect();
  }

  /**
   * Preload a cloned voice. Hamsa's documentation is explicit that without this
   * the FIRST realtime request using a custom voice pays the model-load cost --
   * exactly the kind of one-off latency that would otherwise contaminate the
   * first measured turn.
   *
   * Built-in voices are referenced by name and need no preload, so a non-UUID
   * speaker is reported as a no-op rather than failing.
   */
  async preloadVoice(voiceId: string): Promise<{ preloaded: boolean; required: boolean; message?: string }> {
    const id = voiceId?.trim();
    if (!id) return { preloaded: false, required: false, message: 'no speaker configured' };
    if (!isClonedVoiceId(id)) {
      // Built-in voices are referenced by name and need no preload. This is a
      // normal outcome, not an error.
      return { preloaded: false, required: false, message: 'built-in voice; preload not required' };
    }
    if (this.preloaded.has(id)) return { preloaded: true, required: true, message: 'already preloaded' };

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30_000);
    try {
      const res = await fetch(HAMSA_PRELOAD_URL, {
        method: 'POST',
        headers: { Authorization: `Token ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: id }),
        signal: ac.signal,
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        let message = `preload failed: HTTP ${res.status}`;
        try {
          message = JSON.parse(text)?.message ?? message;
        } catch {
          /* keep default */
        }
        return { preloaded: false, required: true, message };
      }
      this.preloaded.add(id);
      let message = 'preloaded';
      try {
        message = JSON.parse(text)?.message ?? message;
      } catch {
        /* keep default */
      }
      return { preloaded: true, required: true, message };
    } catch (e: any) {
      return { preloaded: false, required: true, message: e?.message ?? String(e) };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * The published docs list conflicting built-in voice names across pages, so
   * the UI always loads the real list from the API rather than hardcoding one.
   */
  async listVoices(): Promise<TtsVoice[]> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15_000);
    try {
      const res = await fetch(HAMSA_VOICES_CATALOG_URL, {
        headers: { Authorization: `Token ${this.opts.apiKey}` },
        signal: ac.signal,
      });
      if (!res.ok) return [];
      const json = (await res.json()) as HamsaVoiceCatalogResponse;
      return (json.voices ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        language: v.language,
        gender: v.gender ?? null,
        isCustom: undefined,
      }));
    } catch {
      return [];
    } finally {
      clearTimeout(t);
    }
  }

  synthesize(req: TtsSynthesisRequest, cb: TtsCallbacks): TtsHandle {
    const merged: TtsSynthesisRequest = {
      ...req,
      sampleRate: req.sampleRate ?? this.opts.sampleRate ?? '16k',
      mulaw: req.mulaw ?? this.opts.mulaw ?? false,
    };
    return (this.ws ?? this.http)!.synthesize(merged, cb);
  }

  async close(): Promise<void> {
    await (this.ws ?? this.http)?.close();
  }
}
