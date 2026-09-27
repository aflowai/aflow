import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve `@aflow/*` imports to the workspace package's `ts-source`
  // export condition (TypeScript source) rather than the prebuilt `dist/`.
  // Matches the dev-mode `NODE_OPTIONS='--conditions=ts-source'` flag so
  // cross-package schema changes are picked up in tests immediately.
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
