/**
 * Live transcript tracking for one conversational turn.
 *
 * Speechmatics delivers a stream of revisable PARTIALS and a stream of
 * immutable FINAL segments. A single utterance normally produces several final
 * segments, so "the final transcript" is their concatenation, and knowing when
 * that concatenation is COMPLETE is the interesting part.
 *
 * When provider-side endpointing is enabled, Speechmatics documents that it
 * "sends a final transcript message to the client, followed by an extra
 * EndOfUtterance message" -- so EndOfUtterance is an exact completion signal.
 * Without it, we fall back to a short settle window after the last final.
 */

import { deltaMs, nowNs } from '@vll/telemetry';
import type { StableTranscript, TranscriptSource } from '@vll/core';

interface Waiter {
  resolve: (text: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TurnTranscriptTracker implements TranscriptSource {
  private partial = '';
  private partialChangedNs: bigint = nowNs();
  private finals: string[] = [];
  private lastFinalNs: bigint | null = null;
  private endOfUtterance = false;
  private waiters: Waiter[] = [];
  private lateFinalSubs = new Set<(t: string) => void>();
  private resolvedOnce = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Milliseconds of quiet after a final before we treat the turn as complete. */
  constructor(private readonly settleMs = 160) {}

  /* ---- ingest ---------------------------------------------------------- */

  pushPartial(text: string): boolean {
    const t = text.trim();
    if (t === this.partial) return false;
    this.partial = t;
    this.partialChangedNs = nowNs();
    return true;
  }

  pushFinal(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.finals.push(t);
    this.lastFinalNs = nowNs();
    // A final supersedes the partial that preceded it.
    this.partial = '';

    if (this.resolvedOnce) {
      // The turn already proceeded without this. Report it so the accuracy cost
      // of that decision can be measured rather than assumed.
      const full = this.finalSoFar();
      for (const cb of this.lateFinalSubs) {
        try {
          cb(full);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (this.endOfUtterance) {
      this.settle();
      return;
    }
    // No provider endpointing: wait a beat in case more finals follow.
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settle(), this.settleMs);
  }

  markEndOfUtterance(): void {
    this.endOfUtterance = true;
    // EndOfUtterance follows the last final, so anything buffered is complete.
    if (this.finals.length > 0) this.settle();
  }

  private settle(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    const text = this.finalSoFar();
    if (!text) return;
    this.resolvedOnce = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(text);
    }
  }

  /* ---- TranscriptSource ------------------------------------------------ */

  latestPartial(): string {
    return this.partial;
  }

  stablePartial(minStableMs: number): StableTranscript | null {
    if (!this.partial) return null;
    const stableFor = deltaMs(this.partialChangedNs, nowNs());
    if (stableFor < minStableMs) return null;
    return { text: this.partial, stableSinceNs: this.partialChangedNs };
  }

  finalSoFar(): string {
    return this.finals.join(' ').replace(/\s+/g, ' ').trim();
  }

  get hasFinal(): boolean {
    return this.finals.length > 0;
  }

  get lastFinalAtNs(): bigint | null {
    return this.lastFinalNs;
  }

  waitForFinal(timeoutMs: number): Promise<string | null> {
    const existing = this.finalSoFar();
    if (existing && (this.endOfUtterance || this.resolvedOnce)) {
      this.resolvedOnce = true;
      return Promise.resolve(existing);
    }
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        this.resolvedOnce = true;
        resolve(this.finalSoFar() || null);
      }, Math.max(0, timeoutMs));
      this.waiters.push({ resolve, timer });
    });
  }

  onLateFinal(cb: (text: string) => void): () => void {
    this.lateFinalSubs.add(cb);
    return () => this.lateFinalSubs.delete(cb);
  }

  /** Called by the runner once it has committed to a transcript. */
  markConsumed(): void {
    this.resolvedOnce = true;
  }

  dispose(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(this.finalSoFar() || null);
    }
    this.waiters = [];
    this.lateFinalSubs.clear();
  }
}
