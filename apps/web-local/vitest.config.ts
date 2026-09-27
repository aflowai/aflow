import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve `@aflow/*` imports to the workspace package's `ts-source`
  // export condition so tests pick up source changes without a dist
  // rebuild. Matches the dev-mode NODE_OPTIONS='--conditions=ts-source'
  // flag.
  resolve: {
    conditions: ['ts-source'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
