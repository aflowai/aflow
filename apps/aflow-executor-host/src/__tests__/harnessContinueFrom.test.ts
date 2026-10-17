/**
 * Contract: a commission naming a session it cannot continue is told the rule
 * that decides which sessions it can — a kept session is owned by the run that
 * made it, and every commission is a new run — and nothing about the session it
 * named. It also says the ways a kept session ends — once it has been idle for
 * an hour, once the executor has restarted since it was made, once a turn
 * naming a new base has failed to prepare its checkout again, or once the grant
 * of its connected folder is withdrawn — because a session this run made and
 * lost one of those ways reaches the same refusal as another run's. Another
 * run's session, this run's idled-out one and one that never existed all get
 * one answer, so the refusal confirms nothing and guesses at no reason for the
 * ref it names.
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
const { forgetSession, recordSession, SESSION_IDLE_TTL_MS } = await import('../harnessSessions.js');

const THIS_RUN = 'run-this-commission';
const OTHER_RUNS = 'hs_other_run';
const IDLED_OUT = 'hs_this_run_idled_out';

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
  keep(OTHER_RUNS, 'run-earlier-commission', Date.now());
  // Made by this commission, and idle past the hour since.
  keep(IDLED_OUT, THIS_RUN, Date.now() - SESSION_IDLE_TTL_MS - 1);
});

function keep(id: string, ownerRunId: string, lastUsedAt: number): void {
  recordSession({
    id,
    ownerRunId,
    logicalExecutionId: 'task:commission',
    bindingId: 'hb',
    harnessId: 'converses',
    worktreePath: join(base, `worktree-${id}`),
    scratchDir: join(base, `scratch-${id}`),
    configDir: join(base, `scratch-${id}`, 'config'),
    conversationId: 'conversation',
    baseSha: 'a'.repeat(40),
    createdAt: lastUsedAt,
    lastUsedAt,
    busy: false,
  });
}

afterEach(async () => {
  forgetSession(OTHER_RUNS);
  forgetSession(IDLED_OUT);
  await rm(base, { recursive: true, force: true });
});

async function commission(continueFrom: string): Promise<{ status: string; message: string }> {
  const written: Record<string, unknown> = {};
  const result = await createHostHarnessHandler(policyPath).execute({
    operationId: 'host.harness.run',
    spaceId: 'space-test',
    runId: THIS_RUN,
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

describe('a commission that names a session it cannot continue', () => {
  it('is told the ownership rule', async () => {
    const { status, message } = await commission(OTHER_RUNS);
    expect(status).toBe('FAILED');
    expect(message).toContain('A kept session is owned by the run that made it');
    expect(message).toContain('every commission is a new run');
    expect(message).toContain('`continueFrom` can name only a session this same run made');
    expect(message).toContain('a session made by any other run is refused');
  });

  it('is told that a kept session ends after an idle hour', async () => {
    const { message } = await commission(OTHER_RUNS);
    expect(SESSION_IDLE_TTL_MS).toBe(60 * 60 * 1000);
    expect(message).toContain('A kept session ends once it has been idle for an hour');
  });

  it('is told that a kept session ends when the executor restarts', async () => {
    const { message } = await commission(OTHER_RUNS);
    expect(message).toContain('once this executor has restarted since it was made');
  });

  it('is told that a kept session ends when its checkout cannot be prepared again', async () => {
    const { message } = await commission(OTHER_RUNS);
    expect(message).toContain(
      "once a turn naming a new `base` has failed to prepare the session's checkout again",
    );
  });

  it("is told that a kept session ends when its folder's grant is withdrawn", async () => {
    const { message } = await commission(OTHER_RUNS);
    expect(message).toContain('or once the grant of its connected folder is withdrawn.');
  });

  it('makes no guess about why the ref it named in particular is not held', async () => {
    const { message } = await commission(OTHER_RUNS);
    expect(message).not.toMatch(/\b(may|might|probably|perhaps|likely)\b/i);
    expect(message.startsWith(`No session \`${OTHER_RUNS}\` is held for this run. `)).toBe(true);
    expect(message.split(OTHER_RUNS)).toHaveLength(2);
    expect(message).not.toContain('run-earlier-commission');
  });

  it("gets one answer for another run's session, this run's idled-out one and one never made", async () => {
    const answers = await Promise.all(
      [OTHER_RUNS, IDLED_OUT, 'hs_never_made'].map(async (ref) => {
        const { status, message } = await commission(ref);
        expect(status, ref).toBe('FAILED');
        return message.replace(ref, '<ref>');
      }),
    );
    expect(new Set(answers).size).toBe(1);
  });
});
