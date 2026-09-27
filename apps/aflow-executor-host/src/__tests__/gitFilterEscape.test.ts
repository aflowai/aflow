/**
 * A filter is a program git runs, and the repository gets to choose it.
 *
 * `core.hooksPath` stops hooks and `protocol.ext.allow` stops transport
 * helpers, which is what the safety arguments were written for. Neither touches
 * `filter.<name>.smudge`, `.clean` or `.process`. A filter is *selected* by
 * `.gitattributes` — a working-tree file a harness may write — and *defined* in
 * config. Both `worktree add` and `git add -A` apply them, and they run here, in
 * the executor, outside the sandbox and with the operator's PATH.
 *
 * The proof is a filter that leaves evidence: if the command ever runs, the file
 * it writes exists.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectChanges, prepareWorktree, removeWorktree } from '../worktree.js';

const run = promisify(execFile);

let base: string;
let repo: string;
let scratch: string;
let fakeHome: string;
let evidence: string;
let realHome: string | undefined;

/** Git as the operator has it configured — global config and all. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', ['-C', cwd, ...args], { env: { ...process.env, HOME: fakeHome } });
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-filter-'));
  repo = join(base, 'repo');
  scratch = join(base, 'scratch');
  fakeHome = join(base, 'home');
  evidence = join(base, 'THE-FILTER-RAN');
  await mkdir(repo, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await mkdir(fakeHome, { recursive: true });

  // The operator's own global config, defining a filter — exactly how git-lfs
  // and friends are installed.
  const script = join(base, 'evil-filter.sh');
  await writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(evidence)}\ncat\n`);
  await chmod(script, 0o755);
  await writeFile(
    join(fakeHome, '.gitconfig'),
    `[user]\n\tname = T\n\temail = t@e.com\n[filter "pwn"]\n\tsmudge = ${script}\n\tclean = ${script}\n`,
  );

  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.email', 't@e.com');
  await git(repo, 'config', 'user.name', 'T');
  // Selected by the working tree, which is what a harness can write.
  await writeFile(join(repo, '.gitattributes'), '* filter=pwn\n');
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'initial');

  // The lane's own git reads `HOME` from this process — that is how it finds
  // the operator's global config, and therefore the filter defined in it. The
  // whole point of the test is that it looks there.
  realHome = process.env['HOME'];
  process.env['HOME'] = fakeHome;
}, 30_000);

afterEach(async () => {
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  await rm(base, { recursive: true, force: true });
});

describe('a filter the repository selects', () => {
  it('does not run when this lane checks a worktree out or stages it', async () => {
    // Sanity: the filter is real and this git would run it. Without that, the
    // test could pass because nothing was configured at all.
    await git(repo, 'checkout', '--', '.');
    expect(existsSync(evidence)).toBe(true);
    await rm(evidence, { force: true });

    const worktree = await prepareWorktree(repo, scratch, 'run-filter');
    await writeFile(join(worktree.path, 'b.txt'), 'added by the harness\n');
    await collectChanges(worktree.path);
    await removeWorktree(repo, worktree.path);

    // `worktree add` checked out every file and `git add -A` staged them. If
    // the filter had been reachable it would have run several times over.
    expect(existsSync(evidence)).toBe(false);
  }, 30_000);
});
