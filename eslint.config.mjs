import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { phoenixOrchestratorLogging } from './eslint-rules/phoenix-orchestrator-logging.mjs';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/.next/**',
      '**/.next-dev/**',
      '**/scripts/dev.mjs',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'vitest.config.ts',
            'eslint-rules/*.mjs',
            'packages/*/tsup.config.ts',
            'packages/*/vitest.config.ts',
            'packages/*/drizzle.config.ts',
            'packages/*/scripts/*.ts',
            'apps/*/tsup.config.ts',
            'apps/*/vitest.config.ts',
            'apps/*/eslint.config.mjs',
            'scripts/*.ts',
            'scripts/large-files/*.ts',
            'scripts/context-budget/*.ts',
            'scripts/dev/*.ts',
            'scripts/lib/*.ts',
            'scripts/flows/l2c/seed-l2c-flows.ts',
            'scripts/*.mjs',
            // Copied into a harness run's scratch and run there, so it is plain
            // JavaScript outside every TypeScript project.
            'apps/aflow-executor-host/src/browser/harnessRelay.mjs',
          ],
          // Cap must exceed total allowDefaultProject matches or ESLint fails (see tail-run-events.ts).
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 96,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript handles undefined-variable checking; no-undef doesn't understand TS globals
      'no-undef': 'off',

      // Ban `any` - prefer `unknown` + schema parsing
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // No floating promises
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Require exhaustive switch handling
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Require await in async functions (warn: many async fns without await are intentional)
      '@typescript-eslint/require-await': 'warn',

      // Template expressions: allow number (safe and idiomatic)
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // Empty callbacks/noop handlers are common and harmless
      '@typescript-eslint/no-empty-function': 'off',

      // Downgrade to warn — many legitimate defensive patterns at Redis/API boundaries
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // Disabled — many valid post-.has() or post-narrowing uses; enforce via code review
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Disabled — || vs ?? needs per-case semantic review; noisy for intentional falsy guards
      '@typescript-eslint/prefer-nullish-coalescing': 'off',

      // Downgrade to warn — style preference, not a quality gate
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'warn',

      // Disable — migration markers tracked in plan docs, not lint counts
      '@typescript-eslint/no-deprecated': 'off',

      // Disable — delete obj[key] is valid; Reflect.deleteProperty() is more obscure, identical behavior
      '@typescript-eslint/no-dynamic-delete': 'off',

      // Disable — stylistic trivia
      '@typescript-eslint/class-literal-property-style': 'off',

      // Consistent type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',

      // Allow Array<T> syntax for complex types
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],

      // Ignore intentionally unused params/vars (e.g. _param, _omit)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // Relax rules for config files and scripts (allowDefaultProject — no strictNullChecks context)
  {
    files: [
      '*.config.mjs',
      '**/*.config.mjs',
      '*.config.ts',
      '**/*.config.ts',
      'scripts/**',
      'eslint-rules/**',
      'packages/*/scripts/**',
      'apps/*/scripts/**',
      'apps/aflow-executor-host/src/browser/harnessRelay.mjs',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/require-await': 'off',
      // Plain JS / implicit-any params; + is fine — rule is for typed codebases
      '@typescript-eslint/restrict-plus-operands': 'off',
    },
  },
  // Relax rules for web app (apps/web) — mirrors apps/web/eslint.config.mjs which
  // isn't loaded from the root. The web config is authoritative for web-only runs;
  // this block is what lint-staged (run from repo root via simple-git-hooks) reads.
  // Keep the two in sync — the full `no-unsafe-*` family is downgraded to warn for
  // Phoenix's QueryClient / TanStack Query consumers, whose generic returns
  // ESLint's type-aware parser narrows to `unknown`/`any` even though the TS
  // compiler infers them correctly via project references.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['apps/aflow-orchestrator/**/*.ts'],
    plugins: { 'phoenix-orch': phoenixOrchestratorLogging },
    rules: {
      'no-console': ['error', { allow: ['warn'] }],
      'phoenix-orch/orchestrator-logger-error-context': 'error',
    },
  },
  {
    files: ['packages/executor-runtime/src/executor.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
];
