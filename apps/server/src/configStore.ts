/**
 * Persisting the session configuration.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Config lived only inside the Session object, and a Session is created per
 * WebSocket connection. So every page reload, every `tsx watch` restart and
 * every second tab started from `defaultConfig()` again, and any prompt the
 * operator had typed was silently gone. It looked exactly like "saving is
 * broken", because from the outside it was.
 *
 * WHY A FILE RATHER THAN PER-SESSION MEMORY
 * -----------------------------------------
 * The operator is tuning ONE agent, not configuring independent calls. A prompt
 * or an endpointing threshold is a property of the thing being benchmarked, so
 * it must outlive the socket that happened to set it and apply to every session
 * opened afterwards.
 *
 * WHY THE WRITE IS DEBOUNCED
 * --------------------------
 * The settings UI commits on every keystroke-blur and slider move. Writing
 * synchronously on each one would put disk I/O on the same thread that
 * timestamps audio frames — the one thing this codebase must never do. The
 * debounce keeps writes off the measurement path entirely.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  clampConfig,
  defaultConfig,
  mergeConfig,
  type DeepPartial,
  type SessionConfig,
} from '@vll/core';
import { serverConfig } from './env.js';

const FILE = join(serverConfig.dataDir, 'session-config.json');
const WRITE_DEBOUNCE_MS = 400;

let cached: SessionConfig | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pending: SessionConfig | null = null;
let lastError: string | null = null;

/**
 * The config every new session starts from.
 *
 * Falls back to the built-in defaults rather than throwing: a corrupt or absent
 * file must never stop the server from starting, it must only lose the saved
 * overrides.
 */
export async function loadPersistedConfig(): Promise<SessionConfig> {
  if (cached) return cached;
  try {
    const raw = await readFile(FILE, 'utf8');
    const parsed = JSON.parse(raw) as DeepPartial<SessionConfig>;
    // Merge onto the current defaults rather than using the file as-is, so a
    // config saved before a new field existed still gains that field instead of
    // arriving undefined and crashing whatever reads it.
    cached = clampConfig(mergeConfig(defaultConfig(), parsed));
    lastError = null;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') lastError = e?.message ?? String(e);
    cached = defaultConfig();
  }
  return cached;
}

/** Synchronous view for callers that cannot await. Null before the first load. */
export function persistedConfigSync(): SessionConfig | null {
  return cached;
}

export function persistError(): string | null {
  return lastError;
}

/** Record the new config and schedule a write. Never throws. */
export function persistConfig(config: SessionConfig): void {
  cached = config;
  pending = config;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushConfig();
  }, WRITE_DEBOUNCE_MS);
}

/** Write immediately, awaiting completion. Used on shutdown and by tests. */
export async function flushConfig(): Promise<void> {
  const toWrite = pending;
  if (!toWrite) return;
  pending = null;
  try {
    await mkdir(dirname(FILE), { recursive: true });
    // Write-then-rename: a crash mid-write would otherwise leave a truncated
    // JSON file that the next start would silently discard as corrupt, losing
    // the operator's settings for a second time.
    const tmp = `${FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(toWrite, null, 2), 'utf8');
    await rename(tmp, FILE);
    lastError = null;
  } catch (e: any) {
    lastError = e?.message ?? String(e);
  }
}

/** Forget the saved overrides and go back to the built-in defaults. */
export async function resetPersistedConfig(): Promise<SessionConfig> {
  cached = defaultConfig();
  persistConfig(cached);
  await flushConfig();
  return cached;
}

export function persistedConfigPath(): string {
  return FILE;
}
