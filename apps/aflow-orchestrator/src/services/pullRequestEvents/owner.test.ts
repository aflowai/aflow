/**
 * Plan 339 D4: the pull request event goes to the pull request's owner — the
 * Helmsman conversation that started the publication that opened it. The
 * owner holds one wait on the pull request, which the platform declares for
 * it and renews after each delivery, so it hears every change. Each delivery
 * tells it to run a shepherd pass aimed at the pull request. An owner that
 * has ended is forgotten, and the fallback sweep tends the pull request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { readPullRequestWatch, readSubjectWaits } from '@aflow/redis';
import {
  claimEndedWaits,
  emitPullRequestChanged,
  type WorkflowRunDetail,
} from '@aflow/cybernetic-runtime';
import {
  PLAN_STREAM_PUBLICATION_SLUG,
  RUN_PULL_REQUEST_URL_OUTPUT,
  SHEPHERD_SLUG,
} from '@aflow/schemas';
import type { HarnessDeps } from '../cybernetic/harness/types.js';

const { buildResult, live, mockQueueMessage, mockWake } = vi.hoisted(() => ({
  buildResult: vi.fn(),
  live: vi.fn(),
  mockQueueMessage: vi.fn(),
  mockWake: vi.fn(),
}));
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/cybernetic-runtime')>()),
  buildWorkflowRunResult: buildResult,
  isLiveConversation: live,
  rehydratePausedRunIfAbsent: () => Promise.resolve(null),
}));
vi.mock('../SessionOrchestrator/helpers/queuedMessage.js', () => ({
  queueMessageForNextTurn: (...args: unknown[]) => mockQueueMessage(...args),
}));
vi.mock('../cybernetic/harness/sessionWakeup.js', () => ({
  wakeSessionForWait: (...args: unknown[]) => mockWake(...args),
}));

const { armPullRequestOnPublication } = await import('./arm.js');
const { deliverEndedWait, runWaitDeliveryCycle } = await import('../waits/waitDelivery.js');

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const OWNER = 'c0ffee00-0000-4000-8000-000000000339';
const SUBJECT = 'aflowai/aflow#276';
const URL = 'https://github.com/AflowAI/Aflow/pull/276';
const T0 = 1_800_000_000_000;
const WATCH = { tenantId: TENANT, spaceId: SPACE, subject: SUBJECT };
const WAITERS = { ...WATCH, kind: 'pull_request.changed' as const };

let redis: Redis;
let deps: HarnessDeps;

function publication(sessionId: string | null = OWNER): WorkflowRunDetail {
  return {
    workflowSlug: PLAN_STREAM_PUBLICATION_SLUG,
    spaceId: SPACE,
    sessionId,
    metadata: { parentTaskInputs: { inputs: { bindingId: 'hb_aflow', branch: 'aflow/x' } } },
  } as unknown as WorkflowRunDetail;
}

async function armed(sessionId: string | null = OWNER) {
  expect(
    await armPullRequestOnPublication(deps, TENANT, publication(sessionId), 'completed', T0),
  ).toBe('armed');
}

function postedBody(): string {
  const [, , message] = mockQueueMessage.mock.calls.at(-1) as [unknown, unknown, { body: string }];
  return message.body;
}

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  deps = { redis, db: {}, payloadStore: {} } as unknown as HarnessDeps;
  buildResult.mockReset().mockResolvedValue({ output: { [RUN_PULL_REQUEST_URL_OUTPUT]: URL } });
  live.mockReset().mockResolvedValue(true);
  mockQueueMessage.mockReset().mockResolvedValue({ seq: 1 });
  mockWake.mockReset().mockResolvedValue('woke');
});

describe('the owner of a loop pull request', () => {
  it('is the live conversation that started the publication, and holds one wait on the pull request', async () => {
    await armed();

    expect(await readPullRequestWatch(redis, WATCH)).toMatchObject({
      ownerSessionId: OWNER,
      bindingId: 'hb_aflow',
    });
    const waits = await readSubjectWaits(redis, WAITERS);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ sessionId: OWNER, owner: expect.any(Object) });

    // A second publication of the branch holds no second wait.
    await armed();
    expect(await readSubjectWaits(redis, WAITERS)).toHaveLength(1);
  });

  it('is nobody where the publication was not started by a live conversation', async () => {
    live.mockResolvedValue(false);
    await armed();
    expect((await readPullRequestWatch(redis, WATCH))?.ownerSessionId).toBeUndefined();
    expect(await readSubjectWaits(redis, WAITERS)).toEqual([]);

    await armed(null);
    expect(await readSubjectWaits(redis, WAITERS)).toEqual([]);
  });

  it('keeps the owner a later publication of the branch does not name', async () => {
    await armed();
    live.mockResolvedValue(false);
    await armed('5e55e55e-0000-4000-8000-000000000339');
    expect((await readPullRequestWatch(redis, WATCH))?.ownerSessionId).toBe(OWNER);
  });
});

describe("the owner's wait on its pull request's event", () => {
  it('tells the owner to run a shepherd pass aimed at the pull request, and holds the next wait', async () => {
    await armed();
    await emitPullRequestChanged(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: SUBJECT,
      change: 'checks_green',
      url: URL,
      headSha: 'c'.repeat(40),
    });
    const [ended] = await claimEndedWaits(redis, Date.now(), 10);
    if (!ended) throw new Error('the event did not end the wait');

    expect(await deliverEndedWait(deps, ended)).toBe('woke');

    const body = postedBody();
    expect(body).toContain('checks_green');
    expect(body).toContain(`slug \`${SHEPHERD_SLUG}\``);
    expect(body).toContain("`bindingId: 'hb_aflow'`");
    expect(body).toContain("`pullNumber: '276'`");
    expect(body).toContain('close its plan step');
    const next = await readSubjectWaits(redis, WAITERS);
    expect(next).toHaveLength(1);
    expect(next[0]?.waitId).not.toBe(ended.registration.waitId);
    expect(next[0]?.owner).toBeDefined();
  });

  it('posts nothing when its window closes with no event, and holds the next wait', async () => {
    await armed();
    const [closed] = await claimEndedWaits(redis, T0 + 25 * 60 * 60 * 1000, 10);
    if (!closed || closed.outcome.endedBy !== 'window_closed') throw new Error('no window closed');

    expect(await deliverEndedWait(deps, closed)).toBe('renewed');

    expect(mockQueueMessage).not.toHaveBeenCalled();
    expect(mockWake).not.toHaveBeenCalled();
    expect(await readSubjectWaits(redis, WAITERS)).toHaveLength(1);
  });

  it('forgets an owner that has ended: no next wait, and the pull request is no conversation’s', async () => {
    await armed();
    await emitPullRequestChanged(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: SUBJECT,
      change: 'conflicting',
      url: URL,
      headSha: 'c'.repeat(40),
    });
    const [ended] = await claimEndedWaits(redis, Date.now(), 10);
    if (!ended) throw new Error('the event did not end the wait');
    live.mockResolvedValue(false);

    await deliverEndedWait(deps, ended);

    expect(await readSubjectWaits(redis, WAITERS)).toEqual([]);
    expect((await readPullRequestWatch(redis, WATCH))?.ownerSessionId).toBeUndefined();
  });

  it('forgets an owner whose conversation is gone', async () => {
    await armed();
    const [closed] = await claimEndedWaits(redis, T0 + 25 * 60 * 60 * 1000, 10);
    if (!closed) throw new Error('no window closed');
    await emitPullRequestChanged(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: SUBJECT,
      change: 'merged',
      url: URL,
      headSha: 'c'.repeat(40),
    });
    mockQueueMessage.mockResolvedValue(undefined);
    const event = await claimEndedWaits(redis, Date.now(), 10);
    expect(event).toEqual([]);

    // A delivery that finds no conversation to post to drops the owner.
    const gone = await deliverEndedWait(deps, {
      registration: closed.registration,
      outcome: {
        endedBy: 'event',
        event: { kind: 'pull_request.changed', subject: SUBJECT, firedAt: T0, detail: {} },
      },
    });
    expect(gone).toBe('session_gone');
    expect((await readPullRequestWatch(redis, WATCH))?.ownerSessionId).toBeUndefined();
  });
});

describe("an event that fires while the owner's last one is delivered", () => {
  const changed = (change: 'checks_green' | 'conflicting') =>
    emitPullRequestChanged(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: SUBJECT,
      change,
      url: URL,
      headSha: 'c'.repeat(40),
    });
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const ctx = { maxBatch: 10, budgetExhausted: () => false, mode: 'enabled' as const };

  it('is queued for delivery with the next wait, and survives a delivery that throws', async () => {
    await armed();
    await changed('checks_green');
    const [first] = await claimEndedWaits(redis, Date.now(), 10);
    if (!first) throw new Error('the event did not end the wait');
    await later();
    await changed('conflicting');

    expect(await deliverEndedWait(deps, first)).toBe('woke');

    // The next wait caught up on the second event: it holds no hash entry, and
    // waits in the delivery set rather than in a caller that could lose it.
    expect(await readSubjectWaits(redis, WAITERS)).toEqual([]);
    mockQueueMessage.mockReset().mockRejectedValueOnce(new Error('room unreachable'));
    const failed = await runWaitDeliveryCycle(
      { harnessDeps: deps, logger, now: () => Date.now() },
      ctx,
    );
    expect(failed).toMatchObject({ candidates: 1, failed: 1 });

    mockQueueMessage.mockResolvedValue({ seq: 2 });
    const delivered = await runWaitDeliveryCycle(
      { harnessDeps: deps, logger, now: () => Date.now() },
      ctx,
    );
    expect(delivered).toMatchObject({ candidates: 1, processed: 1 });
    expect(postedBody()).toContain('conflicting');
    // And the owner holds a wait again.
    expect(await readSubjectWaits(redis, WAITERS)).toHaveLength(1);
  });
});
