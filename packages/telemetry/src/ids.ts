/**
 * Identifier minting. Isomorphic: uses the WebCrypto global, which is available
 * in Node >= 19 and every target browser, so this file can be bundled for the
 * client without pulling in `node:crypto`.
 */

function hex(bytes: number): string {
  const a = new Uint8Array(bytes);
  const c = (globalThis as any).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(a);
  } else {
    for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < bytes; i++) out += a[i].toString(16).padStart(2, '0');
  return out;
}

/** Stable per-browser-connection identity. */
export const newSessionId = (): string => `sess_${hex(8)}`;

/** One per conversational turn (user utterance -> assistant response). */
export const newTurnId = (): string => `turn_${hex(6)}`;

/** W3C-trace-context-shaped id, so these traces can be exported to an APM later. */
export const newTraceId = (): string => hex(16);

export const newSpanId = (): string => hex(8);

export const newId = (prefix: string): string => `${prefix}_${hex(6)}`;

/**
 * Monotonically increasing generation counter used to invalidate stale audio on
 * barge-in. Any audio frame whose generation is behind `current` is discarded
 * rather than played.
 */
export class GenerationCounter {
  private value = 0;
  next(): number {
    return ++this.value;
  }
  get current(): number {
    return this.value;
  }
  isStale(gen: number): boolean {
    return gen < this.value;
  }
}
