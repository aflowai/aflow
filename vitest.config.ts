import { availableParallelism } from 'node:os';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserWorkspaceConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const testFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const narrowSourceAliases = {
  // tsup/esbuild emits the Node builtin as `stream` in payload-store's dist
  // output. Pin it to the builtin protocol so Vitest never treats it as a
  // project-relative module when an already-built artifact is imported.
  stream: 'node:stream',
  '@aflow/cybernetic-runtime/learning/render': path.join(
    repoRoot,
    'packages/cybernetic-runtime/src/learningRender.ts',
  ),
  '@aflow/cybernetic-runtime/scheduling/output-path': path.join(
    repoRoot,
    'packages/cybernetic-runtime/src/scheduling/outputPath.ts',
  ),
};

const projectsWithGlobals = new Set(['@aflow/ai-client', '@aflow/input-resolution']);
const projectsWithLongTests = new Set([
  '@aflow/aflow-executor-api',
  '@aflow/aflow-executor-mcp',
  '@aflow/aflow-executor-memory',
  '@aflow/aflow-orchestrator',
  '@aflow/cybernetic-runtime',
  '@aflow/platform-artifacts',
]);

// These packages are data/schema contract suites with no process-level resources.
// Reusing each worker's module graph removes most of their import cost. Keep this
// allow-list small: stateful suites remain isolated by default.
const projectsWithoutIsolation = new Set(['@aflow/platform-artifacts', '@aflow/schemas']);

function hasTestFile(directory: string): boolean {
  if (!existsSync(directory)) return false;

  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return hasTestFile(entryPath);
    return entry.isFile() && testFilePattern.test(entry.name);
  });
}

function discoverWorkspaceProjects(): UserWorkspaceConfig[] {
  const names = new Set<string>();
  const requestedProjects = process.env['PHOENIX_TEST_PROJECTS']
    ? new Set(process.env['PHOENIX_TEST_PROJECTS'].split(','))
    : undefined;

  return ['apps', 'packages'].flatMap((workspaceGroup) => {
    const groupDirectory = path.join(repoRoot, workspaceGroup);

    return readdirSync(groupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry): UserWorkspaceConfig[] => {
        const workspaceRoot = path.join(groupDirectory, entry.name);
        if (!hasTestFile(path.join(workspaceRoot, 'src'))) return [];

        const manifest = JSON.parse(
          readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'),
        ) as { name?: string };
        if (!manifest.name)
          throw new Error(`Missing package name in ${workspaceRoot}/package.json`);
        if (requestedProjects && !requestedProjects.has(manifest.name)) return [];
        if (names.has(manifest.name))
          throw new Error(`Duplicate Vitest project name: ${manifest.name}`);
        names.add(manifest.name);

        const alias = {
          ...narrowSourceAliases,
          ...(manifest.name === '@aflow/web' ? { '@': path.join(workspaceRoot, 'src') } : {}),
        };

        return [
          {
            extends: true,
            root: workspaceRoot,
            resolve: {
              alias,
              // Tests must exercise current workspace source, not whatever happens
              // to be present in a package's dist directory from an earlier build.
              conditions: ['ts-source'],
            },
            test: {
              name: manifest.name,
              globals: projectsWithGlobals.has(manifest.name),
              environment: 'node',
              include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
              isolate: !projectsWithoutIsolation.has(manifest.name),
              testTimeout: projectsWithLongTests.has(manifest.name) ? 10_000 : 5_000,
            },
          },
        ];
      });
  });
}

function resolveWorkerBudget(): number {
  const configured = process.env['PHOENIX_TEST_WORKERS'];
  if (configured !== undefined) {
    const workers = Number(configured);
    if (!Number.isInteger(workers) || workers < 1) {
      throw new Error('PHOENIX_TEST_WORKERS must be a positive integer');
    }
    return workers;
  }

  // Avoid Vitest's unbounded "all CPUs minus one" default on large developer
  // machines. Eight workers is enough parallelism without making each imported
  // application graph compete for memory with the local dev stack.
  return Math.max(1, Math.min(availableParallelism() - 1, 8));
}

export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: resolveWorkerBudget(),
    projects: [
      ...discoverWorkspaceProjects(),
      ...(!process.env['PHOENIX_TEST_PROJECTS'] ||
      process.env['PHOENIX_TEST_PROJECTS'].split(',').includes('phoenix-test-infrastructure')
        ? [
            {
              extends: true,
              test: {
                name: 'phoenix-test-infrastructure',
                root: repoRoot,
                environment: 'node',
                include: ['scripts/**/*.test.mjs'],
              },
            },
          ]
        : []),
    ],
    forceRerunTriggers: [
      '**/package.json',
      '**/{vitest,vite}.config.*',
      '**/tsconfig*.json',
      'scripts/test-runner.mjs',
      'yarn.lock',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/.git/**'],
  },
});
