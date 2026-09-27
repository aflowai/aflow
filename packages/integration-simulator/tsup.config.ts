import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false, // Using tsc for declarations
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
