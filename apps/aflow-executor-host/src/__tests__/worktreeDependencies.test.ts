/**
 * Contract: the isolated checkout can run the operator's own toolchain.
 *
 * A worktree carries what the repository tracks, and an installed dependency
 * tree is correctly not tracked. Without it, a harness asked to run the tests
 * or the typecheck reaches for a package registry that the boundary denies, and
 * reports a network failure for work the machine could already do.
 */
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostBindingSchema } from '../bindings.js';
import { runSandboxed, sandboxAvailable } from '../sandboxedRun.js';
import { collectChanges, prepareWorktree, removeWorktree } from '../worktree.js';

const run = promisify(execFile);

let repo: string;
let scratch: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'aflow-deps-repo-'));
  scratch = await mkdtemp(join(tmpdir(), 'aflow-deps-scratch-'));
  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await mkdir(join(repo, 'packages', 'a'), { recursive: true });
  await writeFile(join(repo, 'app.txt'), 'committed\n');
  await writeFile(join(repo, 'packages', 'a', 'index.txt'), 'package\n');
  // Ignored the way real repositories ignore it, without a trailing slash, so
  // the rule matches the links too: git refuses a pathspec that names an
  // ignored path, which is the case the collection has to survive.
  await writeFile(join(repo, '.gitignore'), 'node_modules\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'initial');
  // Installed, therefore untracked, therefore absent from any checkout.
  await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(repo, 'node_modules', 'left-pad', 'index.js'), 'root dep\n');
  await mkdir(join(repo, 'packages', 'a', 'node_modules'), { recursive: true });
  await writeFile(join(repo, 'packages', 'a', 'node_modules', 'marker.txt'), 'package dep\n');
  // What makes it a workspace installation: the package manager puts the
  // repository's own packages into `node_modules` beside what it downloaded.
  await mkdir(join(repo, 'node_modules', '@acme'), { recursive: true });
  await symlink(join('..', '..', 'packages', 'a'), join(repo, 'node_modules', '@acme', 'a'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe('dependencies in the isolated checkout', () => {
  it('carries every installation the folder has, at the root and under a package', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');

    for (const relative of ['node_modules', join('packages', 'a', 'node_modules')]) {
      const mirrored = await lstat(join(wt.path, relative));
      // A real directory of links, never one link standing for the whole tree:
      // through a single link every workspace entry inside it resolves into the
      // folder the operator is editing.
      expect(mirrored.isDirectory()).toBe(true);
      expect(mirrored.isSymbolicLink()).toBe(false);
    }
    // And through it, the harness reads what the operator installed.
    expect(await readFile(join(wt.path, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe(
      'root dep\n',
    );
    expect(
      await readFile(join(wt.path, 'packages', 'a', 'node_modules', 'marker.txt'), 'utf8'),
    ).toBe('package dep\n');

    await removeWorktree(repo, wt.path);
  });

  it('resolves a workspace package to the checkout and a real dependency to the folder', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    const worktreeReal = await realpath(wt.path);
    const repoReal = await realpath(repo);

    expect(await realpath(join(wt.path, 'node_modules', '@acme', 'a'))).toBe(
      join(worktreeReal, 'packages', 'a'),
    );
    expect(await realpath(join(wt.path, 'node_modules', 'left-pad'))).toBe(
      join(repoReal, 'node_modules', 'left-pad'),
    );

    await removeWorktree(repo, wt.path);
  });

  it('shows a workspace package as committed, not as the operator is editing it', async () => {
    // The promise the isolated checkout makes. Resolved through one link to the
    // installation, this read returned the operator's uncommitted line.
    await writeFile(join(repo, 'packages', 'a', 'index.txt'), 'operator is mid-edit\n');
    const wt = await prepareWorktree(repo, scratch, 'work');

    expect(await readFile(join(wt.path, 'node_modules', '@acme', 'a', 'index.txt'), 'utf8')).toBe(
      'package\n',
    );

    await removeWorktree(repo, wt.path);
  });

  it('carries an installation the folder keeps somewhere else', async () => {
    // Some folders have their dependencies installed elsewhere and linked in.
    // Treating only a real directory as an installation left those with none.
    const elsewhere = await mkdtemp(join(tmpdir(), 'aflow-deps-store-'));
    await mkdir(join(elsewhere, 'left-pad'), { recursive: true });
    await writeFile(join(elsewhere, 'left-pad', 'index.js'), 'stored dep\n');
    await mkdir(join(elsewhere, '@acme'), { recursive: true });
    await symlink(join(repo, 'packages', 'a'), join(elsewhere, '@acme', 'a'));
    await rm(join(repo, 'node_modules'), { recursive: true, force: true });
    await symlink(elsewhere, join(repo, 'node_modules'));

    try {
      const wt = await prepareWorktree(repo, scratch, 'work');
      expect((await lstat(join(wt.path, 'node_modules'))).isDirectory()).toBe(true);
      expect(await readFile(join(wt.path, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe(
        'stored dep\n',
      );
      expect(await realpath(join(wt.path, 'node_modules', '@acme', 'a'))).toBe(
        join(await realpath(wt.path), 'packages', 'a'),
      );
      expect(await collectChanges(wt.path)).toEqual({
        patch: '',
        filesChanged: 0,
        overCeiling: false,
      });
      await removeWorktree(repo, wt.path);
      expect(await readdir(elsewhere)).toEqual(expect.arrayContaining(['@acme', 'left-pad']));
      expect(await readFile(join(elsewhere, 'left-pad', 'index.js'), 'utf8')).toBe('stored dep\n');
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('reports nothing changed, because a link is this lane doing rather than the harness', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    const changes = await collectChanges(wt.path);
    expect(changes).toEqual({ patch: '', filesChanged: 0, overCeiling: false });
    // Not merely absent from the diff: absent from what git was asked to stage.
    expect(await git(wt.path, 'diff', '--cached', '--name-only')).toBe('');
    await removeWorktree(repo, wt.path);
  });

  it('still reports the work the harness did, beside the links', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    await writeFile(join(wt.path, 'app.txt'), 'harness rewrote this\n');
    const changes = await collectChanges(wt.path);
    expect(changes.filesChanged).toBe(1);
    expect(changes.patch).toContain('harness rewrote this');
    expect(changes.patch).not.toContain('node_modules');
    await removeWorktree(repo, wt.path);
  });

  it('takes the mirror away and leaves what the operator installed and wrote', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    await removeWorktree(repo, wt.path);

    expect(await readFile(join(repo, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe(
      'root dep\n',
    );
    expect(await readdir(join(repo, 'packages', 'a', 'node_modules'))).toEqual(['marker.txt']);
    // The links reach the operator's own packages as well as the installation,
    // so a removal that followed one would delete the repository's source.
    expect((await lstat(join(repo, 'node_modules', '@acme', 'a'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(repo, 'packages', 'a', 'index.txt'), 'utf8')).toBe('package\n');
  });

  it('creates nothing for a folder that has installed nothing', async () => {
    await rm(join(repo, 'node_modules'), { recursive: true, force: true });
    await rm(join(repo, 'packages', 'a', 'node_modules'), { recursive: true, force: true });

    const wt = await prepareWorktree(repo, scratch, 'work');
    await expect(lstat(join(wt.path, 'node_modules'))).rejects.toThrow();
    expect(await collectChanges(wt.path)).toEqual({
      patch: '',
      filesChanged: 0,
      overCeiling: false,
    });
    await removeWorktree(repo, wt.path);
  });

  it.runIf(sandboxAvailable())(
    'lets a confined harness read through the link and refuses it the write',
    async () => {
      // The property the link rests on: the sandbox grants writes to the
      // worktree by path, and a write through the link lands on the operator's
      // own directory, which a harness policy withholds. If that were not so,
      // a run could corrupt what the operator installed.
      const wt = await prepareWorktree(repo, scratch, 'work');
      const result = await runSandboxed({
        binding: HostBindingSchema.parse({
          id: 'hb',
          root: repo,
          mode: 'readwrite',
          allowsExecution: true,
        }),
        argv: [
          '/bin/sh',
          '-c',
          'cat node_modules/left-pad/index.js; ' +
            'echo tampered > node_modules/left-pad/index.js && echo WROTE || echo REFUSED',
        ],
        cwd: wt.path,
        env: {},
        timeoutMs: 60_000,
        scratchDir: scratch,
        widening: {
          authPaths: [],
          allowedDomains: [],
          writableRoot: wt.path,
          withholdBindingWrite: true,
        },
        idPrefix: 'dep',
        ownerRunId: 'probe',
        closeStdin: true,
        signal: new AbortController().signal,
        onDelta: () => undefined,
      });

      expect(result.stdout).toContain('root dep');
      expect(result.stdout).toContain('REFUSED');
      expect(result.stdout).not.toContain('WROTE');
      expect(await readFile(join(repo, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe(
        'root dep\n',
      );

      await removeWorktree(repo, wt.path);
    },
    120_000,
  );
});
