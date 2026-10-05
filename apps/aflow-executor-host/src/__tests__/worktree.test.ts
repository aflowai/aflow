import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import {
  changedRefs,
  checkApplies,
  collectChanges,
  fetchRemoteBase,
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
      expect((await collectChanges(wt.path)).filesChanged).toBe(0);
      await removeWorktree(repo, wt.path);
    }
  });

  it("leaves the run's own scratch out of the change", async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    await mkdir(join(wt.path, '.aflow'), { recursive: true });
    await writeFile(join(wt.path, '.aflow', 'change.patch'), 'a copy of the work\n');
    await writeFile(join(wt.path, 'app.txt'), 'edited\n');

    const changes = await collectChanges(wt.path);
    expect(changes.filesChanged).toBe(1);
    expect(changes.patch).toContain('app.txt');
    expect(changes.patch).not.toContain('.aflow');
    expect(changes.patch).not.toContain('a copy of the work');
    await removeWorktree(repo, wt.path);
  });

  it('leaves out a tracked file under the scratch directory too', async () => {
    await mkdir(join(repo, '.aflow'), { recursive: true });
    await writeFile(join(repo, '.aflow', 'notes.md'), 'tracked\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'tracked scratch');
    const wt = await prepareWorktree(repo, scratch, 'work');
    await writeFile(join(wt.path, '.aflow', 'notes.md'), 'rewritten by the agent\n');

    const changes = await collectChanges(wt.path);
    expect(changes).toEqual({ patch: '', filesChanged: 0, overCeiling: false });
    await removeWorktree(repo, wt.path);
  });

  it('reports no change as no change, not as an empty diff of something', async () => {
    const wt = await prepareWorktree(repo, scratch, 'work');
    const changes = await collectChanges(wt.path);
    expect(changes).toEqual({ patch: '', filesChanged: 0, overCeiling: false });
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
    const { patch } = await collectChanges(wt.path);
    await removeWorktree(repo, wt.path);

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
    const orphanScratch = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    await prepareWorktree(repo, orphanScratch, 'work');
    const orphanPublication = await mkdtemp(join(tempRoot, PUBLICATION_SCRATCH_PREFIX));
    await prepareWorktree(repo, orphanPublication, 'commit', { dependencies: 'none' });
    // A checkout whose directory is already gone is still registered.
    const vanishedScratch = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    await prepareWorktree(repo, vanishedScratch, 'work');
    await rm(vanishedScratch, { recursive: true, force: true });
    const stray = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    const liveScratch = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    const live = await prepareWorktree(repo, liveScratch, 'work');
    recordSession({
      id: 'hs_live',
      ownerRunId: 'run-live',
      logicalExecutionId: 'step:hs_live',
      bindingId: 'hb',
      bindingRoot: repo,
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
    // The operator's own checkouts in the same temp root: one on a branch with
    // work in progress, in a directory named the way this executor names its
    // scratch, and one detached, in a directory it never makes.
    const operatorsScratch = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    const onBranch = join(operatorsScratch, 'mine');
    await git(repo, 'worktree', 'add', '-b', 'operator/review', onBranch);
    await writeFile(join(onBranch, 'app.txt'), 'uncommitted review notes\n');
    const operatorsDetached = await mkdtemp(join(tempRoot, 'aflow-review-'));
    const detached = await prepareWorktree(repo, operatorsDetached, 'mine');
    const unrelated = await mkdtemp(join(tempRoot, 'not-ours-'));

    const outcome = await removeOrphanedCheckouts([repo, repo, scratch], tempRoot);

    expect(outcome.removed).toEqual(new Map([[repo, 3]]));
    expect(outcome.scratchDirs).toBe(3);
    const listed = await git(repo, 'worktree', 'list', '--porcelain');
    // By directory name: git records a checkout under its resolved path.
    expect(listed).not.toContain(basename(orphanScratch));
    expect(listed).not.toContain(basename(orphanPublication));
    expect(listed).not.toContain(basename(vanishedScratch));
    expect(listed).toContain(basename(liveScratch));
    expect(listed).toContain(basename(operatorsScratch));
    expect(listed).toContain('branch refs/heads/operator/review');
    expect(listed).toContain(basename(operatorsDetached));
    expect(await exists(orphanScratch)).toBe(false);
    expect(await exists(orphanPublication)).toBe(false);
    expect(await exists(stray)).toBe(false);
    expect(await exists(live.path)).toBe(true);
    expect(await readFile(join(onBranch, 'app.txt'), 'utf8')).toBe('uncommitted review notes\n');
    expect(await exists(detached.path)).toBe(true);
    expect(await exists(unrelated)).toBe(true);

    await removeWorktree(repo, live.path);
    await removeWorktree(repo, onBranch);
    await removeWorktree(repo, detached.path);
  });

  it('takes nothing when the connected folders could not be read', async () => {
    const orphanScratch = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    const orphan = await prepareWorktree(repo, orphanScratch, 'work');

    const outcome = await removeOrphanedCheckouts(undefined, tempRoot);

    expect(outcome.removed.size).toBe(0);
    expect(outcome.scratchDirs).toBe(0);
    expect(await exists(orphan.path)).toBe(true);
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toContain(basename(orphanScratch));

    await removeWorktree(repo, orphan.path);
  });

  it('leaves scratch whose checkout a folder it could not read still registers', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'wt-unbound-'));
    await git(elsewhere, 'init', '--initial-branch=main');
    await git(elsewhere, 'config', 'user.email', 'test@example.com');
    await git(elsewhere, 'config', 'user.name', 'Test');
    await git(elsewhere, 'commit', '--allow-empty', '-m', 'initial');
    const orphanScratch = await mkdtemp(join(tempRoot, HARNESS_SCRATCH_PREFIX));
    const orphan = await prepareWorktree(elsewhere, orphanScratch, 'work', {
      dependencies: 'none',
    });

    const outcome = await removeOrphanedCheckouts([repo], tempRoot);

    expect(outcome.scratchDirs).toBe(0);
    expect(await exists(orphan.path)).toBe(true);

    await removeWorktree(elsewhere, orphan.path);
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('reports nothing when nothing was left behind', async () => {
    const outcome = await removeOrphanedCheckouts([repo], tempRoot);
    expect(outcome.removed.size).toBe(0);
    expect(outcome.scratchDirs).toBe(0);
  });
});
