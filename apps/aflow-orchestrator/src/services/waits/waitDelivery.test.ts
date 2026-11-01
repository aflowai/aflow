/**
 * The delivery of ended waits (Plan 339 D1): each wait an event or a closed
 * window ended reaches its waiter once, and one whose delivery fails is put
 * back for the next cycle rather than lost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { declareWait, emitPullRequestChanged } from '@aflow/cybernetic-runtime';
import type { EndedWait } from '@aflow/redis';
import type { BackgroundTaskLogger } from '@aflow/lib';
import type { HarnessDeps } from '../cybernetic/harness/types.js';
import { runWaitDeliveryCycle, type WaitDelivery } from './waitDelivery.js';

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
