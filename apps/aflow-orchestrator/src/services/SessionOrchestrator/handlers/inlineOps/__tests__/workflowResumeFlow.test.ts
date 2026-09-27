import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';
import { RESUME_REPLACE_OUTPUT_ATTEMPT_CAP, type WorkflowResumeContract } from '@aflow/schemas';

// ── DB / runtime mocks ────────────────────────────────────────────────────
const mockLoadRunById = vi.fn();
const mockClaimResumeLease = vi.fn();
const mockReleaseResumeClaim = vi.fn();
const mockResumeRunWithClaim = vi.fn();
const mockBumpResumeAttemptCount = vi.fn();
const mockCommitReplaceOutputAndResume = vi.fn();
const mockCommitProvideInputAndResume = vi.fn();
const mockCommitReExecutePausedTaskAndResume = vi.fn();
const mockCommitRetryFailedTaskAndResume = vi.fn();
const mockSurfaceWorkflowResumeContract = vi.fn();
const mockDeriveRunLiveness = vi.fn();
const mockListRecentRuns = vi.fn();
const mockResolveWorkflowForRunRevision = vi.fn();
const mockCheckWorkflowCredentialsPreflight = vi.fn();
const mockCheckWorkflowCapabilityPreflight = vi.fn();

const mockAddWaiter = vi.fn();
const mockLoadPendingWaiters = vi.fn();
const mockListTaskRows = vi.fn();
const mockMarkWaiterNotified = vi.fn();
const mockComputeReadyTasksWithWhen = vi.fn();
const mockClaimAndSchedule = vi.fn();
const mockClaimHumanTask = vi.fn();
const mockCasCompleteTask = vi.fn();
const mockClearCompletionPending = vi.fn();
const mockRecordTaskSkipped = vi.fn();
const mockBlockDescendantTasks = vi.fn();
const mockComputeDescendants = vi.fn();
const mockComputeBlockedDescendantsToClearForRetry = vi.fn();
const mockAddAttentionItem = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
    claimResumeLease: (...args: unknown[]) => mockClaimResumeLease(...args),
    releaseResumeClaim: (...args: unknown[]) => mockReleaseResumeClaim(...args),
    resumeRunWithClaim: (...args: unknown[]) => mockResumeRunWithClaim(...args),
    bumpResumeAttemptCount: (...args: unknown[]) => mockBumpResumeAttemptCount(...args),
    commitReplaceOutputAndResume: (...args: unknown[]) => mockCommitReplaceOutputAndResume(...args),
    commitProvideInputAndResume: (...args: unknown[]) => mockCommitProvideInputAndResume(...args),
    commitReExecutePausedTaskAndResume: (...args: unknown[]) =>
      mockCommitReExecutePausedTaskAndResume(...args),
    commitRetryFailedTaskAndResume: (...args: unknown[]) =>
      mockCommitRetryFailedTaskAndResume(...args),
    surfaceWorkflowResumeContract: (...args: unknown[]) =>
      mockSurfaceWorkflowResumeContract(...args),
    deriveRunLiveness: (...args: unknown[]) => mockDeriveRunLiveness(...args),
    listRecentRuns: (...args: unknown[]) => mockListRecentRuns(...args),
    addWaiter: (...args: unknown[]) => mockAddWaiter(...args),
    emitCatchupToNewWaiter: async () => 0,
    loadPendingWaiters: (...args: unknown[]) => mockLoadPendingWaiters(...args),
    listTaskRows: (...args: unknown[]) => mockListTaskRows(...args),
    markWaiterNotified: (...args: unknown[]) => mockMarkWaiterNotified(...args),
    computeReadyTasksWithWhen: (...args: unknown[]) => mockComputeReadyTasksWithWhen(...args),
    claimAndSchedule: (...args: unknown[]) => mockClaimAndSchedule(...args),
    claimHumanTask: (...args: unknown[]) => mockClaimHumanTask(...args),
    casCompleteTask: (...args: unknown[]) => mockCasCompleteTask(...args),
    clearCompletionPending: (...args: unknown[]) => mockClearCompletionPending(...args),
    recordTaskSkipped: (...args: unknown[]) => mockRecordTaskSkipped(...args),
    blockDescendantTasks: (...args: unknown[]) => mockBlockDescendantTasks(...args),
    computeDescendants: (...args: unknown[]) => mockComputeDescendants(...args),
    computeBlockedDescendantsToClearForRetry: (...args: unknown[]) =>
      mockComputeBlockedDescendantsToClearForRetry(...args),
    addAttentionItem: (...args: unknown[]) => mockAddAttentionItem(...args),
    // Other exports used at module load — return safe defaults.
    pauseRun: vi.fn(),
    resumeRun: vi.fn(),
    recoverStalledRun: vi.fn(),
    recordTaskResult: vi.fn(),
    completeRun: vi.fn(),
    updateRunMetadata: vi.fn(),
    recordRunStart: vi.fn(),
    WorkflowArchivedError: class extends Error {},
    isCyberneticSpace: vi.fn(),
    cyberneticHookSafe: vi.fn(),
    triggerCoachReview: vi.fn(),
    runEvaluation: vi.fn(),
    listActiveRuns: vi.fn(),
    listActiveRunsForWorkflow: vi.fn(),
    listActiveRunsForWorkflowWithLiveness: vi.fn().mockResolvedValue([]),
    deriveRunLivenessFromCounts: () => 'idle',
    getRunStatistics: vi.fn(),
    onSkillRunCompleted: vi.fn(),
    validateWorkflowGraph: vi.fn(),
    patchTouchesGraph: vi.fn(),
  };
});

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
  createTenantContext: vi.fn(() => ({})),
  createMemoryDocRepository: vi.fn(() => ({
    getByPath: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
  })),
  createMemoryDirRepository: vi.fn(() => ({
    ensureParentDirs: vi.fn(),
    mkdir: vi.fn(),
  })),
  resolveWorkflowForRunRevision: (...args: unknown[]) => mockResolveWorkflowForRunRevision(...args),
  withTenantSchema: vi.fn(),
  spaces: {},
  workflowDirPath: (slug: string) => `/workflows/${slug}`,
  workflowDocPath: (slug: string) => `/workflows/${slug}/workflow.json`,
  ensureWorkflowRevisionSnapshot: vi.fn(),
  resolveWorkflowForStart: vi.fn(),
  listWorkflowsWithPlatform: vi.fn(),
}));

// Stub the harness tail. `handleWorkflowRunResume` calls
// `dispatchNextOrTerminate` + `notifyWaiters` to drive the workflow
// forward after the resume commits; the catch path falls back to
// `completeRun(failed)`. The real implementations touch DB tables and
// Redis hot state that aren't part of this test's surface (full
// coverage lives in `WorkflowRunHarness.test.ts`). Stubbing them as
// no-ops keeps the test focused on the resume handler's contract
// (claim → validate → commit → rebind → park) without exercising —
// and silently logging recovery from — the harness internals.
const mockDispatchNextOrTerminate = vi.fn();
const mockNotifyWaiters = vi.fn();
const mockHarnessCompleteRun = vi.fn();
const mockDispatchRetriedTask = vi.fn();
const mockApplyFailureMode = vi.fn();
// Path is relative to THIS test file (4 segments up to `services/`,
// then into `cybernetic/`). `workflowCrud.ts` uses `'../../..'` from
// its own location; both resolve to the same module id.
vi.mock('../../../helpers/workflowCredentialsPreflight.js', () => ({
  checkWorkflowCredentialsPreflight: (...args: unknown[]) =>
    mockCheckWorkflowCredentialsPreflight(...args),
  checkWorkflowCapabilityPreflight: (...args: unknown[]) =>
    mockCheckWorkflowCapabilityPreflight(...args),
  renderPreflightFailureMessage: vi.fn(() => 'credentials still missing'),
  renderCapabilityPreflightFailureMessage: vi.fn(() => 'capability still missing'),
}));

const mockGateWorkflowOperationGrants = vi.fn();
vi.mock('../../../helpers/workflowGrantGate.js', () => ({
  gateWorkflowOperationGrants: (...args: unknown[]) => mockGateWorkflowOperationGrants(...args),
  renderResumeGrantGateFailureMessage: vi.fn(() => 'operation not granted'),
}));

vi.mock('../../../../cybernetic/WorkflowRunHarness.js', () => ({
  dispatchNextOrTerminate: (...args: unknown[]) => mockDispatchNextOrTerminate(...args),
  notifyWaiters: (...args: unknown[]) => mockNotifyWaiters(...args),
  completeRun: (...args: unknown[]) => mockHarnessCompleteRun(...args),
  dispatchRetriedTask: (...args: unknown[]) => mockDispatchRetriedTask(...args),
  applyFailureMode: (...args: unknown[]) => mockApplyFailureMode(...args),
  // start/cancel aren't reached by the resume tests, but listing them
  // keeps the mock surface honest if a future test exercises them
  // through the same module.
  startRun: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockAddStepResult = vi.fn();
const mockAddControlMessage = vi.fn();
const mockGetSessionState = vi.fn();
const mockAtomicCompleteStep = vi.fn();
const mockAllocateRecoverySeqBatch = vi.fn();
const mockBuildRecoveryEvent = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
  atomicCompleteStep: (...args: unknown[]) => mockAtomicCompleteStep(...args),
  allocateRecoverySeqBatch: (...args: unknown[]) => mockAllocateRecoverySeqBatch(...args),
  buildRecoveryEvent: (...args: unknown[]) => mockBuildRecoveryEvent(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  logOrchestratorError: vi.fn(),
}));

// Has to import AFTER the mocks above.
import { handleWorkflowCrudInline } from '../workflowCrud.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const RUN_ID = '11111111-2222-3333-4444-555555555555';
const SESSION_RUN_ID = '99999999-2222-3333-4444-555555555555';

// Failed task's outputContract.schema — `score` field required, must be
// in [0, 1]. The contract violation surfaces when the task produced a
// non-numeric or out-of-range score.
const TASK_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    label: { type: 'string' },
  },
  required: ['score', 'label'],
  additionalProperties: false,
};

// Per-port replace patch — only `score` is in the failed-ports set.
const REPLACE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['score'],
  additionalProperties: false,
};

function makeContract(overrides: Partial<WorkflowResumeContract> = {}): WorkflowResumeContract {
  return {
    pauseCause: 'task_contract_violation',
    allowedResumeModes: ['replace_output'],
    resumePrompt: 'Task "score-task" produced output that did not match its outputContract.',
    replaceOutputSchema: REPLACE_OUTPUT_SCHEMA,
    expectedTaskOutputSchema: TASK_OUTPUT_SCHEMA,
    failedTaskId: 'score-task',
    contractErrors: [],
    ...overrides,
  };
}

function makePausedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-row-id',
    spaceId: SPACE,
    workflowSlug: 'lead-scoring',
    runId: RUN_ID,
    sessionId: 'sess-1',
    status: 'paused',
    workflowRevision: 1,
    startedAt: new Date(),
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    pausedReason: 'task_contract_violation',
    pausedPayloadRef: 'payload:contract-ref',
    pauseVersion: 1,
    resumeAttemptCount: 0,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: {},
    tasks: [
      {
        id: 'task-row-1',
        runId: RUN_ID,
        taskId: 'score-task',
        status: 'paused',
        attempt: 1,
        sessionId: null,
        workerSessionId: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        costCents: null,
        metricsJson: null,
        summary: null,
        failureReason: 'output contract violation',
        outputRef: 'payload:failed-output',
        reflectionJson: null,
      },
    ],
    ...overrides,
  };
}

function makeWorkflow() {
  return {
    workflow: {
      slug: 'lead-scoring',
      revision: 1,
      mode: 'optimization' as const,
      description: 'Score leads',
      tasks: [
        { taskId: 'score-task', name: 'Score Lead', goal: 'g', type: 'agent' as const },
        { taskId: 'submit-task', name: 'Submit', goal: 'g', type: 'agent' as const },
      ],
      outcomes: [],
    },
    source: 'revision' as const,
  };
}

function makeArgs(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockImplementation((ref: string) => {
        if (ref === inputRef) return Promise.resolve(input);
        if (ref === 'payload:failed-output') {
          return Promise.resolve({ score: 999, label: 'high' }); // bad score
        }
        return Promise.resolve(null);
      }),
      store: vi.fn().mockResolvedValue('payload:merged-output'),
    } as never,
    context: {
      tenantId: TENANT,
      runId: SESSION_RUN_ID,
      traceId: 'trace-1',
      spaceId: SPACE,
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: 'wf_resume',
      stepType: 'workflow',
      operation: 'workflow.run.resume',
      tags: [],
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    parentStepExecutionId: null as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inputRef,
  };
}

beforeEach(() => {
  // mockReset (not just clear) drains any queued .mockResolvedValueOnce
  // values from prior tests. clearAllMocks only clears call history;
  // queued return values persist across tests, which can cause stale
  // values to leak into a later test's first call.
  vi.resetAllMocks();
  mockGateWorkflowOperationGrants.mockResolvedValue({ kind: 'ok' });
  mockGetSessionState.mockResolvedValue({
    sessionId: SESSION_RUN_ID,
    tenantId: TENANT,
    agentId: 'cybernetic-helmsman',
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: 1,
    lastUpdatedAt: 1,
  });
  mockAtomicCompleteStep.mockResolvedValue(undefined);
  mockAllocateRecoverySeqBatch.mockResolvedValue([0]);
  mockBuildRecoveryEvent.mockReturnValue({
    version: 1,
    type: 'step.completed',
    tenantId: TENANT,
    runId: SESSION_RUN_ID,
    seq: 0,
    timestamp: 0,
    data: {},
  });
  mockDeriveRunLiveness.mockReturnValue({ liveness: 'waiting_for_input', reason: 'paused' });
  mockResolveWorkflowForRunRevision.mockResolvedValue(makeWorkflow());
  mockListRecentRuns.mockResolvedValue([]);
  mockClaimResumeLease.mockResolvedValue({
    ok: true,
    claim: {
      claimToken: 'claim-token-1',
      pauseVersion: 1,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  mockBumpResumeAttemptCount.mockResolvedValue(1);
  mockCommitReplaceOutputAndResume.mockResolvedValue(true);
  mockCommitRetryFailedTaskAndResume.mockResolvedValue('committed');
  mockComputeDescendants.mockReturnValue(new Set());
  mockComputeBlockedDescendantsToClearForRetry.mockReturnValue(new Set());
  mockResumeRunWithClaim.mockResolvedValue(true);
  mockLoadPendingWaiters.mockResolvedValue([]);
  mockListTaskRows.mockResolvedValue([]);
  mockComputeReadyTasksWithWhen.mockReturnValue({ ready: [], skipped: [], errors: [] });
  mockAddWaiter.mockResolvedValue('waiter-id');
  mockCheckWorkflowCredentialsPreflight.mockResolvedValue({ ok: true, missingBindings: [] });
  mockCheckWorkflowCapabilityPreflight.mockResolvedValue({ ok: true, missingCapabilities: [] });
});

describe('workflow.run.resume — Plan 130 Phase 1 cross-boundary loop', () => {
  it('happy path: replace_output validates merged output and commits atomically', async () => {
    mockLoadRunById.mockResolvedValueOnce(makePausedRun()); // initial load
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'replace_output', output: { score: 0.77 } },
      }),
    );

    // Order of operations must be: claim → bump → commit (atomic helper).
    // No separate recordTaskResult + resumeRunWithClaim split.
    expect(mockClaimResumeLease).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      RUN_ID,
      1, // pauseVersion
    );
    expect(mockBumpResumeAttemptCount).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      RUN_ID,
      'claim-token-1',
    );
    // Atomic commit (task row + run row, single helper).
    expect(mockCommitReplaceOutputAndResume).toHaveBeenCalledTimes(1);
    expect(mockCommitReplaceOutputAndResume).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({
        runId: RUN_ID,
        claimToken: 'claim-token-1',
        failedTaskId: 'score-task',
        outputRef: 'payload:merged-output',
      }),
    );
    // Bump came BEFORE commit (P1/1 — failed validations also count).
    const bumpOrder = mockBumpResumeAttemptCount.mock.invocationCallOrder[0]!;
    const commitOrder = mockCommitReplaceOutputAndResume.mock.invocationCallOrder[0]!;
    expect(bumpOrder).toBeLessThan(commitOrder);

    expect(mockAtomicCompleteStep).toHaveBeenCalledTimes(1);
    expect(mockAddStepResult).not.toHaveBeenCalled();
    const atomicArgs = mockAtomicCompleteStep.mock.calls[0]!;
    const stepUpdates = atomicArgs[2] as { status: string };
    const runUpdates = atomicArgs[3] as { status: string; requestedInputRef: string };
    expect(stepUpdates.status).toBe('PAUSED');
    expect(runUpdates.status).toBe('PAUSED');
    const requestedInputRef = runUpdates.requestedInputRef;
    const decoded = JSON.parse(
      Buffer.from(requestedInputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(decoded['kind']).toBe('waiting_on_workflow_run');
    expect(decoded['runId']).toBe(RUN_ID);
    expect(decoded['status']).toBe('running');

    // No releaseResumeClaim call on the happy path.
    expect(mockReleaseResumeClaim).not.toHaveBeenCalled();

    expect(mockAddControlMessage).not.toHaveBeenCalled();

    expect(mockAddWaiter).toHaveBeenCalledTimes(1);
    const waiterArgs = mockAddWaiter.mock.calls[0]![2] as {
      runId: string;
      waiterSessionId: string;
    };
    expect(waiterArgs.runId).toBe(RUN_ID);
    expect(waiterArgs.waiterSessionId).toBe(SESSION_RUN_ID);

    const parkOrder = mockAtomicCompleteStep.mock.invocationCallOrder[0]!;
    const addWaiterOrder = mockAddWaiter.mock.invocationCallOrder[0]!;
    expect(parkOrder).toBeLessThan(addWaiterOrder);
  });

  it('patch out-of-range bumps counter, rejected by replaceOutputSchema before merge (P1/1)', async () => {
    // score must be in [0, 1] per replaceOutputSchema. The patch schema gates
    // first — a patch that wouldn't pass the per-port subset schema is rejected
    // before it can reach the merge step. P1/1: counter still bumps so the cap
    // catches repeated bad patches.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'replace_output', output: { score: 99 } },
      }),
    );

    expect(mockBumpResumeAttemptCount).toHaveBeenCalledTimes(1);
    expect(mockCommitReplaceOutputAndResume).not.toHaveBeenCalled();
    expect(mockReleaseResumeClaim).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      RUN_ID,
      'claim-token-1',
    );

    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(result['status']).toBe('FAILED');
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('REPLACE_OUTPUT_PATCH_INVALID');
  });

  it('rejects a patch that tries to overwrite a passing port (P1/1: per-port subset)', async () => {
    // The contract's replaceOutputSchema only allows `score` (the failed port).
    // A patch that ALSO touches `label` (a passing port) violates the per-port
    // subset guarantee — the patch schema's additionalProperties:false catches it.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 'replace_output',
          output: { score: 0.5, label: 'rewritten' }, // label was passing — must not be touched
        },
      }),
    );

    expect(mockCommitReplaceOutputAndResume).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('REPLACE_OUTPUT_PATCH_INVALID');
  });

  it('STALE_PAUSE_VERSION rejected at the lease — no bump, no commit', async () => {
    mockLoadRunById.mockResolvedValueOnce(makePausedRun({ pauseVersion: 2 }));
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 2,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    mockClaimResumeLease.mockResolvedValueOnce({ ok: false, code: 'STALE_PAUSE_VERSION' });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1, // stale — live row is at 2
        resolution: { mode: 'replace_output', output: { score: 0.5 } },
      }),
    );

    expect(mockBumpResumeAttemptCount).not.toHaveBeenCalled();
    expect(mockCommitReplaceOutputAndResume).not.toHaveBeenCalled();
    expect(mockReleaseResumeClaim).not.toHaveBeenCalled();

    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(result['status']).toBe('FAILED');
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('STALE_PAUSE_VERSION');
  });

  it('Phase 3d — concurrent resume: second resumer sees RESUME_IN_PROGRESS', async () => {
    // Two Helmsmen attempt resume on the same pauseVersion. The first
    // claimResumeLease succeeds; the second sees the active claim and
    // gets RESUME_IN_PROGRESS. Verify: bump does NOT fire for the
    // loser, commit does NOT fire, and the loser's step result is
    // FAILED with the typed code.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    // Loser path: claimResumeLease returns ok=false code=RESUME_IN_PROGRESS.
    mockClaimResumeLease.mockResolvedValueOnce({ ok: false, code: 'RESUME_IN_PROGRESS' });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'replace_output', output: { score: 0.5 } },
      }),
    );

    // Loser short-circuits BEFORE bump/commit/release (release only
    // fires for losers that already held a claim — RESUME_IN_PROGRESS
    // means we never got one).
    expect(mockBumpResumeAttemptCount).not.toHaveBeenCalled();
    expect(mockCommitReplaceOutputAndResume).not.toHaveBeenCalled();
    expect(mockReleaseResumeClaim).not.toHaveBeenCalled();

    // Loser's step result is FAILED with the typed CAS-race code.
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(result['status']).toBe('FAILED');
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('RESUME_IN_PROGRESS');
  });

  it('replace_output cap: claims lease, promotes under CAS, releases, rejects at cap', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makePausedRun({ resumeAttemptCount: RESUME_REPLACE_OUTPUT_ATTEMPT_CAP }),
    );
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: RESUME_REPLACE_OUTPUT_ATTEMPT_CAP,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'replace_output', output: { score: 0.5 } },
      }),
    );

    expect(mockClaimResumeLease).toHaveBeenCalled();
    expect(mockReleaseResumeClaim).toHaveBeenCalled();
    expect(mockBumpResumeAttemptCount).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('RESUME_ATTEMPT_CAP_REACHED');
  });

  it('refuses all modes when task_contract_violation has no surfaced contract (round-2 P0/1)', async () => {
    // Contract construction failed (or row was repaused with no payload ref).
    // surfaceWorkflowResumeContract returns null. acknowledge would otherwise
    // sail through resumeRunWithClaim, leaving the failed task row paused
    // while the run flips to running. This test pins the hard-require guard.
    mockLoadRunById.mockResolvedValueOnce(
      makePausedRun({ pausedReason: 'task_contract_violation' }),
    );
    mockSurfaceWorkflowResumeContract.mockResolvedValue(null);

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'acknowledge' },
      }),
    );

    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    expect(mockResumeRunWithClaim).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('RESUME_CONTRACT_UNAVAILABLE');
  });

  it('atomic commit reports task_row_not_paused → handler surfaces typed error (round-2 P0/2)', async () => {
    // The atomic commit helper rolls back when the failed task row isn't
    // actually `paused` (e.g., reprocessed out-of-band, or the contract
    // pointed at a stale taskId). The handler must surface this distinctly
    // from a lease loss so the resumer knows the row state — not the
    // claim — is the problem.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    mockCommitReplaceOutputAndResume.mockResolvedValueOnce('task_row_not_paused');

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'replace_output', output: { score: 0.5 } },
      }),
    );

    expect(mockCommitReplaceOutputAndResume).toHaveBeenCalledTimes(1);
    expect(mockReleaseResumeClaim).toHaveBeenCalledTimes(1);
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('RESUME_TASK_ROW_NOT_PAUSED');
  });

  it('rejects mode not in contract.allowedResumeModes (P0/1: no advertised stranded modes)', async () => {
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    // Contract only advertises replace_output for this pause cause.
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({ allowedResumeModes: ['replace_output'] }),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'acknowledge' },
      }),
    );

    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('RESOLUTION_MODE_NOT_ALLOWED');
  });

  it('Plan 167 — rejects acknowledge on HITL pause (human.action_center.focus)', async () => {
    mockLoadRunById.mockResolvedValueOnce(makePausedRun({ pausedReason: 'needs_decision' }));
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: {
        ...makeContract({ allowedResumeModes: ['replace_output', 'acknowledge', 'fail'] }),
        suggestedResumeCall: {
          op: 'human.action_center.focus',
          args: { itemId: 'gate:step-1' },
        },
      },
      pauseVersion: 1,
      pausedReason: 'needs_decision',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'acknowledge' },
      }),
    );

    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('ACKNOWLEDGE_NOT_ALLOWED_ON_HITL');
  });

  it('Plan 171 — acknowledge on needs_credentials re-checks preflight before claim', async () => {
    // Plan 226: the run's persisted connection pin must thread into the re-check so
    // a `{kind:'connection'}` grant is credential-checked against the real binding
    // (not skipped) — assert the pin reaches checkWorkflowCredentialsPreflight.
    mockLoadRunById.mockResolvedValueOnce(
      makePausedRun({
        pausedReason: 'needs_credentials',
        metadata: { connectionBindingId: 'conn-resume-1' },
      }),
    );
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        pauseCause: 'needs_credentials',
        allowedResumeModes: ['acknowledge', 'fail'],
        failedTaskId: undefined,
        replaceOutputSchema: undefined,
        expectedTaskOutputSchema: undefined,
      }),
      pauseVersion: 1,
      pausedReason: 'needs_credentials',
      resumeAttemptCount: 0,
    });
    mockCheckWorkflowCredentialsPreflight.mockResolvedValueOnce({
      ok: false,
      missingBindings: [],
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'acknowledge' },
      }),
    );

    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    expect(mockCheckWorkflowCredentialsPreflight).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'conn-resume-1',
    );
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('WORKFLOW_PRECHECK_CREDENTIALS_MISSING');
  });

  it('Plan 171 — acknowledge on needs_capability re-checks preflight before claim', async () => {
    mockLoadRunById.mockResolvedValueOnce(makePausedRun({ pausedReason: 'needs_capability' }));
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        pauseCause: 'needs_capability',
        allowedResumeModes: ['acknowledge', 'fail'],
        failedTaskId: undefined,
        replaceOutputSchema: undefined,
        expectedTaskOutputSchema: undefined,
      }),
      pauseVersion: 1,
      pausedReason: 'needs_capability',
      resumeAttemptCount: 0,
    });
    mockCheckWorkflowCapabilityPreflight.mockResolvedValueOnce({
      ok: false,
      missingCapabilities: ['cap:missing'],
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'acknowledge' },
      }),
    );

    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('WORKFLOW_PRECHECK_CAPABILITY_MISSING');
  });

  it('refuses to resume when an operation the run dispatches is still ungranted', async () => {
    // Operation tasks never pass step gating, so acknowledging the pause that
    // named the gap would run the operation on the authority that refused it.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun({ pausedReason: 'needs_capability' }));
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        pauseCause: 'needs_capability',
        allowedResumeModes: ['acknowledge', 'fail'],
        failedTaskId: undefined,
        replaceOutputSchema: undefined,
        expectedTaskOutputSchema: undefined,
      }),
      pauseVersion: 1,
      pausedReason: 'needs_capability',
      resumeAttemptCount: 0,
    });
    mockCheckWorkflowCapabilityPreflight.mockResolvedValueOnce({
      ok: true,
      missingCapabilities: [],
    });
    mockGateWorkflowOperationGrants.mockResolvedValue({
      kind: 'ungranted',
      ungrantedOperations: [
        {
          operationId: 'compute.sandbox.exec',
          reason: 'the "Personal Safe" capability profile does not include compute.sandbox',
          consumingTaskIds: ['task-a'],
        },
      ],
    });

    await handleWorkflowCrudInline(
      makeArgs({ runId: RUN_ID, pauseVersion: 1, resolution: { mode: 'acknowledge' } }),
    );

    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('WORKFLOW_PRECHECK_OPERATION_NOT_GRANTED');
  });

  it('refuses to resume when current authority cannot be established', async () => {
    // Unknown authority is not unchanged authority: op tasks dispatch without
    // a second gate, so resuming on an unverified snapshot is fail-open.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun({ pausedReason: 'needs_capability' }));
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        pauseCause: 'needs_capability',
        allowedResumeModes: ['acknowledge'],
        failedTaskId: undefined,
        replaceOutputSchema: undefined,
        expectedTaskOutputSchema: undefined,
      }),
      pauseVersion: 1,
      pausedReason: 'needs_capability',
      resumeAttemptCount: 0,
    });
    mockCheckWorkflowCapabilityPreflight.mockResolvedValueOnce({
      ok: true,
      missingCapabilities: [],
    });
    mockGateWorkflowOperationGrants.mockResolvedValue({
      kind: 'authority_unavailable',
      detail: 'ECONNRESET',
    });

    await handleWorkflowCrudInline(
      makeArgs({ runId: RUN_ID, pauseVersion: 1, resolution: { mode: 'acknowledge' } }),
    );

    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorPayload = result['error'] as Record<string, unknown>;
    expect(errorPayload['code']).toBe('RUN_ACCESS_UNAVAILABLE');
  });

  it('does not gate a resume that ends the run — closing it must not need a grant', async () => {
    mockLoadRunById.mockResolvedValueOnce(makePausedRun({ pausedReason: 'needs_capability' }));
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        pauseCause: 'needs_capability',
        allowedResumeModes: ['acknowledge', 'fail'],
        failedTaskId: undefined,
        replaceOutputSchema: undefined,
        expectedTaskOutputSchema: undefined,
      }),
      pauseVersion: 1,
      pausedReason: 'needs_capability',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'fail', reason: 'operator closed it' },
      }),
    );

    expect(mockGateWorkflowOperationGrants).not.toHaveBeenCalled();
  });

  it('Plan 171 P1 — re_execute respects the per-task retry budget cap', async () => {
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'lead-scoring',
        revision: 1,
        mode: 'optimization' as const,
        description: 'Score leads',
        tasks: [
          {
            taskId: 'score-task',
            name: 'Score Lead',
            goal: 'g',
            type: 'agent' as const,
            retryability: 'safe' as const,
            maxAttempts: 1,
          },
        ],
        outcomes: [],
      },
      source: 'revision' as const,
    });
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({ allowedResumeModes: ['replace_output', 're_execute'] }),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 're_execute', instructions: 'try a different upstream' },
      }),
    );

    // Lease was claimed (the contract gate accepted re_execute).
    expect(mockClaimResumeLease).toHaveBeenCalledTimes(1);
    // No commit on re_execute path — the budget gate refuses pre-commit.
    expect(mockCommitReExecutePausedTaskAndResume).not.toHaveBeenCalled();
    expect(mockResumeRunWithClaim).not.toHaveBeenCalled();
    // Lease released so a follow-up resume isn't blocked.
    expect(mockReleaseResumeClaim).toHaveBeenCalledTimes(1);

    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(result['status']).toBe('FAILED');
    const errorRef = (result['errorRef'] as string).slice('inline:'.length);
    const error = JSON.parse(Buffer.from(errorRef, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(error['code']).toBe('RETRY_ATTEMPT_BUDGET_EXHAUSTED');
  });

  it('Plan 173 — retry_failed_task refuses cancel_siblings tasks before commit', async () => {
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'lead-scoring',
        revision: 1,
        mode: 'optimization' as const,
        description: 'Score leads',
        tasks: [
          {
            taskId: 'score-task',
            name: 'Score Lead',
            goal: 'g',
            type: 'agent' as const,
            retryability: 'safe' as const,
            failureMode: 'cancel_siblings' as const,
            maxAttempts: 3,
          },
        ],
        outcomes: [],
      },
      source: 'revision' as const,
    });
    mockLoadRunById.mockResolvedValueOnce(
      makePausedRun({
        status: 'failed',
        completedAt: new Date('2026-06-03T17:08:00.000Z'),
        pausedReason: null,
        pausedPayloadRef: null,
        tasks: [
          {
            id: 'task-row-1',
            runId: RUN_ID,
            taskId: 'score-task',
            status: 'failed',
            attempt: 1,
            failedAt: new Date('2026-06-03T17:08:00.000Z'),
            failureReason: 'External call failed',
          },
        ],
      }),
    );

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        resolution: {
          mode: 'retry_failed_task',
          taskId: 'score-task',
          failedAt: '2026-06-03T17:08:00.000Z',
          attempt: 1,
        },
      }),
    );

    expect(mockCommitRetryFailedTaskAndResume).not.toHaveBeenCalled();
    expect(mockComputeBlockedDescendantsToClearForRetry).not.toHaveBeenCalled();
    expect(mockDispatchRetriedTask).not.toHaveBeenCalled();

    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(result['status']).toBe('FAILED');
    const error = result['error'] as Record<string, unknown>;
    expect(error['code']).toBe('RETRY_CANCEL_SIBLINGS_NOT_RECOVERABLE');
  });

  it('Plan 132v2.3.1a — addWaiter is called BEFORE loadPendingWaiters/handoff (durable wake)', async () => {
    // Resume tail must insert the new waiter row FIRST so any later
    // failure (handoff or dispatch) is recoverable via
    // completeRun(failed) → notifyWaiters('failed') reaching this
    // session. Previously the order was handoff → addWaiter → dispatch,
    // so an addWaiter throw left the original Helmsman 'handed_off'
    // and no waiter for the recovery path to wake.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    // Pretend there's an old waiter to hand off, so loadPendingWaiters
    // would actually do work — gives the call a recorded order.
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'old-waiter',
        runId: RUN_ID,
        waiterSessionId: 'sess-old',
        waiterStepExecutionId: 'step-old',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        takeOver: true,
        resolution: { mode: 'replace_output', output: { score: 0.5 } },
      }),
    );

    // Both fired.
    expect(mockAddWaiter).toHaveBeenCalledOnce();
    expect(mockLoadPendingWaiters).toHaveBeenCalled();

    // Critical ordering: addWaiter ran BEFORE loadPendingWaiters
    // (which gates the handoff). The handoff filter excludes the
    // calling session, so inserting first is safe; the reverse order
    // would lose durability if addWaiter throws after handoff.
    const addWaiterOrder = mockAddWaiter.mock.invocationCallOrder[0]!;
    const loadPendingOrder = mockLoadPendingWaiters.mock.invocationCallOrder[0]!;
    expect(addWaiterOrder).toBeLessThan(loadPendingOrder);
  });

  it('resume WITHOUT takeOver leaves pre-existing waiters registered (no handed_off)', async () => {
    // The default resolves the paused task and rebinds the resuming
    // session as an ADDITIONAL waiter; the original driver's wait stays
    // intact and receives the run's later pause/terminal notifications
    // via the normal notifyWaiters loop.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'old-waiter',
        runId: RUN_ID,
        waiterSessionId: 'sess-old',
        waiterStepExecutionId: 'step-old',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'replace_output', output: { score: 0.5 } },
      }),
    );

    // Commit landed and the resuming session was rebound as a waiter.
    expect(mockCommitReplaceOutputAndResume).toHaveBeenCalledOnce();
    expect(mockAddWaiter).toHaveBeenCalledOnce();

    // The old waiter was never displaced: the handoff branch (pending
    // waiter load + handed_off notification) never ran and no waiter row
    // was marked notified — the harness's next paused/terminal
    // notifyWaiters will reach it with the full outcome.
    expect(mockLoadPendingWaiters).not.toHaveBeenCalled();
    expect(mockNotifyWaiters).not.toHaveBeenCalled();
    expect(mockMarkWaiterNotified).not.toHaveBeenCalled();

    // The run was still driven forward for the resuming session.
    expect(mockDispatchNextOrTerminate).toHaveBeenCalledOnce();
  });

  it('takeOver has no effect on retry_failed_task — the retry branch exits before the handoff tail', async () => {
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'lead-scoring',
        revision: 1,
        mode: 'optimization' as const,
        description: 'Score leads',
        tasks: [
          {
            taskId: 'score-task',
            name: 'Score Lead',
            goal: 'g',
            type: 'agent' as const,
            retryability: 'safe' as const,
            failureMode: 'cancel_siblings' as const,
            maxAttempts: 3,
          },
        ],
        outcomes: [],
      },
      source: 'revision' as const,
    });
    mockLoadRunById.mockResolvedValueOnce(
      makePausedRun({
        status: 'failed',
        completedAt: new Date('2026-06-03T17:08:00.000Z'),
        pausedReason: null,
        pausedPayloadRef: null,
        tasks: [
          {
            id: 'task-row-1',
            runId: RUN_ID,
            taskId: 'score-task',
            status: 'failed',
            attempt: 1,
            failedAt: new Date('2026-06-03T17:08:00.000Z'),
            failureReason: 'External call failed',
          },
        ],
      }),
    );

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        takeOver: true,
        resolution: {
          mode: 'retry_failed_task',
          taskId: 'score-task',
          failedAt: '2026-06-03T17:08:00.000Z',
          attempt: 1,
        },
      }),
    );

    expect(mockLoadPendingWaiters).not.toHaveBeenCalled();
    expect(mockNotifyWaiters).not.toHaveBeenCalled();
    expect(mockMarkWaiterNotified).not.toHaveBeenCalled();
  });

  it('resume WITH takeOver hands off prior waiters with the enriched payload', async () => {
    mockLoadRunById
      .mockResolvedValueOnce(makePausedRun())
      .mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'old-waiter',
        runId: RUN_ID,
        waiterSessionId: 'sess-old',
        waiterStepExecutionId: 'step-old',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);
    mockGetSessionState.mockResolvedValue({
      sessionId: SESSION_RUN_ID,
      tenantId: TENANT,
      agentId: 'cybernetic-helmsman',
      agentVersion: '1',
      status: 'RUNNING',
      createdAt: 1,
      lastUpdatedAt: 1,
      actorContextJson: JSON.stringify({
        userId: '77777777-7777-7777-7777-777777777777',
        kind: 'human',
        authMethod: 'session',
        tenantId: TENANT,
        tenantRole: 'admin',
        capturedAt: new Date().toISOString(),
      }),
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        takeOver: true,
        resolution: { mode: 'replace_output', output: { score: 0.5 } },
      }),
    );

    expect(mockNotifyWaiters).toHaveBeenCalledOnce();
    expect(mockNotifyWaiters.mock.calls[0]![1]).toMatchObject({
      runId: RUN_ID,
      outcome: 'handed_off',
      excludeSessionIds: [SESSION_RUN_ID],
      handoffPayload: {
        resumedBy: SESSION_RUN_ID,
        actorKind: 'human',
        runStatusAtHandoff: 'running',
        nextStep: 'released_do_not_poll',
      },
    });
  });

  it('takeOver handoff enrichment failures are swallowed — the resume still lands', async () => {
    // The enrichment reads live inside the post-commit harness tail, whose
    // catch escalates to completeRun(failed): a transient error on a read
    // that only decorates the handoff envelope must not fail the run. The
    // default session state carries no actorContextJson, so actorKind is
    // also expected to be omitted.
    mockLoadRunById
      .mockResolvedValueOnce(makePausedRun())
      .mockRejectedValueOnce(new Error('transient db error'));
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    mockLoadPendingWaiters.mockResolvedValue([
      {
        id: 'old-waiter',
        runId: RUN_ID,
        waiterSessionId: 'sess-old',
        waiterStepExecutionId: 'step-old',
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        takeOver: true,
        resolution: { mode: 'replace_output', output: { score: 0.5 } },
      }),
    );

    // The handoff still fires with the guaranteed fields only, and the
    // failed enrichment reads never escalate to completeRun(failed).
    expect(mockNotifyWaiters).toHaveBeenCalledOnce();
    expect(mockNotifyWaiters.mock.calls[0]![1]).toMatchObject({
      outcome: 'handed_off',
      handoffPayload: {
        resumedBy: SESSION_RUN_ID,
        nextStep: 'released_do_not_poll',
      },
    });
    const payload = (
      mockNotifyWaiters.mock.calls[0]![1] as {
        handoffPayload: Record<string, unknown>;
      }
    ).handoffPayload;
    expect(payload['actorKind']).toBeUndefined();
    expect(payload['runStatusAtHandoff']).toBeUndefined();
    expect(mockHarnessCompleteRun).not.toHaveBeenCalled();
    expect(mockDispatchNextOrTerminate).toHaveBeenCalledOnce();
  });

  it('Plan 132v2.3.1c — harness rebind failure AFTER commit drives completeRun(failed)', async () => {
    // The CAS commit succeeds (task=succeeded, run=running). Then
    // the harness rebind throws (e.g., addWaiter fails). Without
    // explicit failure handling the run would orphan-run with the
    // resume step parked in PAUSED forever. The handler now
    // completeRuns(failed) → notifyWaiters('failed') → wakes the
    // resume step's PAUSED with the failure outcome.
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract(),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    // Commit succeeds; addWaiter then throws.
    mockAddWaiter.mockRejectedValueOnce(new Error('waiter insert failed'));

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 'replace_output', output: { score: 0.42 } },
      }),
    );

    // Commit landed.
    expect(mockCommitReplaceOutputAndResume).toHaveBeenCalledOnce();

    expect(mockAtomicCompleteStep).toHaveBeenCalledTimes(1);
    const parkOrder = mockAtomicCompleteStep.mock.invocationCallOrder[0]!;
    const addWaiterOrder = mockAddWaiter.mock.invocationCallOrder[0]!;
    expect(parkOrder).toBeLessThan(addWaiterOrder);

    // Recovery path fired: harness completeRun(failed) drives
    // notifyWaiters('failed') so the parked resume step wakes with
    // the failure outcome rather than orphan-running.
    expect(mockHarnessCompleteRun).toHaveBeenCalledTimes(1);
    const completeArgs = mockHarnessCompleteRun.mock.calls[0]!;
    expect(completeArgs[3]).toBe('failed');

    // completeRun was called with status='failed' as the recovery
    // path — wakes the resume step via notifyWaiters('failed').
    // The mock points at @aflow/cybernetic-runtime's completeRun
    // (top-level import in WorkflowRunHarness via the real harness's
    // ledgerCompleteRun call), but here we just check that the
    // dynamic import succeeded and the chain ran without crashing.
    // The full notifyWaiters wakeup is exercised in
    // WorkflowRunHarness.test.ts; here we just verify the resume
    // handler invokes the recovery path on rebind failure.
  });
});

// ============================================================================

function makeSignalBlockedRun(taskId = 'elicit-target') {
  return {
    id: 'run-row-id',
    spaceId: SPACE,
    workflowSlug: 'bind-capability',
    runId: RUN_ID,
    sessionId: 'sess-1',
    status: 'paused',
    workflowRevision: 1,
    startedAt: new Date(),
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    // Signal_blocked pauses don't set `failedTaskId` on the contract;
    // they store a SubagentHandoff-shaped payload. The resume handler's
    // mode-allowed gate is permissive when `allowedResumeModes` is
    // absent on the surfaced contract.
    pausedReason: 'subagent_handoff',
    pausedPayloadRef: 'payload:signal-blocked-ref',
    pauseVersion: 1,
    resumeAttemptCount: 0,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: {},
    tasks: [
      {
        id: 'task-row-1',
        runId: RUN_ID,
        taskId,
        status: 'paused',
        attempt: 1,
        sessionId: null,
        workerSessionId: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        costCents: null,
        metricsJson: null,
        summary: null,
        failureReason: 'signal_blocked: missing_input',
        outputRef: null,
        reflectionJson: null,
      },
    ],
  };
}

function makeBindCapabilityWorkflow(opts?: { withInputContract?: boolean }) {
  const base = { taskId: 'elicit-target', name: 'Elicit', goal: 'g', type: 'agent' as const };
  const elicit = opts?.withInputContract
    ? {
        ...base,
        inputContract: {
          bindings: {
            vendor: {
              kind: 'run_input' as const,
              bindAs: 'vendor',
              path: 'vendor',
              schema: { type: 'string', minLength: 3 },
            },
          },
        },
      }
    : base;
  return {
    workflow: {
      slug: 'bind-capability',
      revision: 1,
      mode: 'process' as const,
      description: 'Bind external API',
      tasks: [
        elicit,
        {
          taskId: 'draft-definition',
          name: 'Draft',
          goal: 'g',
          type: 'agent' as const,
          dependsOn: ['elicit-target'],
        },
      ],
      outcomes: [],
    },
    source: 'revision' as const,
  };
}

describe('workflow.run.resume — Plan 141 §4.2 provide_input mode', () => {
  beforeEach(() => {
    // Default: signal_blocked contract without `allowedResumeModes` — the
    // mode-allowed gate lets `provide_input` through.
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: {
        pauseCause: 'subagent_handoff' as const,
        resumePrompt: 'Runner needs missing_input to proceed',
      },
      pauseVersion: 1,
      pausedReason: 'subagent_handoff',
      resumeAttemptCount: 0,
    });
    mockCommitProvideInputAndResume.mockResolvedValue('committed');
  });

  it('happy path (catch-all): no inputContract → commit fires with the validated inputs', async () => {
    mockLoadRunById.mockResolvedValueOnce(makeSignalBlockedRun());
    mockResolveWorkflowForRunRevision.mockResolvedValue(makeBindCapabilityWorkflow());

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 'provide_input',
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca', baseUrl: 'https://paper-api.alpaca.markets' },
        },
      }),
    );

    expect(mockClaimResumeLease).toHaveBeenCalledOnce();
    expect(mockBumpResumeAttemptCount).toHaveBeenCalledOnce();
    expect(mockCommitProvideInputAndResume).toHaveBeenCalledOnce();
    const commitArgs = mockCommitProvideInputAndResume.mock.calls[0]![2] as Record<string, unknown>;
    expect(commitArgs['runId']).toBe(RUN_ID);
    expect(commitArgs['taskId']).toBe('elicit-target');
    expect(commitArgs['parentTaskInputs']).toEqual({
      taskId: 'elicit-target',
      inputs: { vendor: 'Alpaca', baseUrl: 'https://paper-api.alpaca.markets' },
    });
  });

  it('happy path (strict): inputContract validates the parent inputs', async () => {
    mockLoadRunById.mockResolvedValueOnce(makeSignalBlockedRun());
    mockResolveWorkflowForRunRevision.mockResolvedValue(
      makeBindCapabilityWorkflow({ withInputContract: true }),
    );

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 'provide_input',
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca' },
        },
      }),
    );

    expect(mockCommitProvideInputAndResume).toHaveBeenCalledOnce();
  });

  it('strict path: rejects PARENT_INPUTS_INVALID with structured details (P2 review fix)', async () => {
    mockLoadRunById.mockResolvedValueOnce(makeSignalBlockedRun());
    mockResolveWorkflowForRunRevision.mockResolvedValue(
      makeBindCapabilityWorkflow({ withInputContract: true }),
    );

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 'provide_input',
          taskId: 'elicit-target',
          // schema requires minLength 3 — "ab" fails.
          inputs: { vendor: 'ab' },
        },
      }),
    );

    expect(mockCommitProvideInputAndResume).not.toHaveBeenCalled();
    // bump attempt count happens AFTER validation per applyProvideInputResolution.
    expect(mockBumpResumeAttemptCount).not.toHaveBeenCalled();
    expect(mockReleaseResumeClaim).toHaveBeenCalledOnce();

    const failedCall = mockAddStepResult.mock.calls.find(
      (c) => (c[1] as { status: string }).status === 'FAILED',
    );
    expect(failedCall).toBeDefined();
    const errorRef = (failedCall![1] as { errorRef: string }).errorRef;
    const error = JSON.parse(
      Buffer.from(errorRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(error['code']).toBe('PARENT_INPUTS_INVALID');
    // Phase 3 review fix (P2) — structured details match Phase 2's
    // start-path codes so parents can branch on machine-readable fields.
    const details = error['details'] as Record<string, unknown>;
    expect(details).toBeDefined();
    expect(details['firstTaskId']).toBe('elicit-target');
    expect(details['populatableBindAs']).toEqual(['vendor']);
    const issues = details['issues'] as Array<Record<string, unknown>>;
    expect(issues[0]!['code']).toBe('SCHEMA_VIOLATION');
    expect(issues[0]!['bindAs']).toBe('vendor');
  });

  it('rejects PROVIDE_INPUT_TASK_NOT_PAUSED when the named task is not paused on the run', async () => {
    // Run paused, but a DIFFERENT task is paused — the parent named the
    // wrong taskId. Surface the actual paused taskIds in the message.
    mockLoadRunById.mockResolvedValueOnce(makeSignalBlockedRun('actually-paused-task'));
    mockResolveWorkflowForRunRevision.mockResolvedValue(makeBindCapabilityWorkflow());

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 'provide_input',
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca' },
        },
      }),
    );

    expect(mockCommitProvideInputAndResume).not.toHaveBeenCalled();
    expect(mockReleaseResumeClaim).toHaveBeenCalledOnce();

    const failedCall = mockAddStepResult.mock.calls.find(
      (c) => (c[1] as { status: string }).status === 'FAILED',
    );
    const errorRef = (failedCall![1] as { errorRef: string }).errorRef;
    const error = JSON.parse(
      Buffer.from(errorRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(error['code']).toBe('PROVIDE_INPUT_TASK_NOT_PAUSED');
    expect(error['message']).toContain('actually-paused-task');
    // Phase 3 review fix (P2) — structured details for self-correction.
    const details = error['details'] as Record<string, unknown>;
    expect(details).toBeDefined();
    expect(details['taskId']).toBe('elicit-target');
    expect(details['pausedTaskIds']).toEqual(['actually-paused-task']);
  });

  it('rejects RESUME_COMMIT_LOST when the ledger reports claim_lost', async () => {
    mockLoadRunById.mockResolvedValueOnce(makeSignalBlockedRun());
    mockResolveWorkflowForRunRevision.mockResolvedValue(makeBindCapabilityWorkflow());
    mockCommitProvideInputAndResume.mockResolvedValueOnce('claim_lost');

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 'provide_input',
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca' },
        },
      }),
    );

    expect(mockCommitProvideInputAndResume).toHaveBeenCalledOnce();
    expect(mockReleaseResumeClaim).toHaveBeenCalledOnce();
    const failedCall = mockAddStepResult.mock.calls.find(
      (c) => (c[1] as { status: string }).status === 'FAILED',
    );
    const errorRef = (failedCall![1] as { errorRef: string }).errorRef;
    const error = JSON.parse(
      Buffer.from(errorRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(error['code']).toBe('RESUME_COMMIT_LOST');
  });

  it('rejects via the contract gate when allowedResumeModes excludes provide_input', async () => {
    mockLoadRunById.mockResolvedValueOnce(makeSignalBlockedRun());
    mockResolveWorkflowForRunRevision.mockResolvedValue(makeBindCapabilityWorkflow());
    // Contract advertises only acknowledge — provide_input should be rejected.
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: {
        pauseCause: 'subagent_handoff' as const,
        resumePrompt: 'manual',
        allowedResumeModes: ['acknowledge'],
      },
      pauseVersion: 1,
      pausedReason: 'subagent_handoff',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 'provide_input',
          taskId: 'elicit-target',
          inputs: { vendor: 'Alpaca' },
        },
      }),
    );

    expect(mockClaimResumeLease).not.toHaveBeenCalled();
    expect(mockCommitProvideInputAndResume).not.toHaveBeenCalled();
    const failedCall = mockAddStepResult.mock.calls.find(
      (c) => (c[1] as { status: string }).status === 'FAILED',
    );
    const errorRef = (failedCall![1] as { errorRef: string }).errorRef;
    const error = JSON.parse(
      Buffer.from(errorRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(error['code']).toBe('RESOLUTION_MODE_NOT_ALLOWED');
  });

  it('Plan 171 P1 — re_execute happy path commits and routes to dispatchRetriedTask (not dispatchNextOrTerminate)', async () => {
    // Workflow exposes the failed task as `retryability: 'safe'` and a
    // budget of 3 attempts (the Kaggle config moves submit-call to
    // unsafe; here we test the safe branch). Row at attempt=1 so the
    // post-commit attempt is 2.
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'lead-scoring',
        revision: 1,
        mode: 'optimization' as const,
        description: 'Score leads',
        tasks: [
          {
            taskId: 'score-task',
            name: 'Score Lead',
            goal: 'g',
            type: 'agent' as const,
            retryability: 'safe' as const,
            maxAttempts: 3,
          },
        ],
        outcomes: [],
      },
      source: 'revision' as const,
    });
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        allowedResumeModes: ['re_execute', 'fail'],
        failedTaskId: 'score-task',
      }),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    mockCommitReExecutePausedTaskAndResume.mockResolvedValue('committed');

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 're_execute',
          instructions: 'Verified upstream API; retry the call.',
        },
      }),
    );

    // Lease claimed + atomic commit landed.
    expect(mockClaimResumeLease).toHaveBeenCalledTimes(1);
    expect(mockCommitReExecutePausedTaskAndResume).toHaveBeenCalledTimes(1);
    const commitArgs = mockCommitReExecutePausedTaskAndResume.mock.calls[0]![2] as Record<
      string,
      unknown
    >;
    expect(commitArgs['runId']).toBe(RUN_ID);
    expect(commitArgs['taskId']).toBe('score-task');
    expect(commitArgs['expectedAttempt']).toBe(1);
    // parentInstructionsPatch carries the normalized stored shape.
    expect(commitArgs['parentInstructionsPatch']).toBeDefined();

    // ORPHAN PREVENTION INVARIANT — dispatchRetriedTask was called with
    // the bumped attempt, dispatchNextOrTerminate was NOT.
    expect(mockDispatchRetriedTask).toHaveBeenCalledTimes(1);
    const dispatchArgs = mockDispatchRetriedTask.mock.calls[0]![1] as Record<string, unknown>;
    expect(dispatchArgs['runId']).toBe(RUN_ID);
    expect(dispatchArgs['taskId']).toBe('score-task');
    expect(dispatchArgs['attempt']).toBe(2);
    expect(mockDispatchNextOrTerminate).not.toHaveBeenCalled();
  });

  it('Plan 171 P1 — re_execute refuses unsafe task without remediationConfirmed (no lease consumed beyond claim)', async () => {
    // Task declares retryability: 'unsafe'. Without remediationConfirmed,
    // the mode handler returns RE_EXECUTE_UNSAFE_TASK_REQUIRES_CONFIRMATION
    // BEFORE the commit helper is invoked. The lease was claimed (gate
    // is downstream of the contract check) and released on the way out.
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'lead-scoring',
        revision: 1,
        mode: 'optimization' as const,
        description: 'Score leads',
        tasks: [
          {
            taskId: 'score-task',
            name: 'Score Lead',
            goal: 'g',
            type: 'agent' as const,
            retryability: 'unsafe' as const,
            maxAttempts: 3,
          },
        ],
        outcomes: [],
      },
      source: 'revision' as const,
    });
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        allowedResumeModes: ['re_execute', 'fail'],
        failedTaskId: 'score-task',
      }),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 're_execute', instructions: 'try again' },
      }),
    );

    expect(mockClaimResumeLease).toHaveBeenCalledTimes(1);
    expect(mockCommitReExecutePausedTaskAndResume).not.toHaveBeenCalled();
    expect(mockDispatchRetriedTask).not.toHaveBeenCalled();
    expect(mockDispatchNextOrTerminate).not.toHaveBeenCalled();
    expect(mockReleaseResumeClaim).toHaveBeenCalledTimes(1);

    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(result['status']).toBe('FAILED');
    const errorRef = (result['errorRef'] as string).slice('inline:'.length);
    const error = JSON.parse(Buffer.from(errorRef, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(error['code']).toBe('RE_EXECUTE_UNSAFE_TASK_REQUIRES_CONFIRMATION');
  });

  it('Plan 171 P1 — re_execute on unsafe task succeeds when remediationConfirmed=true', async () => {
    // Same setup as above, but resolution carries
    // remediationConfirmed: true → gate passes, commit runs,
    // dispatchRetriedTask fires.
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'lead-scoring',
        revision: 1,
        mode: 'optimization' as const,
        description: 'Score leads',
        tasks: [
          {
            taskId: 'score-task',
            name: 'Score Lead',
            goal: 'g',
            type: 'agent' as const,
            retryability: 'unsafe' as const,
            maxAttempts: 3,
          },
        ],
        outcomes: [],
      },
      source: 'revision' as const,
    });
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        allowedResumeModes: ['re_execute', 'fail'],
        failedTaskId: 'score-task',
      }),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });
    mockCommitReExecutePausedTaskAndResume.mockResolvedValue('committed');

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: {
          mode: 're_execute',
          instructions: 'Operator confirmed Kaggle MCP up.',
          remediationConfirmed: true,
        },
      }),
    );

    expect(mockCommitReExecutePausedTaskAndResume).toHaveBeenCalledTimes(1);
    expect(mockDispatchRetriedTask).toHaveBeenCalledTimes(1);
    expect(mockDispatchNextOrTerminate).not.toHaveBeenCalled();
  });

  it('Plan 171 P1 — re_execute on unannotated (omitted retryability) task requires confirmation (defaults to unknown, not safe)', async () => {
    // Round-3 review High #1 — omitted `retryability` defaults to
    // `'unknown'`, NOT `'safe'`. Legacy tasks must pass the
    // remediation gate just like explicit `'unsafe'` / `'unknown'`.
    mockResolveWorkflowForRunRevision.mockResolvedValue({
      workflow: {
        slug: 'lead-scoring',
        revision: 1,
        mode: 'optimization' as const,
        description: 'Score leads',
        tasks: [
          {
            taskId: 'score-task',
            name: 'Score Lead',
            goal: 'g',
            type: 'agent' as const,
            maxAttempts: 3,
            // retryability intentionally omitted
          },
        ],
        outcomes: [],
      },
      source: 'revision' as const,
    });
    mockLoadRunById.mockResolvedValueOnce(makePausedRun());
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: makeContract({
        allowedResumeModes: ['re_execute', 'fail'],
        failedTaskId: 'score-task',
      }),
      pauseVersion: 1,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(
      makeArgs({
        runId: RUN_ID,
        pauseVersion: 1,
        resolution: { mode: 're_execute', instructions: 'try again' },
      }),
    );

    expect(mockCommitReExecutePausedTaskAndResume).not.toHaveBeenCalled();
    expect(mockDispatchRetriedTask).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    const errorRef = (result['errorRef'] as string).slice('inline:'.length);
    const error = JSON.parse(Buffer.from(errorRef, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(error['code']).toBe('RE_EXECUTE_UNSAFE_TASK_REQUIRES_CONFIRMATION');
  });
});
