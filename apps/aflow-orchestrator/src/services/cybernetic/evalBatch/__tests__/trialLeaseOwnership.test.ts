/**
 * Only the lease owner grades a trial.
 *
 * Grading is not idempotent from the outside: the advisory judge stage
 * dispatches paid model calls and `addEvalBatchCost` records their spend
 * BEFORE `completeTrialGraded` CASes the row. A second worker that grades a
 * trial another leader still holds pays a second bill and double-counts it
 * against the ceiling; losing the CAS undoes neither. Expired leases reach a
 * new owner through adoption at the top of the pass, so the guard strands
 * nothing.
 */
import { EvalCaseTrialResultsSchema } from '@aflow/schemas';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { TenantId } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mockAdoptExpiredTrialLeases = vi.fn();
const mockListTrialRows = vi.fn();
const mockGetRevisionsByIds = vi.fn();
const mockLoadTrialRunSnapshot = vi.fn();
const mockCompleteTrialGraded = vi.fn();
const mockAddEvalBatchCost = vi.fn();
const mockSumTrialRunUsage = vi.fn();
const mockClaimScheduledTrials = vi.fn();
const mockGetEvalBatchById = vi.fn();
const mockGradeCaseTrial = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...actual,
    adoptExpiredTrialLeases: (...a: unknown[]) => mockAdoptExpiredTrialLeases(...a),
    listTrialRows: (...a: unknown[]) => mockListTrialRows(...a),
    getGoldenCaseRevisionsByIds: (...a: unknown[]) => mockGetRevisionsByIds(...a),
    loadTrialRunSnapshot: (...a: unknown[]) => mockLoadTrialRunSnapshot(...a),
    completeTrialGraded: (...a: unknown[]) => mockCompleteTrialGraded(...a),
    addEvalBatchCost: (...a: unknown[]) => mockAddEvalBatchCost(...a),
    sumTrialRunUsage: (...a: unknown[]) => mockSumTrialRunUsage(...a),
    claimScheduledTrials: (...a: unknown[]) => mockClaimScheduledTrials(...a),
    getEvalBatchById: (...a: unknown[]) => mockGetEvalBatchById(...a),
    renewTrialLeases: () => Promise.resolve(undefined),
    buildTrialRunRecord: () => ({}),
    gradeCaseTrial: (...a: unknown[]) => mockGradeCaseTrial(...a),
    // Terminalization is a separate concern; hold this pass short of it.
    planBatchTerminalization: () => null,
  };
});

vi.mock('../../harness/cancel.js', () => ({ cancelRun: vi.fn() }));
vi.mock('../startWorkflowRunAtRevision.js', () => ({ startWorkflowRunAtRevision: vi.fn() }));
vi.mock('../fixtureSpaces.js', () => ({
  createTrialFixtureSpace: vi.fn(),
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

function trialRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'trial-row-1',
    batchId: 'batch-1',
    caseRevisionId: 'rev-1',
    trial: 1,
    runId: 'run-1',
    disposition: 'running',
    attempt: 1,
    leaseOwner: 'me',
    startedAt: new Date(),
    ...overrides,
  };
}

type EngineInternals = {
  processBatch: (tenantId: TenantId, batch: never) => Promise<void>;
};

function engine(): EngineInternals {
  return new EvalBatchEngine({
    sqlClient: {} as never,
    harnessDeps: { db: {}, redis: {}, payloadStore: {} } as never,
    instanceId: 'me',
  }) as unknown as EngineInternals;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdoptExpiredTrialLeases.mockResolvedValue([]);
  mockGetRevisionsByIds.mockResolvedValue(new Map([['rev-1', REVISION]]));
  mockLoadTrialRunSnapshot.mockResolvedValue({ run: { runId: 'run-1', status: 'completed' } });
  mockCompleteTrialGraded.mockResolvedValue(true);
  mockAddEvalBatchCost.mockResolvedValue(7);
  mockSumTrialRunUsage.mockResolvedValue({ costCents: 7, totalTokens: 10, usageSteps: 1 });
  mockClaimScheduledTrials.mockResolvedValue([]);
  mockGetEvalBatchById.mockResolvedValue(BATCH);
  // The real grader returns a schema-parsed record; a bare {} here would let
  // a reader of `results` pass against a shape production never produces.
  mockGradeCaseTrial.mockReturnValue({
    verdict: 'pass',
    results: EvalCaseTrialResultsSchema.parse({
      expectationResults: [{ expectationIndex: 0, kind: 'terminal', passed: true, detail: 'ok' }],
      fractionPassed: 1,
      fixtureTier: 'sealed',
    }),
  });
});

describe('trial grading is restricted to the lease owner', () => {
  it('does not grade a terminal trial another instance still holds', async () => {
    mockListTrialRows.mockResolvedValue([trialRow({ leaseOwner: 'other-instance' })]);

    await engine().processBatch(TENANT, BATCH);

    expect(mockGradeCaseTrial).not.toHaveBeenCalled();
    // The two effects a losing CAS cannot undo.
    expect(mockAddEvalBatchCost).not.toHaveBeenCalled();
    expect(mockCompleteTrialGraded).not.toHaveBeenCalled();
  });

  it('grades the same trial once it is ours', async () => {
    mockListTrialRows.mockResolvedValue([trialRow({ leaseOwner: 'me' })]);

    await engine().processBatch(TENANT, BATCH);

    expect(mockGradeCaseTrial).toHaveBeenCalledOnce();
    expect(mockCompleteTrialGraded).toHaveBeenCalledOnce();
    expect(mockAddEvalBatchCost).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({ batchId: 'batch-1', deltaCents: 7 }),
    );
  });

  it('grades a trial whose expired lease adoption just handed us', async () => {
    // Adoption rewrites leaseOwner in the same pass, so the re-read row is
    // ours — the guard must not lock a stranded trial out of grading.
    mockAdoptExpiredTrialLeases.mockResolvedValue([trialRow({ leaseOwner: 'me' })]);
    mockListTrialRows.mockResolvedValue([trialRow({ leaseOwner: 'me' })]);

    await engine().processBatch(TENANT, BATCH);

    expect(mockCompleteTrialGraded).toHaveBeenCalledOnce();
  });

  it('does not settle another holder unlaunched trial', async () => {
    mockListTrialRows.mockResolvedValue([trialRow({ leaseOwner: 'other-instance', runId: null })]);

    await engine().processBatch(TENANT, BATCH);

    expect(mockCompleteTrialGraded).not.toHaveBeenCalled();
  });
});
