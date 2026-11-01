/**
 * The store under the wait primitive (Plan 339 D1).
 *
 * Two properties carry the primitive. A waiter registered after its event
 * fired is woken at once — a store that served only live subscribers would
 * leave it asleep. A waiter whose window closes with no event is woken and
 * told so — a lost event must not leave it asleep either. Each wait ends
 * exactly once, whichever party reaches it first.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { EntityEventEnvelope, WaitRegistration } from '@aflow/schemas';
import {
  WAIT_DELIVERY_LEASE_MS,
  WAIT_FIRED_SUBJECTS_KEY,
  WAIT_WINDOWS_KEY,
  cancelWait,
  claimClosedWindows,
  claimDueDeliveries,
  claimFiredWaits,
  readRecordedWaitEvent,
  rearmEndedWait,
  recordWaitEvent,
  registerWait,
  settleEndedWait,
} from '../waits.js';
import { appendEntityEvent } from '../entityEvents.js';

const TENANT = 'tenant-339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const RUN = '0b7c1d2e-3f40-4a51-8b62-7c83d94ea339';
const T0 = 1_800_000_000_000;

let redis: Redis;
let sequence = 0;

function wait(overrides: Partial<WaitRegistration> = {}): WaitRegistration {
  sequence += 1;
  return {
    waitId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    tenantId: TENANT,
    spaceId: SPACE,
    kind: 'pull_request.changed',
    subject: 'aflowai/aflow#276',
    sessionId: 'session-1',
    declaredAt: T0,
    closesAt: T0 + 60_000,
    ...overrides,
  };
}

const green = {
  kind: 'pull_request.changed' as const,
  subject: 'aflowai/aflow#276',
  firedAt: T0 + 1_000,
  detail: { change: 'checks_green' },
};

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

/** A wait declared after `green` was recorded, catching up from `since` where it names one. */
function lateWait(overrides: Partial<WaitRegistration> = {}): WaitRegistration {
  return wait({
    declaredAt: green.firedAt + 5_000,
    closesAt: green.firedAt + 65_000,
    ...overrides,
  });
}

describe('a waiter registered after its event fired', () => {
  it('that asks to catch up is woken at once, by its own registration', async () => {
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);

    const registered = await registerWait(redis, lateWait({ since: T0 }));

    expect(registered).toEqual({ state: 'woken', outcome: { endedBy: 'event', event: green } });
    expect(await redis.zcard(WAIT_WINDOWS_KEY)).toBe(0);
  });

  it('is not woken twice: the fired subject finds nothing left to wake', async () => {
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);
    await registerWait(redis, lateWait({ since: T0 }));

    expect(await claimFiredWaits(redis, 10)).toEqual([]);
  });

  it('that names no since waits for a new event rather than return the old one', async () => {
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);
    expect(await claimFiredWaits(redis, 10)).toEqual([]);

    const second = lateWait();
    expect(await registerWait(redis, second)).toEqual({ state: 'waiting' });
    // The old event's subject is read again by a later event, and still ends nothing.
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);
    expect(await claimFiredWaits(redis, 10)).toEqual([]);

    const merged = { ...green, firedAt: second.declaredAt + 1, detail: { change: 'merged' } };
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, merged);
    expect(await claimFiredWaits(redis, 10)).toEqual([
      { registration: second, outcome: { endedBy: 'event', event: merged } },
    ]);
  });

  it('keeps waiting where the event is older than the time it waits from', async () => {
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);

    const registered = await registerWait(redis, wait({ since: green.firedAt + 1 }));

    expect(registered).toEqual({ state: 'waiting' });
  });
});

describe('a waiter registered before its event', () => {
  it('is claimed once when the event fires, with the event', async () => {
    const registration = wait();
    expect(await registerWait(redis, registration)).toEqual({ state: 'waiting' });

    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);

    expect(await claimFiredWaits(redis, 10)).toEqual([
      { registration, outcome: { endedBy: 'event', event: green } },
    ]);
    expect(await claimFiredWaits(redis, 10)).toEqual([]);
    expect(await claimClosedWindows(redis, T0 + 120_000, 10)).toEqual([]);
  });

  it('wakes only the waiters of the subject that fired', async () => {
    await registerWait(redis, wait({ subject: 'aflowai/aflow#277' }));

    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);

    expect(await claimFiredWaits(redis, 10)).toEqual([]);
  });
});

describe('a waiter whose window closes with no event', () => {
  it('is woken and told that the window closed', async () => {
    const registration = wait();
    await registerWait(redis, registration);

    expect(await claimClosedWindows(redis, registration.closesAt - 1, 10)).toEqual([]);
    expect(await claimClosedWindows(redis, registration.closesAt, 10)).toEqual([
      { registration, outcome: { endedBy: 'window_closed', closedAt: registration.closesAt } },
    ]);
    expect(await claimClosedWindows(redis, registration.closesAt + 1, 10)).toEqual([]);
  });

  it('is not woken by an event that fires after its window closed and was claimed', async () => {
    const registration = wait();
    await registerWait(redis, registration);
    await claimClosedWindows(redis, registration.closesAt, 10);

    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);

    expect(await claimFiredWaits(redis, 10)).toEqual([]);
  });
});

describe('events that fire close together', () => {
  it('all reach the waiter, the first as what ended its wait', async () => {
    const registration = wait();
    await registerWait(redis, registration);
    const conflicting = { ...green, firedAt: T0 + 2_000, detail: { change: 'conflicting' } };

    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, conflicting);

    expect(await claimFiredWaits(redis, 10, T0)).toEqual([
      {
        registration,
        outcome: { endedBy: 'event', event: green, laterEvents: [conflicting] },
      },
    ]);
  });

  it('are kept for a waiter that catches up on them', async () => {
    const conflicting = { ...green, firedAt: T0 + 2_000, detail: { change: 'conflicting' } };
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, conflicting);

    expect(await registerWait(redis, lateWait({ since: T0 }))).toEqual({
      state: 'woken',
      outcome: { endedBy: 'event', event: green, laterEvents: [conflicting] },
    });
  });
});

describe('a subject nobody waits on', () => {
  it('records its event without entering the fired set', async () => {
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);

    expect(await redis.zcard(WAIT_FIRED_SUBJECTS_KEY)).toBe(0);
    expect(
      await readRecordedWaitEvent(redis, {
        tenantId: TENANT,
        spaceId: SPACE,
        kind: green.kind,
        subject: green.subject,
      }),
    ).toEqual(green);
  });
});

describe('a wait claimed for delivery', () => {
  it('outlives a deliverer that dies, and is delivered again once its lease lapses', async () => {
    const registration = wait();
    await registerWait(redis, registration);
    const [claimed] = await claimClosedWindows(redis, registration.closesAt, 10);
    expect(claimed?.registration).toEqual(registration);

    // The deliverer dies here, before it settles the wait.
    expect(await claimDueDeliveries(redis, registration.closesAt, 10)).toEqual([]);
    expect(
      await claimDueDeliveries(redis, registration.closesAt + WAIT_DELIVERY_LEASE_MS, 10),
    ).toEqual([claimed]);
  });

  it('is forgotten once settled', async () => {
    const registration = wait();
    await registerWait(redis, registration);
    await claimClosedWindows(redis, registration.closesAt, 10);

    await settleEndedWait(redis, registration.waitId);

    expect(
      await claimDueDeliveries(redis, registration.closesAt + WAIT_DELIVERY_LEASE_MS, 10),
    ).toEqual([]);
  });

  it('put back, is due at once with the outcome it was claimed with', async () => {
    const registration = wait();
    await registerWait(redis, registration);
    await recordWaitEvent(redis, { tenantId: TENANT, spaceId: SPACE }, green);
    const [claimed] = await claimFiredWaits(redis, 10, T0);

    await rearmEndedWait(redis, claimed!);

    expect(await claimDueDeliveries(redis, T0, 10)).toEqual([claimed]);
    expect(await claimDueDeliveries(redis, T0, 10)).toEqual([]);
  });
});

describe('a cancelled wait', () => {
  it('ends with nothing to wake', async () => {
    const registration = wait();
    await registerWait(redis, registration);

    expect(await cancelWait(redis, registration)).toBe(true);
    expect(await cancelWait(redis, registration)).toBe(false);
    expect(await claimClosedWindows(redis, registration.closesAt, 10)).toEqual([]);
  });
});

describe('the entity event stream feeds the waits', () => {
  function runUpdated(status: string): EntityEventEnvelope {
    return {
      eventId: '9a7b3c2d-1e0f-4a5b-8c6d-7e8f9a0b1c2d',
      eventType: 'entity.run.updated',
      spaceId: SPACE,
      tenantId: TENANT,
      timestamp: T0 + 5_000,
      workflowRunId: RUN,
      payload: { runId: RUN, status },
      summary: `Workflow run ${status}`,
    };
  }

  it('records a run that ended as run.ended, in the append itself', async () => {
    await appendEntityEvent(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      event: runUpdated('completed'),
    });

    const ref = { tenantId: TENANT, spaceId: SPACE, kind: 'run.ended' as const, subject: RUN };
    expect(await readRecordedWaitEvent(redis, ref)).toEqual({
      kind: 'run.ended',
      subject: RUN,
      firedAt: T0 + 5_000,
      detail: { status: 'completed' },
    });
    expect(
      await registerWait(redis, wait({ kind: 'run.ended', subject: RUN, since: T0 })),
    ).toMatchObject({
      state: 'woken',
      outcome: { endedBy: 'event' },
    });
  });

  it('records nothing for a run that has not ended', async () => {
    await appendEntityEvent(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      event: runUpdated('running'),
    });

    expect(await redis.zcard(WAIT_FIRED_SUBJECTS_KEY)).toBe(0);
  });
});
