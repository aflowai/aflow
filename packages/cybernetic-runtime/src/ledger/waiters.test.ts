import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const released: unknown[] = [];
const inserted: unknown[] = [];
vi.mock('@aflow/database', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      update: () => ({
        set: (values: unknown) => ({
          where: () => {
            calls.push('release');
            released.push(values);
            return Promise.resolve();
          },
        }),
      }),
      insert: () => ({
        values: (row: unknown) => ({
          returning: () => {
            calls.push('insert');
            inserted.push(row);
            return Promise.resolve([{ id: 'waiter-new' }]);
          },
        }),
      }),
    }),
  ),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { addWaiter, claimSessionWaiterDelivery } from './waiters.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';

beforeEach(() => {
  calls.length = 0;
  released.length = 0;
  inserted.length = 0;
});

describe('addWaiter', () => {
  it('registers a session with no parked step', async () => {
    await expect(
      addWaiter({} as never, TENANT, { runId: 'run-1', waiterSessionId: 'sess-1' }),
    ).resolves.toBe('waiter-new');

    expect(calls).toEqual(['insert']);
    expect(inserted).toEqual([
      { runId: 'run-1', waiterSessionId: 'sess-1', waiterStepExecutionId: null },
    ]);
  });

  it('moves a session’s own wait onto the step it parks, in one transaction', async () => {
    await addWaiter({} as never, TENANT, {
      runId: 'run-1',
      waiterSessionId: 'sess-1',
      waiterStepExecutionId: 'step-1',
    });

    expect(calls).toEqual(['release', 'insert']);
    expect(released).toEqual([{ notifiedAt: expect.any(Date), notifiedOutcome: 'handed_off' }]);
    expect(inserted).toEqual([
      { runId: 'run-1', waiterSessionId: 'sess-1', waiterStepExecutionId: 'step-1' },
    ]);
  });
});

describe('claimSessionWaiterDelivery', () => {
  function fakeTx(matches: boolean) {
    const seen: { set?: Record<string, unknown>; where?: SQL } = {};
    const tx = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          seen.set = values;
          return {
            where: (condition: SQL) => {
              seen.where = condition;
              return { returning: () => Promise.resolve(matches ? [{ id: 'waiter-1' }] : []) };
            },
          };
        },
      }),
    };
    return { tx: tx as never, seen };
  }

  it('records the key of a pause and leaves the waiter pending', async () => {
    const { tx, seen } = fakeTx(true);
    await expect(
      claimSessionWaiterDelivery(tx, { waiterId: 'waiter-1', deliveryKey: 'paused:2' }),
    ).resolves.toBe(true);
    expect(seen.set).toEqual({ lastDeliveredKey: 'paused:2' });
  });

  it('retires the waiter with the outcome that ends the run', async () => {
    const { tx, seen } = fakeTx(true);
    await claimSessionWaiterDelivery(tx, {
      waiterId: 'waiter-1',
      deliveryKey: 'completed:2',
      retireAs: 'completed',
    });
    expect(seen.set).toEqual({
      lastDeliveredKey: 'completed:2',
      notifiedAt: expect.any(Date),
      notifiedOutcome: 'completed',
    });
  });

  it('claims only a pending session waiter that has not heard this key', async () => {
    const { tx, seen } = fakeTx(false);
    await expect(
      claimSessionWaiterDelivery(tx, { waiterId: 'waiter-1', deliveryKey: 'paused:2' }),
    ).resolves.toBe(false);
    const where = new PgDialect().sqlToQuery(seen.where!);
    expect(where.sql).toContain('"waiter_step_execution_id" is null');
    expect(where.sql).toContain('"notified_at" is null');
    expect(where.sql).toContain('"last_delivered_key" IS DISTINCT FROM');
    expect(where.params).toEqual(['waiter-1', 'paused:2']);
  });
});
