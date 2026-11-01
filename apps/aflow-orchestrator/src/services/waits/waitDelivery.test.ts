/**
 * The delivery of ended waits (Plan 339 D1): each wait an event or a closed
 * window ended reaches its waiter once, and one whose delivery fails is put
 * back for the next cycle rather than lost. A waiter whose hot state has aged
 * out is rehydrated, told and woken.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { claimEndedWaits, declareWait, emitPullRequestChanged } from '@aflow/cybernetic-runtime';
import { WAIT_DELIVERY_LEASE_MS, type EndedWait } from '@aflow/redis';
import type { BackgroundTaskLogger } from '@aflow/lib';
import type { HarnessDeps } from '../cybernetic/harness/types.js';
import { deliverEndedWait, runWaitDeliveryCycle, type WaitDelivery } from './waitDelivery.js';

const { mockQueueMessage, mockWake, mockRehydrateIfAbsent } = vi.hoisted(() => ({
  mockQueueMessage: vi.fn(),
  mockWake: vi.fn(),
  mockRehydrateIfAbsent: vi.fn(),
}));

vi.mock('../SessionOrchestrator/helpers/queuedMessage.js', () => ({
  queueMessageForNextTurn: (...args: unknown[]) => mockQueueMessage(...args),
}));
vi.mock('../cybernetic/harness/sessionWakeup.js', () => ({
  wakeSessionForWait: (...args: unknown[]) => mockWake(...args),
}));
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/cybernetic-runtime')>()),
  rehydratePausedRunIfAbsent: (...args: unknown[]) => mockRehydrateIfAbsent(...args),
}));

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const SESSION = 'c0ffee00-0000-4000-8000-000000000339';
const T0 = 1_800_000_000_000;

const logger: BackgroundTaskLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const ctx = { maxBatch: 50, budgetExhausted: () => false, mode: 'enabled' as const };

let redis: Redis;
let harnessDeps: HarnessDeps;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  harnessDeps = { redis } as unknown as HarnessDeps;
});

function deliverer(results: WaitDelivery[] = []) {
  const delivered: EndedWait[] = [];
  const deliver = vi.fn(async (ended: EndedWait) => {
    delivered.push(ended);
    return results.shift() ?? 'woke';
  });
  return { deliver, delivered };
}

describe('the wait delivery cycle', () => {
  it('reads nothing else and delivers nothing while no wait has ended', async () => {
    await declareWait(
      redis,
      {
        tenantId: TENANT,
        spaceId: SPACE,
        sessionId: SESSION,
        kind: 'run.ended',
        subject: 'r',
        windowSeconds: 60,
      },
      T0,
    );
    const { deliver } = deliverer();

    const result = await runWaitDeliveryCycle({ harnessDeps, logger, now: () => T0, deliver }, ctx);

    expect(result).toEqual({ candidates: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers a wait an event ended, once', async () => {
    const declared = await declareWait(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      sessionId: SESSION,
      kind: 'pull_request.changed',
      subject: 'aflowai/aflow#276',
      windowSeconds: 3600,
    });
    await emitPullRequestChanged(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: 'aflowai/aflow#276',
      change: 'merged',
      url: 'https://github.com/aflowai/aflow/pull/276',
      headSha: 'abc123',
    });
    const { deliver, delivered } = deliverer();

    await runWaitDeliveryCycle({ harnessDeps, logger, deliver }, ctx);
    await runWaitDeliveryCycle({ harnessDeps, logger, deliver }, ctx);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.registration.waitId).toBe(declared.waitId);
    expect(delivered[0]?.outcome).toMatchObject({
      endedBy: 'event',
      event: { detail: { change: 'merged' } },
    });
  });

  it('delivers a closed window, and tries again where the session could not be woken yet', async () => {
    await declareWait(
      redis,
      {
        tenantId: TENANT,
        spaceId: SPACE,
        sessionId: SESSION,
        kind: 'gate.resolved',
        subject: 'item-1',
        windowSeconds: 60,
      },
      T0,
    );
    const { deliver, delivered } = deliverer(['retry', 'woke']);
    const later = () => T0 + 60_000;

    const first = await runWaitDeliveryCycle({ harnessDeps, logger, now: later, deliver }, ctx);
    const second = await runWaitDeliveryCycle({ harnessDeps, logger, now: later, deliver }, ctx);
    const third = await runWaitDeliveryCycle({ harnessDeps, logger, now: later, deliver }, ctx);

    expect(first).toMatchObject({ candidates: 1, failed: 1 });
    expect(second).toMatchObject({ candidates: 1, processed: 1 });
    expect(third).toEqual({ candidates: 0 });
    expect(delivered.map((ended) => ended.outcome.endedBy)).toEqual([
      'window_closed',
      'window_closed',
    ]);
  });

  it('delivers a wait whose deliverer died after claiming it, once the lease lapses', async () => {
    const declared = await declareWait(
      redis,
      {
        tenantId: TENANT,
        spaceId: SPACE,
        sessionId: SESSION,
        kind: 'run.ended',
        subject: 'r',
        windowSeconds: 60,
      },
      T0,
    );
    const closedAt = T0 + 60_000;
    // A process claims the wait and dies before it delivers it.
    expect(await claimEndedWaits(redis, closedAt, 10)).toHaveLength(1);
    const { deliver, delivered } = deliverer();

    const early = await runWaitDeliveryCycle(
      { harnessDeps, logger, now: () => closedAt, deliver },
      ctx,
    );
    const lapsed = await runWaitDeliveryCycle(
      { harnessDeps, logger, now: () => closedAt + WAIT_DELIVERY_LEASE_MS, deliver },
      ctx,
    );
    const after = await runWaitDeliveryCycle(
      { harnessDeps, logger, now: () => closedAt + 2 * WAIT_DELIVERY_LEASE_MS, deliver },
      ctx,
    );

    expect(early).toEqual({ candidates: 0 });
    expect(lapsed).toMatchObject({ candidates: 1, processed: 1 });
    expect(after).toEqual({ candidates: 0 });
    expect(delivered.map((ended) => ended.registration.waitId)).toEqual([declared.waitId]);
  });

  it('ends no wait in observe mode', async () => {
    await declareWait(
      redis,
      {
        tenantId: TENANT,
        spaceId: SPACE,
        sessionId: SESSION,
        kind: 'run.ended',
        subject: 'r',
        windowSeconds: 60,
      },
      T0,
    );
    const { deliver } = deliverer();

    await runWaitDeliveryCycle(
      { harnessDeps, logger, now: () => T0 + 60_000, deliver },
      { ...ctx, mode: 'observe' },
    );
    const enabled = await runWaitDeliveryCycle(
      { harnessDeps, logger, now: () => T0 + 60_000, deliver },
      ctx,
    );

    expect(enabled).toMatchObject({ candidates: 1, processed: 1 });
  });
});

describe('delivering one ended wait', () => {
  const posted = { eventId: 'e-1', messageSeq: 3 };

  async function endedWait(): Promise<EndedWait> {
    await declareWait(
      redis,
      {
        tenantId: TENANT,
        spaceId: SPACE,
        sessionId: SESSION,
        kind: 'run.ended',
        subject: 'r',
        windowSeconds: 60,
      },
      T0,
    );
    const [ended] = await claimEndedWaits(redis, T0 + 60_000, 10);
    if (!ended) throw new Error('the window did not close');
    return ended;
  }

  beforeEach(() => {
    mockQueueMessage.mockReset();
    mockWake.mockReset();
    mockRehydrateIfAbsent.mockReset();
  });

  it('tells and wakes a session whose hot state is live, with no rehydration', async () => {
    mockQueueMessage.mockResolvedValueOnce(posted);
    mockWake.mockResolvedValueOnce('woke');

    const delivery = await deliverEndedWait(harnessDeps, await endedWait());

    expect(delivery).toBe('woke');
    expect(mockRehydrateIfAbsent).not.toHaveBeenCalled();
    expect(mockWake).toHaveBeenCalledWith(harnessDeps, TENANT, SESSION, expect.any(String));
  });

  it('rehydrates a session whose hot state is gone, then tells and wakes it', async () => {
    mockQueueMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce(posted);
    mockRehydrateIfAbsent.mockResolvedValueOnce({ runId: SESSION });
    mockWake.mockResolvedValueOnce('woke');
    const ended = await endedWait();

    const delivery = await deliverEndedWait(harnessDeps, ended);

    expect(delivery).toBe('woke');
    expect(mockRehydrateIfAbsent).toHaveBeenCalledWith(redis, undefined, TENANT, SESSION);
    expect(mockQueueMessage).toHaveBeenCalledTimes(2);
    expect(mockQueueMessage.mock.calls[1]?.[2]).toMatchObject({
      sessionId: SESSION,
      deliveryKey: `wait:${ended.registration.waitId}`,
    });
    expect(mockWake).toHaveBeenCalledTimes(1);
  });

  it('tells a rehydrated session that is not resting at its prompt, for its next turn to read', async () => {
    mockQueueMessage.mockResolvedValueOnce(undefined).mockResolvedValueOnce(posted);
    mockRehydrateIfAbsent.mockResolvedValueOnce({ runId: SESSION });
    mockWake.mockResolvedValueOnce('deferred');

    expect(await deliverEndedWait(harnessDeps, await endedWait())).toBe('told');
  });

  it('reports the session gone only where no resting snapshot restores it', async () => {
    mockQueueMessage.mockResolvedValueOnce(undefined);
    mockRehydrateIfAbsent.mockResolvedValueOnce(null);

    const delivery = await deliverEndedWait(harnessDeps, await endedWait());

    expect(delivery).toBe('session_gone');
    expect(mockQueueMessage).toHaveBeenCalledTimes(1);
    expect(mockWake).not.toHaveBeenCalled();
  });
});
