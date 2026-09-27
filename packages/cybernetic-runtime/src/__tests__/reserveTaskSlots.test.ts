/**
 * The reservation is only worth anything if the database serializes it: the run
 * row is locked, the active count is read behind that lock, and the claims land
 * in the same transaction. These render the real statements without a database.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  hasFreeSlotForTask,
  reserveTaskSlots,
  SLOT_HOLDING_TASK_STATUSES,
} from '../ledger/concurrencySlots.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const RUN_ID = 'run-1';
const READY = ['task-a', 'task-b', 'task-c', 'task-d', 'task-e'];

interface Captured {
  query: string;
  params: readonly unknown[];
}

/**
 * A real drizzle instance over a fake postgres-js client: statements are built
 * and rendered for real, nothing reaches a database.
 */
function fakeDb(results: unknown[][]): { db: PostgresJsDatabase; captured: Captured[] } {
  const captured: Captured[] = [];
  const queue = [...results];
  const client: Record<string, unknown> = Object.assign(
    () => {
      throw new Error('tagged-template query is not expected');
    },
    {
      unsafe: (query: string, params: readonly unknown[]) => {
        captured.push({ query, params });
        const rows = query.includes('search_path') ? [] : (queue.shift() ?? []);
        const pending = Promise.resolve(rows);
        return Object.assign(pending, { values: () => Promise.resolve(rows) });
      },
      begin: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
      options: { parsers: {}, serializers: {} },
    },
  );
  return { db: drizzle(client as unknown as postgres.Sql), captured };
}

/**
 * run-row read, active count, claim insert — in the order the helper issues them.
 *
 * The run row comes back as whole-row jsonb, so an unmigrated tenant simply has
 * no `effective_concurrency_policy` key rather than raising mid-transaction.
 */
function staged(policy: unknown, activeCount: number, claimedTaskIds: string[]): unknown[][] {
  const runRow = policy === undefined ? {} : { effective_concurrency_policy: policy };
  return [[{ row: runRow }], [{ count: activeCount }], claimedTaskIds.map((taskId) => [taskId])];
}

function statementsAgainst(captured: Captured[], table: string): Captured[] {
  return captured.filter((entry) => entry.query.includes(`"${table}"`));
}

describe('reserveTaskSlots', () => {
  it('locks the run row before reading the active count', async () => {
    const { db, captured } = fakeDb(staged({ maxParallelTasksPerRun: 4 }, 1, ['task-a']));

    await reserveTaskSlots(db, TENANT_ID, { runId: RUN_ID, readyTaskIds: READY });

    const runRead = statementsAgainst(captured, 'workflow_runs')[0];
    expect(runRead?.query.toLowerCase()).toContain('for update');
    expect(runRead?.params).toEqual([RUN_ID]);
    const runIndex = captured.findIndex((entry) => entry.query.includes('"workflow_runs"'));
    const countIndex = captured.findIndex((entry) => entry.query.includes('count(*)'));
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(countIndex).toBeGreaterThan(runIndex);
  });

  it('counts only dispatched, non-terminal rows of this run', async () => {
    const { db, captured } = fakeDb(staged({ maxParallelTasksPerRun: 4 }, 1, ['task-a']));

    await reserveTaskSlots(db, TENANT_ID, { runId: RUN_ID, readyTaskIds: READY });

    const count = captured.find((entry) => entry.query.includes('count(*)'));
    expect(count?.params).toEqual([RUN_ID]);
    // Derived from the shared set, so a status added there is counted here too.
    for (const status of SLOT_HOLDING_TASK_STATUSES) {
      expect(count?.query).toContain(`'${status}'`);
    }
    for (const terminal of ['succeeded', 'failed', 'cancelled', 'skipped']) {
      expect(count?.query).not.toContain(`'${terminal}'`);
    }
  });

  it('claims exactly the tasks the free slots buy, in the same transaction', async () => {
    const { db, captured } = fakeDb(
      staged({ maxParallelTasksPerRun: 4 }, 1, ['task-a', 'task-b', 'task-c']),
    );

    const reservation = await reserveTaskSlots(db, TENANT_ID, {
      runId: RUN_ID,
      readyTaskIds: READY,
    });

    const insert = captured.find((entry) => entry.query.startsWith('insert into'));
    // Five params per reserved row: the last is the dispatch deadline, which
    // makes a reservation that never became a dispatch visible to recovery.
    const params = insert?.params ?? [];
    expect(params).toHaveLength(15);
    const rows = [0, 1, 2].map((i) => params.slice(i * 5, i * 5 + 5));
    expect(rows.map((row) => row.slice(0, 4))).toEqual([
      [RUN_ID, 'task-a', 'scheduled', 1],
      [RUN_ID, 'task-b', 'scheduled', 1],
      [RUN_ID, 'task-c', 'scheduled', 1],
    ]);
    for (const row of rows) {
      expect(Number.isNaN(Date.parse(String(row[4])))).toBe(false);
      expect(Date.parse(String(row[4]))).toBeGreaterThan(Date.now());
    }
    expect(reservation).toEqual({
      reserved: ['task-a', 'task-b', 'task-c'],
      deferred: ['task-d', 'task-e'],
      limit: 4,
      activeCount: 1,
    });
    // One `begin` for the whole helper — the lock is still held at the insert.
    expect(captured.filter((entry) => entry.query.includes('search_path'))).toHaveLength(1);
  });

  it('claims nothing once the run is at its limit', async () => {
    const { db, captured } = fakeDb(staged({ maxParallelTasksPerRun: 2 }, 2, []));

    const reservation = await reserveTaskSlots(db, TENANT_ID, {
      runId: RUN_ID,
      readyTaskIds: READY,
    });

    expect(captured.some((entry) => entry.query.startsWith('insert into'))).toBe(false);
    expect(reservation).toEqual({ reserved: [], deferred: READY, limit: 2, activeCount: 2 });
  });

  it('reads the limit off the pinned run row, defaulting when it is NULL', async () => {
    const { db } = fakeDb(staged(null, 0, ['task-a', 'task-b', 'task-c', 'task-d']));

    const reservation = await reserveTaskSlots(db, TENANT_ID, {
      runId: RUN_ID,
      readyTaskIds: READY,
    });

    expect(reservation.limit).toBe(4);
    expect(reservation.reserved).toHaveLength(4);
    expect(reservation.deferred).toEqual(['task-e']);
  });

  it('defers a task another pass already has a row for', async () => {
    const { db } = fakeDb(staged({ maxParallelTasksPerRun: 4 }, 0, ['task-a', 'task-c', 'task-d']));

    const reservation = await reserveTaskSlots(db, TENANT_ID, {
      runId: RUN_ID,
      readyTaskIds: READY,
    });

    expect(reservation.reserved).toEqual(['task-a', 'task-c', 'task-d']);
    expect(reservation.deferred).toEqual(['task-b', 'task-e']);
  });

  it('touches the database at all only when something is ready', async () => {
    const { db, captured } = fakeDb([]);

    expect(await reserveTaskSlots(db, TENANT_ID, { runId: RUN_ID, readyTaskIds: [] })).toEqual({
      reserved: [],
      deferred: [],
      limit: 0,
      activeCount: 0,
    });
    expect(captured).toHaveLength(0);
  });
});

describe('hasFreeSlotForTask', () => {
  const runRow = (policy: unknown) => [
    { row: policy === null ? {} : { effective_concurrency_policy: policy } },
  ];

  it('excludes the asking task from the count it is asking against', async () => {
    // The row is about to transition INTO a slot; counting it would make a run
    // at limit-1 look full and refuse its own retry forever.
    const { db, captured } = fakeDb([runRow(null), [{ count: 3 }]]);
    await hasFreeSlotForTask(db, 'run-1', 'task-a');
    const count = captured.find((c) => c.query.includes('count(*)'));
    expect(count?.query).toContain('<>');
    expect(count?.params).toContain('task-a');
  });

  it('refuses when every slot is taken', async () => {
    const { db } = fakeDb([runRow({ maxParallelTasksPerRun: 2 }), [{ count: 2 }]]);
    expect(await hasFreeSlotForTask(db, 'run-1', 'task-a')).toBe(false);
  });

  it('admits while a slot is free', async () => {
    const { db } = fakeDb([runRow({ maxParallelTasksPerRun: 2 }), [{ count: 1 }]]);
    expect(await hasFreeSlotForTask(db, 'run-1', 'task-a')).toBe(true);
  });

  it('locks the run row before counting', async () => {
    const { db, captured } = fakeDb([runRow(null), [{ count: 0 }]]);
    await hasFreeSlotForTask(db, 'run-1', 'task-a');
    const lockIndex = captured.findIndex((c) => c.query.toLowerCase().includes('for update'));
    const countIndex = captured.findIndex((c) => c.query.includes('count(*)'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(countIndex).toBeGreaterThan(lockIndex);
  });
});
