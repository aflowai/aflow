/**
 * Coach-gate run counting excludes frozen eval-batch trials: both
 * `getRunStatistics` (Coach dispatch, skill budget/read surfaces) and
 * `countProductionRuns` (the post-run hook's bootstrap-gate count) must
 * carry the `eval_batch_id IS NULL` production filter — a batch of trials
 * must not fast-forward a skill through the Coach bootstrap window.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const capturedWhere: unknown[] = [];

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const fakeTx = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          capturedWhere.push(cond);
          return Promise.resolve([{ totalRuns: 0, completedRuns: 0, failedRuns: 0, count: 0 }]);
        },
      }),
    }),
  };
  return {
    ...actual,
    withTenantSchema: async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
      cb(fakeTx),
  };
});

import { countProductionRuns, getRunStatistics } from '../ledger/queries.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '33333333-3333-4333-8333-333333333333';

function renderedWhere(): string {
  expect(capturedWhere).toHaveLength(1);
  return new PgDialect().sqlToQuery(capturedWhere[0] as SQL).sql;
}

beforeEach(() => {
  capturedWhere.length = 0;
});

describe('production-run counting excludes eval-batch trials', () => {
  it('getRunStatistics filters eval_batch_id IS NULL', async () => {
    await getRunStatistics({} as never, TENANT, SPACE, 'daily-metrics', { windowDays: 30 });
    expect(renderedWhere()).toContain('"eval_batch_id" is null');
  });

  it('countProductionRuns filters eval_batch_id IS NULL', async () => {
    await countProductionRuns({} as never, TENANT, SPACE, 'daily-metrics');
    expect(renderedWhere()).toContain('"eval_batch_id" is null');
  });
});
