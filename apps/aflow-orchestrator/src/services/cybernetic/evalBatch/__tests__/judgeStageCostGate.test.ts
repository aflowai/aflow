/**
 * The advisory judge stage is metered against the batch cost ceiling: a
 * batch past its ceiling dispatches no judges (slots stay pending), the
 * ceiling is re-checked before every dispatch as judge spend accumulates,
 * and every judge call's cost lands in costSpentCents — the ceiling can
 * never be outspent or underreported by the judge bill.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { TenantId } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mockCompleteTrialGraded = vi.fn();
const mockAddEvalBatchCost = vi.fn();
const mockLoadSpaceDirectives = vi.fn();
const mockSumTrialRunUsage = vi.fn();
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...actual,
    completeTrialGraded: (...a: unknown[]) => mockCompleteTrialGraded(...a),
    addEvalBatchCost: (...a: unknown[]) => mockAddEvalBatchCost(...a),
    loadSpaceDirectives: (...a: unknown[]) => mockLoadSpaceDirectives(...a),
    // Trial spend is read from the event log; most of this suite is about what
    // the JUDGE stage adds on top, so the default holds the run's own cost at
    // zero and only the gate test below raises it.
    sumTrialRunUsage: (...a: unknown[]) => mockSumTrialRunUsage(...a),
  };
});

const mockGenerateJson = vi.fn();
vi.mock('@aflow/credential-resolver', () => ({
  createByokAiClientFactory: () => ({
    getClientForModel: () =>
      Promise.resolve({ client: { generateJson: (...a: unknown[]) => mockGenerateJson(...a) } }),
  }),
}));

vi.mock('../../harness/cancel.js', () => ({ cancelRun: vi.fn() }));
vi.mock('../startWorkflowRunAtRevision.js', () => ({ startWorkflowRunAtRevision: vi.fn() }));
vi.mock('../fixtureSpaces.js', () => ({
  createTrialFixtureSpace: vi.fn(),
  reapExpiredEvalFixtureSpaces: vi.fn(),
}));

import { EvalBatchEngine } from '../EvalBatchEngine.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;

function batch(costCeilingCents: number): never {
  return {
    id: 'batch-1',
    spaceId: '33333333-3333-4333-8333-333333333333',
    workflowSlug: 'daily-metrics',
    workflowRevision: 2,
    status: 'running',
    costSpentCents: 0,
    costCeilingCents,
    maxConcurrentTrials: 2,
    trialsPerCase: 1,
    provenanceManifestJson: {
      workflow: { slug: 'daily-metrics', revision: 2, configHash: 'hash' },
      dataset: { datasetId: '44444444-4444-4444-8444-444444444444', datasetVersion: 1 },
      subjectModels: [{ scope: 'runner', modelRef: 'subject-model' }],
      graderVersion: 'det-1',
    },
  } as never;
}

function batchWithCorruptManifest(costCeilingCents: number): never {
  return { ...(batch(costCeilingCents) as object), provenanceManifestJson: null } as never;
}

function rubric(name: string, reads?: unknown[]): unknown {
  return {
    kind: 'case_local',
    criterion: {
      type: 'judge',
      name,
      rubric: [{ criterion: `${name} check`, scale: 'binary', description: 'desc' }],
      ...(reads ? { reads } : {}),
    },
  };
}

const REVISION = {
  id: 'rev-1',
  case: {
    fixture: { tier: 'live', learnings: 'none' },
    trigger: { inputs: {} },
    expectations: [{ kind: 'terminal', runStatus: 'completed' }],
    rubrics: [rubric('clarity'), rubric('tone')],
    stratum: { scenario: 's', direction: 'should_succeed', tier: 'regression' },
    provenance: { source: 'curated', workflowRevision: 1 },
  },
} as never;

/** A run that actually produced a task, so `task_summary` is satisfiable. */
const SNAPSHOT_WITH_TASK = {
  run: { runId: 'run-1', status: 'completed', totalCostCents: null, failureJson: null },
  tasks: [{ taskId: 'answer', status: 'succeeded', summary: 'answered' }],
} as never;

/** Criteria that declare what they read, which is what production now authors. */
const REVISION_DECLARING_READS = {
  ...(REVISION as object),
  case: {
    ...((REVISION as { case: object }).case as object),
    rubrics: [rubric('clarity', [{ kind: 'task_summary' }]), rubric('tone', [{ kind: 'reply' }])],
  },
} as never;

const ROW = {
  id: 'trial-row-1',
  batchId: 'batch-1',
  caseRevisionId: 'rev-1',
  trial: 1,
  runId: 'run-1',
  disposition: 'running',
  attempt: 1,
  startedAt: null,
} as never;

const SNAPSHOT = {
  run: { runId: 'run-1', status: 'completed', totalCostCents: null, failureJson: null },
  tasks: [],
} as never;

type WorkerInternals = {
  gradeTrial: (
    tenantId: TenantId,
    batch: never,
    row: never,
    revision: never,
    snapshot: never,
    costSpentBefore: number,
  ) => Promise<number>;
};

function makeWorker(): WorkerInternals {
  return new EvalBatchEngine({
    sqlClient: {} as never,
    harnessDeps: { db: {}, redis: {}, payloadStore: {} } as never,
    instanceId: 'me',
  }) as unknown as WorkerInternals;
}

/**
 * The judge answers per rubric entry, and the answer is aligned to the rubric
 * that was asked — so a stub must echo the criterion it is answering or it
 * reads as an unanswered one.
 */
function judgeCallCosting(totalCostUsd: number): void {
  mockGenerateJson.mockImplementation((request: { schemaName?: string; messages?: unknown[] }) => {
    const asked = JSON.stringify(request.messages ?? '');
    const criterion = asked.includes('tone check') ? 'tone check' : 'clarity check';
    return Promise.resolve({
      data: { entries: [{ criterion, rationale: 'Weak.', verdict: 'fail' }] },
      cost: { promptCost: 0, completionCost: totalCostUsd, totalCost: totalCostUsd },
    });
  });
}

function gradedResults(): { pendingRubrics: string[]; rubricResults: unknown[] } {
  expect(mockCompleteTrialGraded).toHaveBeenCalledTimes(1);
  return (mockCompleteTrialGraded.mock.calls[0]![2] as { results: never }).results;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCompleteTrialGraded.mockResolvedValue(true);
  mockLoadSpaceDirectives.mockResolvedValue(null);
  mockAddEvalBatchCost.mockImplementation((_db, _tenant, params: { deltaCents: number }) =>
    Promise.resolve(params.deltaCents),
  );
  mockSumTrialRunUsage.mockResolvedValue({ costCents: 0, totalTokens: 0, usageSteps: 1 });
});

describe('judge stage under the batch cost ceiling', () => {
  it('a batch already past its ceiling dispatches NO judges — slots stay pending', async () => {
    judgeCallCosting(0.05);
    const worker = makeWorker();

    const costSpent = await worker.gradeTrial(TENANT, batch(100), ROW, REVISION, SNAPSHOT, 100);

    expect(mockGenerateJson).not.toHaveBeenCalled();
    expect(mockAddEvalBatchCost).not.toHaveBeenCalled();
    expect(costSpent).toBe(100);
    expect(gradedResults().pendingRubrics).toEqual(['clarity', 'tone']);
  });

  it('judge spend lands in costSpentCents and verdicts carry their scope', async () => {
    judgeCallCosting(0.05);
    const worker = makeWorker();

    const costSpent = await worker.gradeTrial(TENANT, batch(1000), ROW, REVISION, SNAPSHOT, 0);

    expect(mockGenerateJson).toHaveBeenCalledTimes(2);
    expect(mockAddEvalBatchCost).toHaveBeenCalledTimes(1);
    expect(mockAddEvalBatchCost.mock.calls[0]![2]).toEqual({ batchId: 'batch-1', deltaCents: 10 });
    expect(costSpent).toBe(10);
    const results = gradedResults();
    expect(results.pendingRubrics).toEqual([]);
    expect(results.rubricResults).toMatchObject([
      { status: 'judged', criterionId: 'clarity', scopeKey: 'case_local' },
      { status: 'judged', criterionId: 'tone', scopeKey: 'case_local' },
    ]);
  });

  it('the ceiling is re-checked before EVERY dispatch — spend inside the stage counts', async () => {
    judgeCallCosting(0.05);
    const worker = makeWorker();

    await worker.gradeTrial(TENANT, batch(4), ROW, REVISION, SNAPSHOT, 0);

    // First call (5¢) crosses the 4¢ ceiling, so the second slot never fires.
    expect(mockGenerateJson).toHaveBeenCalledTimes(1);
    expect(mockAddEvalBatchCost.mock.calls[0]![2]).toEqual({ batchId: 'batch-1', deltaCents: 5 });
    const results = gradedResults();
    expect(results.pendingRubrics).toEqual(['tone']);
    expect(results.rubricResults).toMatchObject([{ status: 'judged', criterionId: 'clarity' }]);
  });

  it('sub-cent judge stages round UP into the ledger, never to zero', async () => {
    judgeCallCosting(0.001);
    const worker = makeWorker();

    await worker.gradeTrial(TENANT, batch(1000), ROW, REVISION, SNAPSHOT, 0);

    expect(mockGenerateJson).toHaveBeenCalledTimes(2);
    expect(mockAddEvalBatchCost.mock.calls[0]![2]).toEqual({ batchId: 'batch-1', deltaCents: 1 });
  });

  // The trial's run spend is already incurred when grading starts but is not
  // recorded on the batch until after the completing CAS below. A gate that
  // reads only the batch column therefore buys judges for the very trial that
  // took the batch over its limit.
  it("counts THIS trial's own run cost — judges do not fire for the trial that crossed the ceiling", async () => {
    judgeCallCosting(0.05);
    mockSumTrialRunUsage.mockResolvedValue({ costCents: 20, totalTokens: 99, usageSteps: 3 });
    const worker = makeWorker();

    // 90¢ recorded against a 100¢ ceiling, and this trial itself spent 20¢.
    const costSpent = await worker.gradeTrial(TENANT, batch(100), ROW, REVISION, SNAPSHOT, 90);

    expect(mockGenerateJson).not.toHaveBeenCalled();
    expect(gradedResults().pendingRubrics).toEqual(['clarity', 'tone']);
    // The run's own spend is still recorded — the gate withholds judges, it
    // never hides what the trial already cost.
    expect(mockAddEvalBatchCost).toHaveBeenCalledWith(expect.anything(), TENANT, {
      batchId: 'batch-1',
      deltaCents: 20,
    });
    expect(costSpent).toBe(20);
  });

  it('still judges when the trial cost leaves room under the ceiling', async () => {
    judgeCallCosting(0.05);
    mockSumTrialRunUsage.mockResolvedValue({ costCents: 20, totalTokens: 99, usageSteps: 3 });
    const worker = makeWorker();

    await worker.gradeTrial(TENANT, batch(1000), ROW, REVISION, SNAPSHOT, 90);

    expect(mockGenerateJson).toHaveBeenCalledTimes(2);
  });

  it('an unparseable manifest FAILS CLOSED: no dispatch, every slot a typed manifest_unavailable error', async () => {
    judgeCallCosting(0.05);
    const worker = makeWorker();

    await worker.gradeTrial(TENANT, batchWithCorruptManifest(1000), ROW, REVISION, SNAPSHOT, 0);

    expect(mockGenerateJson).not.toHaveBeenCalled();
    const results = gradedResults();
    expect(results.pendingRubrics).toEqual([]);
    expect(results.rubricResults).toMatchObject([
      { status: 'error', criterionId: 'clarity', errorCode: 'manifest_unavailable' },
      { status: 'error', criterionId: 'tone', errorCode: 'manifest_unavailable' },
    ]);
  });
});

describe('the evidence gate sits in front of the judge call', () => {
  it('lets a judge run when the pack holds what the criterion declared', async () => {
    // The regression this guards: the gate runs before EVERY judge dispatch, so
    // a misfire silently ends all judging. The pure-function tests cannot show
    // it — they never reach a dispatch.
    judgeCallCosting(0.05);
    const worker = makeWorker();

    await worker.gradeTrial(
      TENANT,
      batch(1000),
      ROW,
      REVISION_DECLARING_READS,
      SNAPSHOT_WITH_TASK,
      0,
    );

    // 'clarity' reads the task summaries, which this run has.
    expect(mockGenerateJson).toHaveBeenCalled();
    expect(gradedResults().rubricResults).toContainEqual(
      expect.objectContaining({ status: 'judged', criterionId: 'clarity' }),
    );
  });

  it('spends nothing on a criterion the pack cannot answer', async () => {
    judgeCallCosting(0.05);
    const worker = makeWorker();

    await worker.gradeTrial(
      TENANT,
      batch(1000),
      ROW,
      REVISION_DECLARING_READS,
      SNAPSHOT_WITH_TASK,
      0,
    );

    // 'tone' reads the reply, and this run stopped on no pause contract. Asking
    // anyway buys a verdict on absent evidence, which a judge reads as the
    // subject having invented something.
    expect(gradedResults().rubricResults).toContainEqual(
      expect.objectContaining({
        criterionId: 'tone',
        status: 'error',
        errorCode: 'evidence_unavailable',
      }),
    );
  });
});
