/**
 * Contract: a folder connected inside a repository under the operator's home
 * works inside the run, not only from outside it.
 *
 * Home is denied as a region and re-allowed a path at a time. The clone of
 * such a folder owns no object — it borrows every one from the repository's
 * store, at `<top>/.git/objects` — and its mirrored top-level installation
 * leads into `<top>/node_modules`. Both are outside the folder and under home,
 * so the run reads them only because the sandbox is told to. A linked worktree
 * is a top level whose store is the main repository's, outside it, and is told
 * the same.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostBindingSchema, type HostBinding } from '../bindings.js';
import { runFolderChecks } from '../commitCheck.js';
import { makeAgentScratch, makeScratch } from '../executorScratch.js';
import { runSandboxed, sandboxAvailable } from '../sandboxedRun.js';
import { checkoutWidening } from '../sandboxPolicy.js';
import { borrowedReads, prepareWorktree, removeWorktree } from '../worktree.js';
import { CONFINEMENT_LISTENERS, requires } from './fixtures/capabilities.js';

const confined = requires(...CONFINEMENT_LISTENERS);

const run = promisify(execFile);

const HOISTED = 'hoisted from the top level';

/** Reads HEAD's commit through the clone, then resolves a hoisted package. */
const PROBE = [
  '/bin/sh',
  '-c',
  `git log -1 --format=%s; "${process.execPath}" -e 'console.log(require("hoisted"))'`,
];

let base: string;
let home: string;
let top: string;
let folder: string;
let previousHome: string | undefined;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout.trim();
}

function bindingOf(root: string): HostBinding {
  return HostBindingSchema.parse({
    id: 'hb',
    root,
    mode: 'readwrite',
    allowsExecution: true,
    sandbox: 'confined',
  });
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'aflow-subdir-boundary-')));
  home = join(base, 'home');
  top = join(home, 'projects', 'mono');
  folder = join(top, 'packages', 'app');
  await mkdir(folder, { recursive: true });
  await git(top, 'init', '-q', '--initial-branch=main');
  await git(top, 'config', 'user.email', 'test@example.com');
  await git(top, 'config', 'user.name', 'Test');
  await writeFile(join(top, '.gitignore'), 'node_modules\n');
  await writeFile(join(folder, 'index.js'), 'module.exports = 1;\n');
  await git(top, 'add', '-A');
  await git(top, 'commit', '-qm', 'the base commit');
  // Installed at the top level, as a workspace hoists it.
  await mkdir(join(top, 'node_modules', 'hoisted'), { recursive: true });
  await writeFile(
    join(top, 'node_modules', 'hoisted', 'package.json'),
    '{"name":"hoisted","main":"index.js"}\n',
  );
  await writeFile(
    join(top, 'node_modules', 'hoisted', 'index.js'),
    `module.exports = ${JSON.stringify(HOISTED)};\n`,
  );
  // The sandbox denies the home it is compiled with, which is read from here.
  previousHome = process.env['HOME'];
  process.env['HOME'] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  await rm(base, { recursive: true, force: true });
});

describe('a folder connected inside a repository under a denied home', () => {
  it('borrows the repository’s object store and the installation above it', async () => {
    expect(await borrowedReads(folder)).toEqual([
      join(top, '.git', 'objects'),
      join(top, 'node_modules'),
    ]);
    expect(await borrowedReads(top)).toEqual([]);
  });

  it('borrows each installation on the way up from a folder below the scan’s depth', async () => {
    const deep = join(top, 'packages', 'group', 'pkg', 'lib');
    await mkdir(deep, { recursive: true });
    await mkdir(join(top, 'packages', 'group', 'pkg', 'node_modules'), { recursive: true });
    expect(await borrowedReads(deep)).toEqual([
      join(top, '.git', 'objects'),
      join(top, 'node_modules'),
      join(top, 'packages', 'group', 'pkg', 'node_modules'),
    ]);
  });

  it.skipIf(!sandboxAvailable() || confined.skip)(
    confined.title('reads its history and resolves a hoisted package inside the run'),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
      const sha = await git(top, 'rev-parse', 'HEAD');
      const checked = await runFolderChecks({
        binding: bindingOf(folder),
        argv: PROBE,
        timeoutMs: 60_000,
        sha,
        base: sha,
        toolPaths: [],
        ownerRunId: 'probe',
        signal: new AbortController().signal,
      });

      expect(checked.output).toContain('the base commit');
      expect(checked.output).toContain(HOISTED);
      expect(checked.result.exitCode).toBe(0);
    },
  );

  it.skipIf(!sandboxAvailable() || confined.skip)(
    confined.title('reads neither without them, so the home is denied indeed'),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
      const scratch = await makeScratch('aflow-check-', base);
      const agentScratch = await makeAgentScratch(scratch);
      const wt = await prepareWorktree(folder, scratch, 'check');
      try {
        const result = await runSandboxed({
          binding: bindingOf(folder),
          argv: PROBE,
          cwd: wt.workDir,
          env: {},
          timeoutMs: 60_000,
          scratchDir: agentScratch,
          widening: { authPaths: [], allowedDomains: [], ...checkoutWidening(wt, []) },
          idPrefix: 'sb',
          ownerRunId: 'probe',
          closeStdin: true,
          signal: new AbortController().signal,
          onDelta: () => undefined,
        });

        expect(result.stdout).not.toContain('the base commit');
        expect(result.stdout).not.toContain(HOISTED);
      } finally {
        await removeWorktree(wt.path);
      }
    },
  );
});

describe('a linked worktree connected under a denied home', () => {
  // A top level whose object store is the main repository's, outside it.
  let linked: string;

  beforeEach(async () => {
    linked = join(home, 'worktrees', 'mono');
    await git(top, 'worktree', 'add', '-q', '--detach', linked);
  });

  it('borrows the main repository’s object store', async () => {
    expect(await borrowedReads(linked)).toEqual([join(top, '.git', 'objects')]);
  });

  it.skipIf(!sandboxAvailable() || confined.skip)(
    confined.title('reads its history inside the run'),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
      const sha = await git(linked, 'rev-parse', 'HEAD');
      const checked = await runFolderChecks({
        binding: bindingOf(linked),
        argv: ['/bin/sh', '-c', 'git log -1 --format=%s'],
        timeoutMs: 60_000,
        sha,
        base: sha,
        toolPaths: [],
        ownerRunId: 'probe',
        signal: new AbortController().signal,
      });

      expect(checked.output).toContain('the base commit');
      expect(checked.result.exitCode).toBe(0);
    },
  );
});
