/**
 * Does the ambience engine actually produce audible output?
 *
 * "The setting exists" and "the code is written" are not the same claim as
 * "sound comes out", and this feature has already failed twice in ways that a
 * settings-page screenshot could not reveal: once because the tick that drives
 * every cue was installed behind an unbounded network request, and once because
 * the bed's loop zeroed its own tail.
 *
 * So these drive the real AmbienceEngine against a mock Web Audio graph and
 * assert on the graph it builds: a source that is started and connected, and a
 * gain that actually leaves zero. A test that only checked "apply() did not
 * throw" would have passed throughout both bugs.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { AmbienceEngine } from './ambience';
import type { BackgroundCue } from '@vll/core';

/* -------------------------------------------------------------------------- */
/* A mock AudioContext, just rich enough to observe what the engine does        */
/* -------------------------------------------------------------------------- */

class MockParam {
  value = 0;
  ramps: Array<{ to: number; at: number }> = [];
  cancelScheduledValues(): void {}
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(to: number, at: number): void {
    this.ramps.push({ to, at });
    this.value = to; // settle immediately so assertions read the target
  }
}

class MockGain {
  gain = new MockParam();
  connections: unknown[] = [];
  connect(n: unknown): unknown {
    this.connections.push(n);
    return n;
  }
  disconnect(): void {}
}

class MockSource {
  buffer: any = null;
  loop = false;
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  connections: unknown[] = [];
  connect(n: unknown): unknown {
    this.connections.push(n);
    return n;
  }
  disconnect(): void {}
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class MockFilter {
  type = '';
  frequency = new MockParam();
  Q = new MockParam();
  connect(n: unknown): unknown {
    return n;
  }
  disconnect(): void {}
}

class MockAudioContext {
  sampleRate = 48000;
  currentTime = 0;
  destination = { id: 'destination' };
  sources: MockSource[] = [];
  gains: MockGain[] = [];

  createGain(): MockGain {
    const g = new MockGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource(): MockSource {
    const s = new MockSource();
    this.sources.push(s);
    return s;
  }
  createBiquadFilter(): MockFilter {
    return new MockFilter();
  }
  createBuffer(channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return {
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      duration: length / rate,
      getChannelData: () => data,
    };
  }
}

function makeEngine() {
  const ctx = new MockAudioContext();
  const engine = new AmbienceEngine(ctx as unknown as AudioContext);
  return { ctx, engine };
}

const bedStart: BackgroundCue = { kind: 'bed', action: 'start' };
const bedGain = (gain: number): BackgroundCue => ({ kind: 'bed', action: 'gain', gain, fadeMs: 100 });

describe('ambience engine — the bed', () => {
  let ctx: MockAudioContext;
  let engine: AmbienceEngine;

  beforeEach(async () => {
    ({ ctx, engine } = makeEngine());
    await engine.prepare('procedural_office', null);
  });

  it('starts a looping source connected to the graph', () => {
    engine.apply(bedStart);
    const started = ctx.sources.filter((s) => s.started);
    expect(started).toHaveLength(1);
    expect(started[0]!.loop).toBe(true);
    expect(started[0]!.buffer).toBeTruthy();
    expect(started[0]!.connections.length).toBeGreaterThan(0);
  });

  it('actually raises the gain off zero — silence is the failure mode', () => {
    engine.apply(bedStart);
    // The bed gain node is created first in the constructor.
    const bedNode = ctx.gains[0]!;
    expect(bedNode.gain.value).toBe(0);

    engine.apply(bedGain(0.035));
    expect(bedNode.gain.value).toBeCloseTo(0.035);
    expect(bedNode.gain.ramps.at(-1)!.to).toBeCloseTo(0.035);
  });

  it('ramps rather than jumping, so the level change is not a click', () => {
    engine.apply(bedStart);
    engine.apply(bedGain(0.04));
    const bedNode = ctx.gains[0]!;
    expect(bedNode.gain.ramps.length).toBeGreaterThan(0);
    expect(bedNode.gain.ramps.at(-1)!.at).toBeGreaterThan(ctx.currentTime);
  });

  it('does not start a second source when told to start twice', () => {
    engine.apply(bedStart);
    engine.apply(bedStart);
    expect(ctx.sources.filter((s) => s.started)).toHaveLength(1);
  });

  it('builds a bed with no silent gap, so the loop does not fall quiet', () => {
    // The earlier bug: the tail was zeroed in place, leaving 1.2s of silence at
    // the end of every 8s pass. Assert the last chunk carries real signal.
    engine.apply(bedStart);
    const buf = ctx.sources.find((s) => s.started)!.buffer;
    const data: Float32Array = buf.getChannelData(0);
    const tail = data.subarray(Math.floor(data.length * 0.9));
    const energy = tail.reduce((n, v) => n + Math.abs(v), 0) / tail.length;
    expect(energy).toBeGreaterThan(0);
  });

  it('produces a buffer shorter than the working length, the folded tail removed', () => {
    engine.apply(bedStart);
    const buf = ctx.sources.find((s) => s.started)!.buffer;
    // 8s worked, 1.2s seam folded in and discarded => ~6.8s published.
    expect(buf.duration).toBeGreaterThan(6);
    expect(buf.duration).toBeLessThan(8);
  });
});

describe('ambience engine — the keyboard', () => {
  it('raises the keyboard gain when typing starts', async () => {
    const { ctx, engine } = makeEngine();
    await engine.prepare('procedural_office', null);
    const kbNode = ctx.gains[1]!; // bed, keyboard, filler — in constructor order
    expect(kbNode.gain.value).toBe(0);

    engine.apply({ kind: 'keyboard', action: 'start', gain: 0.1, rate: 6, jitter: 0.4 });
    expect(kbNode.gain.value).toBeCloseTo(0.1);

    engine.apply({ kind: 'keyboard', action: 'stop', fadeMs: 100 });
    expect(kbNode.gain.value).toBe(0);
  });
});

describe('ambience engine — hesitation sounds', () => {
  it('plays a pre-rendered sample through the graph', async () => {
    const { ctx, engine } = makeEngine();
    await engine.prepare('procedural_office', null);

    const pcm = new Int16Array(1600).fill(1000);
    engine.setFillerSample('ممم', pcm, 16000);
    expect(engine.preparedFillers).toBe(1);

    const before = ctx.sources.filter((s) => s.started).length;
    engine.apply({ kind: 'filler', action: 'play', phrase: 'ممم', gain: 0.85, reason: 'thinking' });
    expect(ctx.sources.filter((s) => s.started).length).toBe(before + 1);
  });

  it('silently skips a phrase that was never pre-rendered', async () => {
    const { ctx, engine } = makeEngine();
    await engine.prepare('procedural_office', null);
    const before = ctx.sources.filter((s) => s.started).length;
    // Synthesising on demand would take longer than the wait it is covering.
    engine.apply({ kind: 'filler', action: 'play', phrase: 'غير موجود', gain: 1, reason: 'thinking' });
    expect(ctx.sources.filter((s) => s.started).length).toBe(before);
  });
});
