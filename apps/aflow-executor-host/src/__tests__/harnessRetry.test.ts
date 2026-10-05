/**
 * Contract (Plan 315 D21, F109): a retry of a harness run that was ended
 * part-way continues the coding agent's own conversation — resumed, as
 * `continueFrom` resumes one — in the checkout the interrupted attempt left,
 * rather than starting the brief again in a fresh one. Exercised against real
 * git; only the sandbox's spawn is stood in for, and the harness command runs.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';

const run = promisify(execFile);
const handed: SandboxedRunInput[] = [];
let interruptNext = false;

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
      // The turn did its work and was then ended under it — the executor
      // stopped, the machine slept past its ceiling — before it answered.
      if (interruptNext) {
        interruptNext = false;
        throw new Error('the turn was ended before it answered');
      }
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

// Finishes only where an earlier turn already did the first half, so a retry
// that started over in a fresh checkout would do the first half again.
const WORKS_IN_HALVES =
  "if [ -f half.txt ]; then printf 'whole\\n' > whole.txt; else printf 'half\\n' > half.txt; fi";

let base: string;
let project: string;
let policyPath: string;
beforeEach(async () => {
  handed.length = 0;
  interruptNext = false;
  base = await mkdtemp(join(tmpdir(), 'aflow-harness-retry-'));
  project = join(base, 'project');
  policyPath = join(base, 'host-policy.json');
  await run('git', ['init', '-q', '-b', 'main', project]);
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: project });
  await run('git', ['config', 'user.name', 'T'], { cwd: project });
  await writeFile(join(project, 'a.txt'), 'a\n');
  await run('git', ['add', '-A'], { cwd: project });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: project });
  const harness = (id: string) => ({
    id,
    executable: '/bin/sh',
    args: ['-c', WORKS_IN_HALVES],
    sessionArgs: ['--session', '{session}'],
    resumeArgs: ['--resume', '{session}'],
  });
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
      harnesses: [harness('converses'), harness('other')],
    }),
  );
});

afterEach(async () => {
  for (const session of allSessions()) {
    forgetSession(session.id);
    await removeWorktree(session.bindingRoot, session.worktreePath).catch(() => {});
    await discardScratch(session);
  }
  await rm(base, { recursive: true, force: true });
});

interface Attempt {
  readonly attempt: number;
  readonly logicalExecutionId?: string;
  readonly harness?: string;
}

async function attempt({
  attempt,
  logicalExecutionId = 'task:commission',
  harness = 'converses',
}: Attempt): Promise<{ status: string; output: Record<string, unknown> }> {
  const written: Record<string, unknown> = {};
  const result = await createHostHarnessHandler(policyPath).execute({
    operationId: 'host.harness.run',
    spaceId: 'space-test',
    runId: 'run-workflow',
    attempt,
    logicalExecutionId,
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () =>
      Promise.resolve({ bindingId: 'hb', harness, task: 'Do it in halves.', timeoutMs: 60_000 }),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (kind: string, data: unknown) => {
      written[kind] = data;
      return Promise.resolve(`inline:${kind}`);
    },
  } as never);
  return { status: result.status, output: (written['output'] ?? {}) as Record<string, unknown> };
}

const changedFiles = (patch: unknown): string[] =>
  [...String(patch).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1] ?? '');

/** The conversation a turn named, and whether it resumed it. */
function conversationOf(input: SandboxedRunInput | undefined): { flag: string; id: string } {
  const argv = input?.argv ?? [];
  const at = argv.findIndex((arg) => arg === '--session' || arg === '--resume');
  return { flag: argv[at] ?? '', id: argv[at + 1] ?? '' };
}

describe('a retry of an interrupted harness run', () => {
  it("continues the agent's own conversation in the checkout the attempt left", async () => {
    interruptNext = true;
    const first = await attempt({ attempt: 1 });
    expect(first.status).toBe('FAILED');

    const retried = await attempt({ attempt: 2 });

    expect(retried.status).toBe('SUCCEEDED');
    const [interrupted, retry] = handed;
    expect(conversationOf(interrupted).flag).toBe('--session');
    expect(conversationOf(retry)).toEqual({
      flag: '--resume',
      id: conversationOf(interrupted).id,
    });
    expect(retry?.cwd).toBe(interrupted?.cwd);
    expect(retry?.argv.join(' ')).toContain('An earlier attempt at this task ended');
    expect(retry?.argv.join(' ')).toContain('Do it in halves.');
    expect(retried.output['continued']).toBe(true);
    expect(retried.output['sessionRef']).toBe(allSessions()[0]?.id);
    // The interrupted attempt's half and the retry's, in one change.
    expect(changedFiles(retried.output['patch']).sort()).toEqual(['half.txt', 'whole.txt']);
  }, 60_000);

  it('starts other work afresh, and a first attempt never inherits a session', async () => {
    interruptNext = true;
    await attempt({ attempt: 1 });

    const otherWork = await attempt({ attempt: 2, logicalExecutionId: 'task:another' });
    const redelivered = await attempt({ attempt: 1 });

    for (const fresh of [otherWork, redelivered]) {
      expect(fresh.status).toBe('SUCCEEDED');
      expect(fresh.output['continued']).toBe(false);
      expect(changedFiles(fresh.output['patch'])).toEqual(['half.txt']);
    }
    expect(conversationOf(handed[1]).flag).toBe('--session');
    expect(handed[1]?.cwd).not.toBe(handed[0]?.cwd);
  }, 60_000);

  it('starts afresh when the retry names another harness', async () => {
    interruptNext = true;
    await attempt({ attempt: 1 });

    const retried = await attempt({ attempt: 2, harness: 'other' });

    expect(retried.status).toBe('SUCCEEDED');
    expect(retried.output['continued']).toBe(false);
    expect(conversationOf(handed[1]).flag).toBe('--session');
    expect(changedFiles(retried.output['patch'])).toEqual(['half.txt']);
  }, 60_000);
});
