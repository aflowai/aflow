/**
 * Contract: a coding agent's git, run with the environment the executor gives
 * it, cannot create, delete or move a local branch or tag of the repository its
 * checkout shares refs with — and everything else a coding run does with git
 * still works.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBaseEnv, workloadHome } from '../baseEnv.js';
import {
  installRefGuard,
  noRefGuardMessage,
  parseGitVersion,
  refGuardMissing,
  refGuardReadiness,
} from '../refGuard.js';
import { prepareWorktree, removeWorktree, snapshotRefs } from '../worktree.js';

const run = promisify(execFile);

let repo: string;
let scratch: string;
let checkout: string;
let harnessEnv: Record<string, string>;

async function operatorGit(...args: string[]): Promise<string> {
  return (await run('git', ['-C', repo, ...args])).stdout.trim();
}

async function agentGit(...args: string[]): Promise<{ ok: boolean; stderr: string }> {
  try {
    const { stderr } = await run('git', args, { cwd: checkout, env: harnessEnv });
    return { ok: true, stderr };
  } catch (error) {
    return { ok: false, stderr: String((error as { stderr?: unknown }).stderr ?? '') };
  }
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'aflow-guard-repo-'));
  scratch = await mkdtemp(join(tmpdir(), 'aflow-guard-scratch-'));
  await operatorGit('init', '--initial-branch=main');
  await operatorGit('config', 'user.email', 'test@example.com');
  await operatorGit('config', 'user.name', 'Test');
  await writeFile(join(repo, 'app.txt'), 'committed\n');
  await operatorGit('add', '-A');
  await operatorGit('commit', '-m', 'initial');
  await operatorGit('branch', 'other');
  checkout = (await prepareWorktree(repo, scratch, 'work', { dependencies: 'none' })).path;
  await mkdir(workloadHome(scratch), { recursive: true });
  // What the harness process is given: the confined base environment, the
  // same global- and system-config withholding the lane's own git uses, and
  // the guard on top.
  harnessEnv = {
    ...buildBaseEnv(scratch),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...(await installRefGuard(scratch, repo)),
  };
});

afterEach(async () => {
  await removeWorktree(repo, checkout);
  await rm(repo, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

const REFUSAL = 'a commission may not move branches or tags';

describe("the agent's git cannot move a branch or a tag", () => {
  it.each([
    ['branch planted', 'refs/heads/planted'],
    ['tag planted', 'refs/tags/planted'],
    ['update-ref refs/heads/planted HEAD', 'refs/heads/planted'],
    ['branch -D other', 'refs/heads/other'],
  ])('refuses `git %s`, naming the ref', async (command, ref) => {
    const before = await snapshotRefs(repo);
    const outcome = await agentGit(...command.split(' '));
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain(`Refused \`${ref}\`: ${REFUSAL}`);
    expect(await snapshotRefs(repo)).toEqual(before);
  });

  it('holds when the repository names a hooks path of its own', async () => {
    await operatorGit('config', 'core.hooksPath', '.githooks');
    const outcome = await agentGit('branch', 'planted');
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain(REFUSAL);
  });

  it("refuses in the folder's own checkout as well as the run's", async () => {
    const outcome = await agentGit('-C', repo, 'branch', 'planted');
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain(`Refused \`refs/heads/planted\`: ${REFUSAL}`);
  });

  it('leaves the same command to the operator, whose git carries no guard', async () => {
    await operatorGit('branch', 'planted');
    expect((await snapshotRefs(repo)).has('refs/heads/planted')).toBe(true);
  });
});

describe('what a coding run does with git still works', () => {
  it('commits on the detached HEAD', async () => {
    await writeFile(join(checkout, 'app.txt'), 'edited\n');
    expect((await agentGit('commit', '-am', 'work')).ok).toBe(true);
  });

  it('stashes', async () => {
    await writeFile(join(checkout, 'app.txt'), 'in progress\n');
    expect((await agentGit('stash')).ok).toBe(true);
  });

  it('moves a remote-tracking ref', async () => {
    expect((await agentGit('update-ref', 'refs/remotes/origin/x', 'HEAD')).ok).toBe(true);
  });

  it('creates and commits in a repository of its own, as a test suite does', async () => {
    const own = await mkdtemp(join(tmpdir(), 'aflow-guard-own-'));
    try {
      await writeFile(join(own, 'fixture.txt'), 'fixture\n');
      for (const args of [
        ['init', '--initial-branch=main'],
        ['add', '-A'],
        ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture'],
        ['branch', 'feature'],
        ['tag', 'v1'],
      ]) {
        const outcome = await agentGit('-C', own, ...args);
        expect(outcome, `git ${args.join(' ')}`).toMatchObject({ ok: true });
      }
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });
});

describe('the git a commission needs', () => {
  it('reads the version however the build spells it', () => {
    expect(parseGitVersion('git version 2.52.0\n')).toEqual({ major: 2, minor: 52, patch: 0 });
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual({
      major: 2,
      minor: 39,
      patch: 5,
    });
    expect(parseGitVersion('git version 2.45.1.windows.1')).toEqual({
      major: 2,
      minor: 45,
      patch: 1,
    });
    expect(parseGitVersion('not git')).toBeUndefined();
  });

  it('names the version found and the version needed below the floor', () => {
    expect(refGuardMissing('git version 2.28.0')).toEqual([]);
    expect(refGuardMissing('git version 3.0.0')).toEqual([]);
    const [missing] = refGuardMissing('git version 2.27.1');
    expect(missing).toContain('git 2.28 or later');
    expect(missing).toContain('this machine has 2.27.1');
    expect(refGuardMissing(undefined)).toHaveLength(1);
    expect(refGuardMissing('something else')[0]).toContain('`something else`');
  });

  it('refuses in the shape of the sandbox refusal, carrying what is missing', () => {
    const message = noRefGuardMessage(refGuardMissing('git version 2.20.1'));
    expect(message).toContain('cannot stop a coding agent');
    expect(message).toContain('Missing: git 2.28 or later — this machine has 2.20.1');
  });

  it('finds this machine ready', async () => {
    expect(await refGuardReadiness()).toEqual({ ready: true, missing: [] });
  });
});
