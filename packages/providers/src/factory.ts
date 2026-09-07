/**
 * Provider factory.
 *
 * The ONE place that knows which concrete vendor implements each interface.
 * Swapping Hamsa for another TTS engine means adding a case here and writing an
 * adapter -- the pipeline never changes.
 */

import type { LlmProvider, SttProvider, TtsProvider } from '@vll/core';
import { SpeechmaticsSttProvider, type SpeechmaticsOptions } from './speechmatics/rtStt.js';
import { OpenAiResponsesProvider, type OpenAiOptions } from './openai/responsesLlm.js';
import { HamsaTtsProvider, type HamsaProviderOptions } from './hamsa/index.js';

export interface ProviderCredentials {
  openaiApiKey?: string;
  speechmaticsApiKey?: string;
  hamsaApiKey?: string;
}

export type SttVendor = 'speechmatics';
export type LlmVendor = 'openai';
export type TtsVendor = 'hamsa';

export function createSttProvider(vendor: SttVendor, opts: SpeechmaticsOptions): SttProvider {
  switch (vendor) {
    case 'speechmatics':
      return new SpeechmaticsSttProvider(opts);
    default:
      throw new Error(`Unknown STT vendor: ${vendor}`);
  }
}

export function createLlmProvider(vendor: LlmVendor, opts: OpenAiOptions): LlmProvider {
  switch (vendor) {
    case 'openai':
      return new OpenAiResponsesProvider(opts);
    default:
      throw new Error(`Unknown LLM vendor: ${vendor}`);
  }
}

export function createTtsProvider(vendor: TtsVendor, opts: HamsaProviderOptions): TtsProvider {
  switch (vendor) {
    case 'hamsa':
      return new HamsaTtsProvider(opts);
    default:
      throw new Error(`Unknown TTS vendor: ${vendor}`);
  }
}
