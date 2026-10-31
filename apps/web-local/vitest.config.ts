import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve `@aflow/*` imports to the workspace package's `ts-source`
  // export condition so tests pick up source changes without a dist
  // rebuild. Matches the dev-mode NODE_OPTIONS='--conditions=ts-source'
  // flag. `@` is the tsconfig path the application imports its own modules by.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['ts-source'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
