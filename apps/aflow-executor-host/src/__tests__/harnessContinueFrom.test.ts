/**
 * Contract: a commission naming a session it cannot continue is told the rule
 * that decides which sessions it can — a kept session is owned by the run that
 * made it, and every commission is a new run — and nothing about the session it
 * named. Another run's session gets the answer a session that never existed
 * gets, so the refusal confirms nothing, and it guesses at no expiry or restart
 * that did not happen.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: () => Promise.reject(new Error('a refused commission runs nothing')),
  };
});

const { createHostHarnessHandler } = await import('../handlers/harnessHandlers.js');
const { forgetSession, recordSession } = await import('../harnessSessions.js');

const OTHER_RUNS = 'hs_other_run';

let base: string;
let policyPath: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-harness-continue-'));
  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root: base,
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
          args: ['-c', 'true'],
          sessionArgs: ['--session', '{session}'],
          resumeArgs: ['--resume', '{session}'],
        },
      ],
    }),
  );
  // Made by another commission, on the same folder and harness, and live.
  recordSession({
    id: OTHER_RUNS,
    ownerRunId: 'run-earlier-commission',
    logicalExecutionId: 'task:commission',
    bindingId: 'hb',
    harnessId: 'converses',
    worktreePath: join(base, 'worktree'),
    scratchDir: join(base, 'scratch'),
    configDir: join(base, 'scratch', 'config'),
    conversationId: 'conversation',
    baseSha: 'a'.repeat(40),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    busy: false,
  });
});

afterEach(async () => {
  forgetSession(OTHER_RUNS);
  await rm(base, { recursive: true, force: true });
});

async function commission(continueFrom: string): Promise<{ status: string; message: string }> {
  const written: Record<string, unknown> = {};
  const result = await createHostHarnessHandler(policyPath).execute({
    operationId: 'host.harness.run',
    spaceId: 'space-test',
    runId: 'run-this-commission',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () =>
      Promise.resolve({
        bindingId: 'hb',
        harness: 'converses',
        task: 'Fix what the review found.',
        timeoutMs: 60_000,
        continueFrom,
      }),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (kind: string, data: unknown) => {
      written[kind] = data;
      return Promise.resolve(`inline:${kind}`);
    },
  } as never);
  const error = written['error'] as { message?: string } | undefined;
  return { status: result.status, message: error?.message ?? '' };
}

describe('a commission that names a session another run made', () => {
  it('is told the ownership rule', async () => {
    const { status, message } = await commission(OTHER_RUNS);
    expect(status).toBe('FAILED');
    expect(message).toContain('A kept session is owned by the run that made it');
    expect(message).toContain('every commission is a new run');
    expect(message).toContain('`continueFrom` can name only a session this same run made');
    expect(message).toContain('a session made by any other run is refused');
  });

  it('is offered neither expiry nor a restart as the reason', async () => {
    const { message } = await commission(OTHER_RUNS);
    expect(message).not.toMatch(/expire/i);
    expect(message).not.toMatch(/restart/i);
  });

  it('gets the answer a session that never existed gets, so nothing is confirmed', async () => {
    const owned = await commission(OTHER_RUNS);
    const never = await commission('hs_never_made');
    expect(never.status).toBe('FAILED');
    expect(owned.message.replace(OTHER_RUNS, '<ref>')).toBe(
      never.message.replace('hs_never_made', '<ref>'),
    );
    expect(owned.message).not.toContain('run-earlier-commission');
  });
});
