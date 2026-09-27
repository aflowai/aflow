import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve `@aflow/*` imports to the workspace package's `ts-source`
  // export condition. Matches the dev-mode NODE_OPTIONS='--conditions=ts-source'
  // flag so changes in @aflow/schemas StreamKeys are picked up without
  // rebuilding the schemas dist.
  resolve: {
    conditions: ['ts-source'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
