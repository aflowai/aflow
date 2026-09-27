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

import { commitReExecutePausedTaskAndResume } from '../ledger.js';
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

const COMMON_ARGS = {
  runId: '11111111-2222-3333-4444-555555555555',
  claimToken: 'claim-abc',
  taskId: 'submit-call',
  expectedAttempt: 1,
};

const PAUSED_ROW = {
  status: 'paused' as const,
  attempt: 1,
  completedAt: new Date('2026-06-02T10:00:00.000Z'),
  failureReason: 'Kaggle MCP unreachable',
  summary: 'Paused on transient external dependency.',
};

describe('commitReExecutePausedTaskAndResume — Plan 171 §2.2.1', () => {
  it("returns 'committed' when both the run CAS and the task UPDATE hit one row", async () => {
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: PAUSED_ROW,
        runReturning: [{ id: 'run-row-id' }],
        taskReturning: [{ id: 'task-row-id' }],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(capturedTx);
    });

    const result = await commitReExecutePausedTaskAndResume({} as never, 'tenant', {
      ...COMMON_ARGS,
      remediationNote: 'Verified Kaggle MCP connectivity restored.',
    });
    expect(result).toBe('committed');
    expect(capturedTx).toBeDefined();
    expect(capturedTx!.selects).toBe(1);
    expect(capturedTx!.updates).toHaveLength(2);

    // Run row: paused → running under the live claim, claim cleared,
    // paused metadata cleared. Same shape as commitReplaceOutputAndResume.
    expect(capturedTx!.updates[0]!.table).toBe('workflowRuns');
    expect(capturedTx!.updates[0]!.setValues['status']).toBe('running');
    expect(capturedTx!.updates[0]!.setValues['completedAt']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['resumeClaimToken']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['resumeClaimExpiresAt']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['pausedReason']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['pausedPayloadRef']).toBeNull();
    // No parentInstructionsPatch supplied → no metadata key written.
    expect(capturedTx!.updates[0]!.setValues['metadata']).toBeUndefined();

    // Task row: in-place flip; attempt bumped; pause metadata cleared.
    // Crucially status='running' (NOT 'scheduled') — `claimRetriedTask`
    // CASes on 'running'.
    expect(capturedTx!.updates[1]!.table).toBe('workflowRunTasks');
    expect(capturedTx!.updates[1]!.setValues['status']).toBe('running');
    expect(capturedTx!.updates[1]!.setValues['attempt']).toBe(2);
    expect(capturedTx!.updates[1]!.setValues['completedAt']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['outputRef']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['summary']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['failureReason']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['durationMs']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['workerSessionId']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['stepExecutionId']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['sessionId']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['startedAt']).toBeNull();
    expect(capturedTx!.updates[1]!.setValues['dispatchAttemptToken']).toBeNull();
    // priorFailures appended via sql fragment.
    expect(capturedTx!.updates[1]!.setValues['priorFailures']).toBeDefined();
  });

  it('writes a metadata.parentInstructions merge when parentInstructionsPatch is supplied', async () => {
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: PAUSED_ROW,
        runReturning: [{ id: 'run-row-id' }],
        taskReturning: [{ id: 'task-row-id' }],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(capturedTx);
    });

    const result = await commitReExecutePausedTaskAndResume({} as never, 'tenant', {
      ...COMMON_ARGS,
      parentInstructionsPatch: { runLevel: 'Try a smaller batch on retry.' },
    });
    expect(result).toBe('committed');
    // Metadata sql fragment was written on the run-row update.
    expect(capturedTx!.updates[0]!.setValues['metadata']).toBeDefined();
  });

  it('deletes blocked descendant rows and matching completion-pending rows in the same transaction', async () => {
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: PAUSED_ROW,
        runReturning: [{ id: 'run-row-id' }],
        taskReturning: [{ id: 'task-row-id' }],
        taskDeleteReturning: [{ taskId: 'poll-lb-score' }, { taskId: 'record-learnings' }],
        workflowRunsToken,
        workflowRunTasksToken,
        workflowRunCompletionPendingToken,
      });
      return fn(capturedTx);
    });

    const result = await commitReExecutePausedTaskAndResume({} as never, 'tenant', {
      ...COMMON_ARGS,
      descendantTaskIds: ['poll-lb-score', 'extract-learnings', 'record-learnings'],
    });

    expect(result).toBe('committed');
    expect(capturedTx!.deletes).toEqual([
      { table: 'workflowRunTasks' },
      { table: 'workflowRunCompletionPending' },
    ]);
  });

  it("returns 'task_row_not_paused' when the task row is not in paused state", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: { ...PAUSED_ROW, status: 'succeeded' },
        runReturning: [],
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitReExecutePausedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_not_paused');
  });

  it("returns 'task_row_not_paused' when row.attempt drifted past expectedAttempt", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: { ...PAUSED_ROW, attempt: 2 },
        runReturning: [],
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitReExecutePausedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_not_paused');
  });

  it("returns 'task_row_not_paused' when the row select returns no row", async () => {
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

    const result = await commitReExecutePausedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_not_paused');
  });

  it("returns 'claim_lost' when the run-row CAS misses (stale claim / expired lease)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: PAUSED_ROW,
        runReturning: [], // CAS missed → claim lost
        taskReturning: [],
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitReExecutePausedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('claim_lost');
  });

  it("returns 'task_row_not_paused' when the task-row UPDATE returns zero rows (concurrent advancement)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: PAUSED_ROW,
        runReturning: [{ id: 'run-row-id' }], // run CAS won
        taskReturning: [], // but task row drifted out from under us
        workflowRunsToken,
        workflowRunTasksToken,
      });
      return fn(tx);
    });

    const result = await commitReExecutePausedTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_not_paused');
  });
});
