/**
 * Contract: a commission naming a session it cannot continue is told the rule
 * that decides which sessions it can — a kept session is owned by the
 * conversation that started the run that made it, and by the run itself where
 * no conversation started one — and nothing about the session it named. It
 * also says the ways a kept session ends — once it has been idle for an hour,
 * once the executor has restarted since it was made, once a turn naming a new
 * base has failed to prepare its checkout again, or once the grant of its
 * connected folder is withdrawn — because a session its own conversation made
 * and lost one of those ways reaches the same refusal as another
 * conversation's. Another conversation's session, its own idled-out one and
 * one that never existed all get one answer, so the refusal confirms nothing
 * and guesses at no reason for the ref it names.
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
const THIS_CONVERSATION = 'conversation-this';
const OTHER_CONVERSATIONS = 'hs_other_conversation';
const IDLED_OUT = 'hs_this_conversation_idled_out';
const OTHER_RUNS = 'hs_other_run_no_conversation';

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
  // Made by a commission another conversation started, on the same folder and
  // harness, and live.
  keep(OTHER_CONVERSATIONS, 'conversation-other', 'run-other-conversation', Date.now());
  // Made by an earlier commission of this conversation, and idle past the hour since.
  keep(IDLED_OUT, THIS_CONVERSATION, 'run-earlier', Date.now() - SESSION_IDLE_TTL_MS - 1);
  // Made by a run no conversation started, and live.
  keep(OTHER_RUNS, 'run-unstarted', 'run-unstarted', Date.now());
});

function keep(id: string, ownerId: string, runId: string, lastUsedAt: number): void {
  recordSession({
    id,
    ownerId,
    runId,
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
  forgetSession(OTHER_CONVERSATIONS);
  forgetSession(IDLED_OUT);
  forgetSession(OTHER_RUNS);
  await rm(base, { recursive: true, force: true });
});

async function commission(
  continueFrom: string,
  startingConversationId: string | undefined = THIS_CONVERSATION,
): Promise<{ status: string; message: string }> {
  const written: Record<string, unknown> = {};
  const result = await createHostHarnessHandler(policyPath).execute({
    operationId: 'host.harness.run',
    spaceId: 'space-test',
    runId: THIS_RUN,
    ...(startingConversationId !== undefined ? { startingConversationId } : {}),
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
    const { status, message } = await commission(OTHER_CONVERSATIONS);
    expect(status).toBe('FAILED');
    expect(message).toContain(
      'A kept session is owned by the conversation that started the run that made it',
    );
    expect(message).toContain(
      '`continueFrom` can name a session made by any run that same conversation started',
    );
    expect(message).toContain('a run no conversation started owns the sessions it makes itself');
    expect(message).toContain('A session owned by any other conversation or run is refused');
    expect(message).not.toContain('every commission is a new run');
  });

  it('is told that a kept session ends after an idle hour', async () => {
    const { message } = await commission(OTHER_CONVERSATIONS);
    expect(SESSION_IDLE_TTL_MS).toBe(60 * 60 * 1000);
    expect(message).toContain('A kept session ends once it has been idle for an hour');
  });

  it('is told that a kept session ends when the executor restarts', async () => {
    const { message } = await commission(OTHER_CONVERSATIONS);
    expect(message).toContain('once this executor has restarted since it was made');
  });

  it('is told that a kept session ends when its checkout cannot be prepared again', async () => {
    const { message } = await commission(OTHER_CONVERSATIONS);
    expect(message).toContain(
      "once a turn naming a new `base` has failed to prepare the session's checkout again",
    );
  });

  it("is told that a kept session ends when its folder's grant is withdrawn", async () => {
    const { message } = await commission(OTHER_CONVERSATIONS);
    expect(message).toContain('or once the grant of its connected folder is withdrawn.');
  });

  it('makes no guess about why the ref it named in particular is not held', async () => {
    const { message } = await commission(OTHER_CONVERSATIONS);
    expect(message).not.toMatch(/\b(may|might|probably|perhaps|likely)\b/i);
    expect(message.startsWith(`No session \`${OTHER_CONVERSATIONS}\` is held for this run. `)).toBe(
      true,
    );
    expect(message.split(OTHER_CONVERSATIONS)).toHaveLength(2);
    expect(message).not.toContain('conversation-other');
    expect(message).not.toContain('run-other-conversation');
  });

  it("gets one answer for another conversation's session, its own idled-out one, a conversation-less run's and one never made", async () => {
    const answers = await Promise.all(
      [OTHER_CONVERSATIONS, IDLED_OUT, OTHER_RUNS, 'hs_never_made'].map(async (ref) => {
        const { status, message } = await commission(ref);
        expect(status, ref).toBe('FAILED');
        return message.replace(ref, '<ref>');
      }),
    );
    expect(new Set(answers).size).toBe(1);
  });

  it('gets the same answer from a run no conversation started', async () => {
    const fromConversation = await commission('hs_never_made');
    const fromNone = await commission(OTHER_CONVERSATIONS, undefined);
    expect(fromNone.status).toBe('FAILED');
    expect(fromNone.message.replace(OTHER_CONVERSATIONS, 'hs_never_made')).toBe(
      fromConversation.message,
    );
  });
});
