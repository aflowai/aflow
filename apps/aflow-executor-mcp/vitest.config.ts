import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve `@aflow/*` imports to the workspace package's `ts-source`
  // export condition (TypeScript source) rather than the prebuilt `dist/`.
  // Matches the dev-mode `NODE_OPTIONS='--conditions=ts-source'` flag so
  // cross-package changes (e.g. @aflow/oauth Phase 5) are picked up in
  // tests immediately without a rebuild.
  resolve: {
    conditions: ['ts-source'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
