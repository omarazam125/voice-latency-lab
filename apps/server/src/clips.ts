/**
 * Recorded test clips, held per session in memory.
 *
 * Kept in its own module so the routes do not have to import the server entry
 * point (which would be a circular dependency).
 */

import type { Session } from './session.js';

export interface RecordedClip {
  pcm: Uint8Array;
  durationMs: number;
  recordedAt: string;
}

const clips = new WeakMap<Session, RecordedClip>();

export function getClip(session: Session): RecordedClip | null {
  return clips.get(session) ?? null;
}

export function setClip(session: Session, clip: { pcm: Uint8Array; durationMs: number }): RecordedClip {
  const stored: RecordedClip = { ...clip, recordedAt: new Date().toISOString() };
  clips.set(session, stored);
  return stored;
}

export function clearClip(session: Session): void {
  clips.delete(session);
}
