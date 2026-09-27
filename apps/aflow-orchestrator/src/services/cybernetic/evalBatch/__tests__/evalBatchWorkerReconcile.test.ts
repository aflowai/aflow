/**
 * D17 idempotent dispatch at the launch seam: the run ledger, not the trial
 * row, decides whether a trial was already launched. A claimed row whose
 * launch crashed before recordTrialRunId is reconciled by adopting the
 * surviving run — never double-launched — and a duplicate survivor is
 * cancelled, not left running ungraded.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { TenantId } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mockListRunsForEvalTrial = vi.fn();
const mockRecordTrialRunId = vi.fn();
const mockMarkTrialInfraRetry = vi.fn();
const mockCompleteTrialGraded = vi.fn();
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...actual,
    listRunsForEvalTrial: (...a: unknown[]) => mockListRunsForEvalTrial(...a),
    recordTrialRunId: (...a: unknown[]) => mockRecordTrialRunId(...a),
    markTrialInfraRetry: (...a: unknown[]) => mockMarkTrialInfraRetry(...a),
    completeTrialGraded: (...a: unknown[]) => mockCompleteTrialGraded(...a),
  };
});

const mockCancelRun = vi.fn();
vi.mock('../../harness/cancel.js', () => ({
  cancelRun: (...a: unknown[]) => mockCancelRun(...a),
}));

const mockStartAtRevision = vi.fn();
vi.mock('../startWorkflowRunAtRevision.js', () => ({
  startWorkflowRunAtRevision: (...a: unknown[]) => mockStartAtRevision(...a),
}));

const mockCreateFixtureSpace = vi.fn();
vi.mock('../fixtureSpaces.js', () => ({
  createTrialFixtureSpace: (...a: unknown[]) => mockCreateFixtureSpace(...a),
  reapExpiredEvalFixtureSpaces: vi.fn(),
}));

import { EvalBatchEngine } from '../EvalBatchEngine.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;

const BATCH = {
  id: 'batch-1',
  spaceId: '33333333-3333-4333-8333-333333333333',
  workflowSlug: 'daily-metrics',
  workflowRevision: 2,
  status: 'running',
  costSpentCents: 0,
  costCeilingCents: 1000,
  maxConcurrentTrials: 2,
  trialsPerCase: 1,
} as never;

const REVISION = {
  id: 'rev-1',
  case: {
    fixture: { tier: 'live', learnings: 'none' },
    trigger: { inputs: {} },
    expectations: [{ kind: 'terminal', runStatus: 'completed' }],
    rubrics: [],
    stratum: { scenario: 's', direction: 'should_succeed', tier: 'regression' },
  },
} as never;

function trialRow(overrides: Record<string, unknown> = {}): never {
  return {
    id: 'trial-row-1',
    batchId: 'batch-1',
    caseRevisionId: 'rev-1',
    trial: 1,
    runId: null,
    disposition: 'running',
    attempt: 1,
    leaseOwner: 'me',
    startedAt: new Date(),
    ...overrides,
  } as never;
}

function makeWorker(): EvalBatchEngine {
  return new EvalBatchEngine({
    sqlClient: {} as never,
    harnessDeps: { db: {}, redis: {}, payloadStore: {} } as never,
    instanceId: 'me',
  });
}

type WorkerInternals = {
  launchTrial: (tenantId: TenantId, batch: never, row: never, revision: never) => Promise<void>;
  settleUnlaunchedTrial: (
    tenantId: TenantId,
    batch: never,
    row: never,
    costSpent: number,
  ) => Promise<number>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordTrialRunId.mockResolvedValue(undefined);
  mockMarkTrialInfraRetry.mockResolvedValue(undefined);
  mockCancelRun.mockResolvedValue(undefined);
});

describe('launchTrial reconciliation', () => {
  it('adopts a surviving run instead of launching a second one', async () => {
    mockListRunsForEvalTrial.mockResolvedValueOnce([{ runId: 'run-A', status: 'running' }]);
    const worker = makeWorker() as unknown as WorkerInternals;

    await worker.launchTrial(TENANT, BATCH, trialRow(), REVISION);

    expect(mockStartAtRevision).not.toHaveBeenCalled();
    expect(mockRecordTrialRunId).toHaveBeenCalledWith({}, TENANT, {
      trialId: 'trial-row-1',
      runId: 'run-A',
    });
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it('cancels a duplicate survivor and adopts the first-started run', async () => {
    mockListRunsForEvalTrial.mockResolvedValueOnce([
      { runId: 'run-A', status: 'running' },
      { runId: 'run-B', status: 'running' },
    ]);
    const worker = makeWorker() as unknown as WorkerInternals;

    await worker.launchTrial(TENANT, BATCH, trialRow(), REVISION);

    expect(mockRecordTrialRunId).toHaveBeenCalledWith({}, TENANT, {
      trialId: 'trial-row-1',
      runId: 'run-A',
    });
    expect(mockCancelRun).toHaveBeenCalledTimes(1);
    expect(mockCancelRun.mock.calls[0]![2]).toBe('run-B');
    expect(mockStartAtRevision).not.toHaveBeenCalled();
  });

  it('launches normally when the ledger holds no run for the trial', async () => {
    mockListRunsForEvalTrial.mockResolvedValueOnce([]);
    mockStartAtRevision.mockResolvedValueOnce({ ok: true, runId: 'run-new', evalSessionId: 's' });
    const worker = makeWorker() as unknown as WorkerInternals;

    await worker.launchTrial(TENANT, BATCH, trialRow(), REVISION);

    expect(mockStartAtRevision).toHaveBeenCalledTimes(1);
    const params = mockStartAtRevision.mock.calls[0]![1] as Record<string, unknown>;
    expect(params['caseRevisionId']).toBe('rev-1');
    expect(params['trial']).toBe(1);
    expect(params['fixtureTier']).toBe('live');
    expect(mockRecordTrialRunId).toHaveBeenCalledWith({}, TENANT, {
      trialId: 'trial-row-1',
      runId: 'run-new',
    });
  });
});

describe('settleUnlaunchedTrial reconciliation', () => {
  it('adopts the surviving run instead of burning an infra retry', async () => {
    mockListRunsForEvalTrial.mockResolvedValueOnce([{ runId: 'run-A', status: 'running' }]);
    const worker = makeWorker() as unknown as WorkerInternals;

    const cost = await worker.settleUnlaunchedTrial(TENANT, BATCH, trialRow(), 42);

    expect(cost).toBe(42);
    expect(mockRecordTrialRunId).toHaveBeenCalledWith({}, TENANT, {
      trialId: 'trial-row-1',
      runId: 'run-A',
    });
    expect(mockMarkTrialInfraRetry).not.toHaveBeenCalled();
    expect(mockCompleteTrialGraded).not.toHaveBeenCalled();
  });

  it('falls back to infra retry when the ledger has nothing to adopt', async () => {
    mockListRunsForEvalTrial.mockResolvedValueOnce([]);
    const worker = makeWorker() as unknown as WorkerInternals;

    await worker.settleUnlaunchedTrial(TENANT, BATCH, trialRow(), 0);

    expect(mockMarkTrialInfraRetry).toHaveBeenCalledWith({}, TENANT, { trialId: 'trial-row-1' });
    expect(mockRecordTrialRunId).not.toHaveBeenCalled();
  });

  it('exhausted attempts terminalize as a typed verdict, not a retry', async () => {
    mockListRunsForEvalTrial.mockResolvedValueOnce([]);
    const worker = makeWorker() as unknown as WorkerInternals;

    await worker.settleUnlaunchedTrial(TENANT, BATCH, trialRow({ attempt: 3 }), 0);

    expect(mockMarkTrialInfraRetry).not.toHaveBeenCalled();
    expect(mockCompleteTrialGraded).toHaveBeenCalledTimes(1);
    const graded = mockCompleteTrialGraded.mock.calls[0]![2] as { verdict: string };
    expect(graded.verdict).toBe('error');
  });
});
