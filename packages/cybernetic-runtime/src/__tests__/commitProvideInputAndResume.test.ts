import { describe, it, expect, vi } from 'vitest';

type ReturningResult = Array<Record<string, unknown>>;

interface FakeTx {
  updates: Array<{ table: 'workflowRuns'; setValues: Record<string, unknown> }>;
  deletes: Array<{ table: 'workflowRunTasks' | 'workflowRunCompletionPending' }>;
}

function makeFakeTx(
  runReturning: ReturningResult,
  taskDeleteReturning: ReturningResult,
  workflowRunsToken: object,
  workflowRunTasksToken: object,
  workflowRunCompletionPendingToken: object,
): FakeTx & {
  update: (table: unknown) => unknown;
  delete: (table: unknown) => unknown;
} {
  const updates: FakeTx['updates'] = [];
  const deletes: FakeTx['deletes'] = [];
  const tx = {
    updates,
    deletes,
    update(table: unknown) {
      const isRunTable = table === workflowRunsToken;
      // Helper only updates workflow_runs.
      const tableLabel: 'workflowRuns' = isRunTable ? 'workflowRuns' : ('workflowRuns' as const);
      return {
        set(values: Record<string, unknown>) {
          updates.push({ table: tableLabel, setValues: { ...values } });
          return {
            where(_cond: unknown) {
              return {
                returning(_proj?: unknown) {
                  return Promise.resolve(runReturning);
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      // Phase 3 review fix (P1) — helper now deletes BOTH the paused
      // workflow_run_tasks row AND any matching
      // workflow_run_completion_pending rows for the task (the FK on
      // that table targets workflow_runs only, so no cascade).
      let tableLabel: 'workflowRunTasks' | 'workflowRunCompletionPending';
      if (table === workflowRunCompletionPendingToken) {
        tableLabel = 'workflowRunCompletionPending';
      } else if (table === workflowRunTasksToken) {
        tableLabel = 'workflowRunTasks';
      } else {
        tableLabel = 'workflowRunTasks';
      }
      deletes.push({ table: tableLabel });
      // Only the task-row DELETE has a `.returning()`; the
      // completion_pending DELETE in the helper does not. We expose
      // returning on both for shape consistency; the helper only
      // consumes it on the first delete.
      return {
        where(_cond: unknown) {
          return {
            returning(_proj?: unknown) {
              return Promise.resolve(taskDeleteReturning);
            },
          };
        },
      };
    },
  };
  return tx;
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

import { commitProvideInputAndResume } from '../ledger.js';
import {
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
  workflowRunCompletionPending,
} from '@aflow/database';

const mockWithTenantSchema = withTenantSchema as ReturnType<typeof vi.fn>;
const workflowRunsToken = workflowRuns as unknown as object;
const workflowRunTasksToken = workflowRunTasks as unknown as object;
const workflowRunCompletionPendingToken = workflowRunCompletionPending as unknown as object;

const COMMON_ARGS = {
  runId: '11111111-2222-3333-4444-555555555555',
  claimToken: 'claim-1',
  taskId: 'elicit-target',
  parentTaskInputs: { taskId: 'elicit-target', inputs: { vendor: 'Alpaca' } },
};

describe('commitProvideInputAndResume — Plan 141 §4.2 / Phase 3', () => {
  it("returns 'committed' when both the run CAS and the task delete hit one row", async () => {
    let capturedTx:
      | (FakeTx & { update: (table: unknown) => unknown; delete: (table: unknown) => unknown })
      | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx(
        [{ id: 'run-row-id' }],
        [{ id: 'task-row-id' }],
        workflowRunsToken,
        workflowRunTasksToken,
        workflowRunCompletionPendingToken,
      );
      return fn(capturedTx);
    });

    const result = await commitProvideInputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('committed');
    expect(capturedTx).toBeDefined();
    expect(capturedTx!.updates).toHaveLength(1);
    // Two deletes: paused task row + matching completion_pending row(s).
    expect(capturedTx!.deletes).toHaveLength(2);
    // Run row commit transitions paused → running and clears pause fields.
    expect(capturedTx!.updates[0]!.setValues['status']).toBe('running');
    expect(capturedTx!.updates[0]!.setValues['pausedReason']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['pausedPayloadRef']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['resumeClaimToken']).toBeNull();
    // Metadata merge stamps a JSONB SQL fragment (`__op: 'sql'` token).
    expect(capturedTx!.updates[0]!.setValues['metadata']).toBeDefined();
    expect(capturedTx!.deletes[0]!.table).toBe('workflowRunTasks');
    expect(capturedTx!.deletes[1]!.table).toBe('workflowRunCompletionPending');
  });

  it("returns 'claim_lost' when the run-row CAS misses (lease expired / repaused)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx(
        [], // run CAS missed
        [{ id: 'task-row-id' }],
        workflowRunsToken,
        workflowRunTasksToken,
        workflowRunCompletionPendingToken,
      );
      return fn(tx);
    });

    const result = await commitProvideInputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('claim_lost');
  });

  it("returns 'task_row_not_paused' when the task DELETE affects 0 rows", async () => {
    let capturedTx:
      | (FakeTx & { update: (table: unknown) => unknown; delete: (table: unknown) => unknown })
      | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx(
        [{ id: 'run-row-id' }],
        [], // task DELETE missed — row not 'paused' (or vanished)
        workflowRunsToken,
        workflowRunTasksToken,
        workflowRunCompletionPendingToken,
      );
      return fn(capturedTx);
    });

    const result = await commitProvideInputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_not_paused');
    // The helper attempted the run-row write + task DELETE inside the tx;
    // real Drizzle rollback semantics handle the run-row revert. The
    // pending-row delete is NOT reached because the task-row-not-paused
    // throw fires first.
    expect(capturedTx!.updates).toHaveLength(1);
    expect(capturedTx!.deletes).toHaveLength(1);
  });

  it("returns 'task_row_not_paused' when more than one task row would match (defensive)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx(
        [{ id: 'run-row-id' }],
        [{ id: 'task-1' }, { id: 'task-2' }],
        workflowRunsToken,
        workflowRunTasksToken,
        workflowRunCompletionPendingToken,
      );
      return fn(tx);
    });

    const result = await commitProvideInputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_not_paused');
  });

  it('deletes the matching workflow_run_completion_pending rows on commit (P1 review fix)', async () => {
    let capturedTx:
      | (FakeTx & { update: (table: unknown) => unknown; delete: (table: unknown) => unknown })
      | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx(
        [{ id: 'run-row-id' }],
        [{ id: 'task-row-id' }],
        workflowRunsToken,
        workflowRunTasksToken,
        workflowRunCompletionPendingToken,
      );
      return fn(capturedTx);
    });

    const result = await commitProvideInputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('committed');
    // Two deletes: the paused task row, then the completion_pending row(s).
    expect(capturedTx!.deletes).toHaveLength(2);
    expect(capturedTx!.deletes[0]!.table).toBe('workflowRunTasks');
    expect(capturedTx!.deletes[1]!.table).toBe('workflowRunCompletionPending');
  });
});
