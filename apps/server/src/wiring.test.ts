/**
 * Wiring tests: does anything actually CALL the code we ship?
 *
 * These exist because of a specific and expensive failure. A full audit found
 * nineteen Mode C settings that were declared, defaulted, clamped, bound to a
 * control in the settings page — and read by nothing at runtime. Among them was
 * the entire stopSpeaking plan, so a caller saying "اه" always interrupted the
 * agent no matter how the acknowledgement phrases were configured.
 *
 * Every one of those settings had passing unit tests. The logic was correct;
 * it simply had no call site. Conventional tests cannot catch that, because a
 * function tested in isolation behaves identically whether production calls it
 * once or never.
 *
 * So these assert the CONNECTION rather than the behaviour. They are
 * deliberately coarse — a source scan, not a mock — because the thing being
 * guarded is "somebody invokes this in the live path", and a mock would satisfy
 * that by construction.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');

/** Strip comments so a mention inside prose never counts as a call site. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('barge-in classification is on the live path', () => {
  const session = code(read('session.ts'));

  it('the live barge-in handler consults the classifier', () => {
    // The original defect: onBargeIn went straight to cancelCurrentTurn without
    // ever reading the transcript or the stopSpeaking plan.
    expect(session).toMatch(/resolveBargeIn\s*\(/);
    expect(session).toMatch(/classifyBargeIn\s*\(/);
  });

  it('a barge-in can be resolved by the transcript, not only by a timeout', () => {
    // Resolving solely on a timer would mean the phrase list still never
    // decided anything -- the agent would just stop slightly later.
    expect(session).toMatch(/resolveBargeIn\('partial_transcript'\)/);
  });

  it('the classifier is gated on the stopSpeaking master switch', () => {
    expect(session).toMatch(/modeC\.stopSpeaking\.enabled/);
  });

  it('classifyBargeIn has a caller outside its own definition', () => {
    const runtime = code(read('modeCRuntime.ts'));
    const definitions = (runtime.match(/classifyBargeIn/g) ?? []).length;
    const callsElsewhere = (session.match(/classifyBargeIn/g) ?? []).length;
    expect(definitions).toBeGreaterThan(0);
    expect(callsElsewhere).toBeGreaterThan(0);
  });
});

describe('session configuration is durable', () => {
  const session = code(read('session.ts'));
  const index = code(read('index.ts'));

  it('applying a config persists it beyond the socket that set it', () => {
    // A Session is constructed per WebSocket, so without this every reload
    // silently reverted the operator's prompt to the built-in default.
    expect(session).toMatch(/persistConfig\s*\(/);
  });

  it('a new session starts from the persisted config, not the bare defaults', () => {
    expect(session).toMatch(/persistedConfigSync\s*\(\)/);
  });

  it('the saved config is loaded before the server accepts connections', () => {
    expect(index).toMatch(/loadPersistedConfig\s*\(\)/);
  });

  it('a connecting client is told the effective config', () => {
    // Otherwise the settings page keeps displaying a prompt the server has
    // already discarded, which is indistinguishable from "saving is broken".
    expect(index).toMatch(/config\.applied/);
  });
});

describe('the TTS cache is written, not only read', () => {
  const orchestrator = code(read('../../../packages/core/src/modeC/orchestrator.ts'));

  it('stores completed phrases', () => {
    // ttsCache.get() had a call site; ttsCache.set() had none, so every lookup
    // missed and the whole feature was inert.
    expect(orchestrator).toMatch(/ttsCache\.set\s*\(/);
    expect(orchestrator).toMatch(/ttsCache\.get\s*\(/);
  });

  it('uses one key builder for both store and lookup', () => {
    // Two hand-rolled key literals would drift, and a cache that never hits
    // looks exactly like a cache that is never written.
    expect((orchestrator.match(/cacheKeyFor\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('background audio can actually produce sound', () => {
  const store = code(read('../../../apps/web/lib/store.ts'));

  it('starts its scheduler tick before the optional filler download', () => {
    // bgTick is the only caller of the scheduler, so nothing is audible until
    // the interval exists. It used to be installed after an unbounded fetch,
    // which kept the bed and keyboard -- neither of which needs any network --
    // silent for as long as that request took, and forever if it hung.
    const tick = store.indexOf('setInterval(bgTick');
    const fetchFillers = store.indexOf('/api/modec/fillers/render');
    expect(tick).toBeGreaterThan(-1);
    expect(fetchFillers).toBeGreaterThan(-1);
    expect(tick).toBeLessThan(fetchFillers);
  });

  it('bounds the filler request so a hang cannot strand the feature', () => {
    expect(store).toMatch(/AbortController/);
  });
});

describe('VAD settings the UI exposes are honoured', () => {
  const vad = code(read('../../../apps/web/lib/vadTypes.ts'));
  const store = code(read('../../../apps/web/lib/store.ts'));

  it('bargeInEnabled reaches the detector and gates the emit', () => {
    // The switch existed in the config and in the settings page but no runtime
    // code read it, so turning barge-in off changed nothing.
    expect(vad).toMatch(/bargeInEnabled/);
    expect(store).toMatch(/bargeInEnabled:/);
  });
});

describe('a turn can never wedge the session', () => {
  const runner = code(read('../../../packages/core/src/pipeline/turnRunner.ts'));
  const orchestrator = code(read('../../../packages/core/src/modeC/orchestrator.ts'));
  const session = code(read('session.ts'));

  /**
   * The worst failure this codebase had: an empty transcript returned early
   * from run(), skipping the completion hook. Nothing else clears
   * `currentTurn`, and run() RESOLVES rather than throwing so the `.catch()`
   * never fires — the session stayed pinned to a turn that could never finish
   * and the agent went silent for the rest of the call, with no error anywhere.
   */
  for (const [name, src] of [
    ['turnRunner', runner],
    ['modeC orchestrator', orchestrator],
  ] as const) {
    it(`${name}: every exit from run() releases the turn`, () => {
      // No bare `return this.result(...)` may remain: each must be wrapped.
      const bare = src.match(/return this\.result\(/g) ?? [];
      expect(bare, `${name} has an exit that skips the completion hook`).toHaveLength(0);
      expect(src).toMatch(/return this\.finish\(/);
    });

    it(`${name}: the completion hook fires exactly once`, () => {
      // A guard, so routing every exit through finish() cannot double-report.
      expect(src).toMatch(/if \(this\.finished\) return res;/);
    });
  }

  it('the session has a backstop for a turn that never completes', () => {
    expect(session).toMatch(/armTurnWatchdog/);
  });

  it('the backstop is cleared on both release paths', () => {
    // A stray timer would otherwise fire later against an unrelated turn.
    expect((session.match(/clearTimeout\(t\.watchdog\)|clearTimeout\(state\.watchdog\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
  });
});

describe('markup is stripped before whitespace is collapsed', () => {
  // Order-dependent and easy to reintroduce: the bullet, heading and
  // blockquote rules are `^`-anchored, so collapsing newlines first silently
  // disables them and the caller hears the hyphens.
  for (const [name, rel] of [
    ['streaming chunker', '../../../packages/core/src/text/chunker.ts'],
    ['mode C', '../../../packages/core/src/modeC/voiceChunkPlanner.ts'],
  ] as const) {
    it(`${name}: does not collapse whitespace before stripping`, () => {
      const src = code(read(rel));
      // stripMarkdown must receive the RAW slice, newlines intact.
      expect(src).toMatch(/stripMarkdown\(raw\)/);
      // And the old order must not have crept back: a whitespace collapse
      // assigned into `text` before stripMarkdown is the exact bug.
      const collapseFirst = src.indexOf("let text = raw.trim().replace(/\\s+/g, ' ')");
      expect(collapseFirst, 'whitespace is collapsed before stripping again').toBe(-1);
    });
  }
});
