import { describe, it, expect, vi } from 'vitest';

// ── Mock @aflow/database before importing the helper ────────────────
//
// The helper opens a tx via `withTenantSchema`; we shim that to call the
// callback with a stub tx whose `.update().set().where().returning()`
// chain is fully controllable. If the callback throws, we propagate the
// throw — which is exactly what real Drizzle does (and what triggers the
// rollback in production).
type ReturningResult = Array<Record<string, unknown>>;

interface UpdateStub {
  setCalls: Array<Record<string, unknown>>;
  whereCalls: number;
  returning: () => Promise<ReturningResult>;
}

function makeUpdateStub(returningResult: ReturningResult): UpdateStub {
  const stub: UpdateStub = {
    setCalls: [],
    whereCalls: 0,
    returning: () => Promise.resolve(returningResult),
  };
  return stub;
}

interface FakeTx {
  update: (table: unknown) => unknown;
  // Track which update was the run-row update vs task-row update so the
  // test can pin the order and the values applied.
  updates: Array<{
    table: 'workflowRuns' | 'workflowRunTasks';
    setValues: Record<string, unknown>;
  }>;
}

function makeFakeTx(
  runReturning: ReturningResult,
  taskReturning: ReturningResult,
  workflowRunsToken: object,
): FakeTx {
  const updates: FakeTx['updates'] = [];
  let updateCallIndex = 0;
  const tx: FakeTx = {
    updates,
    update(table) {
      const isRunTable = table === workflowRunsToken;
      const tableLabel: 'workflowRuns' | 'workflowRunTasks' = isRunTable
        ? 'workflowRuns'
        : 'workflowRunTasks';
      const isFirstCall = updateCallIndex === 0;
      const returningResult = isFirstCall ? runReturning : taskReturning;
      updateCallIndex += 1;
      const setValues: Record<string, unknown> = {};
      const chain = {
        set(values: Record<string, unknown>) {
          Object.assign(setValues, values);
          updates.push({ table: tableLabel, setValues: { ...values } });
          return {
            where(_cond: unknown) {
              return {
                returning(_proj?: unknown) {
                  return Promise.resolve(returningResult);
                },
              };
            },
          };
        },
      };
      return chain;
    },
  };
  return tx;
}

vi.mock('@aflow/database', () => ({
  // Distinct opaque tokens so the fake tx can tell which table is being
  // updated. Inlined inside the factory because vi.mock is hoisted.
  workflowRuns: { __token: 'workflow_runs' },
  workflowRunTasks: { __token: 'workflow_run_tasks' },
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(),
}));

// Trivial drizzle-orm mock — the helper only uses sql/eq/and as opaque tokens.
vi.mock('drizzle-orm', () => ({
  eq: (..._args: unknown[]) => ({ __op: 'eq' }),
  and: (..._args: unknown[]) => ({ __op: 'and' }),
  desc: (..._args: unknown[]) => ({ __op: 'desc' }),
  inArray: (..._args: unknown[]) => ({ __op: 'inArray' }),
  sql: Object.assign((..._args: unknown[]) => ({ __op: 'sql' }), {
    raw: (..._args: unknown[]) => ({ __op: 'sql.raw' }),
  }),
}));

import { commitReplaceOutputAndResume } from '../ledger.js';
import { withTenantSchema, workflowRuns } from '@aflow/database';

const mockWithTenantSchema = withTenantSchema as ReturnType<typeof vi.fn>;
// Reuse the same token the helper imports — distinct from workflowRunTasks.
const workflowRunsToken = workflowRuns as unknown as object;

const COMMON_ARGS = {
  runId: '11111111-2222-3333-4444-555555555555',
  claimToken: 'claim-1',
  failedTaskId: 'score-task',
  outputRef: 'payload:merged',
  summary: 'resolved via replace_output',
};

describe('commitReplaceOutputAndResume — Plan 130 round 2 P0/2', () => {
  it("returns 'committed' when both run and task updates affect 1 row", async () => {
    let capturedTx: FakeTx | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx(
        [{ id: 'run-row-id' }], // run CAS hit
        [{ id: 'task-row-id' }], // task update hit
        workflowRunsToken,
      );
      // Real Drizzle wraps in a tx; we just forward the callback's outcome
      // (a throw bubbles up the same way, which is what triggers rollback).
      return fn(capturedTx);
    });

    const result = await commitReplaceOutputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('committed');
    expect(capturedTx).toBeDefined();
    expect(capturedTx!.updates).toHaveLength(2);
    expect(capturedTx!.updates[0]!.table).toBe('workflowRuns');
    expect(capturedTx!.updates[1]!.table).toBe('workflowRunTasks');
    // Run-row commit clears the resume metadata (P1/2).
    expect(capturedTx!.updates[0]!.setValues['status']).toBe('running');
    expect(capturedTx!.updates[0]!.setValues['pausedReason']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['pausedPayloadRef']).toBeNull();
    // Task-row commit promotes the failed task to succeeded with the new ref.
    expect(capturedTx!.updates[1]!.setValues['status']).toBe('succeeded');
    expect(capturedTx!.updates[1]!.setValues['outputRef']).toBe('payload:merged');
  });

  it("returns 'claim_lost' when the run-row CAS misses (lease expired / repaused)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx(
        [], // run CAS missed — lease lost
        [{ id: 'task-row-id' }], // would-be task update; never reached
        workflowRunsToken,
      );
      try {
        return await fn(tx);
      } catch (err) {
        // Real Drizzle would have rolled back. Re-throw so the helper's
        // .catch() handler can map the typed error to the typed result.
        throw err;
      }
    });

    const result = await commitReplaceOutputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('claim_lost');
  });

  it("returns 'task_row_not_paused' when the task-row update affects 0 rows (round-2 P0/2)", async () => {
    let capturedTx: FakeTx | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx(
        [{ id: 'run-row-id' }], // run CAS hit
        [], // task update missed — row not in 'paused' state
        workflowRunsToken,
      );
      try {
        return await fn(capturedTx);
      } catch (err) {
        // Real Drizzle would roll back the run-row update too. Re-throw
        // so the helper's catch maps to the typed result.
        throw err;
      }
    });

    const result = await commitReplaceOutputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_not_paused');
    // The helper attempted both updates inside the tx — but the throw
    // propagated out, which (in real Drizzle) rolls back the run-row
    // flip too. The handler reports 'task_row_not_paused' so the
    // resumer can distinguish this from a stale lease.
    expect(capturedTx!.updates).toHaveLength(2);
  });

  it("returns 'task_row_not_paused' when more than one task row would match (defensive)", async () => {
    // Defensive: a duplicate match (shouldn't happen given run_id+task_id
    // uniqueness but the helper's check is `length !== 1`) also rolls
    // back rather than risk a stray write.
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx(
        [{ id: 'run-row-id' }],
        [{ id: 'task-1' }, { id: 'task-2' }],
        workflowRunsToken,
      );
      try {
        return await fn(tx);
      } catch (err) {
        throw err;
      }
    });

    const result = await commitReplaceOutputAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_not_paused');
  });
});

describe('commitReplaceOutputAndResume — the record written within the commit', () => {
  function committing(runReturning: ReturningResult, taskReturning: ReturningResult) {
    let tx: FakeTx | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      tx = makeFakeTx(runReturning, taskReturning, workflowRunsToken);
      return fn(tx);
    });
    return () => tx;
  }

  it('writes it once both rows have passed their checks, inside the transaction', async () => {
    const txOf = committing([{ id: 'run-row-id' }], [{ id: 'task-row-id' }]);
    const recordWithinCommit = vi.fn(() => {
      expect(txOf()!.updates).toHaveLength(2);
      return Promise.resolve();
    });
    const result = await commitReplaceOutputAndResume({} as never, 'tenant', {
      ...COMMON_ARGS,
      recordWithinCommit,
    });
    expect(result).toBe('committed');
    expect(recordWithinCommit).toHaveBeenCalledOnce();
  });

  it("rolls the commit back as 'record_failed' when the record throws", async () => {
    committing([{ id: 'run-row-id' }], [{ id: 'task-row-id' }]);
    const result = await commitReplaceOutputAndResume({} as never, 'tenant', {
      ...COMMON_ARGS,
      recordWithinCommit: () => Promise.reject(new Error('redis down')),
    });
    expect(result).toBe('record_failed');
  });

  it('writes nothing when either row misses its check', async () => {
    for (const [run, task, outcome] of [
      [[], [{ id: 'task-row-id' }], 'claim_lost'],
      [[{ id: 'run-row-id' }], [], 'task_row_not_paused'],
    ] as const) {
      committing([...run], [...task]);
      const recordWithinCommit = vi.fn(() => Promise.resolve());
      const result = await commitReplaceOutputAndResume({} as never, 'tenant', {
        ...COMMON_ARGS,
        recordWithinCommit,
      });
      expect(result).toBe(outcome);
      expect(recordWithinCommit).not.toHaveBeenCalled();
    }
  });
});
