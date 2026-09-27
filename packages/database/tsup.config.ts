import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/connectionBudget.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  splitting: true,
  clean: true,
  tsconfig: 'tsconfig.json',
});
