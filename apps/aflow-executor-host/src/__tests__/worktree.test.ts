import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeOrphanedCheckouts } from '../handlers/harnessHandlers.js';
import {
  allSessions,
  forgetSession,
  HARNESS_SCRATCH_PREFIX,
  recordSession,
} from '../harnessSessions.js';
import { PUBLICATION_SCRATCH_PREFIX } from '../branchCommit.js';
import { makeScratch } from '../executorScratch.js';
import { openOrphanJournal, reapOrphans, recordSpawn } from '../orphans.js';
import {
  checkApplies,
  collectChanges,
  fetchRemoteBase,
  isGitRepository,
  prepareWorktree,
  removeWorktree,
  resolveCommit,
  WorktreeError,
} from '../worktree.js';

const run = promisify(execFile);

let repo: string;
let scratch: string;

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

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

    await removeWorktree(wt.path);
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('MY UNSAVED EDIT\n');
  });

  it('runs two harnesses over one repository without them colliding', async () => {
    const a = await prepareWorktree(repo, scratch, 'run-a');
    const b = await prepareWorktree(repo, scratch, 'run-b');
    await writeFile(join(a.path, 'app.txt'), 'from A\n');
    await writeFile(join(b.path, 'app.txt'), 'from B\n');

    const changesA = await collectChanges(a);
    const changesB = await collectChanges(b);
    expect(changesA.patch).toContain('from A');
    expect(changesA.patch).not.toContain('from B');
    expect(changesB.patch).toContain('from B');

    await removeWorktree(a.path);
    await removeWorktree(b.path);
  });

  it('reports added files, which a plain diff would omit entirely', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    await writeFile(join(wt.path, 'brand-new.ts'), 'export const x = 1;\n');

    const changes = await collectChanges(wt);
    expect(changes.filesChanged).toBe(1);
    expect(changes.patch).toContain('brand-new.ts');
    expect(changes.patch).toContain('export const x = 1;');
    await removeWorktree(wt.path);
  });

  it('checks out the commit as it is stored, never what a replace ref stands in for it', async () => {
    // What a review reads is what a push sends, and a push sends the stored objects.
    await writeFile(join(repo, 'app.txt'), 'stored\n');
    await git(repo, 'commit', '-qam', 'stored');
    const stored = (await git(repo, 'rev-parse', 'HEAD')).trim();
    await writeFile(join(repo, 'app.txt'), 'stand-in\n');
    await git(repo, 'commit', '-qam', 'stand-in');
    const standIn = (await git(repo, 'rev-parse', 'HEAD')).trim();
    await git(repo, 'reset', '-q', '--hard', stored);
    await git(repo, 'replace', stored, standIn);
    expect(await git(repo, 'show', `${stored}:app.txt`)).toBe('stand-in\n');

    for (const wt of [
      await prepareWorktree(repo, scratch, 'at-head'),
      await prepareWorktree(repo, scratch, 'at-sha', { at: stored }),
    ]) {
      expect(wt.baseSha).toBe(stored);
      expect(await readFile(join(wt.path, 'app.txt'), 'utf8')).toBe('stored\n');
      expect((await collectChanges(wt)).filesChanged).toBe(0);
      await removeWorktree(wt.path);
    }
  });

  it("leaves the run's own scratch out of the change", async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    await mkdir(join(wt.path, '.aflow'), { recursive: true });
    await writeFile(join(wt.path, '.aflow', 'change.patch'), 'a copy of the work\n');
    await writeFile(join(wt.path, 'app.txt'), 'edited\n');

    const changes = await collectChanges(wt);
    expect(changes.filesChanged).toBe(1);
    expect(changes.patch).toContain('app.txt');
    expect(changes.patch).not.toContain('.aflow');
    expect(changes.patch).not.toContain('a copy of the work');
    await removeWorktree(wt.path);
  });

  it('leaves out a tracked file under the scratch directory too', async () => {
    await mkdir(join(repo, '.aflow'), { recursive: true });
    await writeFile(join(repo, '.aflow', 'notes.md'), 'tracked\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'tracked scratch');
    const wt = await prepareWorktree(repo, scratch, 'work');
    await writeFile(join(wt.path, '.aflow', 'notes.md'), 'rewritten by the agent\n');

    const changes = await collectChanges(wt);
    expect(changes).toEqual({ patch: '', filesChanged: 0, overCeiling: false });
    await removeWorktree(wt.path);
  });

  it('reports no change as no change, not as an empty diff of something', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    const changes = await collectChanges(wt);
    expect(changes).toEqual({ patch: '', filesChanged: 0, overCeiling: false });
    await removeWorktree(wt.path);
  });

  it('collects work from a run that was stopped part-way', async () => {
    // A harness killed on timeout has still done work; the diff is collected
    // from the worktree regardless of how the process ended.
    const wt = await prepareWorktree(repo, scratch, 'work');
    await writeFile(join(wt.path, 'app.txt'), 'half-finished\n');
    const changes = await collectChanges(wt);
    expect(changes.filesChanged).toBe(1);
    await removeWorktree(wt.path);
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

  it('registers nothing in the folder, and leaves nothing once removed', async () => {
    const listed = await git(repo, 'worktree', 'list', '--porcelain');
    const wt = await prepareWorktree(repo, scratch, 'work');
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(listed);
    await removeWorktree(wt.path);
    expect(await exists(wt.path)).toBe(false);
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(listed);
  });

  it('gives a folder connected inside a repository a checkout that works where the folder is', async () => {
    // A package of a monorepo: a repository to `rev-parse`, and no top level
    // `git clone` would take.
    const folder = join(repo, 'packages', 'app');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'index.ts'), 'export const app = 1;\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'a package');
    expect(await isGitRepository(folder)).toBe(true);

    const wt = await prepareWorktree(folder, scratch, 'work');
    try {
      expect(wt.workDir).toBe(join(wt.path, 'packages', 'app'));
      expect(wt.baseSha).toBe((await git(repo, 'rev-parse', 'HEAD')).trim());
      expect(await readFile(join(wt.workDir, 'index.ts'), 'utf8')).toBe('export const app = 1;\n');

      // The run's work is the folder's: an edit beside it in the repository and
      // the run's own files are not part of the change.
      await writeFile(join(wt.workDir, 'index.ts'), 'export const app = 2;\n');
      await writeFile(join(wt.workDir, 'added.ts'), 'export const added = true;\n');
      await mkdir(join(wt.workDir, '.aflow'), { recursive: true });
      await writeFile(join(wt.workDir, '.aflow', 'result.json'), '{}\n');
      await writeFile(join(wt.path, 'app.txt'), 'outside the folder\n');
      const changes = await collectChanges(wt);
      expect(changes.filesChanged).toBe(2);
      expect(changes.patch).toContain('packages/app/index.ts');
      expect(changes.patch).toContain('packages/app/added.ts');
      expect(changes.patch).not.toContain('app.txt');
      expect(changes.patch).not.toContain('result.json');
      expect(await checkApplies(folder, changes.patch)).toEqual({ state: 'clean' });
    } finally {
      await removeWorktree(wt.path);
    }
    expect(await exists(wt.path)).toBe(false);
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
    await removeWorktree(wt.path);
  });

  it('refuses a ref the folder does not have, naming it', async () => {
    await expect(resolveCommit(repo, 'no-such-branch')).rejects.toThrow(/`no-such-branch`/);
    await expect(resolveCommit(repo, '--output=/tmp/x')).rejects.toThrow(WorktreeError);
  });
});

describe('a run started from a ref on a remote', () => {
  let upstream: string;
  let elsewhere: string;

  beforeEach(async () => {
    upstream = await mkdtemp(join(tmpdir(), 'aflow-wt-upstream-'));
    elsewhere = await mkdtemp(join(tmpdir(), 'aflow-wt-elsewhere-'));
    await git(upstream, 'init', '--bare', '--initial-branch=main');
    await git(repo, 'remote', 'add', 'origin', upstream);
    await git(repo, 'push', '-q', 'origin', 'main');
    await git(repo, 'fetch', '-q', 'origin');
  });

  afterEach(async () => {
    await rm(upstream, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  /** Someone else moves the remote's main on, which this folder has not fetched. */
  async function remoteMovesOn(): Promise<string> {
    await git(elsewhere, 'clone', '-q', upstream, '.');
    await git(elsewhere, 'config', 'user.email', 'other@example.com');
    await git(elsewhere, 'config', 'user.name', 'Other');
    await writeFile(join(elsewhere, 'app.txt'), 'the remote moved on\n');
    await git(elsewhere, 'commit', '-qam', 'upstream change');
    await git(elsewhere, 'push', '-q', 'origin', 'main');
    return (await git(elsewhere, 'rev-parse', 'HEAD')).trim();
  }

  it('reads the remote as it is now, not as the folder last fetched it', async () => {
    const stale = (await git(repo, 'rev-parse', 'origin/main')).trim();
    const moved = await remoteMovesOn();
    expect(moved).not.toBe(stale);

    await fetchRemoteBase(repo, 'origin/main');
    expect(await resolveCommit(repo, 'origin/main')).toBe(moved);
  });

  it('refuses a remote it cannot reach, naming the remote', async () => {
    await git(repo, 'remote', 'set-url', 'origin', join(upstream, 'gone'));
    const refusal = fetchRemoteBase(repo, 'origin/main');
    await expect(refusal).rejects.toThrow(WorktreeError);
    await expect(refusal).rejects.toThrow(/the remote `origin`/);
  });

  it('reaches the remote through the transport the operator’s own environment names', async () => {
    const moved = await remoteMovesOn();
    // A global config kept under XDG_CONFIG_HOME is the only thing that knows
    // where `elsewhere:` points; without it the fetch has no remote to reach.
    const xdg = await mkdtemp(join(tmpdir(), 'aflow-wt-xdg-'));
    const prior = process.env['XDG_CONFIG_HOME'];
    try {
      await mkdir(join(xdg, 'git'));
      await writeFile(
        join(xdg, 'git', 'config'),
        `[url "${upstream}"]\n\tinsteadOf = elsewhere:\n`,
      );
      await git(repo, 'remote', 'set-url', 'origin', 'elsewhere:');
      process.env['XDG_CONFIG_HOME'] = xdg;
      await fetchRemoteBase(repo, 'origin/main');
      expect(await resolveCommit(repo, 'origin/main')).toBe(moved);
    } finally {
      if (prior === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = prior;
      await rm(xdg, { recursive: true, force: true });
    }
  });

  it('leaves a local branch with a slash in its name alone', async () => {
    await git(repo, 'branch', 'feat/fix');
    await expect(fetchRemoteBase(repo, 'feat/fix')).resolves.toBeUndefined();
  });

  it('never fetches a refspec into one of the folder’s branches', async () => {
    await remoteMovesOn();
    await git(repo, 'branch', 'victim');
    const victim = (await git(repo, 'rev-parse', 'victim')).trim();
    for (const base of ['origin/+main:refs/heads/victim', 'origin/main:refs/heads/victim']) {
      await fetchRemoteBase(repo, base);
      expect((await git(repo, 'rev-parse', 'victim')).trim()).toBe(victim);
    }
  });
});

describe("a run's checkout is a clone whose refs are its own", () => {
  const refsOf = async (cwd: string): Promise<string> =>
    await git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)');

  beforeEach(async () => {
    await git(repo, 'branch', 'other');
    await git(repo, 'tag', 'v1');
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  });

  it('reads every ref as the folder names it, borrows its objects, and names it as no remote', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work', { dependencies: 'none' });
    expect(await refsOf(wt.path)).toBe(await refsOf(repo));
    // Its git directory sits beside it, and the checkout holds only a gitfile.
    expect(wt.gitDir).toBe(join(scratch, 'git-work'));
    expect(await readFile(join(wt.path, '.git'), 'utf8')).toBe(`gitdir: ${wt.gitDir}\n`);
    expect((await git(wt.path, 'rev-parse', '--absolute-git-dir')).trim()).toBe(
      await realpath(wt.gitDir),
    );
    expect(await readFile(join(wt.gitDir, 'objects', 'info', 'alternates'), 'utf8')).toContain(
      join(basename(repo), '.git', 'objects'),
    );
    expect((await git(wt.path, 'remote')).trim()).toBe('');
    expect((await git(wt.path, 'rev-parse', 'HEAD')).trim()).toBe(wt.baseSha);
    expect(await readFile(join(wt.gitDir, 'HEAD'), 'utf8')).toBe(`${wt.baseSha}\n`);
    await removeWorktree(wt.path);
    await expect(stat(wt.gitDir)).rejects.toThrow();
  });

  it("moves only the clone's refs, whatever git the run uses, with no hook anywhere", async () => {
    const wt = await prepareWorktree(repo, scratch, 'work', { dependencies: 'none' });
    const before = await refsOf(repo);
    await writeFile(join(wt.path, 'app.txt'), 'committed in the clone\n');
    await git(
      wt.path,
      '-c',
      'user.name=Agent',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-qam',
      'w',
    );
    const made = (await git(wt.path, 'rev-parse', 'HEAD')).trim();

    await git(wt.path, 'branch', '-D', 'other');
    await git(wt.path, '-c', 'core.hooksPath=/dev/null', 'update-ref', 'refs/heads/main', made);
    await git(wt.path, '-c', 'core.hooksPath=/dev/null', 'tag', '-f', 'v1', made);
    await git(wt.path, 'update-ref', '-d', 'refs/remotes/origin/main');
    await git(wt.path, 'push', '-q', '.', 'HEAD:refs/heads/pushed');

    expect(await refsOf(repo)).toBe(before);
    expect(await git(repo, 'cat-file', '-t', made).catch(() => 'absent')).toBe('absent');
    const clone = await refsOf(wt.path);
    expect(clone).not.toContain('refs/heads/other ');
    expect(clone).toContain(`refs/heads/main ${made}`);
    expect(clone).toContain(`refs/heads/pushed ${made}`);
    expect(await exists(join(repo, '.git', 'hooks', 'reference-transaction'))).toBe(false);
    expect(await exists(join(scratch, 'git-hooks'))).toBe(false);
    await removeWorktree(wt.path);
  });

  it('reads a commit made in the folder after the clone, through the objects it borrows', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work', { dependencies: 'none' });
    await writeFile(join(repo, 'app.txt'), 'later\n');
    await git(repo, 'commit', '-qam', 'later');
    const later = (await git(repo, 'rev-parse', 'HEAD')).trim();
    expect(await git(wt.path, 'show', `${later}:app.txt`)).toBe('later\n');
    await removeWorktree(wt.path);
  });
});

describe('whether a diff made from a named base applies', () => {
  it('is judged against the base head, touching nothing in the folder', async () => {
    await git(repo, 'branch', 'feat/fix');
    await writeFile(join(repo, 'app.txt'), 'main moved on\n');
    await git(repo, 'commit', '-am', 'main moved');
    await writeFile(join(repo, 'app.txt'), 'my unsaved edit\n');
    await writeFile(join(repo, 'staged.txt'), 'staged\n');
    await git(repo, 'add', 'staged.txt');
    const statusBefore = await git(repo, 'status', '--porcelain');

    const at = await resolveCommit(repo, 'feat/fix');
    const wt = await prepareWorktree(repo, scratch, 'work', { at });
    await writeFile(join(wt.path, 'app.txt'), 'fixed on the branch\n');
    const { patch } = await collectChanges(wt);
    await removeWorktree(wt.path);

    expect((await checkApplies(repo, patch)).state).toBe('conflict');
    expect((await checkApplies(repo, patch, at)).state).toBe('clean');
    const moved = await checkApplies(repo, patch, (await git(repo, 'rev-parse', 'main')).trim());
    expect(moved.state).toBe('conflict');

    expect(await git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('my unsaved edit\n');
  });
});

describe('checkouts a restart left behind', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'wt-temp-'));
  });

  afterEach(async () => {
    for (const session of allSessions()) forgetSession(session.id);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('removes what no session owns under the temp root, and nothing of the operator', async () => {
    const orphanScratch = await makeScratch(HARNESS_SCRATCH_PREFIX, tempRoot);
    await prepareWorktree(repo, orphanScratch, 'work');
    const orphanPublication = await makeScratch(PUBLICATION_SCRATCH_PREFIX, tempRoot);
    await prepareWorktree(repo, orphanPublication, 'commit', { dependencies: 'none' });
    const stray = await makeScratch(HARNESS_SCRATCH_PREFIX, tempRoot);
    const liveScratch = await makeScratch(HARNESS_SCRATCH_PREFIX, tempRoot);
    const live = await prepareWorktree(repo, liveScratch, 'work');
    recordSession({
      id: 'hs_live',
      ownerRunId: 'run-live',
      logicalExecutionId: 'step:hs_live',
      bindingId: 'hb',
      harnessId: 'edits',
      worktreePath: live.path,
      scratchDir: liveScratch,
      configDir: join(liveScratch, 'harness-config'),
      conversationId: 'c',
      baseSha: live.baseSha,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      busy: false,
    });
    // The operator's own checkouts in the same temp root, in directories named
    // the way this executor names its scratch but never marked by it: one added
    // to the folder on a branch with work in progress, and a clone of their own
    // on a branch.
    const operatorsScratch = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    const onBranch = join(operatorsScratch, 'mine');
    await git(repo, 'worktree', 'add', '-b', 'operator/review', onBranch);
    await writeFile(join(onBranch, 'app.txt'), 'uncommitted review notes\n');
    const operatorsClone = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    await git(operatorsClone, 'clone', '-q', repo, 'mine');
    // And one of this lane's shape, in a directory it never makes.
    const operatorsDetached = await mkdtemp(join(tempRoot, 'aflow-review-'));
    const detached = await prepareWorktree(repo, operatorsDetached, 'mine');
    const unrelated = await mkdtemp(join(tempRoot, 'not-ours-'));
    const refs = await git(repo, 'for-each-ref');
    const listed = await git(repo, 'worktree', 'list', '--porcelain');

    const outcome = await removeOrphanedCheckouts(tempRoot);

    expect(outcome).toEqual({ checkouts: 2, scratchDirs: 3 });
    expect(await exists(orphanScratch)).toBe(false);
    expect(await exists(orphanPublication)).toBe(false);
    expect(await exists(stray)).toBe(false);
    expect(await exists(live.path)).toBe(true);
    expect(await readFile(join(onBranch, 'app.txt'), 'utf8')).toBe('uncommitted review notes\n');
    expect(await exists(join(operatorsClone, 'mine', 'app.txt'))).toBe(true);
    expect(await exists(detached.path)).toBe(true);
    expect(await exists(unrelated)).toBe(true);
    // The folder was never a party to any of it.
    expect(await git(repo, 'for-each-ref')).toBe(refs);
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(listed);

    await removeWorktree(live.path);
    await git(repo, 'worktree', 'remove', '--force', onBranch);
    await removeWorktree(detached.path);
  });

  it('removes its own scratch whatever shape the checkouts in it were left in', async () => {
    const scratchDir = await makeScratch(HARNESS_SCRATCH_PREFIX, tempRoot);
    // A run killed between the gitfile and the detached checkout: the mirror's
    // HEAD still names a branch, and the working tree holds only the gitfile.
    const halfMade = join(scratchDir, 'work');
    const halfMadeGitDir = join(scratchDir, 'git-work');
    await git(repo, 'clone', '-q', '--mirror', '--shared', '--', repo, halfMadeGitDir);
    await mkdir(halfMade);
    await writeFile(join(halfMade, '.git'), `gitdir: ${halfMadeGitDir}\n`);
    expect(await readFile(join(halfMadeGitDir, 'HEAD'), 'utf8')).toMatch(/^ref: /);
    // And a worktree an earlier executor added to the folder, whose git
    // directory is the folder's rather than one beside it.
    const stale = join(scratchDir, 'earlier');
    await git(repo, 'worktree', 'add', '--detach', stale);
    const refs = await git(repo, 'for-each-ref');

    expect(await removeOrphanedCheckouts(tempRoot)).toEqual({ checkouts: 2, scratchDirs: 1 });

    expect(await exists(scratchDir)).toBe(false);
    expect(await git(repo, 'for-each-ref')).toBe(refs);
    await git(repo, 'worktree', 'prune');
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(stale);
  });

  it("is what a crashed run's journal entry removes too, leaving nothing in the folder", async () => {
    const journal = openOrphanJournal(join(tempRoot, 'host'));
    const orphanScratch = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    await prepareWorktree(repo, orphanScratch, 'work');
    const listed = await git(repo, 'worktree', 'list', '--porcelain');
    recordSpawn(999_999, orphanScratch);

    reapOrphans(journal, () => undefined);

    expect(await exists(orphanScratch)).toBe(false);
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(listed);
    expect((await git(repo, 'worktree', 'list', '--porcelain')).includes('prunable')).toBe(false);
  });

  it('reports nothing when nothing was left behind', async () => {
    expect(await removeOrphanedCheckouts(tempRoot)).toEqual({ checkouts: 0, scratchDirs: 0 });
  });
});
