import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/artifact/index.ts',
    'src/runtime/index.ts',
    'src/utils/index.ts',
    'src/utils/memoryEmbed.ts',
    'src/catalog/index.ts',
    'src/eval/index.ts',
    'src/guardrails/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: false, // Use tsc for declarations instead
  splitting: false, // splitting: true produces non-deterministic chunk hashes across builds (CI schema-determinism check)
  clean: true,
  tsconfig: 'tsconfig.json',
});
