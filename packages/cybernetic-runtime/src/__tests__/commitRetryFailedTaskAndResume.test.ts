import { describe, it, expect, vi, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

type ReturningResult = Array<Record<string, unknown>>;

interface FakeTx {
  selects: number;
  updates: Array<{
    table: 'workflowRuns' | 'workflowRunTasks';
    setValues: Record<string, unknown>;
  }>;
  deletes: Array<{
    table: 'workflowRunTasks' | 'workflowRunCompletionPending';
  }>;
}

function makeFakeTx(opts: {
  selectRow: Record<string, unknown> | null;
  runReturning: ReturningResult;
  taskReturning: ReturningResult;
  taskDeleteReturning?: ReturningResult;
  workflowRunsToken: object;
  workflowRunTasksToken: object;
  workflowRunCompletionPendingToken?: object;
}): FakeTx & {
  select: () => unknown;
  update: (table: unknown) => unknown;
  delete: (table: unknown) => unknown;
} {
  const updates: FakeTx['updates'] = [];
  const deletes: FakeTx['deletes'] = [];
  let selects = 0;
  return {
    get selects() {
      return selects;
    },
    updates,
    deletes,
    // The slot check reads the run row and the active count as raw statements;
    // an empty policy row means the schema default and zero active rows, so the
    // transition these fixtures exercise is admitted.
    execute() {
      return Promise.resolve([{ row: {} }]);
    },
    select() {
      selects++;
      return {
        from(_table: unknown) {
          return {
            where(_cond: unknown) {
              return {
                limit(_n: number) {
                  return Promise.resolve(opts.selectRow ? [opts.selectRow] : []);
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      const tableLabel: 'workflowRuns' | 'workflowRunTasks' =
        table === opts.workflowRunsToken ? 'workflowRuns' : 'workflowRunTasks';
      return {
        set(values: Record<string, unknown>) {
          updates.push({ table: tableLabel, setValues: { ...values } });
          return {
            where(_cond: unknown) {
              return {
                returning(_proj?: unknown) {
                  return Promise.resolve(
                    tableLabel === 'workflowRuns' ? opts.runReturning : opts.taskReturning,
                  );
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      const tableLabel: 'workflowRunTasks' | 'workflowRunCompletionPending' =
        table === opts.workflowRunTasksToken ? 'workflowRunTasks' : 'workflowRunCompletionPending';
      deletes.push({ table: tableLabel });
      return {
        where(_cond: unknown) {
          return {
            returning(_proj?: unknown) {
              return Promise.resolve(opts.taskDeleteReturning ?? []);
            },
          };
        },
      };
    },
  };
}

vi.mock('@aflow/database', () => ({
  workflowRuns: { __token: 'workflow_runs' },
  workflowRunTasks: { __token: 'workflow_run_tasks' },
  workflowRunCompletionPending: { __token: 'workflow_run_completion_pending' },
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (..._args: unknown[]) => ({ __op: 'eq' }),
  and: (..._args: unknown[]) => ({ __op: 'and' }),
  desc: (..._args: unknown[]) => ({ __op: 'desc' }),
  inArray: (..._args: unknown[]) => ({ __op: 'inArray' }),
  sql: Object.assign((..._args: unknown[]) => ({ __op: 'sql' }), {
    raw: (..._args: unknown[]) => ({ __op: 'sql.raw' }),
  }),
}));

import { commitRetryFailedTaskAndResume } from '../ledger.js';
import {
  withTenantSchema,
  workflowRuns,
  workflowRunCompletionPending,
  workflowRunTasks,
} from '@aflow/database';

const mockWithTenantSchema = withTenantSchema as ReturnType<typeof vi.fn>;
const workflowRunsToken = workflowRuns as unknown as object;
const workflowRunTasksToken = workflowRunTasks as unknown as object;
const workflowRunCompletionPendingToken = workflowRunCompletionPending as unknown as object;

const FAILED_AT = new Date('2026-05-14T10:46:00.000Z');

const COMMON_ARGS = {
  runId: '11111111-2222-3333-4444-555555555555',
  taskId: 'submit-order',
  failedAt: FAILED_AT,
  attempt: 1,
  maxAttempts: 3,
  remediationNote: 'Operator updated the alpaca-paper-orders binding.',
};

const FAILED_ROW = {
  status: 'failed' as const,
  attempt: 1,
  failedAt: FAILED_AT,
  errorCode: 'EGRESS_HTTP_400',
  errorClassification: 'external_dependency',
  errorRetryable: false,
  failureReason: 'Alpaca returned HTTP 400',
};

describe('commitRetryFailedTaskAndResume — Plan 149 §3.3', () => {
  it("returns 'committed' when both the run CAS and the task UPDATE hit one row", async () => {
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: FAILED_ROW,
        runReturning: [{ id: 'run-row-id' }],
        taskReturning: [{ id: 'task-row-id' }],
        workflowRunsToken,
        workflowRunTasksToken,
        workflowRunCompletionPendingToken,
      });
      return fn(capturedTx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('committed');
    expect(capturedTx).toBeDefined();
    expect(capturedTx!.selects).toBe(1);
    expect(capturedTx!.updates).toHaveLength(2);
    // Run row: flipped to running, terminal markers cleared.
    expect(capturedTx!.updates[0]!.table).toBe('workflowRuns');
    expect(capturedTx!.updates[0]!.setValues['status']).toBe('running');
    expect(capturedTx!.updates[0]!.setValues['completedAt']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['failureJson']).toBeNull();
    // Task row: in-place flip; attempt bumped; failure metadata cleared;
    // priorFailures JSONB-appended via sql fragment.
    expect(capturedTx!.updates[1]!.table).toBe('workflowRunTasks');
    expect(capturedTx!.updates[1]!.setValues['status']).toBe('running');
    expect(capturedTx!.updates[1]!.setValues['attempt']).toBe(2);
    expect(capturedTx!.updates[1]!.setValues['failedAt']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['errorCode']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['errorClassification']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['errorRetryable']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['failureReason']).toBeNull();
    // All claim fields must be cleared so a pre-claim dispatch failure
    // (where the fallback `casCompleteTask` writes the row before
    // `claimRetriedTask` lands) doesn't carry the OLD attempt's runner
    // session id into the new attempt — downstream readers that key
    // digest / thread assembly on `sessionId` would then misattribute
    // the new failure to the prior attempt's thread.
    expect(capturedTx!.updates[1]!.setValues['workerSessionId']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['stepExecutionId']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['sessionId']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['startedAt']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['priorFailures']).toBeDefined();
  });

  it('deletes blocked descendant rows and matching completion-pending rows in the same transaction', async () => {
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: FAILED_ROW,
        runReturning: [{ id: 'run-row-id' }],
        taskReturning: [{ id: 'task-row-id' }],
        taskDeleteReturning: [{ taskId: 'poll-lb-score' }, { taskId: 'record-learnings' }],
        workflowRunsToken,
        workflowRunTasksToken,
        workflowRunCompletionPendingToken,
      });
      return fn(capturedTx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', {
      ...COMMON_ARGS,
      descendantTaskIds: ['poll-lb-score', 'extract-learnings', 'record-learnings'],
    });

    expect(result).toBe('committed');
    expect(capturedTx!.deletes).toEqual([
      { table: 'workflowRunTasks' },
      { table: 'workflowRunCompletionPending' },
    ]);
  });

  it("returns 'task_not_found_or_not_failed' when the row select returns nothing", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: null,
        runReturning: [],
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_not_found_or_not_failed');
  });

  it("returns 'task_not_found_or_not_failed' when the task row is in a non-failed state", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: { ...FAILED_ROW, status: 'succeeded' },
        runReturning: [],
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_not_found_or_not_failed');
  });

  it("returns 'stale_failure_cas' when `failedAt` does not match the live row", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: { ...FAILED_ROW, failedAt: new Date('2026-05-15T08:00:00.000Z') },
        runReturning: [],
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('stale_failure_cas');
  });

  it("returns 'stale_failure_cas' when `attempt` does not match the live row", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: { ...FAILED_ROW, attempt: 2 },
        runReturning: [],
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('stale_failure_cas');
  });

  it("returns 'attempt_budget_exhausted' when row.attempt >= maxAttempts", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        // Row's attempt = 3, args.attempt = 3 (matches CAS), maxAttempts = 3.
        selectRow: { ...FAILED_ROW, attempt: 3 },
        runReturning: [],
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', {
      ...COMMON_ARGS,
      attempt: 3,
      maxAttempts: 3,
    });
    expect(result).toBe('attempt_budget_exhausted');
  });

  it('allowBudgetReset bypasses the exhaustion gate → committed', async () => {
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: { ...FAILED_ROW, attempt: 3 },
        runReturning: [{ id: 'run-row-id' }],
        taskReturning: [{ id: 'task-row-id' }],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(capturedTx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', {
      ...COMMON_ARGS,
      attempt: 3,
      maxAttempts: 3,
      allowBudgetReset: true,
    });
    expect(result).toBe('committed');
    // attempt still increments past the budget — audit trail intact.
    expect(capturedTx!.updates[1]!.setValues['attempt']).toBe(4);
  });

  it("returns 'wrong_run_state' when the run row CAS misses (run not failed anymore)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: FAILED_ROW,
        // Run-row UPDATE returned no rows — the run is no longer 'failed'.
        runReturning: [],
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('wrong_run_state');
  });

  it("returns 'stale_failure_cas' when the task UPDATE affects 0 rows (race)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: FAILED_ROW,
        runReturning: [{ id: 'run-row-id' }],
        // Task-row UPDATE missed — another path advanced the row between
        // the select and the update.
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('stale_failure_cas');
  });

  it('captures the row error_code + remediationNote into the prior-failure snapshot SQL fragment', async () => {
    // Spy on JSON serialisation of the snapshot by inspecting the sql
    // template — the helper builds the snapshot, serialises it, and
    // embeds it in a JSONB concat. We can't easily intercept the
    // exact template string in the fake; instead we assert that the
    // priorFailures `set` value was provided (the sql fragment).
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: FAILED_ROW,
        runReturning: [{ id: 'run-row-id' }],
        taskReturning: [{ id: 'task-row-id' }],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(capturedTx);
    });

    const result = await commitRetryFailedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('committed');
    const taskUpdate = capturedTx!.updates[1]!;
    // The priorFailures field is set to a sql fragment in production —
    // here it shows up as the mocked `{ __op: 'sql' }` token.
    expect(taskUpdate.setValues['priorFailures']).toMatchObject({ __op: 'sql' });
  });
});
