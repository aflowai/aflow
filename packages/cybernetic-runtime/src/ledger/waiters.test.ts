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

import { addWaiter } from './waiters.js';

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
