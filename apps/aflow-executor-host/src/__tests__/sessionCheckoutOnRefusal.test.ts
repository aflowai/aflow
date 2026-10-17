/**
 * Contract: a turn that names a new base on a folder the executor refuses
 * leaves its session as it found it — the session's checkout in place, holding
 * the earlier turn's work, and the session held for the next turn to continue.
 *
 * Such a turn moves the session to a fresh checkout, removing the one it had,
 * so everything that can refuse the folder is asked before that removal. A
 * refusal after it would leave a session naming a checkout that no longer
 * exists. The refusal here is the folder's alternates chain running deeper
 * than a clone of it reads.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';

const run = promisify(execFile);
const handed: SandboxedRunInput[] = [];

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: async (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      handed.push(input);
      const [program, ...args] = input.argv;
      const { stdout, stderr } = await run(program ?? '', args, {
        cwd: input.cwd,
        env: { PATH: process.env['PATH'] ?? '', ...input.env, ...input.trustedEnv },
      });
      return {
        processId: 'hr_test',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout,
        stderr,
        truncated: false,
      };
    },
  };
});

const { createHostHarnessHandler } = await import('../handlers/harnessHandlers.js');
const { allSessions, discardScratch, forgetSession } = await import('../harnessSessions.js');
const { removeWorktree } = await import('../worktree.js');

let base: string;
let project: string;
let policyPath: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout;
}

beforeEach(async () => {
  handed.length = 0;
  base = await realpath(await mkdtemp(join(tmpdir(), 'aflow-session-refusal-')));
  project = join(base, 'project');
  policyPath = join(base, 'host-policy.json');
  await run('git', ['init', '-q', '-b', 'main', project]);
  await git(project, 'config', 'user.email', 't@e.com');
  await git(project, 'config', 'user.name', 'T');
  await writeFile(join(project, 'a.txt'), 'one\n');
  await git(project, 'add', '-A');
  await git(project, 'commit', '-q', '-m', 'initial');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root: project,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
      harnesses: [
        {
          id: 'converses',
          executable: '/bin/sh',
          args: ['-c', "printf 'turn\\n' >> work.txt"],
          sessionArgs: ['{session}'],
          resumeArgs: ['{session}'],
        },
      ],
    }),
  );
});

afterEach(async () => {
  for (const session of allSessions()) {
    forgetSession(session.id);
    await removeWorktree(session.worktreePath).catch(() => {});
    await discardScratch(session);
  }
  await rm(base, { recursive: true, force: true });
});

interface Outcome {
  readonly status: string;
  readonly message: string;
  readonly output: Record<string, unknown>;
}

async function commission(input: Record<string, unknown>): Promise<Outcome> {
  const written: Record<string, unknown> = {};
  const result = await createHostHarnessHandler(policyPath).execute({
    operationId: 'host.harness.run',
    spaceId: 'space-test',
    runId: 'run-session-refusal',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () =>
      Promise.resolve({
        bindingId: 'hb',
        harness: 'converses',
        task: 'Fix it.',
        timeoutMs: 60_000,
        ...input,
      }),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (kind: string, data: unknown) => {
      written[kind] = data;
      return Promise.resolve(`inline:${kind}`);
    },
  } as never);
  const error = written['error'] as { message?: string } | undefined;
  return {
    status: result.status,
    message: error?.message ?? result.error?.message ?? '',
    output: (written['output'] ?? {}) as Record<string, unknown>,
  };
}

/**
 * Makes the folder's store borrow through one level of `info/alternates` more
 * than a clone of it reads, every store along the chain existing and new.
 * Resolves to what undoes it.
 */
async function borrowTooDeep(): Promise<() => Promise<void>> {
  const objects = join(project, '.git', 'objects');
  let borrower = objects;
  for (let level = 0; level < 6; level += 1) {
    const store = join(base, `store-${String(level)}`);
    await mkdir(join(store, 'info'), { recursive: true });
    await writeFile(join(borrower, 'info', 'alternates'), `${store}\n`);
    borrower = store;
  }
  return () => rm(join(objects, 'info', 'alternates'), { force: true });
}

describe('a turn naming a new base on a folder the alternates check refuses', () => {
  it("leaves the session's checkout in place and the session held for the next turn", async () => {
    const first = await commission({ base: 'main' });
    expect(first.status).toBe('SUCCEEDED');
    const sessionRef = String(first.output['sessionRef']);
    const [held] = allSessions();
    expect(held?.id).toBe(sessionRef);
    const checkout = held?.worktreePath ?? '';
    const checkouts = await git(project, 'worktree', 'list', '--porcelain');

    const undo = await borrowTooDeep();
    const refused = await commission({ continueFrom: sessionRef, base: 'main' });
    expect(refused.status).toBe('FAILED');
    expect(refused.message).toContain(
      'borrows through more levels of `objects/info/alternates` than git follows',
    );
    expect(handed).toHaveLength(1);

    expect(await readFile(join(checkout, 'work.txt'), 'utf8')).toBe('turn\n');
    expect(await git(project, 'worktree', 'list', '--porcelain')).toBe(checkouts);
    expect(allSessions()).toEqual([
      expect.objectContaining({ id: sessionRef, worktreePath: checkout, busy: false }),
    ]);

    await undo();
    const next = await commission({ continueFrom: sessionRef });
    expect(next.status).toBe('SUCCEEDED');
    expect(next.output['continued']).toBe(true);
    expect(await readFile(join(checkout, 'work.txt'), 'utf8')).toBe('turn\nturn\n');
  }, 60_000);
});
