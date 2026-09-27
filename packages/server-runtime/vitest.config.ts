import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve `@aflow/*` imports to the workspace package's `ts-source`
  // export condition. Matches the dev-mode NODE_OPTIONS='--conditions=ts-source'
  // flag so cross-package source changes (e.g. `@aflow/oauth` helpers, or a
  // Zod schema) are picked up without rebuilding the package first.
  resolve: {
    conditions: ['ts-source'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
