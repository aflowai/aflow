/**
 * The plan's own acceptance criteria for Phase 2, asserted against real git.
 * Each test names the criterion it stands for.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkApplies,
  collectChanges,
  currentHead,
  prepareWorktree,
  removeWorktree,
} from '../worktree.js';

const run = promisify(execFile);

let repo: string;
let scratch: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'aflow-p2-repo-'));
  scratch = await mkdtemp(join(tmpdir(), 'aflow-p2-scratch-'));
  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.email', 't@e.com');
  await git(repo, 'config', 'user.name', 'T');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(repo, 'b.txt'), 'untouched\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'initial');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Every test here shells out to real git several times, and the two-worktree one
 * does it concurrently against a single repository — where git serialises on its
 * own lock, so the second call waits for the first. On an idle machine that is
 * fast; sharing a laptop with the rest of the suite it is not, and the default
 * five seconds turned a passing property into an intermittent failure. The
 * assertions are about the worktrees being independent, not about how long git
 * took, so the budget is the thing that was wrong.
 */
const GIT_HEAVY_MS = 30_000;

describe('Phase 2 acceptance', () => {
  it(
    'runs two harnesses over one repository concurrently',
    async () => {
      // "run two installed/authenticated harnesses concurrently"
      const [a, b] = await Promise.all([
        prepareWorktree(repo, scratch, 'run-a'),
        prepareWorktree(repo, scratch, 'run-b'),
      ]);
      await Promise.all([
        writeFile(join(a.path, 'a.txt'), 'A rewrote this\n'),
        writeFile(join(b.path, 'b.txt'), 'B rewrote this\n'),
      ]);
      const [ca, cb] = await Promise.all([collectChanges(a.path), collectChanges(b.path)]);

      expect(ca.patch).toContain('A rewrote this');
      expect(ca.patch).not.toContain('B rewrote this');
      expect(cb.patch).toContain('B rewrote this');
      expect(cb.patch).not.toContain('A rewrote this');
      expect(a.baseSha).toBe(b.baseSha);

      await removeWorktree(repo, a.path);
      await removeWorktree(repo, b.path);
    },
    GIT_HEAVY_MS,
  );

  it(
    'preserves dirty user changes throughout',
    async () => {
      // "preserve dirty user changes"
      await writeFile(join(repo, 'a.txt'), 'MY EDIT\n');
      const wt = await prepareWorktree(repo, scratch, 'run');
      await writeFile(join(wt.path, 'a.txt'), 'harness edit\n');
      await collectChanges(wt.path);
      await removeWorktree(repo, wt.path);
      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('MY EDIT\n');
    },
    GIT_HEAVY_MS,
  );

  it(
    'stopping one run leaves the other intact',
    async () => {
      // "stop one without affecting the other" — a stopped run's worktree is torn
      // down; the other keeps its checkout and still collects its work.
      const a = await prepareWorktree(repo, scratch, 'run-a');
      const b = await prepareWorktree(repo, scratch, 'run-b');
      await writeFile(join(b.path, 'a.txt'), 'B kept working\n');

      await removeWorktree(repo, a.path);

      const cb = await collectChanges(b.path);
      expect(cb.patch).toContain('B kept working');
      expect(await git(repo, 'worktree', 'list')).not.toContain(a.path);
      expect(await git(repo, 'worktree', 'list')).toContain(b.path);
      await removeWorktree(repo, b.path);
    },
    GIT_HEAVY_MS,
  );

  it(
    'collects partial work from a run that did not finish',
    async () => {
      // "collect partial work"
      const wt = await prepareWorktree(repo, scratch, 'run');
      await writeFile(join(wt.path, 'a.txt'), 'one\nEDITED\nthree\n');
      const changes = await collectChanges(wt.path);
      expect(changes.filesChanged).toBe(1);
      expect(changes.patch).toContain('EDITED');
      await removeWorktree(repo, wt.path);
    },
    GIT_HEAVY_MS,
  );

  it(
    'detects an apply conflict when the operator changed the same lines',
    async () => {
      // "detect an apply conflict"
      const wt = await prepareWorktree(repo, scratch, 'run');
      await writeFile(join(wt.path, 'a.txt'), 'one\nHARNESS\nthree\n');
      const changes = await collectChanges(wt.path);

      // The operator moves the same lines while the run was going.
      await writeFile(join(repo, 'a.txt'), 'one\nOPERATOR\nthree\n');
      await git(repo, 'commit', '-am', 'operator edit');

      const applies = await checkApplies(repo, changes.patch);
      expect(applies.state).toBe('conflict');
      if (applies.state === 'conflict') expect(applies.detail).toContain('a.txt');
      expect(await currentHead(repo)).not.toBe(wt.baseSha);
      await removeWorktree(repo, wt.path);
    },
    GIT_HEAVY_MS,
  );

  it(
    'reports a clean apply when the repository moved elsewhere',
    async () => {
      // A moved HEAD is not a conflict; only overlapping edits are.
      const wt = await prepareWorktree(repo, scratch, 'run');
      await writeFile(join(wt.path, 'a.txt'), 'one\nHARNESS\nthree\n');
      const changes = await collectChanges(wt.path);

      await writeFile(join(repo, 'b.txt'), 'operator touched another file\n');
      await git(repo, 'commit', '-am', 'unrelated edit');

      expect((await checkApplies(repo, changes.patch)).state).toBe('clean');
      expect(await currentHead(repo)).not.toBe(wt.baseSha);
      await removeWorktree(repo, wt.path);
    },
    GIT_HEAVY_MS,
  );

  it(
    'calls an empty diff empty rather than cleanly appliable',
    async () => {
      expect((await checkApplies(repo, '')).state).toBe('empty');
    },
    GIT_HEAVY_MS,
  );
});
