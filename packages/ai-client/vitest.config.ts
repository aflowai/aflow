import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['ts-source'],
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
