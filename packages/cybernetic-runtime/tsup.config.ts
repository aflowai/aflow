import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    learningRender: 'src/learningRender.ts',
    'scheduling/outputPath': 'src/scheduling/outputPath.ts',
  },
  format: ['esm', 'cjs'],
  dts: false,
  splitting: true,
  clean: true,
  tsconfig: 'tsconfig.json',
});
