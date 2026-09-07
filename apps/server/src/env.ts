/**
 * Environment and credential handling.
 *
 * SECURITY CONTRACT (spec section 2):
 *   - API keys live in this process only. They are never serialised into any
 *     response, telemetry event, log line or export.
 *   - The UI may supply a key for a throwaway test; it is held in memory for
 *     the lifetime of the process and never written to disk or localStorage.
 *   - `redact()` is applied to every value that could contain a key before it
 *     reaches a log.
 */

import { config as loadDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Find the repo root by walking up for the workspace marker, then load `.env`
 * from there.
 *
 * `import 'dotenv/config'` resolves relative to `process.cwd()`, so running
 * `npm run dev` inside apps/server silently loaded no keys at all -- every
 * provider then reported "missing credentials" while a fully populated `.env`
 * sat two directories up. Anchoring to the repo root makes the server behave
 * identically whichever directory it is started from.
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    // The workspace root is the package.json that declares the workspaces.
    const pkg = resolve(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
      } catch {
        /* unreadable package.json: keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const repoRoot = findRepoRoot();
loadDotenv({ path: resolve(repoRoot, '.env') });

export interface Secrets {
  openaiApiKey: string;
  speechmaticsApiKey: string;
  hamsaApiKey: string;
  hamsaSpeakerId: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  webOrigin: string;
  dataDir: string;
  kbDir: string;
  uploadsDir: string;
  sessionsDir: string;
  exportsDir: string;
  speechmaticsRegion: 'global' | 'eu' | 'us';
  /** Persist telemetry to NDJSON. Off by default: it is never needed for a
   *  measurement and keeps the process free of disk work entirely. */
  persistTelemetry: boolean;
  logLevel: string;
}

const root = repoRoot;

function envStr(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/**
 * Mutable credential store. Values may be replaced at runtime by the UI's
 * temporary-key feature, but are never persisted.
 */
class SecretStore {
  private secrets: Secrets = {
    openaiApiKey: envStr('OPENAI_API_KEY'),
    speechmaticsApiKey: envStr('SPEECHMATICS_API_KEY'),
    hamsaApiKey: envStr('HAMSA_API_KEY'),
    hamsaSpeakerId: envStr('HAMSA_SPEAKER_ID'),
  };

  get(): Readonly<Secrets> {
    return this.secrets;
  }

  /** Apply UI-supplied overrides. Empty strings are ignored, not cleared. */
  override(patch: Partial<Secrets>): void {
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'string' && v.trim().length > 0) {
        (this.secrets as any)[k] = v.trim();
      }
    }
  }

  /** Presence map safe to send to the browser. Never the values themselves. */
  presence() {
    return {
      openai: this.secrets.openaiApiKey.length > 0,
      speechmatics: this.secrets.speechmaticsApiKey.length > 0,
      hamsa: this.secrets.hamsaApiKey.length > 0,
      hamsaSpeaker: this.secrets.hamsaSpeakerId.length > 0,
    };
  }

  /** All non-empty secret values, for redaction. */
  values(): string[] {
    return Object.values(this.secrets).filter((v) => v.length >= 8);
  }
}

export const secrets = new SecretStore();

/** Replace any known secret occurring in a string with a placeholder. */
export function redact(input: unknown): unknown {
  if (typeof input === 'string') {
    let out = input;
    for (const v of secrets.values()) {
      if (out.includes(v)) out = out.split(v).join('***REDACTED***');
    }
    // Catch bearer tokens that were never in our store (e.g. echoed by a provider).
    return out.replace(/(Bearer|Token|api[_-]?key["'=: ]+)\s*[A-Za-z0-9._-]{12,}/gi, '$1 ***REDACTED***');
  }
  if (Array.isArray(input)) return input.map(redact);
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = /key|secret|token|authorization|password/i.test(k) ? '***REDACTED***' : redact(v);
    }
    return out;
  }
  return input;
}

export const serverConfig: ServerConfig = {
  host: envStr('HOST', '127.0.0.1'),
  port: envInt('PORT', 8787),
  webOrigin: envStr('WEB_ORIGIN', 'http://localhost:3000'),
  dataDir: resolve(root, envStr('DATA_DIR', 'data')),
  kbDir: resolve(root, envStr('DATA_DIR', 'data'), 'kb-index'),
  uploadsDir: resolve(root, envStr('DATA_DIR', 'data'), 'uploads'),
  sessionsDir: resolve(root, envStr('DATA_DIR', 'data'), 'sessions'),
  exportsDir: resolve(root, envStr('DATA_DIR', 'data'), 'exports'),
  speechmaticsRegion: (envStr('SPEECHMATICS_REGION', 'eu') as 'global' | 'eu' | 'us') ?? 'eu',
  persistTelemetry: envBool('PERSIST_TELEMETRY', false),
  logLevel: envStr('LOG_LEVEL', 'info'),
};

export const RETRIEVER_MODE = envStr('RETRIEVER_MODE', 'bm25') as 'bm25' | 'vector' | 'hybrid';
export const EMBEDDING_MODEL = envStr('EMBEDDING_MODEL', 'text-embedding-3-small');
