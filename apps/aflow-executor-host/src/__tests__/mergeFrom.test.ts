/**
 * Contract: a fix to a branch its base has moved past is commissioned with the
 * base merged into its checkout and published as one merge commit holding the
 * fix — the publication making the commission's merge again, to the byte, and
 * folding the patch into it. Exercised against real git; only the sandbox's
 * spawn is stood in for, and the coding agent's command still runs.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';

const run = promisify(execFile);
const handed: SandboxedRunInput[] = [];

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: async (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      handed.push(input);
      const [program, ...args] = input.argv;
      const { stdout, stderr } = await run(program ?? '', args, {
        cwd: input.cwd,
        env: { PATH: process.env['PATH'] ?? '', ...input.env, ...input.trustedEnv },
      });
      return {
        processId: 'hr_test',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout,
        stderr,
        truncated: false,
      };
    },
  };
});

const { createHostHarnessHandler, mergeConflictSentence } =
  await import('../handlers/harnessHandlers.js');
const { createHostPatchHandler } = await import('../handlers/patchHandlers.js');
const { mergeIntoCheckout } = await import('../baseMerge.js');
const { allSessions, discardScratch, forgetSession } = await import('../harnessSessions.js');
const { commitIdentityArgs, prepareWorktree, removeWorktree, WorktreeError } =
  await import('../worktree.js');

let base: string;
let seed: string;
let origin: string;
let project: string;
let lagging: string;
let policyPath: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout;
}

async function head(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, 'rev-parse', ref)).trim();
}

async function identify(repo: string): Promise<void> {
  await git(repo, 'config', 'user.email', 't@e.com');
  await git(repo, 'config', 'user.name', 'T');
}

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', message);
}

interface World {
  /** `aflow/fix` as the folder holds it. */
  readonly branchHead: string;
  /** `main` on `origin`, moved past the branch. */
  readonly mainHead: string;
}

type Conflicting = boolean | 'binary' | 'modify-delete' | 'delete-modify' | 'add-add';

/** The worlds whose two sides leave `a.txt` alone, writing `b.txt` and `c.txt` beside it. */
const besideA = (conflicting: Conflicting): boolean =>
  conflicting === false ||
  conflicting === 'modify-delete' ||
  conflicting === 'delete-modify' ||
  conflicting === 'add-add';

/**
 * `origin` holds `main` and `aflow/fix`; the folder and a second clone of it
 * hold both as they were, and `main` then moves on `origin` alone — beside the
 * branch's change, or over the same line of it — and, for `'binary'`, over
 * the same bytes of a binary file as well. For `'modify-delete'`, `main`
 * deletes `gone.txt`, which the branch changed; for `'delete-modify'`, the
 * branch deletes it and `main` changes it; for `'add-add'`, both add
 * `new.txt` differently. Nothing else conflicts in those three.
 */
async function world(conflicting: Conflicting): Promise<World> {
  await run('git', ['init', '-q', '-b', 'main', seed]);
  await identify(seed);
  await writeFile(join(seed, 'a.txt'), 'one\ntwo\nthree\n');
  if (conflicting === 'binary') await writeFile(join(seed, 'logo.bin'), 'logo\0initial');
  if (conflicting === 'modify-delete' || conflicting === 'delete-modify') {
    await writeFile(join(seed, 'gone.txt'), 'gone\n');
  }
  await commitAll(seed, 'initial');
  await git(seed, 'checkout', '-q', '-b', 'aflow/fix');
  if (conflicting === 'binary') await writeFile(join(seed, 'logo.bin'), 'logo\0BRANCH');
  if (conflicting === 'modify-delete') await writeFile(join(seed, 'gone.txt'), 'gone, changed\n');
  if (conflicting === 'delete-modify') await rm(join(seed, 'gone.txt'));
  if (conflicting === 'add-add') await writeFile(join(seed, 'new.txt'), 'new on the branch\n');
  if (besideA(conflicting)) await writeFile(join(seed, 'b.txt'), 'branch\n');
  else await writeFile(join(seed, 'a.txt'), 'one\nBRANCH\nthree\n');
  await commitAll(seed, 'the branch');
  await git(seed, 'checkout', '-q', 'main');
  await run('git', ['clone', '-q', '--bare', seed, origin]);
  for (const clone of [project, lagging]) {
    await run('git', ['clone', '-q', origin, clone]);
    await identify(clone);
    await git(clone, 'branch', '-q', 'aflow/fix', 'origin/aflow/fix');
  }
  if (conflicting === 'binary') await writeFile(join(seed, 'logo.bin'), 'logo\0MAIN');
  if (conflicting === 'modify-delete') await rm(join(seed, 'gone.txt'));
  if (conflicting === 'delete-modify') await writeFile(join(seed, 'gone.txt'), 'gone, on main\n');
  if (conflicting === 'add-add') await writeFile(join(seed, 'new.txt'), 'new on main\n');
  if (besideA(conflicting)) await writeFile(join(seed, 'c.txt'), 'main\n');
  else await writeFile(join(seed, 'a.txt'), 'one\nMAIN\nthree\n');
  await commitAll(seed, 'main moved');
  await git(seed, 'push', '-q', origin, 'main');
  return { branchHead: await head(project, 'aflow/fix'), mainHead: await head(seed, 'main') };
}

beforeEach(async () => {
  handed.length = 0;
  base = await mkdtemp(join(tmpdir(), 'aflow-merge-from-'));
  seed = join(base, 'seed');
  origin = join(base, 'origin.git');
  project = join(base, 'project');
  lagging = join(base, 'lagging');
  policyPath = join(base, 'host-policy.json');
  const binding = (id: string, root: string) => ({
    id,
    root,
    mode: 'readwrite',
    allowsExecution: true,
    singleFile: false,
    spaceId: 'space-test',
  });
  const harness = (id: string, script: string) => ({
    id,
    executable: '/bin/sh',
    args: ['-c', script],
  });
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [binding('hb', project), binding('hb_lagging', lagging)],
      harnesses: [
        harness('works', "printf 'fixed\\n' > fix.txt"),
        harness('idle', 'true'),
        {
          ...harness('converses', "printf 'fixed\\n' > fix.txt"),
          sessionArgs: ['{session}'],
          resumeArgs: ['{session}'],
        },
        // Resolves only what it finds marked, so a merge that left no markers
        // leaves `a.txt` as the merge made it.
        harness(
          'resolves',
          "if grep -q '^<<<<<<< ' a.txt && grep -q '^>>>>>>> ' a.txt; then " +
            "printf 'one\\nRESOLVED\\nthree\\n' > a.txt; fi; printf 'fixed\\n' > fix.txt",
        ),
        harness(
          'resolves-added',
          "if grep -q '^<<<<<<< ' new.txt && grep -q '^>>>>>>> ' new.txt; then " +
            "printf 'new on both\\n' > new.txt; fi; printf 'fixed\\n' > fix.txt",
        ),
        harness('restores', "printf 'gone, restored\\n' > gone.txt; printf 'fixed\\n' > fix.txt"),
        // A document that holds conflict-marker lines of its own.
        harness(
          'documents',
          "printf 'A conflict reads:\\n<<<<<<< ours\\nmine\\n=======\\ntheirs\\n>>>>>>> theirs\\n' " +
            "> markers.md; printf 'fixed\\n' > fix.txt",
        ),
      ],
    }),
  );
});

afterEach(async () => {
  for (const session of allSessions()) {
    forgetSession(session.id);
    await removeWorktree(session.bindingRoot, session.worktreePath).catch(() => {});
    await discardScratch(session);
  }
  await rm(base, { recursive: true, force: true });
});

interface Outcome {
  readonly status: string;
  readonly message: string;
  readonly output: Record<string, unknown>;
}

async function commission(input: Record<string, unknown>): Promise<Outcome> {
  const written: Record<string, unknown> = {};
  const result = await createHostHarnessHandler(policyPath).execute({
    operationId: 'host.harness.run',
    spaceId: 'space-test',
    runId: 'run-merge-from',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () =>
      Promise.resolve({ bindingId: 'hb', task: 'Fix it.', timeoutMs: 60_000, ...input }),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (kind: string, data: unknown) => {
      written[kind] = data;
      return Promise.resolve(`inline:${kind}`);
    },
  } as never);
  return {
    status: result.status,
    message: result.error?.message ?? '',
    output: (written['output'] ?? {}) as Record<string, unknown>,
  };
}

async function publish(input: Record<string, unknown>): Promise<Outcome> {
  let output: Record<string, unknown> = {};
  const result = await createHostPatchHandler(policyPath).execute({
    operationId: 'host.file.patch',
    spaceId: 'space-test',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve({ bindingId: 'hb', ...input }),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (_kind: string, data: unknown) => {
      output = data as Record<string, unknown>;
      return Promise.resolve('inline:out');
    },
  } as never);
  return { status: result.status, message: result.error?.message ?? '', output };
}

const changedFiles = (patch: unknown): string[] =>
  [...String(patch).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1] ?? '');

describe('a commission merges the branch its base moved past', () => {
  it('merges nothing where the checkout already holds the base, and reports no merge', async () => {
    const { branchHead } = await world(false);
    // The branch merged with `main` as `origin` holds it now.
    await git(project, 'fetch', '-q', 'origin');
    await git(project, 'checkout', '-q', 'aflow/fix');
    await git(project, 'merge', '-q', '--no-edit', 'origin/main');
    await git(project, 'checkout', '-q', 'main');
    const merged = await head(project, 'aflow/fix');
    expect(merged).not.toBe(branchHead);

    const { status, output } = await commission({
      harness: 'works',
      base: 'aflow/fix',
      mergeFrom: 'origin/main',
    });
    expect(status).toBe('SUCCEEDED');
    expect(output['merge']).toBeUndefined();
    expect(output['baseSha']).toBe(merged);
    expect(changedFiles(output['patch'])).toEqual(['fix.txt']);
    expect(output['applies']).toBe('clean');
  }, 60_000);

  it('merges a clean base as one merge commit the diff leaves out, and the publication lands it', async () => {
    const { branchHead, mainHead } = await world(false);
    const { status, output } = await commission({
      harness: 'works',
      base: 'aflow/fix',
      mergeFrom: 'origin/main',
    });
    expect(status).toBe('SUCCEEDED');
    expect(output['merge']).toEqual({ from: mainHead, conflicts: [] });
    expect(output['baseSha']).toBe(branchHead);
    // The agent's work alone: neither `main`'s `c.txt` nor the merge is in it.
    expect(changedFiles(output['patch'])).toEqual(['fix.txt']);
    expect(output['applies']).toBe('clean');

    // Published from a folder that never fetched `main`'s new commit: the
    // publication fetches it from `origin` by its sha.
    await expect(git(lagging, 'cat-file', '-e', `${mainHead}^{commit}`)).rejects.toThrow();
    const published = await publish({
      bindingId: 'hb_lagging',
      patch: output['patch'],
      commit: {
        branch: 'aflow/fix',
        message: 'the fix',
        baseSha: branchHead,
        mergeFrom: mainHead,
      },
    });
    expect(published.status).toBe('SUCCEEDED');
    const commit = published.output['commit'] as Record<string, unknown>;
    expect(commit['merged']).toBe(mainHead);
    expect(commit['appended']).toBe(true);
    expect(commit['baseSha']).toBe(branchHead);
    const sha = String(commit['sha']);
    expect(await head(lagging, 'aflow/fix')).toBe(sha);
    expect((await git(lagging, 'rev-list', '--parents', '-n', '1', sha)).trim()).toBe(
      `${sha} ${branchHead} ${mainHead}`,
    );
    expect((await git(lagging, 'rev-list', '--first-parent', `${branchHead}..${sha}`)).trim()).toBe(
      sha,
    );
    expect((await git(lagging, 'log', '-1', '--format=%B', sha)).trim()).toBe('the fix');
    expect((await git(lagging, 'ls-tree', '--name-only', sha)).split('\n').filter(Boolean)).toEqual(
      ['a.txt', 'b.txt', 'c.txt', 'fix.txt'],
    );
  }, 60_000);

  it('commits a conflicting merge with its markers, and the resolution publishes as one merge commit', async () => {
    const { branchHead, mainHead } = await world(true);
    const { status, output } = await commission({
      harness: 'resolves',
      base: 'aflow/fix',
      mergeFrom: 'origin/main',
    });
    expect(status).toBe('SUCCEEDED');
    expect(output['merge']).toEqual({
      from: mainHead,
      conflicts: [{ path: 'a.txt', kind: 'content' }],
    });
    expect(output['baseSha']).toBe(branchHead);
    // The task names the files, and the agent found them marked.
    expect(handed[0]?.argv.join('\n')).toContain(
      mergeConflictSentence({ from: mainHead, conflicts: [{ path: 'a.txt', kind: 'content' }] }),
    );
    const patch = String(output['patch']);
    expect(changedFiles(patch).sort()).toEqual(['a.txt', 'fix.txt']);
    expect(patch).toMatch(/^-<<<<<<< HEAD$/m);
    expect(patch).toMatch(/^\+RESOLVED$/m);
    expect(output['applies']).toBe('clean');

    const published = await publish({
      patch,
      commit: {
        branch: 'aflow/fix',
        message: 'the fix\n\nWith main merged in.',
        baseSha: branchHead,
        mergeFrom: mainHead,
      },
    });
    expect(published.status).toBe('SUCCEEDED');
    expect(published.output['state']).toBe('applied');
    const commit = published.output['commit'] as Record<string, unknown>;
    const sha = String(commit['sha']);
    expect(commit['merged']).toBe(mainHead);
    expect(commit['message']).toBe('the fix\n\nWith main merged in.');
    expect((await git(project, 'rev-list', '--parents', '-n', '1', sha)).trim()).toBe(
      `${sha} ${branchHead} ${mainHead}`,
    );
    expect(await git(project, 'show', `${sha}:a.txt`)).toBe('one\nRESOLVED\nthree\n');
    expect(await git(project, 'show', `${sha}:fix.txt`)).toBe('fixed\n');
    expect((await git(project, 'status', '--porcelain')).trim()).toBe('');
    expect((await git(project, 'worktree', 'list')).split('\n').filter(Boolean)).toHaveLength(1);
  }, 60_000);

  it('refuses a remote the folder does not have and a branch the fetch cannot find, naming each', async () => {
    await world(false);
    for (const mergeFrom of ['upstream/main', 'origin/no-such-branch']) {
      const { status, message } = await commission({
        harness: 'works',
        base: 'aflow/fix',
        mergeFrom,
      });
      expect(status, mergeFrom).toBe('FAILED');
      expect(message, mergeFrom).toContain(`\`${mergeFrom}\``);
    }
    expect(handed).toHaveLength(0);
    expect((await git(project, 'worktree', 'list')).split('\n').filter(Boolean)).toHaveLength(1);
  }, 60_000);
});

describe('a commission refuses a merge no turn could finish', () => {
  it('refuses a merge that conflicts in a binary file before any turn runs, naming the file', async () => {
    const { branchHead } = await world('binary');
    const { status, message, output } = await commission({
      harness: 'resolves',
      base: 'aflow/fix',
      mergeFrom: 'origin/main',
    });
    expect(status).toBe('FAILED');
    expect(message).toContain('conflicts in `logo.bin`, which git merges as binary');
    expect(message).not.toContain('`a.txt`');
    expect(message).toContain('That merge has to be made by hand');
    expect(output['merge']).toBeUndefined();
    expect(handed).toHaveLength(0);
    expect(await head(project, 'aflow/fix')).toBe(branchHead);
    expect((await git(project, 'worktree', 'list')).split('\n').filter(Boolean)).toHaveLength(1);
  }, 60_000);

  it('leaves the checkout where it stood when it refuses a binary conflict', async () => {
    const { branchHead, mainHead } = await world('binary');
    await git(project, 'fetch', '-q', 'origin');
    const scratch = await mkdtemp(join(tmpdir(), 'aflow-merge-binary-'));
    const checkout = await prepareWorktree(project, scratch, 'merge', {
      dependencies: 'none',
      at: branchHead,
    });
    try {
      const refused = await mergeIntoCheckout(
        checkout.path,
        mainHead,
        await commitIdentityArgs(checkout.path),
      ).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(WorktreeError);
      expect((refused as InstanceType<typeof WorktreeError>).kind).toBe('binary_conflict');
      expect(await head(checkout.path, 'HEAD')).toBe(branchHead);
      expect((await git(checkout.path, 'status', '--porcelain')).trim()).toBe('');
    } finally {
      await removeWorktree(project, checkout.path);
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a `mergeFrom` where no commit identity resolves, naming what to set', async () => {
    await world(false);
    await git(project, 'config', '--unset', 'user.name');
    await git(project, 'config', '--unset', 'user.email');
    const globalConfig = join(base, 'operator.gitconfig');
    await writeFile(globalConfig, '');
    const previous = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
    try {
      const { status, message } = await commission({
        harness: 'works',
        base: 'aflow/fix',
        mergeFrom: 'origin/main',
      });
      expect(status).toBe('FAILED');
      expect(message).toContain(
        "A commission with `mergeFrom` commits its merge under the operator's commit identity",
      );
      expect(message).toContain('Set `user.name` and `user.email` in the repository, or globally');
      expect(handed).toHaveLength(0);
      expect((await git(project, 'worktree', 'list')).split('\n').filter(Boolean)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = previous;
    }
  }, 60_000);
});

describe('a continued turn and the merge its session holds', () => {
  it('refuses a `mergeFrom` without `base` before any checkout, naming both', async () => {
    await world(false);
    const first = await commission({ harness: 'converses', base: 'aflow/fix' });
    expect(first.status).toBe('SUCCEEDED');
    const sessionRef = String(first.output['sessionRef']);
    const checkouts = await git(project, 'worktree', 'list');

    for (const continued of [{}, { continueFrom: sessionRef }]) {
      const { status, message } = await commission({
        harness: 'converses',
        ...continued,
        mergeFrom: 'origin/main',
      });
      expect(status).toBe('FAILED');
      expect(message).toContain('`mergeFrom` (`origin/main`) is given without `base`');
      expect(message).toContain('A merge needs the branch it is merged into');
    }
    expect(handed).toHaveLength(1);
    expect(await git(project, 'worktree', 'list')).toBe(checkouts);
  }, 60_000);

  it('reports the merge again on a turn that keeps the checkout', async () => {
    const { branchHead, mainHead } = await world(true);
    const first = await commission({
      harness: 'converses',
      base: 'aflow/fix',
      mergeFrom: 'origin/main',
    });
    expect(first.output['merge']).toEqual({
      from: mainHead,
      conflicts: [{ path: 'a.txt', kind: 'content' }],
    });
    const sessionRef = String(first.output['sessionRef']);

    const { status, output } = await commission({ harness: 'converses', continueFrom: sessionRef });
    expect(status).toBe('SUCCEEDED');
    expect(output['continued']).toBe(true);
    expect(output['merge']).toEqual({
      from: mainHead,
      conflicts: [{ path: 'a.txt', kind: 'content' }],
    });
    expect(output['baseSha']).toBe(branchHead);
    expect(changedFiles(output['patch'])).toEqual(['fix.txt']);
  }, 60_000);

  it('drops the earlier merge from a turn whose `base` moves it to a fresh checkout', async () => {
    const { branchHead, mainHead } = await world(false);
    const first = await commission({
      harness: 'converses',
      base: 'aflow/fix',
      mergeFrom: 'origin/main',
    });
    expect(first.output['merge']).toEqual({ from: mainHead, conflicts: [] });
    const sessionRef = String(first.output['sessionRef']);

    const { status, output } = await commission({
      harness: 'converses',
      continueFrom: sessionRef,
      base: 'aflow/fix',
    });
    expect(status).toBe('SUCCEEDED');
    expect(output['continued']).toBe(true);
    expect(output['merge']).toBeUndefined();
    expect(output['baseSha']).toBe(branchHead);
    expect(changedFiles(output['patch'])).toEqual(['fix.txt']);
  }, 60_000);
});

/** The tree the commission's own merge of `from` into `at` makes, made the same way in a scratch checkout. */
async function mergedTree(at: string, from: string): Promise<string> {
  await git(project, 'fetch', '-q', 'origin');
  const scratch = await mkdtemp(join(tmpdir(), 'aflow-merge-tree-'));
  const checkout = await prepareWorktree(project, scratch, 'merge', { dependencies: 'none', at });
  try {
    await mergeIntoCheckout(checkout.path, from, await commitIdentityArgs(checkout.path));
    return await head(checkout.path, 'HEAD^{tree}');
  } finally {
    await removeWorktree(project, checkout.path);
    await rm(scratch, { recursive: true, force: true });
  }
}

describe('a publication whose whole change is the merge', () => {
  it.each([
    { world: false as const, files: ['a.txt', 'b.txt', 'c.txt'], conflicts: [] },
    {
      world: 'modify-delete' as const,
      files: ['a.txt', 'b.txt', 'c.txt'],
      conflicts: [{ path: 'gone.txt', kind: 'modify-delete' }],
    },
  ])(
    'lands one merge commit whose tree is the merge’s ($world)',
    async ({ world: conflicting, files, conflicts }) => {
      const { branchHead, mainHead } = await world(conflicting);
      const { status, output } = await commission({
        harness: 'idle',
        base: 'aflow/fix',
        mergeFrom: 'origin/main',
      });
      expect(status).toBe('SUCCEEDED');
      expect(output['merge']).toEqual({ from: mainHead, conflicts });
      expect(output['patchRef']).toBeUndefined();
      expect(output['patch']).toBeUndefined();

      const published = await publish({
        commit: {
          branch: 'aflow/fix',
          message: 'Catch up with main\n\nMerges origin/main into the branch.',
          baseSha: branchHead,
          mergeFrom: mainHead,
        },
      });
      expect(published.status, published.message).toBe('SUCCEEDED');
      expect(published.output).toMatchObject({ state: 'applied', filesChanged: 0, files: [] });
      const commit = published.output['commit'] as Record<string, unknown>;
      expect(commit['merged']).toBe(mainHead);
      expect(commit['body']).toBe('Merges origin/main into the branch.');
      const sha = String(commit['sha']);
      expect(await head(project, 'aflow/fix')).toBe(sha);
      expect((await git(project, 'rev-list', '--parents', '-n', '1', sha)).trim()).toBe(
        `${sha} ${branchHead} ${mainHead}`,
      );
      expect((await git(project, 'rev-list', '--first-parent', `${branchHead}..${sha}`)).trim()).toBe(
        sha,
      );
      expect(await head(project, `${sha}^{tree}`)).toBe(await mergedTree(branchHead, mainHead));
      expect((await git(project, 'ls-tree', '--name-only', sha)).split('\n').filter(Boolean)).toEqual(
        files,
      );
    },
    60_000,
  );

  it('still refuses the markers a merge alone would publish', async () => {
    const { branchHead, mainHead } = await world(true);
    const { output } = await commission({ harness: 'idle', base: 'aflow/fix', mergeFrom: 'origin/main' });
    expect(output['patchRef']).toBeUndefined();

    const { status, message } = await publish({
      commit: { branch: 'aflow/fix', message: 'm', baseSha: branchHead, mergeFrom: mainHead },
    });
    expect(status).toBe('FAILED');
    expect(message).toContain('conflict markers in `a.txt` (content conflict)');
    expect(await head(project, 'aflow/fix')).toBe(branchHead);
  }, 60_000);

  it('is the only publication that goes without a diff', async () => {
    const { branchHead } = await world(false);
    const { status, message } = await publish({
      commit: { branch: 'aflow/fix', message: 'm', baseSha: branchHead },
    });
    expect(status).toBe('FAILED');
    expect(message).toContain('Name the diff to apply');
    expect(await head(project, 'aflow/fix')).toBe(branchHead);
  }, 60_000);
});

describe('a publication makes the merge again', () => {
  it('refuses a tree the patch left conflict markers in, naming the file, with nothing committed', async () => {
    const { branchHead, mainHead } = await world(true);
    // An agent that never touched the conflict: `a.txt` still holds the markers.
    const { output } = await commission({
      harness: 'works',
      base: 'aflow/fix',
      mergeFrom: 'origin/main',
    });
    expect(output['merge']).toEqual({
      from: mainHead,
      conflicts: [{ path: 'a.txt', kind: 'content' }],
    });
    expect(changedFiles(output['patch'])).toEqual(['fix.txt']);

    const { status, message } = await publish({
      patch: output['patch'],
      commit: { branch: 'aflow/fix', message: 'the fix', baseSha: branchHead, mergeFrom: mainHead },
    });
    expect(status).toBe('FAILED');
    expect(message).toContain('conflict markers in `a.txt` (content conflict)');
    expect(await head(project, 'aflow/fix')).toBe(branchHead);
  }, 60_000);

  describe.each([
    {
      kind: 'modify-delete' as const,
      sides: (from: string) => `this branch changed it and \`${from}\` deleted it`,
      kept: 'HEAD^1:gone.txt',
    },
    {
      kind: 'delete-modify' as const,
      sides: (from: string) => `this branch deleted it and \`${from}\` changed it`,
      kept: 'HEAD^2:gone.txt',
    },
  ])('a $kind conflict', ({ kind, sides, kept }) => {
    const conflicts = [{ path: 'gone.txt', kind }];

    it('is recorded with its kind, committed deleted, and named in the task', async () => {
      const { branchHead, mainHead } = await world(kind);
      const { status, output } = await commission({
        harness: 'works',
        base: 'aflow/fix',
        mergeFrom: 'origin/main',
      });
      expect(status).toBe('SUCCEEDED');
      expect(output['merge']).toEqual({ from: mainHead, conflicts });
      expect(output['baseSha']).toBe(branchHead);
      const sentence = mergeConflictSentence({ from: mainHead, conflicts });
      expect(handed[0]?.argv.join('\n')).toContain(sentence);
      expect(sentence).toContain(
        `\`gone.txt\` (${kind}): ${sides(mainHead)}. It is deleted in the merge; restore it ` +
          `with the changes it needs, or leave it deleted. The version`,
      );
      expect(sentence).toContain(`\`${kept}\``);
      // Deleted in the merge, so an agent that leaves it alone changes nothing there.
      expect(changedFiles(output['patch'])).toEqual(['fix.txt']);
      expect(String(output['patch'])).not.toContain('gone.txt');
    }, 60_000);

    it('publishes the deletion when the patch leaves it untouched', async () => {
      const { branchHead, mainHead } = await world(kind);
      const { output } = await commission({
        harness: 'works',
        base: 'aflow/fix',
        mergeFrom: 'origin/main',
      });

      const published = await publish({
        patch: output['patch'],
        commit: {
          branch: 'aflow/fix',
          message: 'the fix',
          baseSha: branchHead,
          mergeFrom: mainHead,
        },
      });
      expect(published.status).toBe('SUCCEEDED');
      const sha = String((published.output['commit'] as Record<string, unknown>)['sha']);
      expect(
        (await git(project, 'ls-tree', '--name-only', sha)).split('\n').filter(Boolean),
      ).toEqual(['a.txt', 'b.txt', 'c.txt', 'fix.txt']);
    }, 60_000);

    it('publishes the file kept when the patch restores it', async () => {
      const { branchHead, mainHead } = await world(kind);
      const { output } = await commission({
        harness: 'restores',
        base: 'aflow/fix',
        mergeFrom: 'origin/main',
      });
      expect(changedFiles(output['patch']).sort()).toEqual(['fix.txt', 'gone.txt']);
      expect(String(output['patch'])).toMatch(/^--- \/dev\/null\n\+\+\+ b\/gone\.txt$/m);

      const published = await publish({
        patch: output['patch'],
        commit: {
          branch: 'aflow/fix',
          message: 'the fix',
          baseSha: branchHead,
          mergeFrom: mainHead,
        },
      });
      expect(published.status).toBe('SUCCEEDED');
      const sha = String((published.output['commit'] as Record<string, unknown>)['sha']);
      expect(await git(project, 'show', `${sha}:gone.txt`)).toBe('gone, restored\n');
    }, 60_000);
  });

  describe('an add-add conflict', () => {
    const conflicts = [{ path: 'new.txt', kind: 'add-add' as const }];

    it('is recorded with its kind, committed with markers, and named in the task', async () => {
      const { branchHead, mainHead } = await world('add-add');
      const { status, output } = await commission({
        harness: 'resolves-added',
        base: 'aflow/fix',
        mergeFrom: 'origin/main',
      });
      expect(status).toBe('SUCCEEDED');
      expect(output['merge']).toEqual({ from: mainHead, conflicts });
      expect(output['baseSha']).toBe(branchHead);
      expect(handed[0]?.argv.join('\n')).toContain(
        mergeConflictSentence({ from: mainHead, conflicts }),
      );
      // The agent found the file marked and resolved it.
      const patch = String(output['patch']);
      expect(changedFiles(patch).sort()).toEqual(['fix.txt', 'new.txt']);
      expect(patch).toMatch(/^-<<<<<<< HEAD$/m);
      expect(patch).toMatch(/^\+new on both$/m);
    }, 60_000);

    it('refuses the markers left in it, naming the path and the kind, with nothing committed', async () => {
      const { branchHead, mainHead } = await world('add-add');
      const { output } = await commission({
        harness: 'works',
        base: 'aflow/fix',
        mergeFrom: 'origin/main',
      });
      expect(changedFiles(output['patch'])).toEqual(['fix.txt']);

      const { status, message } = await publish({
        patch: output['patch'],
        commit: {
          branch: 'aflow/fix',
          message: 'the fix',
          baseSha: branchHead,
          mergeFrom: mainHead,
        },
      });
      expect(status).toBe('FAILED');
      expect(message).toContain('conflict markers in `new.txt` (add-add conflict)');
      expect(await head(project, 'aflow/fix')).toBe(branchHead);
    }, 60_000);

    it('publishes it resolved', async () => {
      const { branchHead, mainHead } = await world('add-add');
      const { output } = await commission({
        harness: 'resolves-added',
        base: 'aflow/fix',
        mergeFrom: 'origin/main',
      });

      const published = await publish({
        patch: output['patch'],
        commit: {
          branch: 'aflow/fix',
          message: 'the fix',
          baseSha: branchHead,
          mergeFrom: mainHead,
        },
      });
      expect(published.status).toBe('SUCCEEDED');
      const sha = String((published.output['commit'] as Record<string, unknown>)['sha']);
      expect(await git(project, 'show', `${sha}:new.txt`)).toBe('new on both\n');
    }, 60_000);
  });

  it('reads no file for markers that the merge did not conflict on', async () => {
    const { branchHead, mainHead } = await world(false);
    const { output } = await commission({
      harness: 'documents',
      base: 'aflow/fix',
      mergeFrom: 'origin/main',
    });
    expect(output['merge']).toEqual({ from: mainHead, conflicts: [] });
    expect(changedFiles(output['patch']).sort()).toEqual(['fix.txt', 'markers.md']);

    const published = await publish({
      patch: output['patch'],
      commit: { branch: 'aflow/fix', message: 'the fix', baseSha: branchHead, mergeFrom: mainHead },
    });
    expect(published.status).toBe('SUCCEEDED');
    const sha = String((published.output['commit'] as Record<string, unknown>)['sha']);
    expect(await git(project, 'show', `${sha}:markers.md`)).toMatch(/^=======$/m);
  }, 60_000);

  it('refuses a patch that does not fit the merge as a conflict naming its files', async () => {
    const { branchHead, mainHead } = await world(true);
    await git(project, 'fetch', '-q', 'origin');
    // Made against the branch alone, where `a.txt` reads `BRANCH` rather than the markers.
    const work = await mkdtemp(join(tmpdir(), 'aflow-merge-from-diff-'));
    await git(project, 'worktree', 'add', '-q', '--detach', work, branchHead);
    await writeFile(join(work, 'a.txt'), 'one\nBRANCH, FIXED\nthree\n');
    await git(work, 'add', '-A');
    const patch = await git(work, 'diff', '--cached');
    await git(project, 'worktree', 'remove', '--force', work);

    const { status, output } = await publish({
      patch,
      commit: { branch: 'aflow/fix', message: 'the fix', baseSha: branchHead, mergeFrom: mainHead },
    });
    expect(status).toBe('SUCCEEDED');
    expect(output['state']).toBe('conflict');
    expect(output['conflicts']).toEqual(['a.txt']);
    expect(output['commit']).toBeUndefined();
    expect(await head(project, 'aflow/fix')).toBe(branchHead);
  }, 60_000);

  it('merges only into a branch that exists, and only what the branch does not hold', async () => {
    const { branchHead, mainHead } = await world(false);
    await git(project, 'fetch', '-q', 'origin');
    const patch =
      'diff --git a/fix.txt b/fix.txt\nnew file mode 100644\n--- /dev/null\n+++ b/fix.txt\n@@ -0,0 +1 @@\n+fixed\n';

    const fresh = await publish({
      patch,
      commit: { branch: 'aflow/fresh', message: 'm', baseSha: branchHead, mergeFrom: mainHead },
    });
    expect(fresh.status).toBe('FAILED');
    expect(fresh.message).toContain('`aflow/fresh` is a new branch');
    await expect(git(project, 'rev-parse', '--verify', 'aflow/fresh')).rejects.toThrow();

    const initial = await head(project, 'aflow/fix^');
    const held = await publish({
      patch,
      commit: { branch: 'aflow/fix', message: 'm', baseSha: branchHead, mergeFrom: initial },
    });
    expect(held.status).toBe('FAILED');
    expect(held.message).toContain('which the branch already holds');
    expect(await head(project, 'aflow/fix')).toBe(branchHead);
  }, 60_000);
});

describe('the same two parents merge to the same tree', () => {
  async function mergeTwice(configure: () => Promise<void>): Promise<string[]> {
    const { branchHead, mainHead } = await world(true);
    await git(project, 'fetch', '-q', 'origin');
    const trees: string[] = [];
    for (const round of [0, 1]) {
      if (round === 1) await configure();
      const scratch = await mkdtemp(join(tmpdir(), 'aflow-merge-twice-'));
      const checkout = await prepareWorktree(project, scratch, 'merge', {
        dependencies: 'none',
        at: branchHead,
      });
      try {
        const merge = await mergeIntoCheckout(
          checkout.path,
          mainHead,
          await commitIdentityArgs(checkout.path),
        );
        expect(merge?.conflicts).toEqual([{ path: 'a.txt', kind: 'content' }]);
        expect(await readFile(join(checkout.path, 'a.txt'), 'utf8')).toMatch(/^<<<<<<< HEAD$/m);
        trees.push(await head(checkout.path, 'HEAD^{tree}'));
      } finally {
        await removeWorktree(project, checkout.path);
        await rm(scratch, { recursive: true, force: true });
      }
    }
    return trees;
  }

  it('conflicts the same way whatever marker style the repository or the operator configures', async () => {
    const globalConfig = join(base, 'operator.gitconfig');
    const previous = process.env['GIT_CONFIG_GLOBAL'];
    try {
      const [first, second] = await mergeTwice(async () => {
        await git(project, 'config', 'merge.conflictStyle', 'diff3');
        await git(project, 'config', 'rerere.enabled', 'true');
        await writeFile(globalConfig, '[merge]\n\tconflictStyle = zdiff3\n');
        process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
      });
      expect(second).toBe(first);
    } finally {
      if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = previous;
    }
  }, 60_000);

  it('merges a clean base to the same tree twice', async () => {
    const { branchHead, mainHead } = await world(false);
    await git(project, 'fetch', '-q', 'origin');
    const trees: string[] = [];
    for (const _round of [0, 1]) {
      const scratch = await mkdtemp(join(tmpdir(), 'aflow-merge-twice-'));
      const checkout = await prepareWorktree(project, scratch, 'merge', {
        dependencies: 'none',
        at: branchHead,
      });
      try {
        const merge = await mergeIntoCheckout(
          checkout.path,
          mainHead,
          await commitIdentityArgs(checkout.path),
        );
        expect(merge?.conflicts).toEqual([]);
        trees.push(await head(checkout.path, 'HEAD^{tree}'));
      } finally {
        await removeWorktree(project, checkout.path);
        await rm(scratch, { recursive: true, force: true });
      }
    }
    expect(trees[1]).toBe(trees[0]);
  }, 60_000);
});
