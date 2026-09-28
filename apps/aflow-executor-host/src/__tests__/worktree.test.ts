import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  changedRefs,
  collectChanges,
  isGitRepository,
  prepareWorktree,
  removeWorktree,
  resolveCommit,
  snapshotRefs,
  WorktreeError,
} from '../worktree.js';

const run = promisify(execFile);

let repo: string;
let scratch: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'aflow-wt-repo-'));
  scratch = await mkdtemp(join(tmpdir(), 'aflow-wt-scratch-'));
  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'app.txt'), 'committed\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe('worktree per run', () => {
  it('leaves the operator uncommitted work untouched while a run edits its own checkout', async () => {
    // The acceptance criterion: a run may start at any time, including while
    // the operator has work in progress.
    await writeFile(join(repo, 'app.txt'), 'MY UNSAVED EDIT\n');
    await writeFile(join(repo, 'scratch-note.txt'), 'my untracked note\n');

    const wt = await prepareWorktree(repo, scratch, 'work');
    await writeFile(join(wt.path, 'app.txt'), 'harness rewrote this\n');

    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('MY UNSAVED EDIT\n');
    expect(await readFile(join(repo, 'scratch-note.txt'), 'utf8')).toBe('my untracked note\n');
    // The worktree started from the commit, not from the dirty state.
    expect(wt.baseSha).toBe((await git(repo, 'rev-parse', 'HEAD')).trim());

    await removeWorktree(repo, wt.path);
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('MY UNSAVED EDIT\n');
  });

  it('runs two harnesses over one repository without them colliding', async () => {
    const a = await prepareWorktree(repo, scratch, 'run-a');
    const b = await prepareWorktree(repo, scratch, 'run-b');
    await writeFile(join(a.path, 'app.txt'), 'from A\n');
    await writeFile(join(b.path, 'app.txt'), 'from B\n');

    const changesA = await collectChanges(a.path);
    const changesB = await collectChanges(b.path);
    expect(changesA.patch).toContain('from A');
    expect(changesA.patch).not.toContain('from B');
    expect(changesB.patch).toContain('from B');

    await removeWorktree(repo, a.path);
    await removeWorktree(repo, b.path);
  });

  it('reports added files, which a plain diff would omit entirely', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    await writeFile(join(wt.path, 'brand-new.ts'), 'export const x = 1;\n');

    const changes = await collectChanges(wt.path);
    expect(changes.filesChanged).toBe(1);
    expect(changes.patch).toContain('brand-new.ts');
    expect(changes.patch).toContain('export const x = 1;');
    await removeWorktree(repo, wt.path);
  });

  it('reports no change as no change, not as an empty diff of something', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    const changes = await collectChanges(wt.path);
    expect(changes).toEqual({ patch: '', filesChanged: 0, truncated: false });
    await removeWorktree(repo, wt.path);
  });

  it('collects work from a run that was stopped part-way', async () => {
    // A harness killed on timeout has still done work; the diff is collected
    // from the worktree regardless of how the process ended.
    const wt = await prepareWorktree(repo, scratch, 'work');
    await writeFile(join(wt.path, 'app.txt'), 'half-finished\n');
    const changes = await collectChanges(wt.path);
    expect(changes.filesChanged).toBe(1);
    await removeWorktree(repo, wt.path);
  });

  it('refuses a folder that is not a repository, naming why', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'aflow-plain-'));
    expect(await isGitRepository(plain)).toBe(false);
    await expect(prepareWorktree(plain, scratch, 'work')).rejects.toThrow(WorktreeError);
    await rm(plain, { recursive: true, force: true });
  });

  it('refuses a repository with no commits rather than diffing against nothing', async () => {
    const unborn = await mkdtemp(join(tmpdir(), 'aflow-unborn-'));
    await git(unborn, 'init', '--initial-branch=main');
    await expect(prepareWorktree(unborn, scratch, 'work')).rejects.toThrow(/no commits yet/);
    await rm(unborn, { recursive: true, force: true });
  });

  it('leaves no worktree registered after cleanup', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    expect(await git(repo, 'worktree', 'list')).toContain(wt.path);
    await removeWorktree(repo, wt.path);
    expect(await git(repo, 'worktree', 'list')).not.toContain(wt.path);
  });
});

describe('a run started from a named ref', () => {
  it('checks out the commit the ref names, not the folder HEAD', async () => {
    await git(repo, 'branch', 'feat/fix');
    const branchHead = (await git(repo, 'rev-parse', 'feat/fix')).trim();
    await writeFile(join(repo, 'app.txt'), 'main moved on\n');
    await git(repo, 'commit', '-am', 'main moved');

    const at = await resolveCommit(repo, 'feat/fix');
    expect(at).toBe(branchHead);
    const wt = await prepareWorktree(repo, scratch, 'work', { at });
    expect(wt.baseSha).toBe(branchHead);
    expect(await readFile(join(wt.path, 'app.txt'), 'utf8')).toBe('committed\n');
    await removeWorktree(repo, wt.path);
  });

  it('refuses a ref the folder does not have, naming it', async () => {
    await expect(resolveCommit(repo, 'no-such-branch')).rejects.toThrow(/`no-such-branch`/);
    await expect(resolveCommit(repo, '--output=/tmp/x')).rejects.toThrow(WorktreeError);
  });
});

describe('the refs reported for a run', () => {
  it('sees nothing when the run only committed in its own checkout', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    const before = await snapshotRefs(repo);
    await writeFile(join(wt.path, 'app.txt'), 'committed in the checkout\n');
    await git(wt.path, 'commit', '-am', 'detached commit');
    expect(changedRefs(before, await snapshotRefs(repo))).toEqual([]);
    await removeWorktree(repo, wt.path);
  });

  it('sees a branch deleted through the shared refs', async () => {
    await git(repo, 'branch', 'other');
    const other = (await git(repo, 'rev-parse', 'other')).trim();
    const wt = await prepareWorktree(repo, scratch, 'work');
    const before = await snapshotRefs(repo);
    await git(wt.path, 'branch', '-D', 'other');

    expect(changedRefs(before, await snapshotRefs(repo))).toEqual([
      { ref: 'refs/heads/other', change: 'deleted', from: other },
    ]);
    await removeWorktree(repo, wt.path);
  });

  it('sees a ref moved and a ref created from inside the checkout', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    const before = await snapshotRefs(repo);
    const main = before.get('refs/heads/main');
    await writeFile(join(wt.path, 'app.txt'), 'rewritten\n');
    await git(wt.path, 'commit', '-am', 'rewrite');
    const rewritten = (await git(wt.path, 'rev-parse', 'HEAD')).trim();
    await git(wt.path, 'update-ref', 'refs/heads/main', rewritten);
    await git(wt.path, 'update-ref', 'refs/tags/planted', rewritten);

    expect(changedRefs(before, await snapshotRefs(repo))).toEqual([
      { ref: 'refs/heads/main', change: 'moved', from: main, to: rewritten },
      { ref: 'refs/tags/planted', change: 'created', to: rewritten },
    ]);
    await removeWorktree(repo, wt.path);
  });

  it('watches local branches and tags, and not what a fetch or a stash moves', async () => {
    await git(repo, 'branch', 'other');
    const wt = await prepareWorktree(repo, scratch, 'work');
    const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const before = await snapshotRefs(repo);

    await git(repo, 'update-ref', 'refs/remotes/origin/x', head);
    await writeFile(join(repo, 'app.txt'), 'work in progress\n');
    await git(repo, 'stash');
    expect(changedRefs(before, await snapshotRefs(repo))).toEqual([]);

    await git(wt.path, 'branch', '-D', 'other');
    await git(wt.path, 'tag', 'planted');
    expect(changedRefs(before, await snapshotRefs(repo)).map((c) => [c.ref, c.change])).toEqual([
      ['refs/heads/other', 'deleted'],
      ['refs/tags/planted', 'created'],
    ]);
    await removeWorktree(repo, wt.path);
  });
});
