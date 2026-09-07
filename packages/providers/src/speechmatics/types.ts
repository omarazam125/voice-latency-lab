/**
 * Speechmatics Realtime (RT) v2 wire types.
 *
 * Field names are taken verbatim from the official AsyncAPI specification
 * (spec/realtime.yaml) and the API reference, captured while implementing this
 * tool. Anything not in the spec is not modelled here.
 */

export type SmRegion = 'global' | 'eu' | 'us';

export const SM_ENDPOINTS: Record<SmRegion, string> = {
  // Routes to the nearest region automatically; recommended default.
  global: 'wss://global.rt.speechmatics.com/v2/',
  eu: 'wss://eu.rt.speechmatics.com/v2/',
  us: 'wss://us.rt.speechmatics.com/v2/',
};

/** Mint a short-lived realtime JWT (only needed for browser-side connections). */
export const SM_TEMP_KEY_URL = 'https://mp.speechmatics.com/v1/api_keys?type=rt';

/* -------------------------------------------------------------------------- */
/* Client -> server                                                            */
/* -------------------------------------------------------------------------- */

export interface SmRawAudioFormat {
  type: 'raw';
  encoding: 'pcm_f32le' | 'pcm_s16le' | 'mulaw';
  sample_rate: number;
}

export interface SmTranscriptionConfig {
  language: string;
  /** 'standard' = fastest, 'enhanced' = most accurate. Replaces operating_point. */
  model?: 'standard' | 'enhanced';
  output_locale?: string;
  additional_vocab?: Array<string | { content: string; sounds_like?: string[] }>;
  diarization?: 'none' | 'speaker' | 'channel' | 'channel_and_speaker';
  /** Seconds. Documented range 0.7 - 4. */
  max_delay?: number;
  max_delay_mode?: 'flexible' | 'fixed';
  enable_partials?: boolean;
  enable_entities?: boolean;
  punctuation_overrides?: { permitted_marks?: string[]; sensitivity?: number };
  /** Provider-side endpointing. 0 disables; documented max is 2 seconds. */
  conversation_config?: { end_of_utterance_silence_trigger: number };
  audio_filtering_config?: { volume_threshold: number };
  transcript_filtering_config?: { remove_disfluencies?: boolean };
}

export interface SmStartRecognition {
  message: 'StartRecognition';
  audio_format: SmRawAudioFormat | { type: 'file' };
  transcription_config: SmTranscriptionConfig;
  /** NOTE: a top-level sibling of transcription_config, not nested inside it. */
  translation_config?: { target_languages: string[]; enable_partials?: boolean };
  audio_events_config?: { types: string[] };
}

export interface SmSetRecognitionConfig {
  message: 'SetRecognitionConfig';
  transcription_config: Partial<SmTranscriptionConfig>;
}

export interface SmForceEndOfUtterance {
  message: 'ForceEndOfUtterance';
}

export interface SmEndOfStream {
  message: 'EndOfStream';
  last_seq_no: number;
}

/* -------------------------------------------------------------------------- */
/* Server -> client                                                            */
/* -------------------------------------------------------------------------- */

export interface SmRecognitionAlternative {
  content: string;
  confidence: number;
  language?: string;
  speaker?: string;
  display?: { direction: 'ltr' | 'rtl' };
  tags?: string[];
}

export interface SmRecognitionResult {
  type: 'word' | 'punctuation' | 'entity';
  start_time: number;
  end_time: number;
  attaches_to?: 'next' | 'previous' | 'none' | 'both';
  is_eos?: boolean;
  alternatives?: SmRecognitionAlternative[];
  volume?: number;
  entity_class?: string;
}

export interface SmRecognitionMetadata {
  start_time: number;
  end_time: number;
  transcript: string;
}

export interface SmTranscriptMessage {
  message: 'AddTranscript' | 'AddPartialTranscript';
  format?: string;
  metadata: SmRecognitionMetadata;
  results: SmRecognitionResult[];
  channel?: string;
  forced?: boolean;
}

export interface SmEndOfUtterance {
  message: 'EndOfUtterance';
  metadata: { start_time: number; end_time: number };
  channel?: string;
  forced?: boolean;
}

export interface SmRecognitionStarted {
  message: 'RecognitionStarted';
  id?: string;
  orchestrator_version?: string;
  language_pack_info?: {
    language_description?: string;
    word_delimiter: string;
    writing_direction?: 'left-to-right' | 'right-to-left';
    itn?: boolean;
    adapted?: boolean;
  };
}

export interface SmAudioAdded {
  message: 'AudioAdded';
  seq_no: number;
}

export interface SmError {
  message: 'Error';
  type?: string;
  reason?: string;
  code?: number;
  seq_no?: number;
}

export interface SmWarning {
  message: 'Warning';
  type?: string;
  reason?: string;
  code?: number;
}

export interface SmInfo {
  message: 'Info';
  type?: string;
  reason?: string;
  quality?: string;
}

export interface SmEndOfTranscript {
  message: 'EndOfTranscript';
}

export type SmServerMessage =
  | SmRecognitionStarted
  | SmAudioAdded
  | SmTranscriptMessage
  | SmEndOfUtterance
  | SmError
  | SmWarning
  | SmInfo
  | SmEndOfTranscript;

/**
 * Errors from which reconnecting could plausibly help. Anything else (bad
 * config, bad auth, quota) is surfaced immediately rather than retried, per
 * spec section 23.
 */
export const SM_RETRYABLE_ERROR_TYPES = new Set([
  'internal_error',
  'timelimit_exceeded',
  'job_error',
  'data_error',
  'buffer_error',
  'protocol_error',
]);
