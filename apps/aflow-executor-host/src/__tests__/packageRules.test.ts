/**
 * Contract: a folder connected as a package of a repository is briefed with the
 * repository's rules as its top level is. The brief names the `CLAUDE.md` at the
 * top of the clone by its path from the folder the harness works in, and the
 * folder's own beside it when it has one.
 *
 * The spawn is stood in for and records the task it is handed.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';

const run = promisify(execFile);

const sandboxed: SandboxedRunInput[] = [];

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      sandboxed.push(input);
      return Promise.resolve({
        processId: 'hr_rules',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout: 'done',
        stderr: '',
        truncated: false,
      });
    },
  };
});

const { createHostHarnessHandler } = await import('../handlers/harnessHandlers.js');

const TOP_RULES =
  "The repository's own instructions are in `../../CLAUDE.md` at the top level of the " +
  'repository this folder is in; read them first and treat them as binding for every change.';

let base: string;
let top: string;
let folder: string;

async function git(...args: string[]): Promise<void> {
  await run('git', ['-C', top, ...args]);
}

async function commit(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(top, path, '..'), { recursive: true });
    await writeFile(join(top, path), text);
  }
  await git('add', '-A');
  await git('commit', '-qm', 'the base commit');
}

/** The task the harness was handed, from a commission on the connected package. */
async function briefOf(): Promise<string> {
  const policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb_package',
          root: folder,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-a',
        },
      ],
      harnesses: [{ id: 'agent', executable: '/bin/sh', args: ['-c', 'true'] }],
    }),
  );
  const result = await createHostHarnessHandler(policyPath).execute({
    operationId: 'host.harness.run',
    spaceId: 'space-a',
    runId: 'run-package-rules',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () =>
      Promise.resolve({ bindingId: 'hb_package', task: 'Fix it.', timeoutMs: 60_000 }),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (kind: string) => Promise.resolve(`inline:${kind}`),
  } as never);
  expect(result.status).toBe('SUCCEEDED');
  expect(sandboxed).toHaveLength(1);
  const argv = sandboxed[0]?.argv ?? [];
  const task = argv.find((arg) => arg.endsWith('Fix it.'));
  expect(task, argv.join(' ')).toBeDefined();
  return task ?? '';
}

beforeEach(async () => {
  sandboxed.length = 0;
  base = await realpath(await mkdtemp(join(tmpdir(), 'aflow-package-rules-')));
  top = join(base, 'mono');
  folder = join(top, 'packages', 'app');
  await mkdir(folder, { recursive: true });
  await git('init', '-q', '--initial-branch=main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('a package of a repository with a root CLAUDE.md, connected', () => {
  it("is briefed with the repository's rules, named by their path from the package", async () => {
    await commit({ 'CLAUDE.md': '# Rules\n', 'packages/app/index.js': '1;\n' });
    expect(await briefOf()).toBe(`${TOP_RULES}\n\nFix it.`);
  });

  it("is briefed with its own rules and the repository's, each where it is", async () => {
    await commit({
      'CLAUDE.md': '# Rules\n',
      'packages/app/CLAUDE.md': '# Package rules\n',
      'packages/app/index.js': '1;\n',
    });
    expect(await briefOf()).toBe(
      "The repository's own instructions are in `CLAUDE.md` in this folder and " +
        '`../../CLAUDE.md` at the top level of the repository this folder is in; read them ' +
        'first and treat them as binding for every change.\n\nFix it.',
    );
  });

  it('is briefed with none when the repository holds none', async () => {
    await commit({ 'packages/app/index.js': '1;\n' });
    expect(await briefOf()).toBe('Fix it.');
  });
});
