import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  splitting: true,
  clean: true,
  tsconfig: 'tsconfig.json',
});
