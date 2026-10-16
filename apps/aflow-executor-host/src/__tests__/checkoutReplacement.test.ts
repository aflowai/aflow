/**
 * Contract: a run cannot put something else in place of its checkout.
 *
 * The executor runs git on a run's checkout outside the sandbox, naming the
 * working tree outright, and git takes a link there as readily as a directory.
 * A checkout replaced by a link to `~/.ssh` would have its contents staged into
 * the run's diff and a merge written into it, as the operator. Two things
 * stand in the way: the sandbox is never handed the directory holding the
 * checkout, so a job cannot replace it; and every git the executor runs on a
 * checkout first finds it the real directory that was made, so a replacement
 * made any other way is refused rather than followed.
 */
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeIntoCheckout } from '../baseMerge.js';
import { HostBindingSchema } from '../bindings.js';
import { makeAgentScratch, makeScratch } from '../executorScratch.js';
import { runSandboxed, sandboxAvailable } from '../sandboxedRun.js';
import { collectChanges, isRealDirectory, prepareWorktree } from '../worktree.js';
import { CONFINEMENT_LISTENERS, requires } from './fixtures/capabilities.js';

const confined = requires(...CONFINEMENT_LISTENERS);

const run = promisify(execFile);

/** What every git the executor would have run there says instead. */
const REFUSAL = /is no longer the directory made for it, so git was not run in it/;

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

let base: string;
let repo: string;
let scratch: string;
/** What a link would lead the executor's git into: the operator's keys, say. */
let keys: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout.trim();
}

async function contentsOf(dir: string): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    contents[name] = await readFile(join(dir, name), 'utf8');
  }
  return contents;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-checkout-replaced-'));
  repo = join(base, 'repo');
  keys = join(base, 'keys');
  await mkdir(join(repo, 'packages', 'app'), { recursive: true });
  await mkdir(keys);
  await writeFile(join(keys, 'id_ed25519'), 'PRIVATE KEY\n');
  await git(repo, 'init', '-q', '--initial-branch=main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), 'base\n');
  await writeFile(join(repo, 'packages', 'app', 'index.txt'), 'app\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'base');
  scratch = await makeScratch('aflow-harness-', base);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("a run's checkout replaced by a link", () => {
  it.skipIf(!sandboxAvailable() || confined.skip)(
    confined.title('cannot be made from inside the sandbox a run is handed'),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
      const wt = await prepareWorktree(repo, scratch, 'work', { dependencies: 'none' });
      const agentScratch = await makeAgentScratch(scratch);
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
          String.raw`rm -rf "$1"; mv "$1" "$1.moved"; ln -s "$2" "$1" && echo REPLACED; rm -rf "$3"; ln -s "$2" "$3" && echo GIT_DIR_REPLACED; exit 0`,
          'sh',
          wt.path,
          keys,
          wt.gitDir,
        ],
        cwd: agentScratch,
        env: {},
        timeoutMs: 60_000,
        // As a commission is handed them: its own scratch, and the checkout.
        scratchDir: agentScratch,
        widening: {
          authPaths: [],
          allowedDomains: [],
          writableRoot: wt.workDir,
          gitDir: wt.gitDir,
          withholdBindingWrite: true,
        },
        idPrefix: 'rp',
        ownerRunId: 'probe',
        closeStdin: true,
        signal: new AbortController().signal,
        onDelta: () => undefined,
      });

      // It ran, and every attempt was refused.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('REPLACED');
      expect(await isRealDirectory(wt.path)).toBe(true);
      expect(await realpath(wt.path)).toBe(wt.path);
      expect(await isRealDirectory(wt.gitDir)).toBe(true);
      await expect(lstat(`${wt.path}.moved`)).rejects.toThrow();
      // Its files were the run's to delete, and the executor's git still reads it.
      await expect(collectChanges(wt)).resolves.toMatchObject({ overCeiling: false });
      expect(await contentsOf(keys)).toEqual({ id_ed25519: 'PRIVATE KEY\n' });
    },
  );

  it('made from outside the sandbox, is refused by collection and by a merge', async () => {
    await git(repo, 'checkout', '-qb', 'moved');
    await writeFile(join(repo, 'README.md'), 'moved\n');
    await writeFile(join(repo, 'planted'), 'written by the merge\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'moved');
    const moved = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', '-q', 'main');

    const wt = await prepareWorktree(repo, scratch, 'work', { dependencies: 'none' });
    await expect(collectChanges(wt)).resolves.toMatchObject({ filesChanged: 0 });

    await rm(wt.path, { recursive: true, force: true });
    await symlink(keys, wt.path);

    await expect(collectChanges(wt)).rejects.toThrow(REFUSAL);
    await expect(mergeIntoCheckout(wt, moved, IDENTITY)).rejects.toMatchObject({
      name: 'WorktreeError',
      kind: 'checkout_replaced',
    });
    expect(await contentsOf(keys)).toEqual({ id_ed25519: 'PRIVATE KEY\n' });
    expect(await git(wt.gitDir, 'rev-parse', 'HEAD')).not.toBe(moved);
  });

  it("made at the folder's place inside the clone, is refused the same way", async () => {
    const wt = await prepareWorktree(join(repo, 'packages', 'app'), scratch, 'work', {
      dependencies: 'none',
    });
    expect(wt.workDir).toBe(join(wt.path, 'packages', 'app'));

    await rm(wt.workDir, { recursive: true, force: true });
    await symlink(keys, wt.workDir);

    await expect(collectChanges(wt)).rejects.toThrow(REFUSAL);
    expect(await contentsOf(keys)).toEqual({ id_ed25519: 'PRIVATE KEY\n' });
  });
});
