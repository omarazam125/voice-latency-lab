import { describe, expect, it } from 'vitest';
import {
  BackgroundAudioScheduler,
  clampBackgroundAudioConfig,
  defaultBackgroundAudioConfig,
  type BackgroundAudioConfig,
  type BackgroundAudioState,
  type BackgroundCue,
} from './backgroundAudio.js';

/** Enabled config with the risky features on, so each test can opt out. */
function cfg(patch: (c: BackgroundAudioConfig) => void = () => {}): BackgroundAudioConfig {
  const c = defaultBackgroundAudioConfig();
  c.enabled = true;
  c.filler.enabled = true;
  c.backchannel.enabled = true;
  patch(c);
  return clampBackgroundAudioConfig(c);
}

function state(patch: Partial<BackgroundAudioState> = {}): BackgroundAudioState {
  return {
    nowMs: 0,
    callerSpeaking: false,
    agentSpeaking: false,
    working: false,
    workingForMs: 0,
    callerSpeakingForMs: 0,
    turnIndex: 0,
    ...patch,
  };
}

const kinds = (cues: BackgroundCue[]) => cues.map((c) => `${c.kind}:${c.action}`);
const find = <K extends BackgroundCue['kind']>(cues: BackgroundCue[], kind: K) =>
  cues.find((c) => c.kind === kind) as Extract<BackgroundCue, { kind: K }> | undefined;

describe('background audio — the measurement contract', () => {
  it('is off by default, so no baseline is ever quietly flattered', () => {
    const d = defaultBackgroundAudioConfig();
    expect(d.enabled).toBe(false);
    // The two features that put SOUND IN THE AGENT'S VOICE in front of the
    // answer are additionally off on their own.
    expect(d.filler.enabled).toBe(false);
    expect(d.backchannel.enabled).toBe(false);
  });

  it('emits nothing at all while the master switch is off', () => {
    const s = new BackgroundAudioScheduler(defaultBackgroundAudioConfig());
    expect(s.evaluate(state({ working: true, workingForMs: 5000 }))).toEqual([]);
  });

  it('tears everything down when the switch is turned off mid-call', () => {
    const c = cfg();
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    c.enabled = false;
    s.update(c);
    expect(kinds(s.evaluate(state()))).toContain('all:stop');
  });
});

describe('background audio — the bed', () => {
  it('starts once and ducks under agent speech, then recovers', () => {
    const c = cfg();
    const s = new BackgroundAudioScheduler(c);

    const first = s.evaluate(state());
    expect(kinds(first)).toContain('bed:start');
    expect(find(first, 'bed')).toBeTruthy();
    // resting level
    const rest = first.filter((x) => x.kind === 'bed' && x.action === 'gain')[0] as any;
    expect(rest.gain).toBeCloseTo(c.bed.gain);

    const ducked = s.evaluate(state({ agentSpeaking: true }));
    expect((ducked.find((x) => x.kind === 'bed' && x.action === 'gain') as any).gain).toBeCloseTo(
      c.bed.duckedGain,
    );

    const back = s.evaluate(state());
    expect((back.find((x) => x.kind === 'bed' && x.action === 'gain') as any).gain).toBeCloseTo(c.bed.gain);
  });

  it('ducks under the CALLER too — there is no silence to fill while they talk', () => {
    const c = cfg();
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    const cues = s.evaluate(state({ callerSpeaking: true }));
    expect((cues.find((x) => x.kind === 'bed' && x.action === 'gain') as any).gain).toBeCloseTo(
      c.bed.duckedGain,
    );
  });

  it('does not re-emit a gain cue when the level has not changed', () => {
    const s = new BackgroundAudioScheduler(cfg());
    s.evaluate(state());
    expect(s.evaluate(state()).filter((x) => x.kind === 'bed')).toHaveLength(0);
  });

  it('never lets a misconfigured duck be LOUDER than the resting level', () => {
    const c = cfg((x) => {
      x.bed.gain = 0.02;
      x.bed.duckedGain = 0.9;
    });
    expect(c.bed.duckedGain).toBeLessThanOrEqual(c.bed.gain);
  });
});

describe('background audio — the keyboard', () => {
  it('stays SILENT on a fast turn: a 200ms blip reads as a glitch, not as work', () => {
    const c = cfg();
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    const cues = s.evaluate(state({ working: true, workingForMs: c.keyboard.startAfterMs - 1 }));
    expect(kinds(cues)).not.toContain('keyboard:start');
  });

  it('starts once the wait is genuinely long enough to need covering', () => {
    const c = cfg();
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    const cues = s.evaluate(state({ working: true, workingForMs: c.keyboard.startAfterMs }));
    const k = find(cues, 'keyboard');
    expect(k?.action).toBe('start');
    expect((k as any).rate).toBe(c.keyboard.rate);
  });

  it('stops the instant real answer audio is audible', () => {
    const c = cfg();
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    s.evaluate(state({ working: true, workingForMs: 900 }));

    const cues = s.onRealAudio();
    expect(kinds(cues)).toEqual(expect.arrayContaining(['keyboard:stop', 'all:stop']));
    expect(cues.find((x) => x.kind === 'all')).toMatchObject({ reason: 'real_audio' });
  });

  it('does not restart typing while the agent is speaking', () => {
    const s = new BackgroundAudioScheduler(cfg());
    s.evaluate(state());
    const cues = s.evaluate(state({ working: true, workingForMs: 5000, agentSpeaking: true }));
    expect(kinds(cues)).not.toContain('keyboard:start');
  });

  it('only emits start once, not on every poll', () => {
    const s = new BackgroundAudioScheduler(cfg());
    s.evaluate(state());
    s.evaluate(state({ working: true, workingForMs: 600 }));
    const again = s.evaluate(state({ working: true, workingForMs: 700 }));
    expect(kinds(again)).not.toContain('keyboard:start');
  });
});

describe('background audio — the thinking filler', () => {
  it('does not play in front of a fast answer, where it would ADD perceived latency', () => {
    const c = cfg();
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    const cues = s.evaluate(state({ working: true, workingForMs: c.filler.afterMs - 50 }));
    expect(kinds(cues)).not.toContain('filler:play');
  });

  it('plays exactly once per turn, however often it is polled', () => {
    const s = new BackgroundAudioScheduler(cfg());
    s.evaluate(state());
    const a = s.evaluate(state({ working: true, workingForMs: 800 }));
    const b = s.evaluate(state({ working: true, workingForMs: 900 }));
    expect(kinds(a)).toContain('filler:play');
    expect(kinds(b)).not.toContain('filler:play');
  });

  it('honours the turn cooldown so the agent does not hesitate every single turn', () => {
    const c = cfg((x) => {
      x.filler.cooldownTurns = 2;
    });
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    expect(kinds(s.evaluate(state({ turnIndex: 0, working: true, workingForMs: 800 })))).toContain(
      'filler:play',
    );
    // turns 1 and 2 fall inside the cooldown
    expect(kinds(s.evaluate(state({ turnIndex: 1, working: true, workingForMs: 800 })))).not.toContain(
      'filler:play',
    );
    expect(kinds(s.evaluate(state({ turnIndex: 2, working: true, workingForMs: 800 })))).not.toContain(
      'filler:play',
    );
    expect(kinds(s.evaluate(state({ turnIndex: 3, working: true, workingForMs: 800 })))).toContain(
      'filler:play',
    );
  });

  it('rotates variants instead of picking at random, so none repeats back to back', () => {
    const c = cfg((x) => {
      x.filler.cooldownTurns = 0;
      x.filler.phrases = ['ممم', 'أممم', 'إيه'];
    });
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    const heard: string[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const cues = s.evaluate(state({ turnIndex: turn, working: true, workingForMs: 800 }));
      const f = find(cues, 'filler');
      if (f) heard.push(f.phrase);
    }
    expect(heard).toEqual(['ممم', 'أممم', 'إيه', 'ممم', 'أممم', 'إيه']);
    for (let i = 1; i < heard.length; i++) expect(heard[i]).not.toBe(heard[i - 1]);
  });

  it('uses non-lexical sounds only — a hesitation must not promise anything', () => {
    // "لحظة من فضلك" commits the agent to an action; "ممم" commits it to nothing
    // and therefore cannot be contradicted by the answer that follows.
    for (const p of defaultBackgroundAudioConfig().filler.phrases) {
      expect(p.split(/\s+/)).toHaveLength(1);
    }
  });
});

describe('background audio — the backchannel', () => {
  it('waits for a sustained turn before acknowledging', () => {
    const c = cfg();
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());
    const early = s.evaluate(
      state({ callerSpeaking: true, callerSpeakingForMs: c.backchannel.afterMs - 1 }),
    );
    expect(kinds(early)).not.toContain('backchannel:play');

    const ok = s.evaluate(state({ callerSpeaking: true, callerSpeakingForMs: c.backchannel.afterMs }));
    expect(kinds(ok)).toContain('backchannel:play');
  });

  it('respects the cooldown however long the caller keeps talking', () => {
    const c = cfg((x) => {
      x.backchannel.afterMs = 1000;
      x.backchannel.cooldownMs = 5000;
    });
    const s = new BackgroundAudioScheduler(c);
    s.evaluate(state());

    const at = (nowMs: number) =>
      kinds(s.evaluate(state({ nowMs, callerSpeaking: true, callerSpeakingForMs: nowMs })));

    expect(at(1000)).toContain('backchannel:play');
    expect(at(3000)).not.toContain('backchannel:play');
    expect(at(6000)).toContain('backchannel:play');
  });

  it('never speaks over the agent', () => {
    const s = new BackgroundAudioScheduler(cfg());
    s.evaluate(state());
    const cues = s.evaluate(
      state({ callerSpeaking: true, callerSpeakingForMs: 9999, agentSpeaking: true }),
    );
    expect(kinds(cues)).not.toContain('backchannel:play');
  });
});

describe('background audio — barge-in', () => {
  it('drops every perceptual sound at once', () => {
    const s = new BackgroundAudioScheduler(cfg());
    s.evaluate(state());
    s.evaluate(state({ working: true, workingForMs: 900 }));
    expect(s.onBargeIn()[0]).toMatchObject({ kind: 'all', action: 'stop', reason: 'barge_in' });
  });

  it('can start cleanly again after a reset', () => {
    const s = new BackgroundAudioScheduler(cfg());
    s.evaluate(state());
    s.reset();
    expect(kinds(s.evaluate(state()))).toContain('bed:start');
  });
});

describe('background audio — clamping', () => {
  it('keeps every gain inside a sane range', () => {
    const c = clampBackgroundAudioConfig(
      cfg((x) => {
        x.bed.gain = 99;
        x.keyboard.gain = -5;
        x.keyboard.rate = 1000;
        x.filler.gain = 42;
      }),
    );
    expect(c.bed.gain).toBeLessThanOrEqual(0.4);
    expect(c.keyboard.gain).toBeGreaterThanOrEqual(0);
    expect(c.keyboard.rate).toBeLessThanOrEqual(20);
    expect(c.filler.gain).toBeLessThanOrEqual(1);
  });

  it('restores the defaults when a phrase list is emptied', () => {
    const c = clampBackgroundAudioConfig(
      cfg((x) => {
        x.filler.phrases = [];
        x.backchannel.phrases = [];
      }),
    );
    expect(c.filler.phrases.length).toBeGreaterThan(0);
    expect(c.backchannel.phrases.length).toBeGreaterThan(0);
  });
});
