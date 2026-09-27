import { describe, it, expect, vi, beforeEach } from 'vitest';

type ReturningResult = Array<Record<string, unknown>>;

interface FakeTx {
  update: (table: unknown) => unknown;
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
      const returningResult = updateCallIndex === 0 ? runReturning : taskReturning;
      updateCallIndex += 1;
      const setValues: Record<string, unknown> = {};
      const chain = {
        set(values: Record<string, unknown>) {
          Object.assign(setValues, values);
          updates.push({ table: tableLabel, setValues: { ...values } });
          return chain;
        },
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve(returningResult);
        },
      };
      return chain;
    },
  };
  return tx;
}

const workflowRunsToken = { __table: 'workflowRuns' };
const workflowRunTasksToken = { __table: 'workflowRunTasks' };

const mockWithTenantSchema = vi.fn();

vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn((tenantId: string) => ({ tenantId })),
  withTenantSchema: (...args: unknown[]) => mockWithTenantSchema(...args),
  workflowRuns: workflowRunsToken,
  workflowRunTasks: workflowRunTasksToken,
}));

const { commitFailTaskAndResume } = await import('../ledger/resume.js');

const COMMON_ARGS = {
  runId: '11111111-2222-3333-4444-555555555555',
  claimToken: 'claim-1',
  taskId: 'approve-task',
  attempt: 1,
  reason: 'rejected_by_operator',
};

describe('commitFailTaskAndResume — Plan 167', () => {
  beforeEach(() => {
    mockWithTenantSchema.mockReset();
  });

  it("returns 'committed' when run + task rows both update", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx([{ id: 'run' }], [{ id: 'task' }], workflowRunsToken);
      return fn(tx);
    });
    const result = await commitFailTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('committed');
  });

  it("returns 'claim_lost' when run-row CAS misses", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx([], [{ id: 'task' }], workflowRunsToken);
      return fn(tx);
    });
    const result = await commitFailTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('claim_lost');
  });

  it("returns 'task_row_state_mismatch' when task row is not paused", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx([{ id: 'run' }], [], workflowRunsToken);
      return fn(tx);
    });
    const result = await commitFailTaskAndResume({} as never, 'tenant', COMMON_ARGS);
    expect(result).toBe('task_row_state_mismatch');
  });
});
