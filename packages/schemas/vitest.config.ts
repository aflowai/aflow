import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['ts-source'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    isolate: false,
  },
});
