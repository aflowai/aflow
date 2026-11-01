/**
 * The wait primitive (Plan 339 D1), end to end over the space's entity events.
 *
 * A wait names a kind, a subject and a window. A waiter that declares its
 * wait after the event fired is woken at once — that case fails where the
 * primitive serves only live subscribers. A waiter whose window closes with no
 * event is woken and told that the window closed — that case fails where a
 * lost event leaves a waiter asleep.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  claimEndedWaits,
  declareWait,
  describeWaitOutcome,
  WaitDeclarationError,
} from '../waits.js';
import { emitGateResolved, emitPlanUpdated, emitPullRequestChanged } from '../entityEvents.js';

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const SESSION = 'c0ffee00-0000-4000-8000-000000000339';
const PULL = 'aflowai/aflow#276';
const T0 = 1_800_000_000_000;

let redis: RedisType;

beforeEach(async () => {
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

function waitOn(
  kind: Parameters<typeof declareWait>[1]['kind'],
  subject: string,
  windowSeconds = 600,
) {
  return { tenantId: TENANT, spaceId: SPACE, sessionId: SESSION, kind, subject, windowSeconds };
}

describe('a waiter declared after its event fired', () => {
  it('is woken at once by its own declaration, and told which change happened', async () => {
    await emitPullRequestChanged(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: PULL,
      change: 'checks_green',
      url: 'https://github.com/aflowai/aflow/pull/276',
      headSha: 'abc123',
    });

    const declared = await declareWait(redis, waitOn('pull_request.changed', PULL));

    expect(declared.state).toBe('ended');
    if (declared.state !== 'ended') return;
    expect(declared.outcome).toMatchObject({
      endedBy: 'event',
      event: {
        kind: 'pull_request.changed',
        subject: PULL,
        detail: { change: 'checks_green', headSha: 'abc123' },
      },
    });
    expect(await claimEndedWaits(redis, Date.now() + 3_600_000, 10)).toEqual([]);
  });

  it('is woken at once by a gate already resolved', async () => {
    await emitGateResolved(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      itemId: 'paused:step-1',
      resolution: 'approve',
    });

    const declared = await declareWait(redis, waitOn('gate.resolved', 'paused:step-1'));

    expect(declared).toMatchObject({
      state: 'ended',
      outcome: { endedBy: 'event', event: { detail: { resolution: 'approve' } } },
    });
  });
});

describe('a waiter declared before its event', () => {
  it('is handed the event once it fires, and only once', async () => {
    const declared = await declareWait(redis, waitOn('plan.node.status_changed', 'node-1'));
    expect(declared.state).toBe('waiting');

    // A write that does not change the status wakes nothing.
    await emitPlanUpdated(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      nodeId: 'node-1',
      revision: 2,
      status: 'active',
      previousStatus: 'active',
    });
    expect(await claimEndedWaits(redis, Date.now(), 10)).toEqual([]);

    await emitPlanUpdated(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      nodeId: 'node-1',
      revision: 3,
      status: 'done',
      previousStatus: 'active',
    });
    const ended = await claimEndedWaits(redis, Date.now(), 10);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.registration.waitId).toBe(declared.waitId);
    expect(ended[0]?.outcome).toMatchObject({
      endedBy: 'event',
      event: { detail: { status: 'done', previousStatus: 'active' } },
    });
    expect(await claimEndedWaits(redis, Date.now() + 3_600_000, 10)).toEqual([]);
  });
});

describe('a waiter whose window closes with no event', () => {
  it('is woken and told that the window closed', async () => {
    const declared = await declareWait(redis, waitOn('run.ended', 'run-1', 60), T0);
    expect(declared).toMatchObject({ state: 'waiting', closesAt: T0 + 60_000 });

    expect(await claimEndedWaits(redis, T0 + 59_999, 10)).toEqual([]);
    const ended = await claimEndedWaits(redis, T0 + 60_000, 10);

    expect(ended).toHaveLength(1);
    const [only] = ended;
    expect(only?.outcome).toEqual({ endedBy: 'window_closed', closedAt: T0 + 60_000 });
    expect(describeWaitOutcome(only!.registration, only!.outcome)).toContain(
      'its window closed at 2027-01-15T08:01:00.000Z with no event',
    );
  });
});

describe('a wait is declared by a kind, a subject and a window, never a cadence', () => {
  it('refuses a kind it does not know', async () => {
    await expect(
      declareWait(redis, waitOn('pull_request.polled' as 'run.ended', PULL)),
    ).rejects.toBeInstanceOf(WaitDeclarationError);
  });

  it('refuses a window outside its bounds', async () => {
    await expect(declareWait(redis, waitOn('run.ended', 'run-1', 5))).rejects.toThrow(
      /whole number of seconds/,
    );
  });
});
