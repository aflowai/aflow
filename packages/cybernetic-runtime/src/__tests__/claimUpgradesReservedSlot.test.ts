/**
 * A dispatch claim runs against a row its scheduler already reserved, so it can
 * no longer be an insert-or-skip: skipping would strand the slot and never
 * dispatch the task. It upgrades the reserved row and nothing else — the guard
 * is what still makes a losing racer return false.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { claimAndSchedule, claimHumanTask } from '../ledger/claims.js';
import { RESERVED_TASK_STATUS } from '../ledger/concurrencySlots.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const RUN_ID = 'run-1';
const ROW_ID = '11111111-1111-1111-1111-111111111111';

interface Captured {
  query: string;
  params: readonly unknown[];
}

/** A real drizzle instance over a fake postgres-js client. */
function fakeDb(rowsPerStatement: unknown[][][]): {
  db: PostgresJsDatabase;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const queue = [...rowsPerStatement];
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

function claimStatement(captured: Captured[]): Captured {
  const statement = captured.find((entry) => entry.query.includes('on conflict'));
  expect(statement).toBeDefined();
  return statement!;
}

describe('claimAndSchedule', () => {
  it('upgrades the reserved row rather than skipping it', async () => {
    const { db, captured } = fakeDb([[[ROW_ID]], []]);

    const claimed = await claimAndSchedule(db, TENANT_ID, {
      runId: RUN_ID,
      taskId: 'task-a',
      attempt: 1,
      workerSessionId: '22222222-2222-2222-2222-222222222222',
      dispatchAttemptToken: 'dispatch:run-1:task-a:1',
      inputRef: 'inline:x',
      dueAt: new Date(0),
      operationId: 'ai.text.generate',
    });

    const { query, params } = claimStatement(captured);
    expect(query).toContain('do update set');
    expect(query).toContain(`"status" = excluded.status`);
    expect(query).toContain(`"worker_session_id" = excluded.worker_session_id`);
    expect(query).toMatch(/where workflow_run_tasks\.status = \$\d+ returning/);
    expect(params).toContain(RESERVED_TASK_STATUS);
    expect(claimed).toBe(true);
  });

  it('reports a loss when the guard rejects the row', async () => {
    const { db } = fakeDb([[]]);

    await expect(
      claimAndSchedule(db, TENANT_ID, {
        runId: RUN_ID,
        taskId: 'task-a',
        attempt: 1,
        workerSessionId: '22222222-2222-2222-2222-222222222222',
        dispatchAttemptToken: 'dispatch:run-1:task-a:1',
        inputRef: 'inline:x',
        dueAt: new Date(0),
      }),
    ).resolves.toBe(false);
  });

  it('does not arm completion supervision for a claim it lost', async () => {
    const { db, captured } = fakeDb([[]]);

    await claimAndSchedule(db, TENANT_ID, {
      runId: RUN_ID,
      taskId: 'task-a',
      attempt: 1,
      workerSessionId: '22222222-2222-2222-2222-222222222222',
      dispatchAttemptToken: 'dispatch:run-1:task-a:1',
      inputRef: 'inline:x',
      dueAt: new Date(0),
    });

    expect(
      captured.some((entry) => entry.query.includes('"workflow_run_completion_pending"')),
    ).toBe(false);
  });
});

describe('claimHumanTask', () => {
  it('upgrades the reserved row into a pause under the same guard', async () => {
    const { db, captured } = fakeDb([[[ROW_ID]]]);

    const claimed = await claimHumanTask(db, TENANT_ID, {
      runId: RUN_ID,
      taskId: 'task-h',
      attempt: 1,
      inputRef: 'inline:h',
      humanTaskHydrationRef: 'inline:hyd',
      humanTaskHydrationPauseVersion: 2,
      humanTaskHydrationAttempt: 1,
    });

    const { query, params } = claimStatement(captured);
    expect(query).toContain('do update set');
    expect(query).toContain(`"human_task_hydration_ref" = excluded.human_task_hydration_ref`);
    expect(query).toMatch(/where workflow_run_tasks\.status = \$\d+ returning/);
    expect(params).toContain(RESERVED_TASK_STATUS);
    expect(claimed).toBe(true);
  });
});
