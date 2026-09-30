/**
 * Contract: a diff is taken whole, or the folder is left as it was.
 *
 * Exercised against real git, including diffs built to reach outside the
 * binding — a patch is a third way to write files and gets the same gate.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PayloadAccessError } from '@aflow/executor-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHostPatchHandler } from '../handlers/patchHandlers.js';
import { INLINE_DIFF_CAP_BYTES } from '../worktree.js';

const run = promisify(execFile);

let base: string;
let root: string;
let policyPath: string;

interface Captured {
  output?: Record<string, unknown>;
}

function contextFor(input: unknown, captured: Captured): never {
  return {
    operationId: 'host.file.patch',
    spaceId: 'space-test',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve(input),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data as Record<string, unknown>;
      return Promise.resolve('inline:out');
    },
  } as never;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout;
}

/** A diff produced the way a harness produces one: edit a checkout, read it back. */
async function diffFor(mutate: (dir: string) => Promise<void>, at = 'HEAD'): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), 'aflow-diffsrc-'));
  await git(root, 'worktree', 'add', '--detach', work, at);
  await mutate(work);
  await git(work, 'add', '-A');
  const patch = await git(work, 'diff', '--cached');
  await git(root, 'worktree', 'remove', '--force', work);
  return patch;
}

/**
 * A global git config of this test's own, so nothing here reads the identity the
 * machine running it happens to have configured.
 */
async function withGlobalConfig<T>(contents: string, body: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'aflow-gitconfig-'));
  const path = join(home, '.gitconfig');
  await writeFile(path, contents);
  const previous = process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_GLOBAL'] = path;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-patch-'));
  root = join(base, 'project');
  await run('git', ['init', '-q', '--initial-branch=main', root]);
  await git(root, 'config', 'user.email', 't@e.com');
  await git(root, 'config', 'user.name', 'T');
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-m', 'initial');

  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root,
          mode: 'readwrite',
          allowsExecution: false,
          singleFile: false,
          spaceId: 'space-test',
        },
        {
          id: 'hb_read',
          root,
          mode: 'read',
          allowsExecution: false,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('applying a patch', () => {
  it('takes a diff that still fits', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('applied');
    expect(captured.output?.['filesChanged']).toBe(1);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toContain('EDITED');
  });

  it('changes nothing when the diff no longer fits', async () => {
    // "whole or not at all" — the property that makes an applied patch
    // reviewable, since a partial one is a state nobody looked at.
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nFROM PATCH\nthree\n');
    });
    await writeFile(join(root, 'a.txt'), 'one\nMOVED ON\nthree\n');
    await git(root, 'commit', '-am', 'operator edit');

    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('conflict');
    expect(captured.output?.['filesChanged']).toBe(0);
    expect(String(captured.output?.['detail'] ?? '')).toContain('a.txt');
    // Untouched.
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toContain('MOVED ON');
  });

  it('still applies when the folder moved on elsewhere', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });
    await writeFile(join(root, 'b.txt'), 'unrelated\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-m', 'unrelated');

    const captured: Captured = {};
    await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch }, captured),
    );
    expect(captured.output?.['state']).toBe('applied');
  });

  it('adds a file the diff creates', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'brand-new.ts'), 'export const x = 1;\n');
    });
    const captured: Captured = {};
    await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch }, captured),
    );
    expect(captured.output?.['state']).toBe('applied');
    expect(captured.output?.['files']).toEqual(['brand-new.ts']);
    expect(await readFile(join(root, 'brand-new.ts'), 'utf8')).toContain('export const x');
  });

  it('calls an empty diff empty', async () => {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch: '\n' }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('empty');
  });
});

describe('a patch is not a way around the binding', () => {
  it('refuses a diff that plants a hook, which would run unconfined', async () => {
    // The whole reason `.git` is unreachable: git executes what is there, as
    // the operator, on the next checkout — which every coding run performs.
    const patch = [
      'diff --git a/.git/hooks/post-checkout b/.git/hooks/post-checkout',
      'new file mode 100755',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/.git/hooks/post-checkout',
      '@@ -0,0 +1,2 @@',
      '+#!/bin/sh',
      '+echo pwned',
      '',
    ].join('\n');
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch }, captured),
    );
    expect(result.status).toBe('FAILED');
    await expect(readFile(join(root, '.git', 'hooks', 'post-checkout'), 'utf8')).rejects.toThrow();
  });

  it('refuses a diff that climbs out of the binding', async () => {
    const patch = [
      'diff --git a/../../escaped.txt b/../../escaped.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/../../escaped.txt',
      '@@ -0,0 +1 @@',
      '+escaped',
      '',
    ].join('\n');
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch }, captured),
    );
    expect(result.status).toBe('FAILED');
    await expect(readFile(join(base, 'escaped.txt'), 'utf8')).rejects.toThrow();
  });

  it('refuses a read-only binding rather than writing to it', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb_read', patch }, captured),
    );
    expect(result.status).toBe('FAILED');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).not.toContain('EDITED');
  });

  it('refuses an unknown binding', async () => {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'nope', patch: 'diff --git a/x b/x\n' }, captured),
    );
    expect(result.status).toBe('FAILED');
  });

  it('rejects something that is not a diff instead of guessing', async () => {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch: 'this is not a diff at all\n' }, captured),
    );
    expect(result.status).toBe('FAILED');
  });
});

describe('generation and publication stay separate', () => {
  it('the host lane has no operation that pushes, commits or branches', async () => {
    // Producing a change and publishing it are separate decisions. A step that
    // could do both would collapse them, and the collapse is the risk.
    const { getOperationsByStepType } = await import('@aflow/schemas');
    const ids = [...getOperationsByStepType('host').keys()];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => /\.(push|commit|publish|merge)$/i.test(id))).toBe(false);
  });
});

describe('what a diff touches is established from git, for every diff form', () => {
  it('sees a rename source, which git deletes and numstat never names', async () => {
    // A gate reading only the destination would let `rename from .git/config`
    // through, leaving git's own refusal as the single thing standing in the
    // way — which is what this gate exists not to depend on.
    const { patchPaths } = await import('../worktree.js');
    await writeFile(join(root, 'orig.txt'), 'aaa\nbbb\nccc\nddd\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-m', 'add orig');

    const work = await mkdtemp(join(tmpdir(), 'aflow-ren-'));
    await git(root, 'worktree', 'add', '--detach', work, 'HEAD');
    await git(work, 'mv', 'orig.txt', 'moved.txt');
    await git(work, 'add', '-A');
    const patch = await git(work, 'diff', '--cached', '-M');
    await git(root, 'worktree', 'remove', '--force', work);

    const paths = await patchPaths(root, patch);
    expect(paths).toContain('orig.txt');
    expect(paths).toContain('moved.txt');
  });

  it('reads a filename containing a tab as one name', async () => {
    const { patchPaths } = await import('../worktree.js');
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'has\ttab.txt'), 'content\n');
    });
    expect(await patchPaths(root, patch)).toEqual(['has\ttab.txt']);
  });

  it('does not mistake a file named in digits for a column of numbers', async () => {
    // The old filter dropped it, so a diff touching only `2026` reported
    // "empty" and applied nothing — a silent no-op on a real change.
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, '2026'), 'a year is a fine name for a file\n');
    });
    const captured: Captured = {};
    await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch }, captured),
    );
    expect(captured.output?.['state']).toBe('applied');
    expect(captured.output?.['files']).toEqual(['2026']);
    expect(await readFile(join(root, '2026'), 'utf8')).toContain('a year');
  });
});

describe('a conflicted merge says what it actually did', () => {
  it('names the conflicted files and reports that the tree changed', async () => {
    // `git apply --3way` writes the tree, reports `U <path>` on stdout and
    // exits non-zero. Reading only stderr reported no conflicts and no changed
    // files over a working copy that now carried markers.
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nFROM PATCH\nthree\n');
    });
    await writeFile(join(root, 'a.txt'), 'one\nOPERATOR MOVED IT\nthree\n');
    await git(root, 'commit', '-am', 'operator edit');

    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch, mode: 'merge' }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('conflict');
    expect(captured.output?.['conflicts']).toEqual(['a.txt']);
    // The tree really was written, and the report says so.
    expect(captured.output?.['filesChanged']).toBe(1);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toContain('<<<<<<<');
  });

  it('leaves a clean-mode failure reporting no change, because there was none', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nFROM PATCH\nthree\n');
    });
    const before = 'one\nSTILL MINE\nthree\n';
    await writeFile(join(root, 'a.txt'), before);
    await git(root, 'commit', '-am', 'operator edit');

    const captured: Captured = {};
    await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch, mode: 'clean' }, captured),
    );
    expect(captured.output?.['state']).toBe('conflict');
    expect(captured.output?.['filesChanged']).toBe(0);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(before);
  });
});

describe('landing a patch as a commit on a new branch', () => {
  it('leaves the operator checkout exactly as it was', async () => {
    // The whole reason this mode exists: the operator is a second writer, and
    // a publication must not need their working tree, index or branch.
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });
    const headBefore = (await git(root, 'rev-parse', 'HEAD')).trim();
    const branchBefore = (await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();

    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor(
        { bindingId: 'hb', patch, commit: { branch: 'aflow/x', message: 'the change' } },
        captured,
      ),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('applied');
    expect(captured.output?.['files']).toEqual(['a.txt']);
    expect(captured.output?.['filesChanged']).toBe(1);

    const commit = captured.output?.['commit'] as Record<string, string> | undefined;
    expect(commit?.['branch']).toBe('aflow/x');
    expect(commit?.['message']).toBe('the change');
    expect(commit?.['baseSha']).toBe(headBefore);
    expect((await git(root, 'rev-parse', 'aflow/x')).trim()).toBe(commit?.['sha']);
    expect((await git(root, 'rev-parse', 'aflow/x^')).trim()).toBe(headBefore);
    expect(await git(root, 'show', 'aflow/x:a.txt')).toContain('EDITED');
    expect((await git(root, 'log', '-1', '--format=%s', 'aflow/x')).trim()).toBe('the change');

    // Untouched: same HEAD, same branch, nothing modified or left behind.
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(headBefore);
    expect((await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe(branchBefore);
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).not.toContain('EDITED');
    expect((await git(root, 'worktree', 'list')).split('\n').filter((l) => l !== '')).toHaveLength(
      1,
    );
  }, 30_000);

  it('reports the message as git recorded it, which is what an approval shows', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor(
        {
          bindingId: 'hb',
          patch,
          commit: { branch: 'aflow/x', message: '\nThe change   \n\n\nWhy it matters.\n\n' },
        },
        captured,
      ),
    );
    expect(result.status).toBe('SUCCEEDED');
    const commit = captured.output?.['commit'] as Record<string, string> | undefined;
    expect(commit?.['message']).toBe('The change\n\nWhy it matters.');
    expect((await git(root, 'log', '-1', '--format=%B', 'aflow/x')).replace(/\n+$/, '')).toBe(
      commit?.['message'],
    );
  }, 30_000);

  it('refuses to move a branch that already exists when no base is named', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });
    await git(root, 'branch', 'aflow/taken');
    const taken = (await git(root, 'rev-parse', 'aflow/taken')).trim();

    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor(
        { bindingId: 'hb', patch, commit: { branch: 'aflow/taken', message: 'the change' } },
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    // Refused before a checkout is made, naming the branch and the two ways
    // out: an apply that reached git and failed there says something else.
    expect(result.error?.message ?? '').toContain('aflow/taken');
    expect(result.error?.message ?? '').toContain('`baseSha`');
    expect(result.error?.message ?? '').toContain('new branch name');
    expect((await git(root, 'rev-parse', 'aflow/taken')).trim()).toBe(taken);
  }, 30_000);

  it('makes no branch when the diff no longer fits', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nFROM PATCH\nthree\n');
    });
    await writeFile(join(root, 'a.txt'), 'one\nMOVED ON\nthree\n');
    await git(root, 'commit', '-am', 'operator edit');

    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor(
        { bindingId: 'hb', patch, commit: { branch: 'aflow/x', message: 'the change' } },
        captured,
      ),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('conflict');
    expect(captured.output?.['filesChanged']).toBe(0);
    expect(captured.output?.['commit']).toBeUndefined();
    await expect(git(root, 'rev-parse', 'aflow/x')).rejects.toThrow();
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  }, 30_000);

  it("takes the operator's global identity when the repository names none", async () => {
    // Almost no repository carries a local identity, and the operator's own
    // lives in their global config. Reading two strings from it is not the risk
    // withholding that file addresses.
    await git(root, 'config', '--unset', 'user.email');
    await git(root, 'config', '--unset', 'user.name');
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });

    const captured: Captured = {};
    const result = await withGlobalConfig(
      '[user]\n\tname = Global Operator\n\temail = global@example.com\n',
      async () =>
        await createHostPatchHandler(policyPath).execute(
          contextFor(
            { bindingId: 'hb', patch, commit: { branch: 'aflow/x', message: 'the change' } },
            captured,
          ),
        ),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('applied');
    expect((await git(root, 'log', '-1', '--format=%an <%ae>', 'aflow/x')).trim()).toBe(
      'Global Operator <global@example.com>',
    );
  }, 30_000);

  it('names both remedies when nothing configures an identity', async () => {
    // A commit carries the operator's name. Making one up would put this lane's
    // guess into their history, so something has to say who they are.
    await git(root, 'config', '--unset', 'user.email');
    await git(root, 'config', '--unset', 'user.name');
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });

    const captured: Captured = {};
    const result = await withGlobalConfig(
      '',
      async () =>
        await createHostPatchHandler(policyPath).execute(
          contextFor(
            { bindingId: 'hb', patch, commit: { branch: 'aflow/x', message: 'the change' } },
            captured,
          ),
        ),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('user.email');
    expect(result.error?.message ?? '').toContain('globally');
    await expect(git(root, 'rev-parse', 'aflow/x')).rejects.toThrow();
  }, 30_000);
});

describe('appending a patch to the branch it was made on', () => {
  /** A branch one commit ahead of main, made the way an operator makes one. */
  async function reviewedBranch(): Promise<string> {
    await git(root, 'checkout', '-q', '-b', 'feat/fix');
    await writeFile(join(root, 'b.txt'), 'reviewed\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-m', 'the reviewed change');
    await git(root, 'checkout', '-q', 'main');
    return (await git(root, 'rev-parse', 'feat/fix')).trim();
  }

  async function publish(commit: Record<string, string>, patch: string) {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch, commit: { message: 'the fix', ...commit } }, captured),
    );
    return { result, captured };
  }

  it('advances the branch by one commit on its old head, leaving the checkout alone', async () => {
    const reviewed = await reviewedBranch();
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'b.txt'), 'reviewed and fixed\n');
    }, 'feat/fix');
    const mainBefore = (await git(root, 'rev-parse', 'main')).trim();

    const { result, captured } = await publish({ branch: 'feat/fix', baseSha: reviewed }, patch);
    expect(result.status).toBe('SUCCEEDED');
    const commit = captured.output?.['commit'] as Record<string, unknown> | undefined;
    expect(commit?.['appended']).toBe(true);
    expect(commit?.['baseSha']).toBe(reviewed);
    expect((await git(root, 'rev-parse', 'feat/fix')).trim()).toBe(commit?.['sha']);
    expect((await git(root, 'rev-parse', 'feat/fix^')).trim()).toBe(reviewed);
    expect(await git(root, 'show', 'feat/fix:b.txt')).toBe('reviewed and fixed\n');

    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(mainBefore);
    expect((await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main');
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
    expect((await git(root, 'worktree', 'list')).split('\n').filter((l) => l !== '')).toHaveLength(
      1,
    );
  }, 30_000);

  it('takes the base as a sha, abbreviated or whole, and never as a branch name', async () => {
    const reviewed = await reviewedBranch();
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'b.txt'), 'fixed\n');
    }, 'feat/fix');

    // The branch's own name would resolve to its head and always pass the
    // stale-base check, so the schema refuses it before anything is read.
    const named = await publish({ branch: 'feat/fix', baseSha: 'feat/fix' }, patch);
    expect(named.result.status).toBe('FAILED');
    expect(named.result.error?.message ?? '').toContain('not a branch or tag name');
    expect((await git(root, 'rev-parse', 'feat/fix')).trim()).toBe(reviewed);

    const { result, captured } = await publish(
      { branch: 'feat/fix', baseSha: reviewed.slice(0, 12) },
      patch,
    );
    expect(result.status).toBe('SUCCEEDED');
    const commit = captured.output?.['commit'] as Record<string, unknown>;
    expect(commit['appended']).toBe(true);
    expect(commit['baseSha']).toBe(reviewed);
  }, 30_000);

  it('reads a hex base as a sha even where a branch carries that name', async () => {
    const reviewed = await reviewedBranch();
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'b.txt'), 'fixed\n');
    }, 'feat/fix');
    // A branch named like a sha, pointing at the head of the target branch:
    // read as a ref, it would make any base look current.
    await git(root, 'branch', 'deadbeef', 'feat/fix');

    const { result } = await publish({ branch: 'feat/fix', baseSha: 'deadbeef' }, patch);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('`deadbeef` names no commit');
    expect((await git(root, 'rev-parse', 'feat/fix')).trim()).toBe(reviewed);
  }, 30_000);

  it('refuses an append onto a branch that moved since the patch was made', async () => {
    const reviewed = await reviewedBranch();
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'b.txt'), 'fixed\n');
    }, 'feat/fix');
    await git(root, 'checkout', '-q', 'feat/fix');
    await writeFile(join(root, 'c.txt'), 'someone else\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-m', 'moved on');
    await git(root, 'checkout', '-q', 'main');
    const moved = (await git(root, 'rev-parse', 'feat/fix')).trim();

    const { result } = await publish({ branch: 'feat/fix', baseSha: reviewed }, patch);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain(`\`${reviewed}\``);
    expect(result.error?.message ?? '').toContain(`\`feat/fix\` is at \`${moved}\``);
    expect((await git(root, 'rev-parse', 'feat/fix')).trim()).toBe(moved);
  }, 30_000);

  /** A repository the folder has as `origin`, one commit ahead of the folder's main. */
  async function upstreamAhead(): Promise<string> {
    const upstream = join(base, 'upstream');
    await run('git', ['clone', '-q', root, upstream]);
    await writeFile(join(upstream, 'c.txt'), 'merged upstream\n');
    await git(upstream, 'add', '-A');
    await git(upstream, '-c', 'user.email=u@e.com', '-c', 'user.name=U', 'commit', '-m', 'ahead');
    await git(root, 'remote', 'add', 'origin', upstream);
    return (await git(upstream, 'rev-parse', 'HEAD')).trim();
  }

  it("starts a new branch at a base behind the folder's HEAD", async () => {
    const behind = (await git(root, 'rev-parse', 'HEAD')).trim();
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nFIXED\nthree\n');
    });
    await writeFile(join(root, 'd.txt'), 'the operator moved on\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-m', 'moved on');
    const head = (await git(root, 'rev-parse', 'HEAD')).trim();

    const { result, captured } = await publish({ branch: 'aflow/fresh', baseSha: behind }, patch);
    expect(result.status).toBe('SUCCEEDED');
    const commit = captured.output?.['commit'] as Record<string, unknown>;
    expect(commit['appended']).toBe(false);
    expect(commit['baseSha']).toBe(behind);
    expect((await git(root, 'rev-parse', 'aflow/fresh^')).trim()).toBe(behind);
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(head);
  }, 30_000);

  it("starts a new branch at a fetched remote commit ahead of the folder's HEAD", async () => {
    const ahead = await upstreamAhead();
    await git(root, 'fetch', '-q', 'origin');
    const head = (await git(root, 'rev-parse', 'HEAD')).trim();
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'c.txt'), 'merged upstream, then fixed\n');
    }, 'origin/main');

    const { result, captured } = await publish({ branch: 'aflow/fresh', baseSha: ahead }, patch);
    expect(result.status).toBe('SUCCEEDED');
    const commit = captured.output?.['commit'] as Record<string, unknown>;
    expect(commit['baseSha']).toBe(ahead);
    expect((await git(root, 'rev-parse', 'aflow/fresh^')).trim()).toBe(ahead);
    expect(await git(root, 'show', 'aflow/fresh:c.txt')).toBe('merged upstream, then fixed\n');
    expect((await git(root, 'rev-parse', 'HEAD')).trim()).toBe(head);
    expect((await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main');
  }, 30_000);

  it('refuses a new branch at a base the folder does not have, naming it', async () => {
    const ahead = await upstreamAhead();
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nFIXED\nthree\n');
    });

    const { result } = await publish({ branch: 'aflow/fresh', baseSha: ahead }, patch);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain(`\`${ahead}\` names no commit`);
    await expect(git(root, 'rev-parse', '--verify', 'aflow/fresh')).rejects.toThrow();
  }, 30_000);

  it('refuses an unknown base before any checkout is made', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nEDITED\nthree\n');
    });
    const { result } = await publish({ branch: 'aflow/x', baseSha: '0123456789abc' }, patch);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('`0123456789abc` names no commit');
    await expect(git(root, 'rev-parse', '--verify', 'aflow/x')).rejects.toThrow();
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
    expect((await git(root, 'worktree', 'list')).split('\n').filter((l) => l !== '')).toHaveLength(
      1,
    );
  }, 30_000);

  it('refuses to advance a branch some checkout has open', async () => {
    await reviewedBranch();
    await git(root, 'checkout', '-q', 'feat/fix');
    const reviewed = (await git(root, 'rev-parse', 'HEAD')).trim();
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'b.txt'), 'fixed\n');
    });

    const { result } = await publish({ branch: 'feat/fix', baseSha: reviewed }, patch);
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('is checked out in');
    expect((await git(root, 'rev-parse', 'feat/fix')).trim()).toBe(reviewed);
  }, 30_000);
});

describe("a commission's diff taken by reference", () => {
  const REF = 'gs://file-store/tenants/t_1/runs/r_1/steps/s_1/attempt/1/patch.json';

  /** The job's input at its own ref, and every other ref read from `stored`. */
  function contextWithStore(
    input: unknown,
    stored: ReadonlyMap<string, unknown>,
    captured: Captured,
  ): never {
    return {
      ...(contextFor(input, captured) as object),
      readPayload: (ref: string) => {
        if (ref === 'inline:x') return Promise.resolve(input);
        if (!stored.has(ref)) return Promise.reject(new Error(`Payload not found: ${ref}`));
        return Promise.resolve(stored.get(ref));
      },
    } as never;
  }

  it('applies the diff the ref names to the working tree', async () => {
    const patch = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nBY REFERENCE\nthree\n');
    });
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextWithStore({ bindingId: 'hb', patchRef: REF }, new Map([[REF, patch]]), captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('applied');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toContain('BY REFERENCE');
  });

  it('commits a diff past the inline cap whole', async () => {
    const lines = Array.from(
      { length: 60_000 },
      (_, i) => `line ${String(i)} of a change larger than any inline copy of it`,
    );
    const body = `${lines.join('\n')}\n`;
    const work = await mkdtemp(join(tmpdir(), 'aflow-diffsrc-'));
    await git(root, 'worktree', 'add', '--detach', work, 'HEAD');
    await writeFile(join(work, 'large.txt'), body);
    await git(work, 'add', '-A');
    const { stdout: patch } = await run('git', ['-C', work, 'diff', '--cached'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    await git(root, 'worktree', 'remove', '--force', work);
    expect(Buffer.byteLength(patch, 'utf8')).toBeGreaterThan(INLINE_DIFF_CAP_BYTES);

    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextWithStore(
        { bindingId: 'hb', patchRef: REF, commit: { branch: 'aflow/large', message: 'large' } },
        new Map([[REF, patch]]),
        captured,
      ),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['state']).toBe('applied');
    const { stdout: committed } = await run('git', ['-C', root, 'show', 'aflow/large:large.txt'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(committed).toBe(body);
  }, 60_000);

  it('refuses a call naming neither, saying which to pass', async () => {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb' }, captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('`patchRef` for the change a commission');
  });

  it('refuses a call naming both, since they would be two diffs', async () => {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patch: 'diff --git a/x b/x\n', patchRef: REF }, captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('not both');
  });

  it('refuses a ref that names nothing, and says how to get a fresh one', async () => {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextWithStore({ bindingId: 'hb', patchRef: REF }, new Map(), captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.classification).toBe('validation');
    expect(result.error?.message ?? '').toContain('Commission the change again');
  });

  it('refuses a ref to something that is not a diff', async () => {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextWithStore(
        { bindingId: 'hb', patchRef: REF },
        new Map([[REF, { state: 'applied' }]]),
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('not a diff');
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  });

  it('refuses a ref to text of another kind before git sees it', async () => {
    const output = REF.replace(/patch\.json$/, 'output.json');
    const diff = await diffFor(async (d) => {
      await writeFile(join(d, 'a.txt'), 'one\nNOT A PATCH KIND\nthree\n');
    });
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextWithStore({ bindingId: 'hb', patchRef: output }, new Map([[output, diff]]), captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.classification).toBe('validation');
    expect(result.error?.message ?? '').toContain('not a diff');
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  });

  it('refuses a stored patch whose text does not open like a diff', async () => {
    const captured: Captured = {};
    const result = await createHostPatchHandler(policyPath).execute(
      contextWithStore(
        { bindingId: 'hb', patchRef: REF },
        new Map([[REF, 'the harness said it fixed the parser\n']]),
        captured,
      ),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('`patchRef` names a payload that is not a diff');
    expect(result.error?.message ?? '').not.toContain('git');
    expect((await git(root, 'status', '--porcelain')).trim()).toBe('');
  });

  it('refuses an inline ref, which carries the bytes rather than naming them', async () => {
    const captured: Captured = {};
    const inline = `inline:${Buffer.from(JSON.stringify('diff --git a/x b/x\n')).toString('base64')}`;
    const result = await createHostPatchHandler(policyPath).execute(
      contextFor({ bindingId: 'hb', patchRef: inline }, captured),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.message ?? '').toContain('A stored reference only');
  });

  it("refuses a ref to another tenant's payload as a permission, not a missing diff", async () => {
    const captured: Captured = {};
    const context = {
      ...(contextFor({ bindingId: 'hb', patchRef: REF }, captured) as object),
      readPayload: (ref: string) =>
        ref === 'inline:x'
          ? Promise.resolve({ bindingId: 'hb', patchRef: REF })
          : Promise.reject(
              new PayloadAccessError('Payload reference belongs to another tenant.', {}),
            ),
    } as never;
    const result = await createHostPatchHandler(policyPath).execute(context);
    expect(result.status).toBe('FAILED');
    expect(result.error?.classification).toBe('permission');
  });
});
