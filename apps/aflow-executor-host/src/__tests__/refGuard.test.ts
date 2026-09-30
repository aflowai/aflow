/**
 * Contract: a coding agent's git, run with the environment the executor gives
 * it, cannot create, delete or move a local branch or tag of the repository its
 * checkout shares refs with — and everything else a coding run does with git
 * still works.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

interface AgentOutcome {
  ok: boolean;
  stderr: string;
}

async function agentGitIn(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): Promise<AgentOutcome> {
  try {
    const { stderr } = await run('git', args, { cwd, env: { ...harnessEnv, ...env } });
    return { ok: true, stderr };
  } catch (error) {
    return { ok: false, stderr: String((error as { stderr?: unknown }).stderr ?? '') };
  }
}

async function agentGit(...args: string[]): Promise<AgentOutcome> {
  return await agentGitIn(checkout, {}, ...args);
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

  describe('however the path to the repository is spelled', () => {
    let elsewhere: string;

    beforeEach(async () => {
      elsewhere = await mkdtemp(join(tmpdir(), 'aflow-guard-elsewhere-'));
    });

    afterEach(async () => {
      await rm(elsewhere, { recursive: true, force: true });
    });

    interface Invocation {
      cwd: string;
      env?: Record<string, string>;
      args?: string[];
    }

    const spellings: [string, () => Promise<Invocation>][] = [
      ["the run's checkout", () => Promise.resolve({ cwd: checkout })],
      [
        "a subdirectory of the run's checkout",
        async () => {
          await mkdir(join(checkout, 'nested', 'deeper'), { recursive: true });
          return { cwd: join(checkout, 'nested', 'deeper') };
        },
      ],
      ["the folder's own checkout", () => Promise.resolve({ cwd: repo })],
      [
        'a relative GIT_DIR of ../.git',
        async () => {
          await mkdir(join(repo, 'nested'), { recursive: true });
          return { cwd: join(repo, 'nested'), env: { GIT_DIR: '../.git' } };
        },
      ],
      [
        '--git-dir',
        () => Promise.resolve({ cwd: elsewhere, args: [`--git-dir=${join(repo, '.git')}`] }),
      ],
      [
        'a symlink to the repository',
        async () => {
          await symlink(repo, join(elsewhere, 'linked'));
          return { cwd: join(elsewhere, 'linked') };
        },
      ],
      [
        "a GIT_DIR naming the checkout's entry under .git/worktrees",
        async () => {
          const gitDir = (await run('git', ['-C', checkout, 'rev-parse', '--absolute-git-dir']))
            .stdout;
          return { cwd: elsewhere, env: { GIT_DIR: gitDir.trim() } };
        },
      ],
      [
        'a relative GIT_DIR that begins with a dash',
        async () => {
          await symlink(join(repo, '.git'), join(elsewhere, '-P'));
          return { cwd: elsewhere, env: { GIT_DIR: '-P' } };
        },
      ],
      [
        'a CDPATH that holds another .git',
        async () => {
          await mkdir(join(elsewhere, '.git'));
          return { cwd: repo, env: { CDPATH: elsewhere } };
        },
      ],
    ];

    // A macOS volume keeps the letter case a path was typed with and answers
    // to any other, and the data volume is reachable under its firmlink too.
    const macSpellings: [string, () => Promise<Invocation>][] = [
      [
        'a GIT_DIR in a different letter case than the folder',
        async () => {
          const folder = await realpath(repo);
          const recased = join(dirname(folder), basename(folder).toUpperCase(), '.git');
          return { cwd: elsewhere, env: { GIT_DIR: recased } };
        },
      ],
      [
        'a GIT_DIR under the data volume firmlink',
        async () => ({
          cwd: elsewhere,
          env: { GIT_DIR: join('/System/Volumes/Data', await realpath(repo), '.git') },
        }),
      ],
    ];

    async function refusesThrough(arrange: () => Promise<Invocation>): Promise<void> {
      const { cwd, env = {}, args = [] } = await arrange();
      const before = await snapshotRefs(repo);
      const outcome = await agentGitIn(cwd, env, ...args, 'branch', 'planted');
      expect(outcome.ok).toBe(false);
      expect(outcome.stderr).toContain(`Refused \`refs/heads/planted\`: ${REFUSAL}`);
      expect(await snapshotRefs(repo)).toEqual(before);
    }

    it.each(spellings)('refuses through %s', async (_spelling, arrange) => {
      await refusesThrough(arrange);
    });

    it.runIf(process.platform === 'darwin').each(macSpellings)(
      'refuses through %s',
      async (_spelling, arrange) => {
        await refusesThrough(arrange);
      },
    );
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
