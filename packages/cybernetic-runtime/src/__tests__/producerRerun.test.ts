import { describe, it, expect, vi, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

type ReturningResult = Array<Record<string, unknown>>;

interface FakeTx {
  selects: number;
  updates: Array<{ setValues: Record<string, unknown> }>;
  deletes: Array<{ table: 'workflowRunTasks' | 'workflowRunCompletionPending' }>;
}

function makeFakeTx(opts: {
  selectRow: Record<string, unknown> | null;
  taskReturning: ReturningResult;
  taskDeleteReturning?: ReturningResult;
  workflowRunTasksToken: object;
}): FakeTx & {
  select: () => unknown;
  update: () => unknown;
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
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(opts.selectRow ? [opts.selectRow] : []);
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push({ setValues: { ...values } });
          return {
            where() {
              return {
                returning() {
                  return Promise.resolve(opts.taskReturning);
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
        where() {
          return {
            returning() {
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
  inArray: (..._args: unknown[]) => ({ __op: 'inArray' }),
  sql: Object.assign((..._args: unknown[]) => ({ __op: 'sql' }), {
    raw: (..._args: unknown[]) => ({ __op: 'sql.raw' }),
  }),
}));

import {
  commitProducerRerun,
  countProducerReruns,
  type ProducerRerunProvenance,
} from '../ledger/producerRerun.js';
import { withTenantSchema, workflowRunTasks } from '@aflow/database';
import { WorkflowTaskPriorFailureSchema } from '@aflow/schemas';

const mockWithTenantSchema = withTenantSchema as ReturnType<typeof vi.fn>;
const workflowRunTasksToken = workflowRunTasks as unknown as object;

const PROVENANCE: ProducerRerunProvenance = {
  kind: 'producer_contract_rerun',
  failedAt: '2026-06-17T00:00:00.000Z',
  consumerTaskId: 'validate-task-graph',
  bindAs: 'draft',
  producerTaskId: 'draft-task-graph',
  contractName: 'draft',
  attempt: 1,
  failureReason: 'dangling ref',
};

const COMMON = {
  runId: '11111111-2222-3333-4444-555555555555',
  producerTaskId: 'draft-task-graph',
  expectedProducerAttempt: 1,
  descendantTaskIds: ['validate-task-graph', 'validate-source-coverage', 'assemble-workflow'],
  provenance: PROVENANCE,
};

const SUCCEEDED_PRODUCER = { status: 'succeeded' as const, attempt: 1 };

describe('countProducerReruns — Plan 202 §3.1 budget accounting', () => {
  const match = {
    consumerTaskId: 'validate-task-graph',
    bindAs: 'draft',
    producerTaskId: 'draft-task-graph',
  };

  it('returns 0 for absent / non-array prior_failures', () => {
    expect(countProducerReruns(undefined, match)).toBe(0);
    expect(countProducerReruns(null, match)).toBe(0);
    expect(countProducerReruns({}, match)).toBe(0);
  });

  it('counts only matching producer_contract_rerun entries (consumer + bindAs + producer)', () => {
    const priorFailures = [
      { ...PROVENANCE }, // match
      { ...PROVENANCE, contractName: 'a-different-subcheck' }, // still matches — contractName NOT in key
      { ...PROVENANCE, consumerTaskId: 'validate-source-coverage' }, // different consumer
      { ...PROVENANCE, bindAs: 'intent' }, // different binding
      { ...PROVENANCE, producerTaskId: 'analyze-intent' }, // different producer
      { kind: 'producer_contract_rerun' }, // missing keys
      { attempt: 2, failedAt: '...' }, // an ordinary retry prior-failure, not a rerun
    ];
    expect(countProducerReruns(priorFailures, match)).toBe(2);
  });
});

describe('commitProducerRerun — Plan 202 §3.1', () => {
  it('re-arms a succeeded producer: status→running, attempt+1, descendants + completion-pending deleted', async () => {
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: SUCCEEDED_PRODUCER,
        taskReturning: [{ id: 'producer-row-id' }],
        taskDeleteReturning: [{ taskId: 'validate-task-graph' }, { taskId: 'assemble-workflow' }],
        workflowRunTasksToken,
      });
      return fn(capturedTx);
    });

    const result = await commitProducerRerun({} as never, 'tenant', COMMON);
    expect(result).toEqual({
      kind: 'committed',
      newAttempt: 2,
      clearedTaskIds: ['validate-task-graph', 'assemble-workflow'],
    });
    expect(capturedTx!.updates).toHaveLength(1);
    expect(capturedTx!.updates[0]!.setValues['status']).toBe('running');
    expect(capturedTx!.updates[0]!.setValues['attempt']).toBe(2);
    expect(capturedTx!.updates[0]!.setValues['outputRef']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['workerSessionId']).toBeNull();
    expect(capturedTx!.updates[0]!.setValues['priorFailures']).toMatchObject({ __op: 'sql' });
    // descendant rows + their completion-pending supervision rows both deleted.
    expect(capturedTx!.deletes).toEqual([
      { table: 'workflowRunTasks' },
      { table: 'workflowRunCompletionPending' },
    ]);
  });

  it('does not delete completion-pending when no descendant rows were cleared', async () => {
    let capturedTx: ReturnType<typeof makeFakeTx> | undefined;
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      capturedTx = makeFakeTx({
        selectRow: SUCCEEDED_PRODUCER,
        taskReturning: [{ id: 'producer-row-id' }],
        taskDeleteReturning: [],
        workflowRunTasksToken,
      });
      return fn(capturedTx);
    });

    const result = await commitProducerRerun({} as never, 'tenant', COMMON);
    expect(result.kind).toBe('committed');
    expect(capturedTx!.deletes).toEqual([{ table: 'workflowRunTasks' }]);
  });

  it("returns 'producer_not_resettable' when the producer is not 'succeeded' (concurrent rerun won)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: { status: 'running', attempt: 2 },
        taskReturning: [],
        workflowRunTasksToken,
      });
      return fn(tx);
    });
    const result = await commitProducerRerun({} as never, 'tenant', COMMON);
    expect(result).toEqual({ kind: 'producer_not_resettable' });
  });

  it("returns 'producer_not_resettable' on attempt CAS mismatch", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: { status: 'succeeded', attempt: 2 },
        taskReturning: [],
        workflowRunTasksToken,
      });
      return fn(tx);
    });
    const result = await commitProducerRerun({} as never, 'tenant', COMMON);
    expect(result).toEqual({ kind: 'producer_not_resettable' });
  });

  it("returns 'producer_not_resettable' when the row vanished", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({ selectRow: null, taskReturning: [], workflowRunTasksToken });
      return fn(tx);
    });
    const result = await commitProducerRerun({} as never, 'tenant', COMMON);
    expect(result).toEqual({ kind: 'producer_not_resettable' });
  });

  it("returns 'producer_not_resettable' when the UPDATE CAS affects 0 rows (race)", async () => {
    mockWithTenantSchema.mockImplementationOnce(async (_db, _ctx, fn) => {
      const tx = makeFakeTx({
        selectRow: SUCCEEDED_PRODUCER,
        taskReturning: [], // UPDATE returned no rows
        workflowRunTasksToken,
      });
      return fn(tx);
    });
    const result = await commitProducerRerun({} as never, 'tenant', COMMON);
    expect(result).toEqual({ kind: 'producer_not_resettable' });
  });
});

describe('ProducerRerunProvenance ↔ run-detail DTO conformance (Plan 206)', () => {
  it('conforms to WorkflowTaskPriorFailureSchema — failedAt is required, else GET /workflow-runs/:runId 500s', () => {
    // Mirrors the entry built in contractFailureRoute.ts. prior_failures is
    // serialized through WorkflowTaskPriorFailureSchema on the run-detail
    // response; a producer-rerun entry without failedAt fails serialization.
    const provenance: ProducerRerunProvenance = {
      kind: 'producer_contract_rerun',
      failedAt: '2026-06-17T00:00:00.000Z',
      consumerTaskId: 'validate-task-graph',
      bindAs: 'draft',
      producerTaskId: 'draft-task-graph',
      contractName: 'compose-input-schema',
      attempt: 1,
      failureReason: 'Consumer "validate-task-graph" rejected binding "draft": ...',
    };
    const parsed = WorkflowTaskPriorFailureSchema.safeParse(provenance);
    expect(parsed.success).toBe(true);
  });
});
