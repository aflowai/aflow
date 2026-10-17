/**
 * Contract (Plan 315 F121): a kept session is owned by the conversation that
 * started the run that made it. A second run that conversation starts
 * continues the coding agent's own conversation in the checkout the first one
 * left; a run another conversation started is refused with the text a session
 * that never existed gets; a run no conversation started owns its sessions
 * itself, so its own tasks share one and no other run does. A retry continues
 * only the session its own run made, though every commission a conversation
 * starts is the same task. Exercised against real git; only the sandbox's
 * spawn is stood in for, and the harness command runs.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// Finishes only where an earlier turn already did the first half, so a turn
// that started over in a fresh checkout would do the first half again.
const WORKS_IN_HALVES =
  "if [ -f half.txt ]; then printf 'whole\\n' > whole.txt; else printf 'half\\n' > half.txt; fi";

const CONVERSATION = '00000000-0000-4000-8000-0000000000c1';
const OTHER_CONVERSATION = '00000000-0000-4000-8000-0000000000c2';

let base: string;
let project: string;
let policyPath: string;

async function git(...args: string[]): Promise<void> {
  await run('git', [`--git-dir=${join(project, '.git')}`, `--work-tree=${project}`, ...args]);
}

beforeEach(async () => {
  handed.length = 0;
  interruptNext = false;
  base = await mkdtemp(join(tmpdir(), 'aflow-harness-owner-'));
  project = join(base, 'project');
  policyPath = join(base, 'host-policy.json');
  await mkdir(project);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 't@e.com');
  await git('config', 'user.name', 'T');
  await writeFile(join(project, 'a.txt'), 'a\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
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
          args: ['-c', WORKS_IN_HALVES],
          sessionArgs: ['--session', '{session}'],
          resumeArgs: ['--resume', '{session}'],
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

interface Commission {
  readonly runId: string;
  readonly conversation?: string;
  readonly continueFrom?: string;
  readonly attempt?: number;
  readonly logicalExecutionId?: string;
}

interface Outcome {
  readonly status: string;
  readonly output: Record<string, unknown>;
  readonly message: string;
}

async function commission({
  runId,
  conversation,
  continueFrom,
  attempt = 1,
  logicalExecutionId = 'task:commission',
}: Commission): Promise<Outcome> {
  const written: Record<string, unknown> = {};
  const result = await createHostHarnessHandler(policyPath).execute({
    operationId: 'host.harness.run',
    spaceId: 'space-test',
    runId,
    ...(conversation !== undefined ? { startingConversationId: conversation } : {}),
    attempt,
    logicalExecutionId,
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () =>
      Promise.resolve({
        bindingId: 'hb',
        harness: 'converses',
        task: 'Do it in halves.',
        timeoutMs: 60_000,
        ...(continueFrom !== undefined ? { continueFrom } : {}),
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
    output: (written['output'] ?? {}) as Record<string, unknown>,
    message: error?.message ?? '',
  };
}

const changedFiles = (patch: unknown): string[] =>
  [...String(patch).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1] ?? '');

/** The conversation a turn named, and whether it resumed it. */
function conversationOf(input: SandboxedRunInput | undefined): { flag: string; id: string } {
  const argv = input?.argv ?? [];
  const at = argv.findIndex((arg) => arg === '--session' || arg === '--resume');
  return { flag: argv[at] ?? '', id: argv[at + 1] ?? '' };
}

describe('a session kept for a conversation', () => {
  it('is continued by a second run the same conversation started', async () => {
    const first = await commission({ runId: 'run-first', conversation: CONVERSATION });
    expect(first.status).toBe('SUCCEEDED');
    const sessionRef = String(first.output['sessionRef']);

    const fix = await commission({
      runId: 'run-fix',
      conversation: CONVERSATION,
      continueFrom: sessionRef,
    });

    expect(fix.status).toBe('SUCCEEDED');
    expect(fix.output['continued']).toBe(true);
    expect(fix.output['sessionRef']).toBe(sessionRef);
    const [made, continued] = handed;
    expect(conversationOf(made).flag).toBe('--session');
    expect(conversationOf(continued)).toEqual({ flag: '--resume', id: conversationOf(made).id });
    expect(continued?.cwd).toBe(made?.cwd);
    expect(changedFiles(fix.output['patch']).sort()).toEqual(['half.txt', 'whole.txt']);
  }, 60_000);

  it('is refused to a run another conversation started, as a session never made is', async () => {
    const first = await commission({ runId: 'run-first', conversation: CONVERSATION });
    const sessionRef = String(first.output['sessionRef']);

    const elsewhere = await commission({
      runId: 'run-elsewhere',
      conversation: OTHER_CONVERSATION,
      continueFrom: sessionRef,
    });
    const neverMade = await commission({
      runId: 'run-elsewhere',
      conversation: OTHER_CONVERSATION,
      continueFrom: 'hs_never_made',
    });

    expect(elsewhere.status).toBe('FAILED');
    expect(elsewhere.message.replace(sessionRef, '<ref>')).toBe(
      neverMade.message.replace('hs_never_made', '<ref>'),
    );
    expect(handed).toHaveLength(1);
    // Refused, not taken: the conversation that owns it still continues it.
    const fix = await commission({
      runId: 'run-fix',
      conversation: CONVERSATION,
      continueFrom: sessionRef,
    });
    expect(fix.output['continued']).toBe(true);
  }, 60_000);
});

describe('a session kept for a run no conversation started', () => {
  it("is continued by the run's own later task and refused to any other run", async () => {
    const first = await commission({ runId: 'run-unstarted' });
    const sessionRef = String(first.output['sessionRef']);

    const otherRun = await commission({ runId: 'run-another', continueFrom: sessionRef });
    const ownTask = await commission({
      runId: 'run-unstarted',
      continueFrom: sessionRef,
      logicalExecutionId: 'task:fix',
    });

    expect(otherRun.status).toBe('FAILED');
    expect(otherRun.message).toContain(`No session \`${sessionRef}\` is held for this run.`);
    expect(ownTask.status).toBe('SUCCEEDED');
    expect(ownTask.output['continued']).toBe(true);
    expect(changedFiles(ownTask.output['patch']).sort()).toEqual(['half.txt', 'whole.txt']);
  }, 60_000);

  it('is refused to a run a conversation started', async () => {
    const first = await commission({ runId: 'run-unstarted' });
    const sessionRef = String(first.output['sessionRef']);

    const fromConversation = await commission({
      runId: 'run-conversation',
      conversation: CONVERSATION,
      continueFrom: sessionRef,
    });

    expect(fromConversation.status).toBe('FAILED');
    expect(handed).toHaveLength(1);
  }, 60_000);
});

describe('a retry in a conversation that started several runs', () => {
  it("continues its own run's session, never an earlier run's of the same task", async () => {
    await commission({ runId: 'run-first', conversation: CONVERSATION });

    interruptNext = true;
    const interrupted = await commission({ runId: 'run-second', conversation: CONVERSATION });
    expect(interrupted.status).toBe('FAILED');
    const retried = await commission({
      runId: 'run-second',
      conversation: CONVERSATION,
      attempt: 2,
    });
    const coldRetry = await commission({
      runId: 'run-third',
      conversation: CONVERSATION,
      attempt: 2,
    });

    const [first, second, retry, cold] = handed;
    expect(retried.output['continued']).toBe(true);
    expect(retry?.cwd).toBe(second?.cwd);
    expect(conversationOf(retry)).toEqual({ flag: '--resume', id: conversationOf(second).id });
    expect(coldRetry.output['continued']).toBe(false);
    expect(conversationOf(cold).flag).toBe('--session');
    expect([first?.cwd, second?.cwd]).not.toContain(cold?.cwd);
    expect(changedFiles(coldRetry.output['patch'])).toEqual(['half.txt']);
  }, 60_000);
});
