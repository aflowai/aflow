/**
 * The terminal write of a run. A failed run is written with the failure that
 * ended it, and a caller that reached its verdict from an earlier read of the
 * run can bind the write to that read through the scheduler cursor version.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { completeRun } from '../ledger/runs.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const RUN_ID = 'run-1';

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

function updateStatement(captured: Captured[]): Captured {
  const statement = captured.find((entry) => entry.query.startsWith('update'));
  expect(statement).toBeDefined();
  return statement!;
}

describe('completeRun', () => {
  it('writes the failure that ended a failed run to failure_json', async () => {
    const { db, captured } = fakeDb([[[RUN_ID]]]);

    const landed = await completeRun(db, TENANT_ID, {
      runId: RUN_ID,
      status: 'failed',
      completedAt: new Date(0),
      failure: {
        reason: 'task_failed',
        message: 'The run ended on task push (failed): rejected',
        taskIds: ['push'],
      },
    });

    const { query, params } = updateStatement(captured);
    expect(query).toContain('"failure_json" = $');
    const failureParam = params.find(
      (param) => typeof param === 'string' && param.includes('task_failed'),
    );
    expect(JSON.parse(failureParam as string)).toEqual({
      reason: 'task_failed',
      message: 'The run ended on task push (failed): rejected',
      taskIds: ['push'],
    });
    expect(landed).toBe(true);
  });

  it('leaves failure_json alone on a run that completed', async () => {
    const { db, captured } = fakeDb([[[RUN_ID]]]);

    await completeRun(db, TENANT_ID, {
      runId: RUN_ID,
      status: 'completed',
      completedAt: new Date(0),
    });

    expect(updateStatement(captured).query).not.toContain('failure_json');
  });

  it('lands only while the scheduler cursor version is the one the caller read', async () => {
    // No row matches: a task outcome bumped the version after the caller read it.
    const { db, captured } = fakeDb([[]]);

    const landed = await completeRun(db, TENANT_ID, {
      runId: RUN_ID,
      status: 'failed',
      completedAt: new Date(0),
      failure: { reason: 'workflow_run_orphaned', message: 'No task was in flight.' },
      expectedSchedulerCursorVersion: 4,
    });

    const { query, params } = updateStatement(captured);
    expect(query).toMatch(/"workflow_runs"."scheduler_cursor_version" = \$\d+/);
    expect(params).toContain(4);
    expect(landed).toBe(false);
  });
});
