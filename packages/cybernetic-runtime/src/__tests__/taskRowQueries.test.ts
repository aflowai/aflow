/**
 * Task-row reads: the single-row lookup must reach one row in SQL, and the
 * list must stay uncapped — a task completion that scans the run reads every
 * row of every wave, and a capped list answers a readiness question with a
 * silently truncated status set.
 */
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { workflowRunTasks, type WorkflowRunTaskRow } from '@aflow/database';
import { getTaskRow, listTaskRows } from '../ledger/queries.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const RUN_ID = 'run-1';

const ROW: WorkflowRunTaskRow = {
  id: '11111111-1111-1111-1111-111111111111',
  runId: RUN_ID,
  taskId: 'task-a',
  status: 'running',
  attempt: 2,
  sessionId: 'session-1',
  workerSessionId: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
  costCents: null,
  metricsJson: null,
  summary: null,
  failureReason: null,
  outputRef: null,
  reflectionJson: null,
  stepExecutionId: null,
  inputRef: null,
  pendingCompletionAt: null,
  dispatchDeadlineAt: null,
  dispatchAttemptToken: null,
  operationId: null,
  errorCode: null,
  errorClassification: null,
  errorRetryable: null,
  failedAt: null,
  priorFailures: [],
  humanTaskHydrationRef: null,
  humanTaskHydrationPauseVersion: null,
  humanTaskHydrationAttempt: null,
  pollCycle: 1,
};

const COLUMN_KEYS = Object.keys(getTableColumns(workflowRunTasks)) as Array<
  keyof WorkflowRunTaskRow
>;

/** One row as the driver hands it over: positional, in column order. */
function driverRow(overrides: Partial<Record<keyof WorkflowRunTaskRow, unknown>> = {}): unknown[] {
  const row: Record<string, unknown> = { ...ROW, ...overrides };
  return COLUMN_KEYS.map((key) => row[key]);
}

interface Captured {
  query: string;
  params: readonly unknown[];
}

/**
 * A real drizzle instance over a fake postgres-js client: statements are built
 * and rendered for real, nothing reaches a database.
 */
function fakeDb(results: unknown[][][]): { db: PostgresJsDatabase; captured: Captured[] } {
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

function taskRowStatement(captured: Captured[]): Captured {
  const statement = captured.find((entry) => entry.query.includes('"workflow_run_tasks"'));
  expect(statement).toBeDefined();
  return statement!;
}

describe('getTaskRow', () => {
  it('constrains the read to one run and one task in SQL', async () => {
    const { db, captured } = fakeDb([[driverRow()]]);

    await getTaskRow(db, TENANT_ID, RUN_ID, 'task-a');

    const { query, params } = taskRowStatement(captured);
    expect(query).toContain(
      'where ("workflow_run_tasks"."run_id" = $1 and "workflow_run_tasks"."task_id" = $2)',
    );
    expect(params).toEqual([RUN_ID, 'task-a', 1]);
  });

  it('asks the database for a single row', async () => {
    const { db, captured } = fakeDb([[driverRow()]]);

    await getTaskRow(db, TENANT_ID, RUN_ID, 'task-a');

    expect(taskRowStatement(captured).query).toContain('limit $3');
  });

  it('runs inside the tenant schema', async () => {
    const { db, captured } = fakeDb([[driverRow()]]);

    await getTaskRow(db, TENANT_ID, RUN_ID, 'task-a');

    expect(captured[0]?.query).toBe(
      'SET LOCAL search_path TO "t_a0000000000000000000000000000001", public',
    );
  });

  it('projects the row the same way the list does', async () => {
    const { db } = fakeDb([[driverRow({ status: 'paused', attempt: 3 })]]);

    const row = await getTaskRow(db, TENANT_ID, RUN_ID, 'task-a');

    expect(row).toMatchObject({
      runId: RUN_ID,
      taskId: 'task-a',
      status: 'paused',
      attempt: 3,
      sessionId: 'session-1',
      pollCycle: 1,
    });
  });

  it('reports a missing row as null rather than an empty list', async () => {
    const { db } = fakeDb([[]]);

    expect(await getTaskRow(db, TENANT_ID, RUN_ID, 'task-a')).toBeNull();
  });
});

describe('listTaskRows', () => {
  it('reads a run whole — no limit that could truncate the status set', async () => {
    const { db, captured } = fakeDb([[driverRow(), driverRow({ taskId: 'task-b' })]]);

    const rows = await listTaskRows(db, TENANT_ID, RUN_ID);

    const { query, params } = taskRowStatement(captured);
    expect(query).toContain('where "workflow_run_tasks"."run_id" = $1');
    expect(query).not.toContain('limit');
    expect(params).toEqual([RUN_ID]);
    expect(rows.map((row) => row.taskId)).toEqual(['task-a', 'task-b']);
  });
});
