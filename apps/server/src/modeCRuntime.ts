/**
 * Server-side Mode C runtime.
 *
 * Holds the pieces of Mode C that live for the whole SESSION rather than for a
 * single turn: the endpointing engine, its evaluation loop, the phrase cache and
 * the event bus.
 *
 * The key structural difference from Modes A and B: in Mode C the ENDPOINT
 * DECISION IS MADE HERE, on the server, not in the browser. It has to be —
 * the decision depends on the transcript, and only the server has that. The
 * browser still detects the physical end of speech (which is a pure audio
 * question and belongs next to the microphone); the server then decides how
 * long that silence needs to last given what the caller actually said.
 *
 * No protocol change was needed for this: once the clocks are synchronised, the
 * server can compute elapsed silence itself from the browser's speech-end
 * timestamp, and re-evaluate on its own timer.
 */

import { deltaMs, nowNs, roundMs, type ScopedEmitter } from '@vll/telemetry';
import {
  EndpointingManager,
  TtsCache,
  VoiceEventBus,
  classifyInterruption,
  type EndpointDecision,
  type InterruptionDecision,
  type ModeCConfig,
} from '@vll/core';
import type { TurnTranscriptTracker } from './transcripts.js';

export interface ModeCRuntimeHooks {
  /** Fired when the endpointing engine decides the turn is over. */
  onCommit: (decision: EndpointDecision, speechEndNs: bigint, commitNs: bigint) => void;
  /** Fired on every evaluation, for the live endpointing lane. */
  onEvaluated: (decision: EndpointDecision) => void;
}

/** How often the endpointing engine re-evaluates while the caller is silent. */
const EVAL_INTERVAL_MS = 20;

export class ModeCRuntime {
  readonly bus = new VoiceEventBus();
  readonly cache: TtsCache;
  private endpointing: EndpointingManager;

  private timer: ReturnType<typeof setInterval> | null = null;
  private speechEndNs: bigint | null = null;
  private speaking = false;
  private lastDecision: EndpointDecision | null = null;
  private committed = false;

  /** Transcript revision tracking, for the stability score. */
  private previousTranscript = '';
  private revisions = 0;
  private lastChangeNs = nowNs();

  /** Interruption state. */
  private bargeStartNs: bigint | null = null;
  private lastInterruptionNs: bigint | null = null;
  private lastInterruption: InterruptionDecision | null = null;

  /* -- perceived-latency acknowledgements -------------------------------- */
  /**
   * Cross-turn state for the spoken acknowledgement.
   *
   * It has to live here rather than in the orchestrator because the
   * orchestrator is built fresh for every turn, and both a cooldown measured in
   * turns and a rotation through the phrase list are meaningless without
   * memory that outlives one. Previously neither worked: cooldownTurns was read
   * by nothing and only phrases[0] was ever spoken.
   */
  private turnIndex = 0;
  private lastAckTurn = -Infinity;
  private ackPhraseIx = 0;

  /** Advance the turn counter. Called once per committed turn. */
  noteTurnStarted(): void {
    this.turnIndex++;
  }

  /**
   * The phrase to speak while a slow operation runs, or null to stay silent.
   *
   * Returning null on cooldown is the point: an agent that hesitates audibly on
   * every single turn reads as a stutter, not as thoughtfulness.
   */
  takeAcknowledgement(): string | null {
    const p = this.config.perceivedLatency;
    if (!p.enabled || p.phrases.length === 0) return null;
    if (this.turnIndex - this.lastAckTurn <= p.cooldownTurns) return null;
    this.lastAckTurn = this.turnIndex;
    // Rotate rather than always speaking phrases[0]: the same words twice in a
    // row are instantly recognisable as a recording.
    return p.phrases[this.ackPhraseIx++ % p.phrases.length] ?? null;
  }

  constructor(
    private config: ModeCConfig,
    private readonly hooks: ModeCRuntimeHooks,
  ) {
    this.endpointing = new EndpointingManager(config.endpointing);
    this.cache = new TtsCache({
      maxEntries: config.ttsCache.maxEntries,
      maxBytes: config.ttsCache.maxBytes,
      maxPhraseChars: config.ttsCache.maxPhraseChars,
    });
  }

  updateConfig(config: ModeCConfig): void {
    this.config = config;
    this.endpointing.updateConfig(config.endpointing);
    this.cache.updateOptions({
      maxEntries: config.ttsCache.maxEntries,
      maxBytes: config.ttsCache.maxBytes,
      maxPhraseChars: config.ttsCache.maxPhraseChars,
    });
  }

  get decision(): EndpointDecision | null {
    return this.lastDecision;
  }

  get interruption(): InterruptionDecision | null {
    return this.lastInterruption;
  }

  /* ---------------------------------------------------------------------- */
  /* Transcript tracking                                                     */
  /* ---------------------------------------------------------------------- */

  onTranscriptChanged(text: string): void {
    if (text === this.previousTranscript) return;
    this.previousTranscript = this.currentText;
    this.currentText = text;
    this.revisions++;
    this.lastChangeNs = nowNs();
  }

  private currentText = '';

  /* ---------------------------------------------------------------------- */
  /* VAD                                                                     */
  /* ---------------------------------------------------------------------- */

  onSpeechStarted(): void {
    this.speaking = true;
    this.speechEndNs = null;
    this.committed = false;
    this.stopLoop();
    this.endpointing.reset();
    this.revisions = 0;
    this.currentText = '';
    this.previousTranscript = '';
    this.bargeStartNs = null;
  }

  /**
   * The caller physically stopped. This starts the DECISION process; it is not
   * itself the decision.
   */
  onSpeechEnded(atNs: bigint): void {
    this.speaking = false;
    this.speechEndNs = atNs;
    this.committed = false;
    this.startLoop();
  }

  /** Abandon the in-progress evaluation (new turn, barge-in, reset). */
  reset(): void {
    this.stopLoop();
    this.speaking = false;
    this.speechEndNs = null;
    this.committed = false;
    this.endpointing.reset();
    this.revisions = 0;
    this.currentText = '';
    this.previousTranscript = '';
    this.lastDecision = null;
  }

  private startLoop(): void {
    this.stopLoop();
    // Evaluate immediately so a very short onPunctuationSeconds is not rounded
    // up to the tick interval.
    this.evaluate();
    this.timer = setInterval(() => this.evaluate(), EVAL_INTERVAL_MS);
    (this.timer as any).unref?.();
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called whenever a transcript arrives, so punctuation acts without waiting for a tick. */
  evaluateNow(): void {
    if (this.speechEndNs !== null && !this.committed) this.evaluate();
  }

  private evaluate(): void {
    if (this.committed || this.speechEndNs === null) return;
    const now = nowNs();
    const silenceMs = deltaMs(this.speechEndNs, now);

    const decision = this.endpointing.evaluate({
      speaking: this.speaking,
      silenceMs,
      transcript: this.currentText,
      hasFinal: this.hasFinal,
      timeSinceTranscriptChangedMs: deltaMs(this.lastChangeNs, now),
      revisions: this.revisions,
      previousTranscript: this.previousTranscript,
    });

    this.lastDecision = decision;
    this.hooks.onEvaluated(decision);

    if (decision.commit) {
      this.committed = true;
      this.stopLoop();
      this.hooks.onCommit(decision, this.speechEndNs, now);
    }
  }

  private hasFinal = false;

  setHasFinal(v: boolean): void {
    this.hasFinal = v;
    if (v) this.evaluateNow();
  }

  /* ---------------------------------------------------------------------- */
  /* Interruption                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Classify a caller utterance heard while the assistant is speaking.
   *
   * Returns the decision so the caller can log it either way: a REJECTED
   * interruption ("تمام" as a backchannel) is just as interesting as an
   * accepted one, and silently ignoring it would look like a bug.
   */
  classifyBargeIn(transcript: string, voiceMs: number): InterruptionDecision {
    const now = nowNs();
    const inBackoff =
      this.lastInterruptionNs !== null &&
      deltaMs(this.lastInterruptionNs, now) < this.config.stopSpeaking.backoffSeconds * 1000;

    const d = classifyInterruption(
      transcript,
      voiceMs,
      {
        numWords: this.config.stopSpeaking.numWords,
        voiceSeconds: this.config.stopSpeaking.voiceSeconds,
        acknowledgementPhrases: this.config.stopSpeaking.acknowledgementPhrases,
        interruptionPhrases: this.config.stopSpeaking.interruptionPhrases,
      },
      inBackoff,
    );

    this.lastInterruption = d;
    if (d.interrupt) this.lastInterruptionNs = now;
    return d;
  }

  /** Track how long the caller has been talking over the assistant. */
  noteAssistantOverlapStart(atNs: bigint): void {
    if (this.bargeStartNs === null) this.bargeStartNs = atNs;
  }

  overlapMs(): number {
    return this.bargeStartNs === null ? 0 : deltaMs(this.bargeStartNs, nowNs());
  }

  clearOverlap(): void {
    this.bargeStartNs = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Observability                                                           */
  /* ---------------------------------------------------------------------- */

  /** Live snapshot for the endpointing lane in the UI. */
  snapshot() {
    const d = this.lastDecision;
    const silenceMs = this.speechEndNs !== null ? roundMs(deltaMs(this.speechEndNs, nowNs())) : 0;
    return {
      strategy: this.config.endpointing.strategy,
      speaking: this.speaking,
      silenceMs,
      transcript: this.currentText,
      revisions: this.revisions,
      committed: this.committed,
      decision: d
        ? {
            commit: d.commit,
            reason: d.reason,
            reasonCode: d.reasonCode,
            requiredSilenceMs: roundMs(d.requiredSilenceMs),
            observedSilenceMs: roundMs(d.observedSilenceMs),
            confidence: d.confidence,
            contentClass: d.contentClass,
            stabilityScore: d.stabilityScore,
            words: d.words,
            ruleName: d.ruleName,
            savedVersusFixedMs: this.endpointing.savedVersusFixedTimer(d),
          }
        : null,
      interruption: this.lastInterruption,
      cache: this.cache.stats(),
    };
  }

  dispose(): void {
    this.stopLoop();
    this.bus.dispose();
    this.cache.clear();
  }
}

/**
 * Build the live transcript view the endpointing engine consumes.
 * Kept as a free function so the runtime does not depend on the tracker type.
 */
export function currentTranscriptOf(tracker: TurnTranscriptTracker): string {
  const final = tracker.finalSoFar();
  const partial = tracker.latestPartial();
  if (final && partial) return `${final} ${partial}`.trim();
  return final || partial;
}
