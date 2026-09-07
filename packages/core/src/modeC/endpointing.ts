/**
 * EndpointingManager — decides when the caller has finished their turn.
 *
 * A fixed "silence > X ms" timer is the single most common cause of a voice
 * agent feeling slow, because X has to be set for the WORST case. Someone
 * reading out an account number pauses between digit groups, so X ends up at
 * 1.5 s — and then every short, obviously-finished question ("شو الخدمات؟")
 * also waits 1.5 s for no reason.
 *
 * This manager instead chooses the required silence FROM THE CONTENT of the
 * live transcript:
 *
 *   ends in "؟" or "."   -> the thought is complete, commit almost immediately
 *   ends in a number     -> they are probably mid-sequence, wait longer
 *   ends in "و" / "بس"   -> they are mid-thought, wait longer still
 *   no punctuation       -> ambiguous, fall back to the long timer
 *
 * Every decision is published with its REASON, because an endpointing engine
 * that cannot explain itself is impossible to tune and impossible to trust.
 * A false commit cuts the caller off mid-sentence, which is far more damaging
 * than a late one, so the aggressive paths are all gated on transcript
 * stability as well as on time.
 */

import { queryEquivalence } from '../text/similarity.js';
import type { EndpointingConfig, EndpointingStrategy } from './config.js';

/* -------------------------------------------------------------------------- */
/* Transcript stability                                                        */
/* -------------------------------------------------------------------------- */

export interface TranscriptState {
  /** Latest partial from the transcriber. */
  partial: string;
  /** The previous partial, for change detection. */
  previous: string;
  /** Longest common prefix that has stopped changing. */
  stablePrefix: string;
  /** The part still in flux. */
  changedSuffix: string;
  /** Milliseconds since the partial last changed materially. */
  timeSinceChangedMs: number;
  /** 0..1 — how settled the transcript looks. */
  stabilityScore: number;
  /** Number of revisions observed this turn. */
  revisions: number;
}

/** Longest common prefix of two strings, cut back to a word boundary. */
export function stablePrefixOf(a: string, b: string): string {
  // Identical strings are entirely stable. Checked first: otherwise the
  // word-boundary trim below would chop the last word off an unchanged
  // transcript and permanently under-report stability.
  if (a === b) return a;

  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const cut = a.slice(0, i);

  // A partial match must not report half a word as "stable".
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace) : '';
}

/**
 * Stability in [0,1], combining three independent signals:
 *
 *   - how long the text has been unchanged (the dominant term)
 *   - how much of it is a stable prefix
 *   - how few revisions the transcriber has made
 *
 * Weighted rather than thresholded so that a long-but-recently-revised
 * transcript and a short-but-settled one are distinguishable.
 */
export function computeStability(
  partial: string,
  previous: string,
  timeSinceChangedMs: number,
  revisions: number,
  windowMs: number,
): number {
  if (!partial) return 0;

  const timeScore = Math.min(1, timeSinceChangedMs / Math.max(1, windowMs));

  const prefix = stablePrefixOf(partial, previous || partial);
  const prefixScore = partial.length > 0 ? prefix.length / partial.length : 0;

  // Many revisions means the transcriber is still making up its mind.
  const revisionScore = 1 / (1 + revisions * 0.15);

  return Math.max(0, Math.min(1, timeScore * 0.6 + prefixScore * 0.25 + revisionScore * 0.15));
}

/* -------------------------------------------------------------------------- */
/* Content classification                                                      */
/* -------------------------------------------------------------------------- */

/** Sentence-final punctuation, including the Arabic question mark. */
const SENTENCE_END = /[.!?؟۔]\s*$/u;
/** Non-terminal punctuation: a pause, not an ending. */
const SOFT_END = /[,،;؛:]\s*$/u;
/** Trailing digits, Western or Arabic-Indic. */
const TRAILING_NUMBER = /[0-9٠-٩۰-۹]\s*$/u;
/** Ellipsis: explicitly unfinished. */
const TRAILING_ELLIPSIS = /(\.\.\.|…)\s*$/u;

export type ContentClass = 'punctuation' | 'number' | 'soft_punctuation' | 'ellipsis' | 'none';

export function classifyTranscript(text: string): ContentClass {
  const t = text.trimEnd();
  if (!t) return 'none';
  if (TRAILING_ELLIPSIS.test(t)) return 'ellipsis';
  if (SENTENCE_END.test(t)) return 'punctuation';
  if (TRAILING_NUMBER.test(t)) return 'number';
  if (SOFT_END.test(t)) return 'soft_punctuation';
  return 'none';
}

const WORDISH = /[\p{L}\p{N}]/u;
export function usefulWordCount(text: string): number {
  let n = 0;
  for (const tok of text.split(/\s+/)) if (tok && WORDISH.test(tok)) n++;
  return n;
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                   */
/* -------------------------------------------------------------------------- */

export interface EndpointDecision {
  /** True when the turn should be committed now. */
  commit: boolean;
  /** Human-readable justification, shown verbatim in the monitor. */
  reason: string;
  /** Machine-readable reason for telemetry and aggregation. */
  reasonCode:
    | 'waiting'
    | 'below_wait_seconds'
    | 'too_few_words'
    | 'punctuation_complete'
    | 'number_pause_elapsed'
    | 'soft_punctuation_elapsed'
    | 'no_punctuation_timeout'
    | 'custom_rule'
    | 'ellipsis_timeout'
    | 'max_wait_ceiling'
    | 'vad_silence'
    | 'final_transcript'
    | 'forced';
  /** How much silence this decision required, in ms. */
  requiredSilenceMs: number;
  /** Silence observed so far, in ms. */
  observedSilenceMs: number;
  /** Confidence in [0,1] that the caller really has finished. */
  confidence: number;
  contentClass: ContentClass;
  stabilityScore: number;
  words: number;
  strategy: EndpointingStrategy;
  /** Name of the custom rule that fired, when one did. */
  ruleName?: string;
}

export interface EndpointingInputs {
  /** True while the VAD reports speech. */
  speaking: boolean;
  /** Continuous trailing silence, in ms. 0 while speaking. */
  silenceMs: number;
  /** Latest transcript text (partial or final). */
  transcript: string;
  /** True when the transcriber has delivered a FINAL for this utterance. */
  hasFinal: boolean;
  /** Milliseconds since the transcript last changed materially. */
  timeSinceTranscriptChangedMs: number;
  /** Revisions observed this turn. */
  revisions: number;
  previousTranscript: string;
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                     */
/* -------------------------------------------------------------------------- */

export class EndpointingManager {
  private compiledRules: Array<{ name: string; re: RegExp; seconds: number }> = [];
  private lastDecision: EndpointDecision | null = null;
  private committed = false;

  constructor(private config: EndpointingConfig) {
    this.compileRules();
  }

  updateConfig(config: EndpointingConfig): void {
    this.config = config;
    this.compileRules();
  }

  private compileRules(): void {
    this.compiledRules = [];
    for (const r of this.config.customRules ?? []) {
      if (!r.enabled) continue;
      try {
        this.compiledRules.push({ name: r.name, re: new RegExp(r.pattern, 'u'), seconds: r.seconds });
      } catch {
        // A malformed user-supplied pattern must not break endpointing; it is
        // simply skipped, and the rule shows as inactive in the UI.
      }
    }
  }

  reset(): void {
    this.committed = false;
    this.lastDecision = null;
  }

  get decision(): EndpointDecision | null {
    return this.lastDecision;
  }

  get hasCommitted(): boolean {
    return this.committed;
  }

  /** Build the observable transcript-stability view for the monitor. */
  buildState(i: EndpointingInputs): TranscriptState {
    const stablePrefix = stablePrefixOf(i.transcript, i.previousTranscript || i.transcript);
    return {
      partial: i.transcript,
      previous: i.previousTranscript,
      stablePrefix,
      changedSuffix: i.transcript.slice(stablePrefix.length),
      timeSinceChangedMs: i.timeSinceTranscriptChangedMs,
      stabilityScore: computeStability(
        i.transcript,
        i.previousTranscript,
        i.timeSinceTranscriptChangedMs,
        i.revisions,
        this.config.transcriptStabilityMs,
      ),
      revisions: i.revisions,
    };
  }

  /**
   * Evaluate whether the turn is over. Called on every VAD frame and on every
   * transcript update -- it is pure and cheap, with no timers of its own, so the
   * caller controls exactly when decisions happen.
   */
  evaluate(i: EndpointingInputs): EndpointDecision {
    const cfg = this.config;
    const text = i.transcript.trimEnd();
    const words = usefulWordCount(text);
    const contentClass = classifyTranscript(text);
    const stability = computeStability(
      text,
      i.previousTranscript,
      i.timeSinceTranscriptChangedMs,
      i.revisions,
      cfg.transcriptStabilityMs,
    );

    const base = {
      observedSilenceMs: i.silenceMs,
      contentClass,
      stabilityScore: Math.round(stability * 1000) / 1000,
      words,
      strategy: cfg.strategy,
    };

    // Still talking: nothing to decide.
    if (i.speaking) {
      return this.remember({
        ...base,
        commit: false,
        reason: 'Caller is still speaking',
        reasonCode: 'waiting',
        requiredSilenceMs: 0,
        confidence: 0,
      });
    }

    const maxWaitMs = cfg.maxWaitSeconds * 1000;

    /* -- strategy: plain VAD silence ------------------------------------- */
    if (cfg.strategy === 'vad_silence') {
      const required = cfg.onNoPunctuationSeconds * 1000;
      const commit = i.silenceMs >= required && words >= cfg.minWords;
      return this.remember({
        ...base,
        commit,
        reason: commit
          ? `Fixed silence timer elapsed (${Math.round(required)} ms)`
          : `Waiting for ${Math.round(required)} ms of silence`,
        reasonCode: commit ? 'vad_silence' : 'waiting',
        requiredSilenceMs: required,
        confidence: commit ? 0.6 : 0,
      });
    }

    /* -- absolute ceiling ------------------------------------------------ */
    // Checked before the word-count guard so a turn can never hang forever on
    // an unintelligible utterance.
    if (i.silenceMs >= maxWaitMs) {
      return this.remember({
        ...base,
        commit: words > 0,
        reason: `Maximum wait of ${Math.round(maxWaitMs)} ms reached`,
        reasonCode: 'max_wait_ceiling',
        requiredSilenceMs: maxWaitMs,
        confidence: 0.5,
      });
    }

    /* -- minimum floor --------------------------------------------------- */
    const waitMs = cfg.waitSeconds * 1000;
    if (i.silenceMs < waitMs) {
      return this.remember({
        ...base,
        commit: false,
        reason: `Below the minimum wait of ${Math.round(waitMs)} ms`,
        reasonCode: 'below_wait_seconds',
        requiredSilenceMs: waitMs,
        confidence: 0,
      });
    }

    if (words < cfg.minWords) {
      return this.remember({
        ...base,
        commit: false,
        reason: `Only ${words} useful word(s); need ${cfg.minWords}`,
        reasonCode: 'too_few_words',
        requiredSilenceMs: waitMs,
        confidence: 0,
      });
    }

    /* -- custom rules win over the built-in classes ---------------------- */
    for (const r of this.compiledRules) {
      if (!r.re.test(text)) continue;
      const required = r.seconds * 1000;
      const commit = i.silenceMs >= required;
      return this.remember({
        ...base,
        commit,
        reason: commit
          ? `Custom rule "${r.name}" satisfied after ${Math.round(required)} ms`
          : `Custom rule "${r.name}" requires ${Math.round(required)} ms`,
        reasonCode: commit ? 'custom_rule' : 'waiting',
        requiredSilenceMs: required,
        confidence: commit ? 0.75 : 0,
        ruleName: r.name,
      });
    }

    /* -- content-driven timers ------------------------------------------- */
    let required: number;
    let code: EndpointDecision['reasonCode'];
    let label: string;
    let confidence: number;

    switch (contentClass) {
      case 'punctuation':
        required = cfg.onPunctuationSeconds * 1000;
        code = 'punctuation_complete';
        label = 'ends in sentence punctuation';
        confidence = 0.95;
        break;
      case 'number':
        required = cfg.onNumberSeconds * 1000;
        code = 'number_pause_elapsed';
        label = 'ends in a number, caller may still be reading';
        confidence = 0.7;
        break;
      case 'soft_punctuation':
        // A comma is a pause, not an ending: treat it as closer to "no
        // punctuation" than to a full stop.
        required = Math.max(cfg.onNumberSeconds, cfg.onNoPunctuationSeconds * 0.6) * 1000;
        code = 'soft_punctuation_elapsed';
        label = 'ends in a comma — a pause, not an ending';
        confidence = 0.6;
        break;
      case 'ellipsis':
        required = cfg.onNoPunctuationSeconds * 1000;
        code = 'ellipsis_timeout';
        label = 'ends in an ellipsis — explicitly unfinished';
        confidence = 0.5;
        break;
      default:
        required = cfg.onNoPunctuationSeconds * 1000;
        code = 'no_punctuation_timeout';
        label = 'no punctuation';
        confidence = 0.65;
        break;
    }

    // The floor always applies, even when punctuation says "commit now".
    required = Math.max(required, waitMs);

    // A settled FINAL transcript is the strongest possible signal.
    if (i.hasFinal && contentClass === 'punctuation') {
      required = Math.min(required, Math.max(waitMs, cfg.onPunctuationSeconds * 1000));
      confidence = 0.98;
    }

    // Gate the aggressive punctuation path on stability. Punctuation on a
    // transcript that is still being revised is not yet trustworthy.
    const stabilityOk = stability >= cfg.minStabilityScore;
    if (contentClass === 'punctuation' && !stabilityOk) {
      const fallback = Math.max(required, cfg.onNoPunctuationSeconds * 1000 * 0.5);
      const commit = i.silenceMs >= fallback;
      return this.remember({
        ...base,
        commit,
        reason: commit
          ? `Punctuation present but transcript unsettled (${base.stabilityScore}); waited ${Math.round(fallback)} ms`
          : `Punctuation present but transcript still changing (stability ${base.stabilityScore} < ${cfg.minStabilityScore})`,
        reasonCode: commit ? 'punctuation_complete' : 'waiting',
        requiredSilenceMs: fallback,
        confidence: commit ? 0.7 : 0,
      });
    }

    const commit = i.silenceMs >= required;
    return this.remember({
      ...base,
      commit,
      reason: commit
        ? `Committed: ${label} (required ${Math.round(required)} ms, observed ${Math.round(i.silenceMs)} ms)`
        : `Waiting: ${label} needs ${Math.round(required)} ms, observed ${Math.round(i.silenceMs)} ms`,
      reasonCode: commit ? code : 'waiting',
      requiredSilenceMs: required,
      confidence: commit ? confidence : 0,
    });
  }

  private remember(d: EndpointDecision): EndpointDecision {
    this.lastDecision = d;
    if (d.commit) this.committed = true;
    return d;
  }

  /**
   * How much time this decision saved against the plain fixed-silence timer the
   * other modes use. Negative means the content-aware path was more cautious,
   * which is a legitimate and expected outcome for numbers and trailing
   * conjunctions.
   */
  savedVersusFixedTimer(d: EndpointDecision): number {
    const fixed = this.config.onNoPunctuationSeconds * 1000;
    return Math.round(fixed - d.requiredSilenceMs);
  }
}

/* -------------------------------------------------------------------------- */
/* Interruption classification                                                 */
/* -------------------------------------------------------------------------- */

export type InterruptionClass = 'interruption' | 'acknowledgement' | 'insufficient' | 'backoff';

export interface InterruptionDecision {
  klass: InterruptionClass;
  interrupt: boolean;
  reason: string;
  matchedPhrase?: string;
  words: number;
  voiceMs: number;
}

/**
 * Distinguishes a genuine interruption from a backchannel.
 *
 * A caller saying "تمام" or "اه" while the assistant talks is agreeing, not
 * taking the floor. Treating that as an interruption makes the agent stop
 * constantly and feel broken, which is a worse failure than being slightly slow
 * to yield.
 */
export function classifyInterruption(
  text: string,
  voiceMs: number,
  cfg: {
    numWords: number;
    voiceSeconds: number;
    acknowledgementPhrases: string[];
    interruptionPhrases: string[];
  },
  inBackoff = false,
): InterruptionDecision {
  const normalized = text.trim().toLowerCase();
  const words = usefulWordCount(normalized);

  if (inBackoff) {
    // The backoff exists to stop ONE burst of speech cutting the agent off
    // repeatedly. It must not silence a caller who has clearly taken the floor:
    // observed live, a 872 ms three-word question was labelled a backchannel
    // and ignored purely because it landed inside the window.
    //
    // So the window raises the bar rather than closing the door. An explicit
    // stop phrase still wins outright, and sustained speech still interrupts —
    // it just has to be twice as sustained.
    const explicit = cfg.interruptionPhrases.some((p) => {
      const needle = p.trim().toLowerCase();
      return needle && normalized.includes(needle);
    });
    const emphatic = voiceMs >= cfg.voiceSeconds * 2000 || (cfg.numWords > 0 && words >= cfg.numWords * 2);
    if (!explicit && !emphatic) {
      return {
        klass: 'backoff',
        interrupt: false,
        reason: 'Within the post-interruption backoff window',
        words,
        voiceMs,
      };
    }
  }

  // Explicit stop phrases always win, whatever the thresholds say.
  for (const p of cfg.interruptionPhrases) {
    const needle = p.trim().toLowerCase();
    if (needle && normalized.includes(needle)) {
      return {
        klass: 'interruption',
        interrupt: true,
        reason: `Explicit interruption phrase "${p}"`,
        matchedPhrase: p,
        words,
        voiceMs,
      };
    }
  }

  // A short utterance that is ENTIRELY a backchannel is not an interruption.
  if (normalized && words <= 2) {
    for (const p of cfg.acknowledgementPhrases) {
      const needle = p.trim().toLowerCase();
      if (!needle) continue;
      if (normalized === needle || queryEquivalence(normalized, needle) >= 0.9) {
        return {
          klass: 'acknowledgement',
          interrupt: false,
          reason: `Backchannel "${p}" — caller is agreeing, not interrupting`,
          matchedPhrase: p,
          words,
          voiceMs,
        };
      }
    }
  }

  const voiceThresholdMs = cfg.voiceSeconds * 1000;
  if (voiceMs < voiceThresholdMs) {
    return {
      klass: 'insufficient',
      interrupt: false,
      reason: `Voice activity ${Math.round(voiceMs)} ms below the ${Math.round(voiceThresholdMs)} ms threshold`,
      words,
      voiceMs,
    };
  }

  // numWords = 0 means voice activity alone is enough.
  if (cfg.numWords > 0 && words < cfg.numWords) {
    return {
      klass: 'insufficient',
      interrupt: false,
      reason: `${words} word(s) below the ${cfg.numWords}-word threshold`,
      words,
      voiceMs,
    };
  }

  return {
    klass: 'interruption',
    interrupt: true,
    reason:
      cfg.numWords === 0
        ? `Sustained voice activity (${Math.round(voiceMs)} ms)`
        : `${words} word(s) spoken over the assistant`,
    words,
    voiceMs,
  };
}
