/**
 * Session configuration shared by the server and the browser.
 *
 * A single object drives both pipeline modes: the model, prompt, voice,
 * knowledge base and STT settings live here once and are applied identically,
 * so a comparison between modes isolates the orchestration decision rather
 * than incidental configuration differences.
 */

import type { ChunkerConfig } from './text/chunker.js';
import { STREAMING_POLICY, clonePolicy } from './text/chunker.js';
import type { ModeCConfig } from './modeC/config.js';
import { clampModeCConfig, defaultModeCConfig } from './modeC/config.js';

/**
 * B = fully streamed pipeline
 * C = Vapi-style orchestration (its own settings live in `SessionConfig.modeC`)
 */
export type PipelineMode = 'B' | 'C';
export type Language = 'ar' | 'en';

/* -------------------------------------------------------------------------- */

export interface SttConfig {
  language: Language;
  /** 'standard' is fastest, 'enhanced' is most accurate. */
  model: 'standard' | 'enhanced';
  enablePartials: boolean;
  /**
   * Seconds. Speechmatics enforces a documented floor of 0.7 and a ceiling of 4.
   * Lower is faster but slightly less accurate.
   */
  maxDelay: number;
  maxDelayMode: 'flexible' | 'fixed';
  /**
   * Provider-side endpointing, in seconds (0 disables, max 2). Kept BELOW
   * maxDelay per Speechmatics guidance. Our own VAD runs in parallel and is
   * what the pipeline actually triggers on; this is measured for comparison.
   */
  endOfUtteranceSilenceTrigger: number;
  punctuationSensitivity: number;
  additionalVocab: string[];
}

export interface VadConfig {
  /**
   * Milliseconds of trailing silence before the system declares the turn over.
   * The headline tunable of the whole application.
   */
  silenceThresholdMs: number;
  /** Probability above which a frame counts as speech. */
  positiveSpeechThreshold: number;
  /** Probability below which a frame counts as silence. */
  negativeSpeechThreshold: number;
  /** Minimum speech frames before a turn is considered real (anti-noise). */
  minSpeechFrames: number;
  /** Milliseconds of audio kept before speech onset, prepended to the stream. */
  preSpeechPadMs: number;
  /** Allow the user to interrupt assistant audio. */
  bargeInEnabled: boolean;
  /** Consecutive speech frames required to trigger a barge-in. */
  bargeInSpeechFrames: number;
}

export interface LlmConfig {
  /** Free-text so any current or future model id can be benchmarked. */
  model: string;
  maxOutputTokens: number;
  temperature: number | null;
  /** none | minimal | low | medium | high | xhigh | max. Model dependent. */
  reasoningEffort: string | null;
  verbosity: 'low' | 'medium' | 'high' | null;
  /** auto | default | fast | priority | flex | scale */
  serviceTier: string | null;
  store: boolean;
  /** Turns of prior conversation replayed to the model. */
  historyTurns: number;
}

export interface TtsConfig {
  /** Voice name for a built-in voice, or a UUID for a cloned voice. */
  speaker: string;
  dialect: string;
  languageId: string;
  sampleRate: '8k' | '16k';
  mulaw: boolean;
  expressiveness: number;
  /**
   * 'websocket' keeps one warm socket and is strictly sequential (Hamsa's
   * realtime WS carries no correlation id, so two in-flight requests cannot be
   * told apart). 'http' issues one keep-alive POST per phrase, which permits
   * overlap and true cancellation via request abort.
   */
  transport: 'websocket' | 'http';
  /** Number of phrases allowed to be synthesised concurrently on the http transport. */
  maxConcurrentPhrases: number;
}

export interface RagConfig {
  enabled: boolean;
  topK: number;
  /**
   * Floor on the NORMALISED score. Near-useless as a relevance gate, because
   * the top hit is always 1.0 by construction; kept for tuning the tail.
   */
  minScore: number;
  /**
   * Floor on query-term coverage, in [0,1]. THIS is the relevance gate.
   *
   * Below it, retrieval returns nothing and the agent falls back instead of
   * being handed confident-looking but unrelated passages. That failure is what
   * makes an agent answer a question the caller did not ask.
   */
  minCoverage: number;
  /** Mode B only: start retrieval from a stabilised partial transcript. */
  prefetchEnabled: boolean;
  /**
   * Similarity above which a prefetched result is reused for the final
   * transcript instead of being recomputed.
   */
  prefetchReuseThreshold: number;
  /** Milliseconds a partial must be unchanged before it counts as stable. */
  partialStabilityMs: number;
  maxContextChars: number;
}

export interface AudioConfig {
  /**
   * Milliseconds of audio buffered in the browser before playback starts.
   * Directly trades TTFS against underrun risk.
   */
  jitterBufferMs: number;
  /** Hard cap on queued playback audio; excess triggers backpressure. */
  maxQueueMs: number;
  /** PCM frame size sent from the browser to the server. */
  micFrameMs: number;
}

export interface SpeculativeConfig {
  /** Master switch for section 27. OFF by default. */
  enabled: boolean;
  /** Begin the LLM request before endpoint confirmation. */
  preemptiveLlm: boolean;
  /** Milliseconds a partial must be stable before speculating on it. */
  stabilityMs: number;
  /** Minimum words in the partial before speculating. */
  minWords: number;
  /**
   * Normalised edit distance above which the speculative request is considered
   * invalid once the real transcript lands.
   */
  divergenceThreshold: number;
}

export interface SessionConfig {
  mode: PipelineMode;
  language: Language;
  systemPrompt: string;
  stt: SttConfig;
  vad: VadConfig;
  llm: LlmConfig;
  tts: TtsConfig;
  rag: RagConfig;
  audio: AudioConfig;
  speculative: SpeculativeConfig;
  /** Streaming chunker policy. */
  chunker: { B: ChunkerConfig };
  /**
   * Mode C settings. Present at all times so they survive switching modes, but
   * they only take effect while `mode === 'C'`; Mode B ignores them entirely.
   */
  modeC: ModeCConfig;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The production persona this lab benchmarks against.
 *
 * Deliberately the REAL prompt rather than a toy one. Prompt length is a direct
 * input to time-to-first-token, so measuring against a three-line placeholder
 * would understate every latency figure the lab reports. The short/production
 * prompt comparison in the LLM lab exists precisely to quantify that gap.
 */
export const DEFAULT_SYSTEM_PROMPT_AR = `<role>
أنت روان، موظف في تجمع تبوك الصحي.

مهمتك الرد على أسئلة الموظفين والمتقدمين ومساعدتهم بالمعلومات الصحيحة وفق مصادر المعرفة المعتمدة. </role>

<speaking_style>
تكلم باللهجة السعودية البيضاء فقط.

أسلوبك بشري، طبيعي، ودود، محترم، واضح، عملي وواثق.

لا تستخدم أي كلمة إنجليزية نهائيًا.

لا تذكر روابط أثناء المكالمة، ولا تهجّي أي رابط أو حروف إنجليزية.

لا تفترض جنس الطرف الآخر. استخدم صياغة حيادية، وإذا ذكر الشخص جنسه بوضوح وكان ذلك مهمًا للإجابة، استخدم الصياغة المناسبة بشكل طبيعي.

لا تستخدم:
أخوي، أختي، يا رجال، يا بنت، يا عزيزي، يا عزيزتي.

خلك مختصر ومباشر، لكن لا تختصر على حساب اكتمال الإجابة.

إذا كان السؤال بسيطًا، أجب باختصار.
إذا كان يحتاج شرحًا أو تفاصيل مهمة، أعطِ التفاصيل اللازمة بدون إطالة.

لا تكرر الترحيب بعد بداية المحادثة.
لا تكرر اسم الشخص بدون حاجة.
لا تنهِ كل رد بسؤال مثل "هل عندك استفسار آخر؟"
لا تستخدم نفس البداية أو القفلة في كل رد.

ابدأ واختم بشكل طبيعي وتفاعلي عندما يكون ذلك مناسبًا.

حافظ على أسلوب محادثة طبيعي، ولا تتكلم كأنك تقرأ نصًا ثابتًا.
النطق الصحيح للكلمات هو يجب اخراج الكلمات هاي تحديدا زي ما مكتوبه هنا :
تَظَلُّم
شَكْوَى
تَجَمُّع
أَبْشِر
تِسْلَم
</speaking_style>

<conversation_understanding>
افهم المقصود الحقيقي من كلام المستخدم ضمن سياق المحادثة كاملة، وليس آخر رسالة فقط.

إذا كان السؤال واضحًا، أجب مباشرة.

إذا كان غير واضح وكانت المعلومة الناقصة تؤثر على الإجابة، اسأل سؤالًا توضيحيًا واحدًا قصيرًا.

لا تسأل عن شيء سبق أن ذكره المستخدم.

إذا قال الشخص كلمة "العرض" ولم يكن واضحًا المقصود، اسأله:
"تقصد عرض وظيفي أو عرض انتقال؟"

تعامل مع الرسائل المتتابعة كمحادثة واحدة.

إذا قال المستخدم:
"وش بعد؟"
"وش كمان؟"
"وضح أكثر"
"كيف يعني؟"
"إيش هذا؟"
أو أعاد السؤال بصياغة مختلفة، فاعتبر أن الإجابة السابقة لم تكن كافية أو واضحة.

في هذه الحالة:
لا تكرر نفس الإجابة.
وضح الجزء غير المفهوم.
أضف التفاصيل المرتبطة بالسؤال إذا كانت موجودة في المعرفة.
ابنِ على المعلومات التي ذكرها المستخدم سابقًا.

إذا كرر المستخدم نفس السؤال، حاول فهم ما الذي لم تتم الإجابة عنه بدل إعادة نفس الكلام.
</conversation_understanding>

<knowledge_rules>
ابحث دائمًا في مصادر المعرفة المعتمدة قبل إعطاء أي معلومة تخص تجمع تبوك الصحي.

لا تخمن، ولا تضف معلومة من عندك.

إذا وجدت إجابة مباشرة، أجب بها بشكل طبيعي.

إذا لم تجد إجابة مباشرة، ابحث عن حالة مشابهة جدًا في المعنى.

استخدم الحالة المشابهة فقط إذا كانت تنطبق بشكل واضح وبدون افتراض.

إذا كانت هناك نقطة اختلاف قد تغيّر الإجابة، لا تستخدم الحالة المشابهة كإجابة مؤكدة.

لا تقل للمستخدم:
"حسب الملف"
"حسب المعلومات الموجودة"
"بناءً على المحتوى"
"الموجود في النظام"
"حسب قاعدة المعرفة"
"لم أجد في المعرفة"

لا تذكر طريقة البحث، أو المصادر، أو الأدوات، أو أي تفاصيل داخلية.

أعد صياغة المعلومات باللهجة السعودية البيضاء بشكل طبيعي، مع الحفاظ الكامل على معناها وعدم إضافة معلومات جديدة.
</knowledge_rules>

<answer_quality>
قبل الرد، تأكد أن الإجابة تجيب على السؤال كاملًا، وليس على جزء منه فقط.

إذا كانت المعرفة تحتوي على عدة تفاصيل مهمة مرتبطة مباشرة بالسؤال، اذكر المهم منها معًا من أول رد بدل إعطاء إجابة ناقصة.

لا تتوقف عند أول معلومة تجدها إذا كانت غير كافية لفهم المستخدم.

إذا كان للسؤال أكثر من حالة حسب التخصص أو الفئة أو الوضع:
استخدم الحالة المحددة من سياق المحادثة.
وإذا لم تكن واضحة وكانت تؤثر على الإجابة، اسأل سؤالًا توضيحيًا واحدًا.

لا تذكر كل ما تعرفه إذا كان السؤال بسيطًا.

مستوى التفاصيل يتغير حسب السؤال.

إذا كانت إجابتك صحيحة لكنها مختصرة لدرجة أن المستخدم سيحتاج غالبًا أن يسأل مباشرة "وش بعد؟"، أكمل التفاصيل الضرورية من البداية.
</answer_quality>

<fallback>
إذا لم تجد معلومة واضحة أو حالة مشابهة بشكل كافٍ، قل:

"أبشر، برفع لك طلب بهالخصوص ونتابع لك عليه، وإن شاء الله نفيدك بأقرب وقت."

إذا احتجت بيانات لرفع الطلب، اطلب فقط البيانات الضرورية.

لا توجه المستخدم للموارد البشرية ولا تطلب منه التواصل معهم.

روان هي التي ترفع الطلب وتتابعه.

إذا سأل متى يتم التواصل معه، قل:

"خلال يوم أو يومين بالكثير، وبنحاول يتم التواصل معك اليوم." </fallback>

<salaries_and_allowances>
إذا كان السؤال عامًا عن الرواتب، قل:

"الرواتب في تجمع تبوك الصحي تنافسية، وتتكون من راتب أساسي وبدل سكن وبدل نقل، وتختلف حسب التخصص."

لا تذكر بدل الندرة أو بدل التميز ضمن الرد العام.

استخدم "تغطية طبية" وليس "تأمين طبي".

بالنسبة لطلب الانتقال، جميع البدلات التي كان الموظف يستلمها قبل الانتقال تكون ضمن الطلب، باستثناء بدل الإشراف وبدل التميز.

عروض الانتقال لا تحتوي على فترة تجربة لأنها امتداد للخدمة السابقة.

عقود موظفي الخدمة المدنية بعد الانتقال تخضع لنظام العمل ونظام التأمينات الاجتماعية.

لا يقل الراتب الأساسي أو الراتب الإجمالي بعد الانتقال عما كان الموظف يتقاضاه قبل الانتقال.
</salaries_and_allowances>

<benefits>
عند السؤال عن المزايا، اذكر باختصار:

الرواتب التنافسية،
المسار المهني الواضح،
التدريب والتطوير،
التغطية الطبية داخل التجمع،
ومكافآت الأداء عند انطباقها.

لا تضف مزايا أخرى إلا إذا كانت موجودة في مصادر المعرفة. </benefits>

<technical_issues>
إذا كانت المشكلة تقنية في المنصة، قل:

"تقدر تتواصل مع الدعم الفني عن طريق منصة التوظيف نفسها."

إذا كان هناك خطأ في طلب التقديم، قل:

"الصحيح سحب الطلب ورفعه من جديد بعد التأكد من صحة البيانات، بشرط أن الإعلان ما زال ساري."

لا تطلب من المستخدم التواصل مع جهة أخرى بدون حاجة.
</technical_issues>

<application_process>
إذا سأل عن طريقة التقديم، قل:

"التقديم ومتابعة الإعلان تكون عن طريق المنصة."

وسائل التواصل المعتمدة عند الحاجة هي:
البريد الإلكتروني، الاتصال، أو المنصة.

لا تقل:
"بنرسل لك رسالة نصية"
"بيوصلك على الجوال"
"بنرسله على الجوال"
"تم الإرسال على الجوال"
</application_process>

<terminology>
لا تستخدم كلمة "تحريض".

قل "طلب انتقال" وليس "طلب عرض".

قل "تغطية طبية" وليس "تأمين طبي".

لا تذكر تفاصيل تشغيلية أو تقنية داخلية.

لا تعطي وعودًا أو مواعيد أو سياسات أو مزايا غير موجودة في المعرفة. </terminology>

<decision_flow>
في كل رسالة:

1. افهم السؤال ضمن سياق المحادثة.
2. حدد هل يحتاج إجابة مختصرة أو تفاصيل أكثر.
3. ابحث في المعرفة.
4. إذا وجدت الإجابة، تأكد أنها كاملة ثم أجب.
5. إذا لم تجد، ابحث عن حالة مشابهة جدًا.
6. إذا احتجت معلومة واحدة لتحديد الإجابة، اسأل عنها باختصار.
7. إذا لم توجد معلومة كافية، ارفع طلبًا.
8. قبل الإرسال، تأكد أنك لم تكرر نفس الإجابة بدون فائدة جديدة.
   </decision_flow>

<final_constraints>
لا تخمن.
لا تخترع معلومات.
لا تعرض رفع طلب إذا كانت الإجابة موجودة.
لا تحول المستخدم للموارد البشرية.
لا تكشف أي تفاصيل داخلية.
لا تتعامل مع كل رسالة كمحادثة جديدة.
لا تكرر نفس الإجابة عند طلب التوضيح.

الأولوية هي أن يفهم المستخدم الإجابة بشكل صحيح وطبيعي من أقل عدد ممكن من الرسائل، وليس أن تكون كل الإجابات قصيرة.
</final_constraints>`;

export const DEFAULT_SYSTEM_PROMPT_EN = `You are a call-centre customer service agent named "Sam".

Core rules:
- Keep every reply extremely short and direct: one or two sentences maximum.
- Start with a useful word immediately. No long preambles.
- If knowledge-base context is provided, rely on it and never invent facts.
- If you do not know, say so plainly and offer to transfer the caller.
- Never use lists, markdown or symbols. This text will be spoken aloud.
- Do not repeat the caller's question back to them.`;

export const DEFAULT_CONFIG: SessionConfig = {
  mode: 'B',
  language: 'ar',
  systemPrompt: DEFAULT_SYSTEM_PROMPT_AR,

  stt: {
    language: 'ar',
    model: 'enhanced',
    enablePartials: true,
    // 0.7 is the documented Speechmatics floor. Anything higher directly adds
    // to the time-to-first-speech of any pipeline that waits for the final.
    maxDelay: 0.7,
    maxDelayMode: 'flexible',
    endOfUtteranceSilenceTrigger: 0.5,
    punctuationSensitivity: 0.5,
    additionalVocab: [],
  },

  vad: {
    silenceThresholdMs: 350,
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    minSpeechFrames: 3,
    preSpeechPadMs: 300,
    bargeInEnabled: true,
    bargeInSpeechFrames: 4,
  },

  llm: {
    // gpt-4.1 measured a markedly lower TTFT than the reasoning models on this
    // workload (~486 ms vs ~1200 ms), which matters more than anything else for
    // time to first speech. Fully editable in the UI -- type any model id.
    model: 'gpt-4.1',
    // 200 truncated real answers MID-SENTENCE. A live call ended a reply on
    // "...منتهي بالتوظيف، التَجَمُّع" and the response carried
    // reason=max_output_tokens: the caller simply heard the agent stop talking.
    //
    // Arabic costs roughly twice as many tokens per character as English, so a
    // budget that looks generous in English is not. 800 covers the longest
    // answers observed with room to spare; because every mode streams, a longer
    // ceiling costs nothing in time-to-first-speech -- only an unused ceiling
    // is free, whereas a breached one is heard.
    maxOutputTokens: 800,
    // gpt-4.1 accepts temperature; the GPT-5 reasoning models do not use it.
    // A low value keeps call-centre answers consistent between runs.
    temperature: 0.3,
    // Both of these are GPT-5-era parameters. gpt-4.1 returns HTTP 400 for
    // either one, so they are left unset and re-enabled automatically by
    // `applyModelCapabilities` when a model that supports them is selected.
    reasoningEffort: null,
    verbosity: null,
    serviceTier: null,
    store: false,
    historyTurns: 6,
  },

  tts: {
    speaker: 'Amjad',
    dialect: 'pls',
    languageId: 'ar',
    sampleRate: '16k',
    mulaw: false,
    expressiveness: 1,
    // HTTP, not the websocket, and this is the single biggest fix for choppy
    // speech.
    //
    // Hamsa's realtime WS carries no correlation id, so the transport must run
    // strictly one request at a time -- `maxConcurrentPhrases` is silently
    // ignored on it. Every phrase therefore waits for the previous one to
    // finish and then pays TTS time-to-first-audio again (~334 ms measured).
    // Across a nine-phrase answer that is nine separate gaps, heard as
    // word - pause - word - pause.
    //
    // HTTP keep-alive lets phrase N+1 synthesise while N is still playing, so
    // the gaps close. It also gives real cancellation via AbortController;
    // on the websocket a barge-in could only log "Discarding in-flight Hamsa
    // audio (no provider cancel API)" and let the audio keep arriving.
    transport: 'http',
    maxConcurrentPhrases: 2,
  },

  rag: {
    enabled: true,
    topK: 3,
    minScore: 0.05,
    // 0.35 of the query's IDF mass. Tuned against this corpus: on-topic
    // questions land well above it, and "how is the weather?" lands far below.
    minCoverage: 0.35,
    prefetchEnabled: true,
    prefetchReuseThreshold: 0.8,
    partialStabilityMs: 200,
    maxContextChars: 2400,
  },

  audio: {
    jitterBufferMs: 80,
    // 6 s was smaller than a normal answer. Once the queue hit the cap the
    // player deleted the OLDEST audio -- the samples being spoken at that very
    // moment -- so ~959 ms vanished from the middle of a word. Speech tolerates
    // latency far better than it tolerates holes.
    //
    // 30 s of 16 kHz mono is under 2 MB, and a barge-in flushes the queue
    // anyway, so a deep buffer costs nothing that matters.
    maxQueueMs: 30_000,
    micFrameMs: 20,
  },

  speculative: {
    enabled: false,
    preemptiveLlm: false,
    stabilityMs: 250,
    minWords: 3,
    divergenceThreshold: 0.25,
  },

  chunker: {
    B: clonePolicy(STREAMING_POLICY),
  },

  modeC: defaultModeCConfig(),
};

export function defaultConfig(): SessionConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** Deep-merge a partial config over the defaults, preserving unknown keys. */
export function mergeConfig(base: SessionConfig, patch: DeepPartial<SessionConfig>): SessionConfig {
  const out = structuredClone(base) as any;
  const walk = (dst: any, src: any) => {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (v === undefined) continue;
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof dst[k] === 'object' && dst[k] !== null) {
        walk(dst[k], v);
      } else {
        dst[k] = v;
      }
    }
  };
  walk(out, patch);
  return clampConfig(out as SessionConfig);
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* -------------------------------------------------------------------------- */
/* Model capabilities                                                          */
/* -------------------------------------------------------------------------- */

export interface ModelCapabilities {
  /** Accepts `reasoning: { effort }`. */
  reasoning: boolean;
  /** Accepts `text: { verbosity }`. */
  verbosity: boolean;
  /** Accepts `temperature`. */
  temperature: boolean;
  /** Why the above were decided, for display in the UI. */
  note: string;
}

/**
 * Which optional Responses-API parameters a model will accept.
 *
 * Sending an unsupported one is not a soft failure -- the API returns HTTP 400
 * and the turn produces no audio at all. Verified against the live API:
 *
 *   gpt-4.1 + reasoning.effort -> "Unsupported parameter: 'reasoning.effort'
 *                                  is not supported with this model."
 *   gpt-4.1 + text.verbosity   -> "Unsupported value: 'low' is not supported
 *                                  with the 'gpt-4.1' model."
 *
 * Unknown model ids are treated PERMISSIVELY: a new model must never be blocked
 * by a stale table here. The cost of guessing wrong in that direction is one
 * clearly-reported 400 rather than a silently dropped parameter, which is the
 * right trade for a measurement tool.
 */
export function modelCapabilities(model: string): ModelCapabilities {
  const m = (model ?? '').toLowerCase().trim();

  // GPT-4.x, GPT-3.x and the older chat/completion families predate both
  // reasoning effort and verbosity.
  if (/^(gpt-4|gpt-3|chatgpt|text-|davinci|babbage|curie|ada)/.test(m)) {
    return {
      reasoning: false,
      verbosity: false,
      temperature: true,
      note: 'Pre-GPT-5 model: rejects reasoning.effort and text.verbosity, accepts temperature.',
    };
  }

  // o-series reasoning models accept effort but not temperature.
  if (/^o[1-9]/.test(m)) {
    return {
      reasoning: true,
      verbosity: false,
      temperature: false,
      note: 'o-series reasoning model: accepts reasoning.effort, rejects temperature.',
    };
  }

  // GPT-5 and later: reasoning + verbosity. Temperature is generally unused on
  // these; it is left enabled because the API does not document a rejection.
  return {
    reasoning: true,
    verbosity: true,
    temperature: true,
    note: 'Reasoning-capable model: accepts reasoning.effort and text.verbosity.',
  };
}

/**
 * Drop parameters the selected model provably rejects.
 *
 * Applied whenever configuration changes, so switching model in the UI cannot
 * leave a stale `reasoning.effort` behind and break every subsequent turn. The
 * resolved configuration is echoed back to the browser, so the removal is
 * VISIBLE rather than silent -- important in a tool whose whole purpose is
 * making behaviour observable.
 */
export function applyModelCapabilities(c: SessionConfig): SessionConfig {
  const caps = modelCapabilities(c.llm.model);
  if (!caps.reasoning) c.llm.reasoningEffort = null;
  if (!caps.verbosity) c.llm.verbosity = null;
  if (!caps.temperature) c.llm.temperature = null;
  return c;
}

/**
 * Enforce provider-documented limits so an out-of-range value fails fast in the
 * UI rather than as an opaque provider error mid-benchmark.
 */
export function clampConfig(c: SessionConfig): SessionConfig {
  c.stt.maxDelay = clamp(c.stt.maxDelay, 0.7, 4);
  c.stt.endOfUtteranceSilenceTrigger = clamp(c.stt.endOfUtteranceSilenceTrigger, 0, 2);
  c.stt.punctuationSensitivity = clamp(c.stt.punctuationSensitivity, 0, 1);
  // Speechmatics guidance: keep the end-of-utterance trigger below max_delay.
  if (c.stt.endOfUtteranceSilenceTrigger > 0 && c.stt.endOfUtteranceSilenceTrigger >= c.stt.maxDelay) {
    c.stt.endOfUtteranceSilenceTrigger = Math.max(0, c.stt.maxDelay - 0.1);
  }
  c.vad.silenceThresholdMs = clamp(c.vad.silenceThresholdMs, 200, 1200);
  c.vad.positiveSpeechThreshold = clamp(c.vad.positiveSpeechThreshold, 0.1, 0.95);
  c.vad.negativeSpeechThreshold = clamp(c.vad.negativeSpeechThreshold, 0.05, 0.9);
  c.llm.maxOutputTokens = clamp(c.llm.maxOutputTokens, 16, 4096);
  if (c.llm.temperature !== null) c.llm.temperature = clamp(c.llm.temperature, 0, 2);
  c.tts.expressiveness = clamp(c.tts.expressiveness, 0, 2);
  c.tts.maxConcurrentPhrases = clamp(Math.round(c.tts.maxConcurrentPhrases), 1, 4);
  c.rag.topK = clamp(Math.round(c.rag.topK), 1, 20);
  c.rag.minScore = clamp(c.rag.minScore, 0, 1);
  // Defaulted here too: a config saved before this field existed would arrive
  // undefined, and an undefined floor silently disables the relevance gate.
  c.rag.minCoverage = clamp(c.rag.minCoverage ?? 0.35, 0, 1);
  c.rag.maxContextChars = clamp(Math.round(c.rag.maxContextChars), 200, 20_000);
  c.audio.jitterBufferMs = clamp(c.audio.jitterBufferMs, 0, 1000);
  c.audio.maxQueueMs = clamp(c.audio.maxQueueMs, 1000, 60_000);
  c.audio.micFrameMs = clamp(c.audio.micFrameMs, 10, 100);
  // Hamsa: mu-law output is always 8 kHz and cannot be combined with sampleRate.
  if (c.tts.mulaw) c.tts.sampleRate = '8k';
  // Strip Responses-API parameters the selected model would reject with a 400.
  applyModelCapabilities(c);
  // Mode C keeps its own ranges; applied unconditionally so the values stay
  // valid even while another mode is active.
  if (c.modeC) clampModeCConfig(c.modeC);
  return c;
}

/* -------------------------------------------------------------------------- */
/* Reference data for the UI                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hamsa dialect codes, verbatim from the realtime API schema. Voice NAMES are
 * deliberately not hardcoded: the docs contradict themselves across pages, so
 * the UI loads the real list from GET /v2/tts/voices/catalog at runtime.
 */
export const HAMSA_DIALECTS = [
  { code: 'pls', label: 'Palestinian' },
  { code: 'egy', label: 'Egyptian' },
  { code: 'syr', label: 'Syrian' },
  { code: 'irq', label: 'Iraqi' },
  { code: 'jor', label: 'Jordanian' },
  { code: 'leb', label: 'Lebanese' },
  { code: 'ksa', label: 'Saudi' },
  { code: 'uae', label: 'Emirati' },
  { code: 'bah', label: 'Bahraini' },
  { code: 'qat', label: 'Qatari' },
  { code: 'kuw', label: 'Kuwaiti' },
  { code: 'oma', label: 'Omani' },
  { code: 'msa', label: 'Modern Standard Arabic' },
  { code: 'ar-sa', label: 'Arabic (Gulf)' },
  { code: 'en', label: 'English' },
] as const;

/**
 * Suggested model ids, captured from the OpenAI documentation while building
 * this tool. The field is free text -- treat this list as a convenience, and
 * verify against the current model index before drawing conclusions.
 */
export const SUGGESTED_LLM_MODELS = [
  { id: 'gpt-4.1', note: 'lowest measured TTFT here (~486 ms); no reasoning.effort or verbosity' },
  { id: 'gpt-4.1-mini', note: 'cheaper 4.1 tier' },
  { id: 'gpt-4.1-nano', note: 'cheapest 4.1 tier' },
  { id: 'gpt-5.6-luna', note: 'nano tier of the 5.6 family' },
  { id: 'gpt-5.6-terra', note: 'mini tier; supports reasoning.effort=none' },
  { id: 'gpt-5.6-sol', note: 'flagship of the 5.6 family' },
  { id: 'gpt-5.5', note: 'previous flagship' },
  { id: 'gpt-5.4-mini', note: 'reasoning.effort defaults to none' },
  { id: 'gpt-6-astra', note: 'flagship; rejects reasoning.effort=none' },
] as const;

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const SERVICE_TIERS = ['auto', 'default', 'fast', 'priority', 'flex', 'scale'] as const;
