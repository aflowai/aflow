/**
 * Each of these is a way in that the checks around it did not cover. They are
 * grouped because they share one shape: a rule that was enforced at one point
 * and assumed everywhere else.
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertRootOutsideRepositoryMetadata,
  resolveWithin,
  type HostBinding,
} from '../bindings.js';
import {
  forgetSpawn,
  openOrphanJournal,
  readJournal,
  reapOrphans,
  recordSpawn,
} from '../orphans.js';
import { serializePolicy, writePolicyAtomically } from '../policyFile.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-r8-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function binding(over: Partial<HostBinding> & { root: string }): HostBinding {
  return {
    id: 'hb_test',
    mode: 'readwrite',
    allowsExecution: false,
    singleFile: false,
    spaceId: 'space-1',
    ...over,
  } as HostBinding;
}

describe('a binding root inside repository metadata', () => {
  it('is refused when the root is the .git directory itself', async () => {
    const git = join(dir, 'repo', '.git');
    await mkdir(git, { recursive: true });
    // Every containment check asks where a path lands RELATIVE to the root, so
    // a root that is already `.git` had nothing above it to be judged against.
    await expect(assertRootOutsideRepositoryMetadata('hb_x', git)).rejects.toThrow(/\.git/);
  });

  it('is refused for a single file inside it, which skipped the check entirely', async () => {
    const git = join(dir, 'repo', '.git');
    await mkdir(git, { recursive: true });
    await writeFile(join(git, 'config'), '[remote "origin"]\n\turl = https://token@host/r\n');

    const single = binding({ root: join(git, 'config'), singleFile: true, id: 'hb_cfg' });
    await expect(resolveWithin(single, 'config', true)).rejects.toThrow(/\.git/);
  });

  it('is refused when reached through a symlink, since the root is canonicalised', async () => {
    const git = join(dir, 'repo', '.git');
    await mkdir(git, { recursive: true });
    const link = join(dir, 'looks-ordinary');
    await symlink(git, link);
    await expect(assertRootOutsideRepositoryMetadata('hb_x', link)).rejects.toThrow(/\.git/);
  });

  it('leaves an ordinary repository root alone', async () => {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await expect(assertRootOutsideRepositoryMetadata('hb_ok', repo)).resolves.toBeUndefined();
  });
});

describe('the policy file is replaced, never rewritten in place', () => {
  it('leaves no readable window and no temporary behind', async () => {
    const policyPath = join(dir, 'host-policy.json');
    await writePolicyAtomically(policyPath, serializePolicy({ version: 1, bindings: [] }));

    const { mode } = await stat(policyPath);
    expect(mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(policyPath, 'utf8'))).toEqual({ version: 1, bindings: [] });
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the previous contents when the replacement cannot be written', async () => {
    const policyPath = join(dir, 'host-policy.json');
    await writePolicyAtomically(policyPath, serializePolicy({ version: 1, bindings: ['first'] }));
    // A directory that cannot be written to is the observable stand-in for any
    // interruption: what matters is that the old policy is still the one on disk.
    await expect(
      writePolicyAtomically(join(dir, 'nope', 'host-policy.json'), 'x'),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(policyPath, 'utf8')).bindings).toEqual(['first']);
  });
});

describe('the orphan journal names processes, and a pid is not a name', () => {
  it('does not signal a pid recorded before the process now holding it started', async () => {
    const path = openOrphanJournal(dir);
    // The pid-reuse case, made observable: a live process group, and a journal
    // entry claiming that pid was recorded long before this process began. That
    // is exactly what the operating system hands back after a pid wraps around,
    // and the old reap killed the group on the strength of the number alone.
    const victim = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    victim.unref();
    await once(victim, 'spawn');
    const pid = victim.pid;
    expect(pid).toBeDefined();

    writeJournal(path, [
      { pid, scratchDir: join(dir, 'scratch'), recordedAt: Date.now() - 86_400_000 },
    ]);
    expect(reapOrphans(path)).toBe(0);
    expect(alive(pid!)).toBe(true);

    // And it IS killed when the record is the one this executor actually wrote,
    // rather than a timestamp manufactured by the test — which is the path that
    // runs, and the one whose tolerance has to hold on a loaded machine.
    recordSpawn(pid!, join(dir, 'scratch'));
    expect(reapOrphans(path)).toBe(1);
    await until(() => !alive(pid!));
  });

  it('does not signal a pid that no longer exists', () => {
    const path = openOrphanJournal(dir);
    const gone = Number(
      execFileSync('bash', ['-c', 'sleep 0 & echo $!'], { encoding: 'utf8' }).trim(),
    );
    recordSpawn(gone, join(dir, 'scratch'));
    expect(reapOrphans(path)).toBe(0);
  });

  it('forgets one entry without losing the others', () => {
    const path = openOrphanJournal(dir);
    recordSpawn(4242, join(dir, 'a'));
    recordSpawn(4243, join(dir, 'b'));
    forgetSpawn(4242);
    expect(readJournal(path).map((r) => r.pid)).toEqual([4243]);
  });
});

function writeJournal(path: string, records: unknown[]): void {
  writeFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polled rather than slept on: the kill is asynchronous to this process. */
async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached');
}
