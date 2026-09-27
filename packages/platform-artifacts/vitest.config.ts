import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve `@aflow/*` imports to the workspace package's `ts-source`
  // export condition (TypeScript source) rather than the prebuilt `dist/`.
  resolve: {
    conditions: ['ts-source'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    isolate: false,
    testTimeout: 10_000,
  },
});
