import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/tracing.ts',
    'src/metrics.ts',
    'src/logging.ts',
    'src/crashReporting.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
});
