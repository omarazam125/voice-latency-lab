/**
 * MODE C configuration — Vapi-style voice orchestration.
 *
 * SCOPE: every setting in this file applies ONLY when `SessionConfig.mode === 'C'`.
 * Mode B is untouched by anything here, which keeps the comparison valid:
 * Mode C adds a second data point, it does not redefine the first.
 *
 * NAMING: field names deliberately mirror the publicly documented Vapi
 * configuration surface (`startSpeakingPlan`, `stopSpeakingPlan`,
 * `voice.chunkPlan`) so an engineer who knows that product can map settings
 * one-to-one. This is a reproduction of PUBLICLY DOCUMENTED BEHAVIOUR using our
 * own code; it is not, and does not claim to be, Vapi's internal implementation.
 */

import {
  clampBackgroundAudioConfig,
  defaultBackgroundAudioConfig,
  type BackgroundAudioConfig,
} from './backgroundAudio.js';

/* -------------------------------------------------------------------------- */
/* Endpointing                                                                 */
/* -------------------------------------------------------------------------- */

export type EndpointingStrategy =
  /** Fixed trailing-silence timer. What Modes A and B use. */
  | 'vad_silence'
  /** Punctuation- and content-aware timers driven by the live transcript. */
  | 'vapi_transcription'
  /** Transcription rules, but a VAD silence ceiling always wins. */
  | 'hybrid';

export interface CustomEndpointingRule {
  name: string;
  /** JavaScript regular expression source, tested against the live transcript. */
  pattern: string;
  /** Silence required, in seconds, when this rule matches. */
  seconds: number;
  enabled: boolean;
}

export interface EndpointingConfig {
  strategy: EndpointingStrategy;

  /**
   * Minimum silence before the turn can be committed at all, regardless of how
   * complete the text looks. Guards against committing on a mid-sentence pause.
   */
  waitSeconds: number;

  /** Silence required when the transcript ends in sentence punctuation. */
  onPunctuationSeconds: number;

  /** Silence required when the transcript ends with no punctuation at all. */
  onNoPunctuationSeconds: number;

  /**
   * Silence required when the transcript ends in a number. Deliberately longer
   * than punctuation: a caller reading an account number pauses between groups
   * of digits, and committing there cuts them off mid-number.
   */
  onNumberSeconds: number;

  /** Absolute ceiling. The turn commits after this much silence no matter what. */
  maxWaitSeconds: number;

  /** How long a partial must be unchanged before it counts as stable. */
  transcriptStabilityMs: number;

  /**
   * Stability score in [0,1] required before a punctuation-based early commit is
   * allowed. A false endpoint is expensive -- it cuts the caller off -- so this
   * is the safety valve on the aggressive path.
   */
  minStabilityScore: number;

  /** Require at least this many words before any commit. Rejects noise blips. */
  minWords: number;

  customRules: CustomEndpointingRule[];
}

/* -------------------------------------------------------------------------- */
/* Interruption                                                                */
/* -------------------------------------------------------------------------- */

export interface StopSpeakingConfig {
  enabled: boolean;

  /**
   * Words the caller must speak before an interruption is honoured.
   * 0 means interrupt on voice activity alone -- the most responsive setting,
   * and the most vulnerable to echo if the microphone hears the assistant.
   */
  numWords: number;

  /** Seconds of continuous voice activity required to interrupt. */
  voiceSeconds: number;

  /** After an interruption, ignore further interruptions for this long. */
  backoffSeconds: number;

  /**
   * Backchannel phrases. The caller saying these is agreement, not an attempt to
   * take the floor, so the assistant keeps talking.
   */
  acknowledgementPhrases: string[];

  /** Phrases that always interrupt immediately, whatever the word threshold. */
  interruptionPhrases: string[];
}

/* -------------------------------------------------------------------------- */
/* Voice chunk plan                                                            */
/* -------------------------------------------------------------------------- */

export interface FirstChunkPolicy {
  /** Never emit a first phrase shorter than this. */
  minCharacters: number;
  /** Preferred size; the planner stops looking for a better boundary here. */
  preferredCharacters: number;
  /** Never emit fewer useful words than this. */
  minWords: number;
  /**
   * Once enough safe text exists, wait at most this long for a natural
   * boundary before flushing at the latest whitespace.
   */
  maxWaitMs: number;
}

export interface SubsequentChunkPolicy {
  minCharacters: number;
  maxCharacters: number;
  minWords: number;
  maxWords: number;
  maxWaitMs: number;
}

export interface ChunkPlanConfig {
  enabled: boolean;

  /** Baseline minimum, applied when a position-specific policy does not override. */
  minCharacters: number;

  /** Characters treated as natural speech boundaries. */
  punctuationBoundaries: string[];

  first: FirstChunkPolicy;
  subsequent: SubsequentChunkPolicy;

  /**
   * Honour an inline `<flush />` marker in model output: everything before it is
   * submitted to TTS immediately. The marker is ALWAYS stripped before
   * synthesis -- it must never be spoken.
   */
  flushEnabled: boolean;
  flushMarker: string;
}

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                   */
/* -------------------------------------------------------------------------- */

export type RagStrategy =
  /** endpoint -> final transcript -> retrieve -> LLM. Fully on the critical path. */
  | 'serial'
  /** Retrieve speculatively from a stabilised partial; reuse if still valid. */
  | 'prefetch'
  /** Classify first: skip retrieval entirely for greetings and chit-chat. */
  | 'conditional';

export interface ModeCRagConfig {
  strategy: RagStrategy;
  /** Words that make a turn likely to need the knowledge base. */
  triggerPatterns: string[];
  /** Turns matching these skip retrieval outright ("hello", "thanks"). */
  skipPatterns: string[];
  /** Minimum words before conditional retrieval will even consider running. */
  minWordsForRetrieval: number;
  /** Similarity required to reuse a prefetched result for the final query. */
  prefetchReuseThreshold: number;
}

/* -------------------------------------------------------------------------- */
/* Perceived latency                                                           */
/* -------------------------------------------------------------------------- */

export interface PerceivedLatencyConfig {
  /**
   * OFF by default. When on, a short acknowledgement is spoken while a genuinely
   * slow operation runs, so the caller hears something sooner.
   *
   * This changes PERCEIVED latency, not real latency, and the two are reported
   * as separate numbers. It is off by default precisely so a baseline
   * measurement is never quietly flattered by it.
   */
  enabled: boolean;
  /** Only acknowledge when the pending operation is expected to exceed this. */
  minOperationMs: number;
  phrases: string[];
  /** Do not acknowledge again for this many turns. */
  cooldownTurns: number;
}

/* -------------------------------------------------------------------------- */
/* Speculation, cache, transport                                               */
/* -------------------------------------------------------------------------- */

export interface PreemptiveLlmConfig {
  enabled: boolean;
  /** Endpoint confidence in [0,1] required before speculating. */
  minConfidence: number;
  minWords: number;
  /** Similarity below which the speculative request is discarded. */
  divergenceThreshold: number;
}

export interface TtsCacheConfig {
  /**
   * Cache audio for short, frequently repeated phrases. OFF during provider
   * latency comparisons, because a cache hit measures our disk, not Hamsa.
   */
  enabled: boolean;
  maxEntries: number;
  maxBytes: number;
  /** Only cache phrases at or below this length. */
  maxPhraseChars: number;
}

export interface ModeCTransportConfig {
  /** Startup audio buffer. The single most direct TTFS/underrun tradeoff. */
  jitterBufferMs: number;
  /** Measure cold connection cost instead of reusing warm connections. */
  coldConnectionTest: boolean;
}

/* -------------------------------------------------------------------------- */
/* Root                                                                        */
/* -------------------------------------------------------------------------- */

export interface ModeCConfig {
  endpointing: EndpointingConfig;
  stopSpeaking: StopSpeakingConfig;
  chunkPlan: ChunkPlanConfig;
  rag: ModeCRagConfig;
  perceivedLatency: PerceivedLatencyConfig;
  preemptiveLlm: PreemptiveLlmConfig;
  ttsCache: TtsCacheConfig;
  transport: ModeCTransportConfig;
  /**
   * Ambience, keyboard and hesitation sounds. Mode C only, off by default:
   * it moves PERCEIVED latency and must never flatter a baseline measurement.
   */
  backgroundAudio: BackgroundAudioConfig;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Arabic acknowledgement / backchannel phrases. The caller saying one of these
 * is agreeing, not interrupting.
 */
export const AR_ACKNOWLEDGEMENT_PHRASES = [
  'اه',
  'آه',
  'ايوه',
  'أيوه',
  'تمام',
  'اوكي',
  'أوكي',
  'ممم',
  'همم',
  'صح',
  'طيب',
  'ماشي',
  'اها',
  'نعم',
  'يب',
];

/** Phrases that always take the floor immediately. */
export const AR_INTERRUPTION_PHRASES = [
  'استنى',
  'إستنى',
  'وقف',
  'لحظة',
  'لا',
  'خلص',
  'كفاية',
  'ثانية',
  'اسمع',
  'مو هيك',
  'غلط',
];

/**
 * Boundary characters offered to the chunk planner.
 *
 * NOTE: this list is OUR choice, not a reproduction of a documented default.
 * The Vapi schema explicitly declines to publish one: "Default is automatically
 * set to balance the trade-off between quality and latency based on the
 * provider." We therefore pick a set that covers Arabic (، ؛ ؟), Latin and the
 * CJK full-width forms, and expose it for tuning.
 */
export const DEFAULT_PUNCTUATION_BOUNDARIES = [
  '。',
  '，',
  '.',
  '!',
  '?',
  ';',
  ':',
  ',',
  '،',
  '؛',
  '؟',
  '\n',
];

/** Turns that almost never need the knowledge base. */
export const DEFAULT_RAG_SKIP_PATTERNS = [
  'سلام',
  'مرحبا',
  'أهلا',
  'اهلا',
  'صباح الخير',
  'مساء الخير',
  'كيف حالك',
  'شكرا',
  'شكراً',
  'مع السلامة',
  'باي',
  'تمام',
  'اوكي',
  'hello',
  'hi',
  'thanks',
  'thank you',
  'bye',
  'good morning',
];

/** Turns that usually do. */
export const DEFAULT_RAG_TRIGGER_PATTERNS = [
  'كم',
  'شو',
  'ما هي',
  'ماهي',
  'وش',
  'كيف',
  'متى',
  'أين',
  'اين',
  'هل',
  'ليش',
  'لماذا',
  'خدمات',
  'رسوم',
  'سعر',
  'إجازة',
  'اجازة',
  'راتب',
  'نظام',
  'شروط',
  'مدة',
  'what',
  'how',
  'when',
  'where',
  'why',
  'which',
  'cost',
  'price',
  'policy',
];

/**
 * The DOCUMENTED default acknowledgement list (22 entries), reproduced verbatim
 * from the published schema. Offered as a preset for English conversations.
 */
export const DOCUMENTED_ACK_PHRASES_EN = [
  'i understand', 'i see', 'i got it', 'i hear you', 'im listening', 'im with you',
  'right', 'okay', 'ok', 'sure', 'alright', 'got it', 'understood', 'yeah', 'yes',
  'uh-huh', 'mm-hmm', 'gotcha', 'mhmm', 'ah', 'yeah okay', 'yeah sure',
];

/**
 * The DOCUMENTED default interruption list (20 entries), reproduced verbatim.
 *
 * CAUTION: these are bare tokens rather than phrases. "up", "but", "not", "no",
 * "never" and "bad" are extremely common words, which makes the list very
 * trigger-happy — a caller saying "no problem" would interrupt the assistant.
 * It is provided for fidelity, NOT recommended as-is, and is not the default
 * here.
 */
export const DOCUMENTED_INTERRUPTION_PHRASES_EN = [
  'stop', 'shut', 'up', 'enough', 'quiet', 'silence', 'but', 'dont', 'not', 'no',
  'hold', 'wait', 'cut', 'pause', 'nope', 'nah', 'nevermind', 'never', 'bad', 'actually',
];

export const DEFAULT_ACK_PHRASES_AR = [
  'أكيد، خليني أتأكد لك.',
  'لحظة واحدة من فضلك.',
  'تمام، خليني أشوف.',
];

export function defaultModeCConfig(): ModeCConfig {
  return {
    endpointing: {
      // Transcription-aware endpointing is the whole point of Mode C: a fixed
      // silence timer cannot tell a finished question from a mid-sentence pause.
      strategy: 'vapi_transcription',
      // Timing profile matching the publicly documented Vapi defaults, used as
      // the initial benchmark preset. Every value is editable in the UI.
      waitSeconds: 0.4,
      onPunctuationSeconds: 0.1,
      onNoPunctuationSeconds: 1.5,
      onNumberSeconds: 0.5,
      maxWaitSeconds: 2.5,
      transcriptStabilityMs: 180,
      minStabilityScore: 0.7,
      minWords: 1,
      customRules: [
        {
          name: 'trailing conjunction (caller is mid-thought)',
          // "و", "أو", "بس", "لكن", "يعني" at the end almost always mean more
          // speech is coming, whatever the silence timer says.
          pattern: '(^|\\s)(و|أو|او|بس|لكن|يعني|عشان|لأن|لان)\\s*$',
          seconds: 1.8,
          enabled: true,
        },
        {
          name: 'trailing ellipsis',
          pattern: '(\\.\\.\\.|…)\\s*$',
          seconds: 1.5,
          enabled: true,
        },
      ],
    },

    stopSpeaking: {
      enabled: true,
      // 0 words = interrupt on voice activity alone. Browser echo cancellation
      // is what makes this safe; without it the assistant interrupts itself.
      numWords: 0,
      // 0.2 s was far too twitchy in practice. With numWords at 0 this is the
      // ONLY gate, so 200 ms of any speech cancelled the turn -- and a caller
      // who is still finishing their own question trips it constantly. Two
      // separate turns in one observed call were cut off this way, which is
      // what "the agent does not finish what it is saying" actually was.
      //
      // 0.5 s still feels responsive to a deliberate interruption while
      // ignoring the tail of the caller's own sentence.
      voiceSeconds: 0.5,
      backoffSeconds: 1.0,
      acknowledgementPhrases: [...AR_ACKNOWLEDGEMENT_PHRASES],
      interruptionPhrases: [...AR_INTERRUPTION_PHRASES],
    },

    chunkPlan: {
      enabled: true,
      minCharacters: 30,
      punctuationBoundaries: [...DEFAULT_PUNCTUATION_BOUNDARIES],
      first: {
        // The first phrase is the only one the caller waits for, so it is
        // allowed to be shorter and less prosodically perfect than the rest.
        minCharacters: 20,
        preferredCharacters: 45,
        minWords: 3,
        maxWaitMs: 150,
      },
      subsequent: {
        minCharacters: 50,
        maxCharacters: 120,
        minWords: 8,
        maxWords: 18,
        maxWaitMs: 200,
      },
      flushEnabled: true,
      flushMarker: '<flush />',
    },

    rag: {
      strategy: 'prefetch',
      triggerPatterns: [...DEFAULT_RAG_TRIGGER_PATTERNS],
      skipPatterns: [...DEFAULT_RAG_SKIP_PATTERNS],
      minWordsForRetrieval: 2,
      prefetchReuseThreshold: 0.8,
    },

    perceivedLatency: {
      enabled: false,
      minOperationMs: 400,
      phrases: [...DEFAULT_ACK_PHRASES_AR],
      cooldownTurns: 2,
    },

    backgroundAudio: defaultBackgroundAudioConfig(),

    preemptiveLlm: {
      enabled: false,
      minConfidence: 0.85,
      minWords: 3,
      divergenceThreshold: 0.25,
    },

    ttsCache: {
      enabled: false,
      maxEntries: 200,
      maxBytes: 32 * 1024 * 1024,
      maxPhraseChars: 60,
    },

    transport: {
      jitterBufferMs: 40,
      coldConnectionTest: false,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                     */
/* -------------------------------------------------------------------------- */

export interface ModeCPreset {
  id: string;
  label: string;
  description: string;
  apply: (c: ModeCConfig) => ModeCConfig;
}

export const MODE_C_PRESETS: ModeCPreset[] = [
  {
    id: 'vapi_like_arabic',
    label: 'Vapi-like Arabic',
    description:
      'Transcription-aware endpointing with the documented Vapi timing profile, aggressive first chunk, RAG prefetch. The default benchmark preset.',
    apply: (c) => ({
      ...c,
      endpointing: {
        ...c.endpointing,
        strategy: 'vapi_transcription',
        waitSeconds: 0.4,
        onPunctuationSeconds: 0.1,
        onNoPunctuationSeconds: 1.5,
        onNumberSeconds: 0.5,
      },
      chunkPlan: { ...c.chunkPlan, enabled: true, minCharacters: 30 },
      rag: { ...c.rag, strategy: 'prefetch' },
    }),
  },
  {
    id: 'lowest_latency',
    label: 'Lowest latency (aggressive)',
    description:
      'Shortest safe timers everywhere. Expect occasional early endpoints on slow speakers — the tradeoff this preset exists to expose.',
    apply: (c) => ({
      ...c,
      endpointing: {
        ...c.endpointing,
        strategy: 'vapi_transcription',
        waitSeconds: 0.25,
        onPunctuationSeconds: 0.05,
        onNoPunctuationSeconds: 0.9,
        onNumberSeconds: 0.4,
        transcriptStabilityMs: 120,
        minStabilityScore: 0.6,
      },
      chunkPlan: {
        ...c.chunkPlan,
        first: { minCharacters: 14, preferredCharacters: 32, minWords: 2, maxWaitMs: 90 },
      },
      rag: { ...c.rag, strategy: 'conditional' },
      transport: { ...c.transport, jitterBufferMs: 20 },
    }),
  },
  {
    id: 'natural',
    label: 'Natural speech (conservative)',
    description: 'Longer waits and larger phrases. Slower first audio, smoother prosody.',
    apply: (c) => ({
      ...c,
      endpointing: {
        ...c.endpointing,
        strategy: 'hybrid',
        waitSeconds: 0.6,
        onPunctuationSeconds: 0.3,
        onNoPunctuationSeconds: 2.0,
        onNumberSeconds: 0.8,
      },
      chunkPlan: {
        ...c.chunkPlan,
        first: { minCharacters: 40, preferredCharacters: 80, minWords: 6, maxWaitMs: 300 },
        subsequent: { minCharacters: 80, maxCharacters: 180, minWords: 12, maxWords: 26, maxWaitMs: 350 },
      },
      transport: { ...c.transport, jitterBufferMs: 80 },
    }),
  },
  {
    id: 'vad_baseline',
    label: 'VAD silence only (control)',
    description:
      'Disables transcription-aware endpointing so Mode C uses the same fixed silence timer as Modes A and B. Isolates exactly what the endpointing engine is worth.',
    apply: (c) => ({
      ...c,
      endpointing: { ...c.endpointing, strategy: 'vad_silence' },
      rag: { ...c.rag, strategy: 'serial' },
    }),
  },
];

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep every Mode C value inside a sane, documented range. */
export function clampModeCConfig(c: ModeCConfig): ModeCConfig {
  const e = c.endpointing;
  e.waitSeconds = clampN(e.waitSeconds, 0, 3);
  e.onPunctuationSeconds = clampN(e.onPunctuationSeconds, 0, 3);
  e.onNoPunctuationSeconds = clampN(e.onNoPunctuationSeconds, 0, 5);
  e.onNumberSeconds = clampN(e.onNumberSeconds, 0, 5);
  e.maxWaitSeconds = clampN(e.maxWaitSeconds, 0.3, 10);
  e.transcriptStabilityMs = clampN(e.transcriptStabilityMs, 20, 2000);
  e.minStabilityScore = clampN(e.minStabilityScore, 0, 1);
  e.minWords = clampN(Math.round(e.minWords), 0, 10);

  const s = c.stopSpeaking;
  s.numWords = clampN(Math.round(s.numWords), 0, 10);
  s.voiceSeconds = clampN(s.voiceSeconds, 0, 3);
  s.backoffSeconds = clampN(s.backoffSeconds, 0, 10);

  const p = c.chunkPlan;
  p.minCharacters = clampN(Math.round(p.minCharacters), 1, 500);
  p.first.minCharacters = clampN(Math.round(p.first.minCharacters), 1, 300);
  p.first.preferredCharacters = clampN(Math.round(p.first.preferredCharacters), p.first.minCharacters, 400);
  p.first.minWords = clampN(Math.round(p.first.minWords), 1, 30);
  p.first.maxWaitMs = clampN(Math.round(p.first.maxWaitMs), 0, 2000);
  p.subsequent.minCharacters = clampN(Math.round(p.subsequent.minCharacters), 1, 500);
  p.subsequent.maxCharacters = clampN(Math.round(p.subsequent.maxCharacters), p.subsequent.minCharacters, 800);
  p.subsequent.minWords = clampN(Math.round(p.subsequent.minWords), 1, 60);
  p.subsequent.maxWords = clampN(Math.round(p.subsequent.maxWords), p.subsequent.minWords, 100);
  p.subsequent.maxWaitMs = clampN(Math.round(p.subsequent.maxWaitMs), 0, 3000);

  c.rag.prefetchReuseThreshold = clampN(c.rag.prefetchReuseThreshold, 0.1, 1);
  c.rag.minWordsForRetrieval = clampN(Math.round(c.rag.minWordsForRetrieval), 0, 20);

  c.perceivedLatency.minOperationMs = clampN(Math.round(c.perceivedLatency.minOperationMs), 0, 10_000);
  c.perceivedLatency.cooldownTurns = clampN(Math.round(c.perceivedLatency.cooldownTurns), 0, 20);

  c.preemptiveLlm.minConfidence = clampN(c.preemptiveLlm.minConfidence, 0, 1);
  c.preemptiveLlm.minWords = clampN(Math.round(c.preemptiveLlm.minWords), 1, 20);

  c.ttsCache.maxEntries = clampN(Math.round(c.ttsCache.maxEntries), 0, 5000);
  c.ttsCache.maxPhraseChars = clampN(Math.round(c.ttsCache.maxPhraseChars), 1, 500);

  c.transport.jitterBufferMs = clampN(Math.round(c.transport.jitterBufferMs), 0, 500);

  // A defaults() guard: configs loaded from an older saved session predate this
  // block and would otherwise arrive undefined.
  c.backgroundAudio = clampBackgroundAudioConfig(c.backgroundAudio ?? defaultBackgroundAudioConfig());
  return c;
}
