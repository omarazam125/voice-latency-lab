/**
 * Mode C — background audio and non-lexical fillers.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A caller who hears *nothing* for 900 ms assumes the line is dead. A caller
 * who hears a keyboard and a distant office for those same 900 ms assumes
 * someone is looking something up. The wait is identical; the experience is
 * not. Vapi exposes the same idea as a single `backgroundSound` property
 * (`"off"` | `"office"` | a custom audio URL), defaulting to `office` on phone
 * calls and `off` on web calls.
 *
 * THE MEASUREMENT CONTRACT — read this before touching anything here
 * ------------------------------------------------------------------
 * Background audio changes PERCEIVED latency. It changes real latency by
 * exactly zero milliseconds. Two rules keep that distinction honest:
 *
 *   1. Everything in this module is OFF by default, so no baseline measurement
 *      is ever quietly flattered by it.
 *   2. Nothing emitted here is `tts.first_audio`. Filler and ambience cues
 *      carry `perceptual: true` and are excluded from the TTFS critical path.
 *      A keyboard click is not an answer, and must never be counted as one.
 *
 * The lab reports both numbers side by side: true TTFS (when the ANSWER was
 * audible) and perceived TTFS (when ANY intentional sound was audible). The
 * gap between them is the illusion, stated as a number rather than hidden.
 *
 * This module is pure decision logic — no Web Audio, no timers, no I/O — so
 * the scheduling rules can be tested deterministically. Rendering lives in the
 * browser (apps/web/lib/ambience.ts) on the player's existing AudioContext.
 */

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/** Where a bed sound comes from. */
export type AmbienceSource =
  /** Synthesised in the browser: no asset, no download, no licence. */
  | 'procedural_office'
  /** A file the operator supplies. Mirrors Vapi's custom-URL affordance. */
  | 'url';

export interface AmbienceBedConfig {
  enabled: boolean;
  source: AmbienceSource;
  /** Used when `source === 'url'`. */
  url: string | null;
  /** Resting level. Deliberately tiny: a bed you consciously notice is too loud. */
  gain: number;
  /**
   * Level while either party is speaking. Ducking matters for more than taste:
   * a bed at full gain during agent speech measurably degrades intelligibility,
   * and if the caller is on a speakerphone it feeds back into our own STT.
   */
  duckedGain: number;
  /** Ramp time for every gain change. Instant jumps are audible as clicks. */
  fadeMs: number;
}

export interface KeyboardConfig {
  enabled: boolean;
  /**
   * Only start typing once the turn has genuinely been working this long.
   *
   * The threshold is the entire trick. Typing that starts and stops inside
   * 200 ms reads as a glitch and makes the agent feel BROKEN rather than busy,
   * so a fast turn must stay silent. Slower than this and the silence is what
   * needs covering.
   */
  startAfterMs: number;
  gain: number;
  /** Keystrokes per second. Human sustained typing is roughly 4-8. */
  rate: number;
  /** Randomises inter-key gaps by +/- this fraction. Perfectly even keystrokes read as a machine. */
  jitter: number;
  fadeMs: number;
}

export interface FillerConfig {
  enabled: boolean;
  /**
   * Play a filler only once the wait has already exceeded this. Same reasoning
   * as the keyboard threshold: a filler in front of a fast answer ADDS
   * perceived latency, because the answer now queues behind it.
   */
  afterMs: number;
  /**
   * Non-lexical fillers only. These are hesitation sounds, not words: they
   * commit the agent to nothing, so they cannot contradict the answer that
   * follows. "لحظة من فضلك" is a promise; "ممم" is just a breath.
   */
  phrases: string[];
  /** Skip this many turns after playing one. Every-turn hesitation reads as a stutter. */
  cooldownTurns: number;
  gain: number;
}

export interface BackchannelConfig {
  /**
   * Short acknowledgement WHILE THE CALLER IS STILL SPEAKING, to signal
   * listening. Off by default and the riskiest feature here: a backchannel
   * mistimed over the caller's own words is an interruption, which is worse
   * than silence.
   */
  enabled: boolean;
  /** Caller must have been talking uninterrupted for at least this long. */
  afterMs: number;
  /** Never twice inside this window, however long the caller talks. */
  cooldownMs: number;
  phrases: string[];
  gain: number;
}

export interface BackgroundAudioConfig {
  /** Master switch. Off by default — see the measurement contract above. */
  enabled: boolean;
  bed: AmbienceBedConfig;
  keyboard: KeyboardConfig;
  filler: FillerConfig;
  backchannel: BackchannelConfig;
}

/**
 * Arabic non-lexical hesitation sounds.
 *
 * Spelled as sounds rather than words on purpose. They are rendered through
 * the same Hamsa voice as the answer and cached, so the hesitation and the
 * reply come from one mouth rather than two.
 */
export const AR_FILLER_SOUNDS = ['ممم', 'أممم', 'إيه', 'أهه'];

/** Short "I am listening" tokens. Kept separate: a backchannel is not a hesitation. */
export const AR_BACKCHANNEL_SOUNDS = ['ممم', 'اها', 'أيوه', 'تمام'];

export function defaultBackgroundAudioConfig(): BackgroundAudioConfig {
  return {
    enabled: false,
    bed: {
      enabled: true,
      source: 'procedural_office',
      url: null,
      gain: 0.035,
      duckedGain: 0.012,
      fadeMs: 400,
    },
    keyboard: {
      enabled: true,
      startAfterMs: 350,
      gain: 0.1,
      rate: 6,
      jitter: 0.45,
      fadeMs: 120,
    },
    filler: {
      enabled: false,
      afterMs: 700,
      phrases: [...AR_FILLER_SOUNDS],
      cooldownTurns: 2,
      gain: 0.85,
    },
    backchannel: {
      enabled: false,
      afterMs: 2500,
      cooldownMs: 6000,
      phrases: [...AR_BACKCHANNEL_SOUNDS],
      gain: 0.6,
    },
  };
}

const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

export function clampBackgroundAudioConfig(c: BackgroundAudioConfig): BackgroundAudioConfig {
  const b = c.bed;
  b.gain = clamp(b.gain, 0, 0.4);
  // The duck must actually duck. Allowing ducked > resting would let a
  // misconfiguration make the bed LOUDER under speech.
  b.duckedGain = clamp(b.duckedGain, 0, b.gain);
  b.fadeMs = clamp(b.fadeMs, 10, 3000);

  const k = c.keyboard;
  k.startAfterMs = clamp(k.startAfterMs, 100, 5000);
  k.gain = clamp(k.gain, 0, 0.5);
  k.rate = clamp(k.rate, 1, 20);
  k.jitter = clamp(k.jitter, 0, 1);
  k.fadeMs = clamp(k.fadeMs, 10, 2000);

  const f = c.filler;
  f.afterMs = clamp(f.afterMs, 150, 5000);
  f.cooldownTurns = Math.round(clamp(f.cooldownTurns, 0, 20));
  f.gain = clamp(f.gain, 0, 1);
  if (f.phrases.length === 0) f.phrases = [...AR_FILLER_SOUNDS];

  const bc = c.backchannel;
  bc.afterMs = clamp(bc.afterMs, 500, 20_000);
  bc.cooldownMs = clamp(bc.cooldownMs, 0, 60_000);
  bc.gain = clamp(bc.gain, 0, 1);
  if (bc.phrases.length === 0) bc.phrases = [...AR_BACKCHANNEL_SOUNDS];

  return c;
}

/* -------------------------------------------------------------------------- */
/* Scheduler                                                                   */
/* -------------------------------------------------------------------------- */

export type BackgroundCue =
  | { kind: 'bed'; action: 'start' | 'stop' }
  | { kind: 'bed'; action: 'gain'; gain: number; fadeMs: number }
  | { kind: 'keyboard'; action: 'start'; gain: number; rate: number; jitter: number }
  | { kind: 'keyboard'; action: 'stop'; fadeMs: number }
  | { kind: 'filler'; action: 'play'; phrase: string; gain: number; reason: 'thinking' }
  | { kind: 'backchannel'; action: 'play'; phrase: string; gain: number }
  | { kind: 'all'; action: 'stop'; reason: 'real_audio' | 'barge_in' | 'turn_end' };

/** Everything the scheduler needs to know, sampled at one instant. */
export interface BackgroundAudioState {
  /** Monotonic milliseconds. Never a wall clock. */
  nowMs: number;
  callerSpeaking: boolean;
  /** True once REAL answer audio is playing. Filler audio does not count. */
  agentSpeaking: boolean;
  /** Endpoint fired, pipeline running, no answer audio yet. */
  working: boolean;
  /** How long `working` has been true. */
  workingForMs: number;
  /** How long the caller has been speaking without a break. */
  callerSpeakingForMs: number;
  turnIndex: number;
}

/**
 * Turns pipeline state into audio cues.
 *
 * Deliberately a state machine over sampled state rather than a set of event
 * callbacks: the caller can poll it at any cadence, and the same input
 * sequence always yields the same cues, which is what makes it testable.
 */
export class BackgroundAudioScheduler {
  private started = false;
  private keyboardOn = false;
  private beddedGain: number | null = null;
  private fillerTurn = -Infinity;
  private fillerThisTurn = false;
  private lastBackchannelMs = -Infinity;
  private phraseIx = 0;
  private backchannelIx = 0;
  private lastTurn = -1;

  constructor(private cfg: BackgroundAudioConfig) {}

  update(cfg: BackgroundAudioConfig): void {
    this.cfg = cfg;
  }

  /** Cues to apply for this sample. Returns [] when nothing should change. */
  evaluate(s: BackgroundAudioState): BackgroundCue[] {
    const cues: BackgroundCue[] = [];
    if (!this.cfg.enabled) {
      if (this.started) {
        this.started = false;
        this.keyboardOn = false;
        this.beddedGain = null;
        cues.push({ kind: 'all', action: 'stop', reason: 'turn_end' });
      }
      return cues;
    }

    if (s.turnIndex !== this.lastTurn) {
      this.lastTurn = s.turnIndex;
      this.fillerThisTurn = false;
    }

    /* -- the bed ---------------------------------------------------------- */
    if (this.cfg.bed.enabled) {
      if (!this.started) {
        this.started = true;
        cues.push({ kind: 'bed', action: 'start' });
      }
      // Duck under ANY speech, the caller's included: the bed exists to fill
      // silence, and there is no silence to fill while someone is talking.
      const target =
        s.agentSpeaking || s.callerSpeaking ? this.cfg.bed.duckedGain : this.cfg.bed.gain;
      if (this.beddedGain === null || Math.abs(this.beddedGain - target) > 1e-6) {
        this.beddedGain = target;
        cues.push({ kind: 'bed', action: 'gain', gain: target, fadeMs: this.cfg.bed.fadeMs });
      }
    } else if (this.started) {
      this.started = false;
      this.beddedGain = null;
      cues.push({ kind: 'bed', action: 'stop' });
    }

    /* -- the keyboard ----------------------------------------------------- */
    const k = this.cfg.keyboard;
    // Real audio always wins. The instant the answer is audible the typing is
    // not just unnecessary, it is actively competing with the thing the caller
    // is trying to hear.
    const keyboardWanted =
      k.enabled && s.working && !s.agentSpeaking && !s.callerSpeaking && s.workingForMs >= k.startAfterMs;

    if (keyboardWanted && !this.keyboardOn) {
      this.keyboardOn = true;
      cues.push({ kind: 'keyboard', action: 'start', gain: k.gain, rate: k.rate, jitter: k.jitter });
    } else if (!keyboardWanted && this.keyboardOn) {
      this.keyboardOn = false;
      cues.push({ kind: 'keyboard', action: 'stop', fadeMs: k.fadeMs });
    }

    /* -- the thinking filler ---------------------------------------------- */
    const f = this.cfg.filler;
    if (
      f.enabled &&
      s.working &&
      !s.agentSpeaking &&
      !s.callerSpeaking &&
      !this.fillerThisTurn &&
      s.workingForMs >= f.afterMs &&
      s.turnIndex - this.fillerTurn > f.cooldownTurns
    ) {
      this.fillerThisTurn = true;
      this.fillerTurn = s.turnIndex;
      cues.push({
        kind: 'filler',
        action: 'play',
        phrase: this.nextPhrase(f.phrases, 'filler'),
        gain: f.gain,
        reason: 'thinking',
      });
    }

    /* -- the backchannel -------------------------------------------------- */
    const bc = this.cfg.backchannel;
    if (
      bc.enabled &&
      s.callerSpeaking &&
      !s.agentSpeaking &&
      s.callerSpeakingForMs >= bc.afterMs &&
      s.nowMs - this.lastBackchannelMs >= bc.cooldownMs
    ) {
      this.lastBackchannelMs = s.nowMs;
      cues.push({
        kind: 'backchannel',
        action: 'play',
        phrase: this.nextPhrase(bc.phrases, 'backchannel'),
        gain: bc.gain,
      });
    }

    return cues;
  }

  /**
   * Real answer audio has started. Everything perceptual stops immediately.
   * Called from the audio path rather than inferred from a poll, because a
   * filler still sounding underneath the first word of the answer is the one
   * failure mode that makes the whole feature sound broken.
   */
  onRealAudio(): BackgroundCue[] {
    const cues: BackgroundCue[] = [];
    if (this.keyboardOn) {
      this.keyboardOn = false;
      cues.push({ kind: 'keyboard', action: 'stop', fadeMs: this.cfg.keyboard.fadeMs });
    }
    cues.push({ kind: 'all', action: 'stop', reason: 'real_audio' });
    return cues;
  }

  /** The caller interrupted: drop every perceptual sound at once. */
  onBargeIn(): BackgroundCue[] {
    this.keyboardOn = false;
    return [{ kind: 'all', action: 'stop', reason: 'barge_in' }];
  }

  reset(): void {
    this.started = false;
    this.keyboardOn = false;
    this.beddedGain = null;
    this.fillerTurn = -Infinity;
    this.fillerThisTurn = false;
    this.lastBackchannelMs = -Infinity;
    this.lastTurn = -1;
  }

  /**
   * Round-robin rather than random.
   *
   * Random selection repeats by chance, and a hesitation sound repeating twice
   * in a row is instantly recognisable as a recording. Rotating guarantees the
   * caller hears every variant before hearing any of them twice.
   */
  private nextPhrase(list: string[], which: 'filler' | 'backchannel'): string {
    if (list.length === 0) return '';
    if (which === 'filler') return list[this.phraseIx++ % list.length]!;
    return list[this.backchannelIx++ % list.length]!;
  }
}
