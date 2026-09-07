import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => resolve(root, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@vll/telemetry': pkg('telemetry'),
      '@vll/core': pkg('core'),
      '@vll/providers': pkg('providers'),
      '@vll/rag': pkg('rag'),
      '@vll/audio': pkg('audio'),
    },
  },
  test: {
    // apps/web/lib is included so the browser-side audio and capture logic is
    // covered too. Those modules are the ones whose failures are invisible from
    // the server, and "no sound came out" is not something a server test can
    // ever catch.
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts', 'apps/web/lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    environment: 'node',
    reporters: ['default'],
    testTimeout: 20_000,
  },
});
