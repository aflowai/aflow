import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectChanges,
  isGitRepository,
  prepareWorktree,
  removeWorktree,
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
