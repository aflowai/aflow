/**
 * Contract: in a checkout at another commit, a workspace package is that
 * commit's package, and this repository's check builds its declarations there.
 *
 * The folder's installation links its own packages back into the repository
 * (`node_modules/@acme/a -> ../../packages/a`); the checkout's link is relative
 * too, so it resolves inside the checkout from wherever the checkout is
 * reached. A dependency the package manager downloaded — landing inside an
 * installation or outside the repository — is still the folder's.
 *
 * A checkout builds nothing, and a workspace type-checks against the compiled
 * declarations of the packages it references, which the folder has from its
 * install and the checkout never does. So `scripts/verify-commit.mjs`, run as
 * the folder's check over a fixture workspace, passes at a commit that reads
 * an internal package without touching it only because it builds that package
 * first — found through the project reference alone, built in the checkout,
 * and never in the folder, whose declarations are an older commit's.
 *
 * The check runs under a stand-in for the sandbox, as the handler suites do: a
 * nested sandbox cannot start under one, and the boundary is held by the
 * sandbox's own tests.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HostCommitCheckOutputSchema } from '@aflow/schemas';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';

const run = promisify(execFile);

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  const { buildBaseEnv, workloadHome } = await import('../baseEnv.js');
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: async (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      const [program, ...args] = input.argv;
      const startedAt = Date.now();
      await mkdir(workloadHome(input.scratchDir), { recursive: true });
      return await new Promise((resolve) => {
        const child = spawn(program ?? '', args, {
          cwd: input.cwd,
          env: { ...buildBaseEnv(input.scratchDir), ...input.env, ...input.trustedEnv },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          input.onDelta(chunk.toString());
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          input.onDelta(chunk.toString());
        });
        child.on('close', (code, signal) => {
          resolve({
            processId: 'hc_test',
            exitCode: code,
            signal,
            timedOut: false,
            durationMs: Date.now() - startedAt,
            stdout,
            stderr,
            truncated: false,
          });
        });
      });
    },
  };
});

const { createHostHandler } = await import('../handlers/hostHandler.js');
const { noPushApprovals } = await import('./fixtures/pushApprovals.js');
const { prepareWorktree, removeWorktree } = await import('../worktree.js');

const VERIFY_COMMIT = fileURLToPath(
  new URL('../../../../scripts/verify-commit.mjs', import.meta.url),
);
const CHECKS = [process.execPath, 'scripts/verify-commit.mjs'];
const COMPILER_OPTIONS = { strict: true, module: 'nodenext', types: [] };

const installed = createRequire(import.meta.url);

/** Where this repository's installation holds a package. */
function installedPackage(name: string): string {
  return dirname(installed.resolve(`${name}/package.json`));
}

/** The file a package's manifest names for one of its commands. */
async function installedBin(name: string, command: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(installedPackage(name), 'package.json'), 'utf8'),
  ) as { bin: string | Record<string, string> };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[command];
  return join(installedPackage(name), bin ?? '');
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

let dir: string;
let repo: string;
let store: string;
let base: string;
let sha: string;
let policyPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-workspace-links-'));
  repo = join(dir, 'repo');
  store = join(dir, 'store');
  await mkdir(repo, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main', repo);
  await git(repo, 'config', 'user.email', 't@e.com');
  await git(repo, 'config', 'user.name', 'T');
  await writeFile(join(repo, '.gitignore'), 'node_modules\ndist\n*.tsbuildinfo\n');
  await writeFile(join(repo, 'eslint.config.mjs'), 'export default [];\n');
  await mkdir(join(repo, 'scripts'), { recursive: true });
  await writeFile(join(repo, 'scripts', 'verify-commit.mjs'), await readFile(VERIFY_COMMIT));
  for (const guard of ['large-files', 'context-budget']) {
    await mkdir(join(repo, 'scripts', guard), { recursive: true });
    await writeFile(join(repo, 'scripts', guard, 'cli.ts'), 'export {};\n');
  }
  await writeJson(join(repo, 'packages', 'a', 'package.json'), {
    name: '@acme/a',
    version: '0.0.0',
    types: 'dist/index.d.ts',
    scripts: { build: 'tsc' },
  });
  await writeJson(join(repo, 'packages', 'a', 'tsconfig.json'), {
    compilerOptions: {
      ...COMPILER_OPTIONS,
      composite: true,
      emitDeclarationOnly: true,
      rootDir: 'src',
      outDir: 'dist',
    },
    include: ['src'],
  });
  await writeJson(join(repo, 'apps', 'app', 'package.json'), {
    name: '@acme/app',
    version: '0.0.0',
  });
  await writeJson(join(repo, 'apps', 'app', 'tsconfig.json'), {
    compilerOptions: { ...COMPILER_OPTIONS, rootDir: 'src' },
    include: ['src'],
    references: [{ path: '../../packages/a' }],
  });
  await mkdir(join(repo, 'packages', 'a', 'src'), { recursive: true });
  await mkdir(join(repo, 'apps', 'app', 'src'), { recursive: true });
  await writeFile(
    join(repo, 'packages', 'a', 'src', 'index.ts'),
    'export const value: number = 1;\n',
  );
  await writeFile(
    join(repo, 'apps', 'app', 'src', 'main.ts'),
    'import { value } from "@acme/a";\n\nexport const doubled: number = value * 2;\n',
  );
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'the package answers a number');
  const installedAt = (await git(repo, 'rev-parse', 'HEAD')).trim();

  await writeFile(
    join(repo, 'packages', 'a', 'src', 'index.ts'),
    'export const value: string = "a";\n',
  );
  await writeFile(
    join(repo, 'apps', 'app', 'src', 'main.ts'),
    'import { value } from "@acme/a";\n\nexport const shouted: string = value.toUpperCase();\n',
  );
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'the package answers a string');
  base = (await git(repo, 'rev-parse', 'HEAD')).trim();

  // The checked commit touches only the code that reads the package, so
  // nothing but the package's project reference says it must be built.
  await writeFile(
    join(repo, 'apps', 'app', 'src', 'main.ts'),
    'import { value } from "@acme/a";\n\nexport const whispered: string = value.toLowerCase();\n',
  );
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'the app whispers');
  sha = (await git(repo, 'rev-parse', 'HEAD')).trim();
  await git(repo, 'checkout', '-q', '--detach', installedAt);

  // The folder as its install leaves it: the package's declarations built at
  // its own commit, which a check at another one must never read.
  await mkdir(join(repo, 'packages', 'a', 'dist'), { recursive: true });
  await writeFile(
    join(repo, 'packages', 'a', 'dist', 'index.d.ts'),
    'export declare const value: number;\n',
  );

  // The installation: the workspace package as the package manager links it,
  // the tools the check calls, a downloaded dependency kept outside the
  // repository, and one landing in the installation's own store.
  await mkdir(join(repo, 'node_modules', '@acme'), { recursive: true });
  await symlink(join('..', '..', 'packages', 'a'), join(repo, 'node_modules', '@acme', 'a'));
  for (const name of ['typescript', 'tsx']) {
    await symlink(installedPackage(name), join(repo, 'node_modules', name));
  }
  await mkdir(join(repo, 'node_modules', '.bin'), { recursive: true });
  for (const [name, command] of [
    ['typescript', 'tsc'],
    ['eslint', 'eslint'],
    ['prettier', 'prettier'],
  ] as const) {
    await symlink(await installedBin(name, command), join(repo, 'node_modules', '.bin', command));
  }
  await mkdir(join(store, 'left-pad'), { recursive: true });
  await writeFile(join(store, 'left-pad', 'index.js'), 'stored dep\n');
  await symlink(join(store, 'left-pad'), join(repo, 'node_modules', 'left-pad'));
  await mkdir(join(repo, 'node_modules', '.store', 'right-pad'), { recursive: true });
  await symlink(join('.store', 'right-pad'), join(repo, 'node_modules', 'right-pad'));

  policyPath = join(dir, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb_app',
          root: repo,
          mode: 'readwrite',
          allowsExecution: true,
          spaceId: 'space-a',
          branchPolicy: { branchPrefix: 'aflow/', checks: CHECKS },
        },
      ],
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a workspace package in the isolated checkout', () => {
  it('is mirrored as the relative link the folder holds, resolving inside the checkout', async () => {
    const wt = await prepareWorktree(repo, join(dir, 'scratch-mirror'), 'work', { at: sha });
    try {
      const link = join(wt.path, 'node_modules', '@acme', 'a');
      expect(await readlink(link)).toBe(join('..', '..', 'packages', 'a'));
      expect(await realpath(link)).toBe(join(await realpath(wt.path), 'packages', 'a'));
    } finally {
      await removeWorktree(repo, wt.path);
    }
  });

  it('leaves a downloaded dependency resolving to the folder’s installation', async () => {
    const wt = await prepareWorktree(repo, join(dir, 'scratch-deps'), 'work', { at: sha });
    try {
      expect(await realpath(join(wt.path, 'node_modules', 'left-pad'))).toBe(
        join(await realpath(store), 'left-pad'),
      );
      expect(await realpath(join(wt.path, 'node_modules', 'right-pad'))).toBe(
        join(await realpath(repo), 'node_modules', '.store', 'right-pad'),
      );
    } finally {
      await removeWorktree(repo, wt.path);
    }
  });
});

describe('this repository’s check, at a commit reading a workspace package it leaves alone', () => {
  it('builds the package’s declarations in the checkout, then passes', async () => {
    let output: unknown;
    const result = await createHostHandler(policyPath, noPushApprovals).execute({
      operationId: 'host.commit.check',
      spaceId: 'space-a',
      runId: 'run-a',
      stepExecutionId: 'step-1',
      tenantId: 'tenant-a',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve({ bindingId: 'hb_app', sha, base }),
      emitLiveDelta: () => Promise.resolve(),
      writePayload: (kind: string, data: unknown) => {
        if (kind === 'output' || kind === 'error') output = data;
        return Promise.resolve(`inline:${kind}`);
      },
    } as never);

    expect(result.status).toBe('SUCCEEDED');
    const answer = HostCommitCheckOutputSchema.parse(output);
    expect(answer).toMatchObject({ passed: true, exitCode: 0, clearedSha: sha });
    expect(answer.tail).toContain('ok   build @acme/a');
    expect(answer.tail).toContain('ok   tsc apps/app/tsconfig.json');
    expect(await readFile(join(repo, 'packages', 'a', 'dist', 'index.d.ts'), 'utf8')).toBe(
      'export declare const value: number;\n',
    );
    expect(existsSync(join(repo, 'packages', 'a', 'tsconfig.tsbuildinfo'))).toBe(false);
  }, 60_000);
});
