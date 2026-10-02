/**
 * Contract: in a checkout at another commit, a workspace package is that
 * commit's package.
 *
 * The folder's installation links its own packages back into the repository
 * (`node_modules/@acme/a -> ../../packages/a`). Mirrored as that same relative
 * link, it resolves inside the checkout; mirrored to where it lands in the
 * folder, a check builds and type-checks against the folder's packages rather
 * than the commit it was asked about. A dependency the package manager
 * downloaded — landing inside an installation or outside the repository — is
 * still the folder's.
 *
 * The check runs under a stand-in for the sandbox, as the handler suites do: a
 * nested sandbox cannot start under one, and the boundary is held by the
 * sandbox's own tests.
 */
import { execFile, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HostCommitCheckOutputSchema } from '@aflow/schemas';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';

const run = promisify(execFile);

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: async (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      const [program, ...args] = input.argv;
      const startedAt = Date.now();
      return await new Promise((resolve) => {
        const child = spawn(program ?? '', args, {
          cwd: input.cwd,
          env: { PATH: process.env['PATH'] ?? '', ...input.env, ...input.trustedEnv },
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

const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const TYPECHECK = [process.execPath, TSC, '-p', 'tsconfig.json'];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout;
}

async function typecheck(cwd: string): Promise<{ exitCode: number; output: string }> {
  const [program, ...args] = TYPECHECK;
  try {
    const { stdout } = await run(program ?? '', args, { cwd });
    return { exitCode: 0, output: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { exitCode: failed.code ?? 1, output: failed.stdout ?? '' };
  }
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
  await mkdir(join(repo, 'packages', 'a'), { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main', repo);
  await git(repo, 'config', 'user.email', 't@e.com');
  await git(repo, 'config', 'user.name', 'T');
  await writeFile(join(repo, '.gitignore'), 'node_modules\n');
  await writeFile(
    join(repo, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: 'nodenext', types: [] },
      files: ['app.ts'],
    }),
  );
  await writeFile(
    join(repo, 'packages', 'a', 'package.json'),
    JSON.stringify({ name: '@acme/a', version: '0.0.0', types: 'index.d.ts' }),
  );
  await writeFile(
    join(repo, 'packages', 'a', 'index.d.ts'),
    'export declare const value: number;\n',
  );
  await writeFile(
    join(repo, 'app.ts'),
    "import { value } from '@acme/a';\nexport const doubled: number = value * 2;\n",
  );
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  base = (await git(repo, 'rev-parse', 'HEAD')).trim();

  // The checked commit changes the package's types and the code that reads them together.
  await writeFile(
    join(repo, 'packages', 'a', 'index.d.ts'),
    'export declare const value: string;\n',
  );
  await writeFile(
    join(repo, 'app.ts'),
    "import { value } from '@acme/a';\nexport const shouted: string = value.toUpperCase();\n",
  );
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'the package answers a string');
  sha = (await git(repo, 'rev-parse', 'HEAD')).trim();
  await git(repo, 'checkout', '-q', '--detach', base);

  // The installation: the workspace package as the package manager links it,
  // a downloaded dependency kept outside the repository, and one landing in
  // the installation's own store.
  await mkdir(join(repo, 'node_modules', '@acme'), { recursive: true });
  await symlink(join('..', '..', 'packages', 'a'), join(repo, 'node_modules', '@acme', 'a'));
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
          branchPolicy: { branchPrefix: 'aflow/', checks: TYPECHECK },
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

  it('fails the commit’s typecheck when it is the folder’s copy instead', async () => {
    const wt = await prepareWorktree(repo, join(dir, 'scratch-control'), 'work', { at: sha });
    try {
      const link = join(wt.path, 'node_modules', '@acme', 'a');
      await unlink(link);
      await symlink(join(repo, 'packages', 'a'), link);
      const result = await typecheck(wt.path);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('toUpperCase');
    } finally {
      await removeWorktree(repo, wt.path);
    }
  });
});

describe('host.commit.check at a commit that changes a workspace package’s types', () => {
  it('passes the typecheck against the commit’s package', async () => {
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
    expect(answer.tail).toBe('');
    expect(answer).toMatchObject({ passed: true, exitCode: 0, clearedSha: sha });
  }, 60_000);
});
