import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_INLINE_PAYLOAD_BYTES } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

// ── DB / runtime mocks ────────────────────────────────────────────────────
const mockLoadRunById = vi.fn();
const mockLoadPendingWaiters = vi.fn();
const mockListPendingAttention = vi.fn();
const mockSurfaceWorkflowResumeContract = vi.fn();
const mockCancelNonTerminalTasksForRun = vi.fn();
const mockListCompletionPendingForRun = vi.fn();
const mockClearAllCompletionPendingForRun = vi.fn();
const mockCompleteRun = vi.fn();
const mockAddAttentionItem = vi.fn();
const mockAddControlMessage = vi.fn();
const mockSelectActiveLearningSetForSkill = vi.fn();
const mockGetRunStatistics = vi.fn();
const mockListRecentRuns = vi.fn();
const mockListActiveRunsForWorkflow = vi.fn();
const mockResolveWorkflowForStart = vi.fn();
const mockGetTaskRow = vi.fn();

async function mockBuildWorkflowRunDetail(
  _db: unknown,
  _payloadStore: unknown,
  tenantId: string,
  spaceId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const run = (await mockLoadRunById(_db, tenantId, spaceId, runId)) as
    | (Record<string, unknown> & {
        runId: string;
        workflowSlug: string;
        workflowRevision: number;
        status: string;
        pauseVersion: number;
        startedAt: Date;
        completedAt?: Date | null;
        pausedReason?: string | null;
        tasks: Array<
          Record<string, unknown> & {
            taskId: string;
            status: string;
            attempt: number;
            workerSessionId?: string | null;
            operationId?: string | null;
            summary?: string | null;
            outputRef?: string | null;
            failureReason?: string | null;
            startedAt?: Date | null;
            completedAt?: Date | null;
          }
        >;
      })
    | null;
  if (!run) return null;
  const waiters = (await mockLoadPendingWaiters(_db, tenantId, run.runId)) as Array<{
    waiterSessionId: string;
    waiterStepExecutionId: string;
    registeredAt: Date;
  }>;
  const output: Record<string, unknown> = {
    run: {
      runId: run.runId,
      workflowSlug: run.workflowSlug,
      workflowRevision: run.workflowRevision,
      status: run.status,
      pauseVersion: run.pauseVersion,
      ...(run.pausedReason ? { pausedReason: run.pausedReason } : {}),
      startedAt: run.startedAt.toISOString(),
      ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    },
    tasks: run.tasks.map((t) => ({
      taskId: t.taskId,
      label: t.taskId, // mock — real helper sources from WorkflowTaskSchema.name
      status: t.status,
      attempt: t.attempt,
      ...(t.workerSessionId ? { workerSessionId: t.workerSessionId } : {}),
      ...(t.operationId ? { operationId: t.operationId } : {}),
      ...(t.summary ? { summary: t.summary } : {}),
      ...(t.outputRef ? { outputRef: t.outputRef } : {}),
      ...(t.failureReason ? { failureReason: t.failureReason } : {}),
      ...(t.startedAt ? { startedAt: t.startedAt.toISOString() } : {}),
      ...(t.completedAt ? { completedAt: t.completedAt.toISOString() } : {}),
    })),
    activeWaiters: waiters.map((w) => ({
      sessionId: w.waiterSessionId,
      stepExecutionId: w.waiterStepExecutionId,
      registeredAt: w.registeredAt.toISOString(),
    })),
  };
  if (run.status === 'paused') {
    const surfaced = (await mockSurfaceWorkflowResumeContract(
      _db,
      _payloadStore,
      tenantId,
      run.runId,
    )) as { contract: unknown } | null;
    if (surfaced) output.resumeContract = surfaced.contract;
  }
  return output;
}

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
  loadPendingWaiters: (...args: unknown[]) => mockLoadPendingWaiters(...args),
  listPendingAttention: (...args: unknown[]) => mockListPendingAttention(...args),
  deriveSuggestedNextCallForPausedRun: () => Promise.resolve(null),
  surfaceWorkflowResumeContract: (...args: unknown[]) => mockSurfaceWorkflowResumeContract(...args),
  buildWorkflowRunDetail: (...args: Parameters<typeof mockBuildWorkflowRunDetail>) =>
    mockBuildWorkflowRunDetail(...args),
  cancelNonTerminalTasksForRun: (...args: unknown[]) => mockCancelNonTerminalTasksForRun(...args),
  listCompletionPendingForRun: (...args: unknown[]) => mockListCompletionPendingForRun(...args),
  clearAllCompletionPendingForRun: (...args: unknown[]) =>
    mockClearAllCompletionPendingForRun(...args),
  completeRun: (...args: unknown[]) => mockCompleteRun(...args),
  addAttentionItem: (...args: unknown[]) => mockAddAttentionItem(...args),
  // Other exports used at module load — return safe defaults.
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  recoverStalledRun: vi.fn(),
  recordTaskResult: vi.fn(),
  updateRunMetadata: vi.fn(),
  recordRunStart: vi.fn(),
  WorkflowArchivedError: class extends Error {},
  isCyberneticSpace: vi.fn(),
  cyberneticHookSafe: vi.fn(),
  triggerCoachReview: vi.fn(),
  runEvaluation: vi.fn(),
  listActiveRuns: vi.fn(),
  listActiveRunsForWorkflow: (...args: unknown[]) => mockListActiveRunsForWorkflow(...args),
  listActiveRunsForWorkflowWithLiveness: vi.fn().mockResolvedValue([]),
  deriveRunLivenessFromCounts: () => 'idle',
  listRecentRuns: (...args: unknown[]) => mockListRecentRuns(...args),
  listTaskRows: vi.fn(),
  getTaskRow: (...args: unknown[]) => mockGetTaskRow(...args),
  getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
  selectActiveLearningSetForSkill: (...args: unknown[]) =>
    mockSelectActiveLearningSetForSkill(...args),
  ensureCurrentSkillValidity: vi.fn(() => ({ status: 'valid', diagnostics: [] })),
  deriveFirstTaskInputContract: vi.fn(() => null),
  resolveSkillForWorkflow: vi.fn(async () => null),
  deriveCampaignContractJsonSchema: vi.fn(),
  resolveBestScoreForWorkflow: vi.fn(),
  onSkillRunCompleted: vi.fn(),
  validateWorkflowGraph: vi.fn(),
  patchTouchesGraph: vi.fn(),
  deriveRunLiveness: vi.fn(),
  claimResumeLease: vi.fn(),
  releaseResumeClaim: vi.fn(),
  resumeRunWithClaim: vi.fn(),
  bumpResumeAttemptCount: vi.fn(),
  commitReplaceOutputAndResume: vi.fn(),
  addWaiter: vi.fn(),
  markWaiterNotified: vi.fn(),
  computeReadyTasksWithWhen: vi.fn(),
  claimAndSchedule: vi.fn(),
  claimHumanTask: vi.fn(),
  casCompleteTask: vi.fn(),
  clearCompletionPending: vi.fn(),
  recordTaskSkipped: vi.fn(),
  blockDescendantTasks: vi.fn(),
  computeDescendants: vi.fn(),
}));

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    })),
    createMemoryDirRepository: vi.fn(() => ({
      ensureParentDirs: vi.fn(),
      mkdir: vi.fn(),
    })),
    resolveWorkflowForRunRevision: vi.fn(),
    // Pass-through tx with the minimum shape harness's
    // loadRunByRunIdAcrossSpaces inner query expects (select.from.where.limit).
    // SPACE constant inlined here to avoid TDZ on the hoisted mock.
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
      cb({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df' }]),
            }),
          }),
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      }),
    ),
    workflowDirPath: (slug: string) => `/workflows/${slug}`,
    workflowDocPath: (slug: string) => `/workflows/${slug}/workflow.json`,
    ensureWorkflowRevisionSnapshot: vi.fn(),
    resolveWorkflowForStart: (...args: unknown[]) => mockResolveWorkflowForStart(...args),
    listWorkflowsWithPlatform: vi.fn(),
  };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
  publishStepAbort: vi.fn(),
  markStepCancelled: vi.fn().mockResolvedValue(undefined),
  getSessionState: vi.fn().mockResolvedValue(null),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
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

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-row-id',
    spaceId: SPACE,
    workflowSlug: 'lead-scoring',
    runId: RUN_ID,
    sessionId: 'sess-1',
    status: 'running',
    workflowRevision: 1,
    startedAt: new Date('2026-05-08T10:00:00Z'),
    completedAt: null,
    totalCostCents: null,
    totalTokens: null,
    pausedReason: null,
    pausedPayloadRef: null,
    pauseVersion: 0,
    resumeAttemptCount: 0,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: {},
    tasks: [],
    ...overrides,
  };
}

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-row-id',
    runId: RUN_ID,
    taskId: 'task-a',
    status: 'running',
    attempt: 1,
    sessionId: null,
    workerSessionId: null,
    startedAt: new Date('2026-05-08T10:01:00Z'),
    completedAt: null,
    durationMs: null,
    costCents: null,
    metricsJson: null,
    summary: null,
    failureReason: null,
    outputRef: null,
    reflectionJson: null,
    ...overrides,
  };
}

function makeArgs(
  operationId: string,
  input: Record<string, unknown>,
  payloads: Record<string, unknown> = {},
): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockImplementation((ref: string) => {
        if (ref === inputRef) return Promise.resolve(input);
        if (ref in payloads) return Promise.resolve(payloads[ref]);
        return Promise.resolve(null);
      }),
      store: vi.fn().mockResolvedValue('inline:stored='),
      shouldStore: () => false,
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
      stepId: 'wf_op',
      stepType: 'workflow',
      operation: operationId,
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
  vi.resetAllMocks();
});

describe('workflow.run.detail — Plan 132v2 §Phase 4', () => {
  it('returns run + tasks + activeWaiters for a running run', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makeRun({
        status: 'running',
        tasks: [
          makeTaskRow({ taskId: 'task-a', status: 'succeeded' }),
          makeTaskRow({ taskId: 'task-b', status: 'running', workerSessionId: 'worker-uuid' }),
        ],
      }),
    );
    mockLoadPendingWaiters.mockResolvedValueOnce([
      {
        id: 'waiter-1',
        runId: RUN_ID,
        waiterSessionId: 'helmsman-sess',
        waiterStepExecutionId: 'helmsman-step',
        registeredAt: new Date('2026-05-08T10:00:30Z'),
        notifiedAt: null,
        notifiedOutcome: null,
      },
    ]);

    await handleWorkflowCrudInline(makeArgs('workflow.run.detail', { runId: RUN_ID }));

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string };
    expect(result.status).toBe('SUCCEEDED');
    const output = JSON.parse(
      Buffer.from(result.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;

    expect(output.run).toMatchObject({
      runId: RUN_ID,
      workflowSlug: 'lead-scoring',
      status: 'running',
      pauseVersion: 0,
    });
    const tasks = output.tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toBe(2);
    expect(tasks[0]).toMatchObject({ taskId: 'task-a', status: 'succeeded' });
    expect(tasks[1]).toMatchObject({
      taskId: 'task-b',
      status: 'running',
      workerSessionId: 'worker-uuid',
    });
    const waiters = output.activeWaiters as Array<Record<string, unknown>>;
    expect(waiters).toEqual([
      {
        sessionId: 'helmsman-sess',
        stepExecutionId: 'helmsman-step',
        registeredAt: '2026-05-08T10:00:30.000Z',
      },
    ]);
    // Resume contract is NOT included for a running run.
    expect(output.resumeContract).toBeUndefined();
    // surfaceWorkflowResumeContract not called for non-paused runs.
    expect(mockSurfaceWorkflowResumeContract).not.toHaveBeenCalled();
  });

  it('surfaces live resumeContract for a paused run (cross-session pickup)', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makeRun({
        status: 'paused',
        pauseVersion: 3,
        pausedReason: 'task_contract_violation',
        pausedPayloadRef: 'payload:contract',
        tasks: [makeTaskRow({ status: 'paused' })],
      }),
    );
    mockLoadPendingWaiters.mockResolvedValueOnce([]);
    // surfaceWorkflowResumeContract validates the persisted payload AND
    // injects the live pauseVersion. We assert the handler forwards
    // the surfaced contract verbatim.
    const surfacedContract = {
      pauseCause: 'task_contract_violation',
      allowedResumeModes: ['replace_output'],
      resumePrompt: 'Fix the score field',
      replaceOutputSchema: {},
      expectedTaskOutputSchema: {},
      failedTaskId: 'task-a',
      contractErrors: [],
      suggestedResumeCall: {
        op: 'workflow.run.resume',
        args: { runId: RUN_ID, pauseVersion: 3, resolution: { mode: 'acknowledge' } },
      },
    };
    mockSurfaceWorkflowResumeContract.mockResolvedValueOnce({
      contract: surfacedContract,
      pauseVersion: 3,
      pausedReason: 'task_contract_violation',
      resumeAttemptCount: 0,
    });

    await handleWorkflowCrudInline(makeArgs('workflow.run.detail', { runId: RUN_ID }));

    expect(mockSurfaceWorkflowResumeContract).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string };
    expect(result.status).toBe('SUCCEEDED');
    const output = JSON.parse(
      Buffer.from(result.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(output.run).toMatchObject({ status: 'paused', pauseVersion: 3 });
    expect(output.resumeContract).toEqual(surfacedContract);
  });

  it('emits validation error when run is not found in this space', async () => {
    // loadRunById returns null when (spaceId, runId) doesn't match — a
    // run from a different space is functionally invisible.
    mockLoadRunById.mockResolvedValueOnce(null);

    await handleWorkflowCrudInline(makeArgs('workflow.run.detail', { runId: RUN_ID }));

    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      error: { code: string };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
    // No waiter or contract loads on the not-found path.
    expect(mockLoadPendingWaiters).not.toHaveBeenCalled();
    expect(mockSurfaceWorkflowResumeContract).not.toHaveBeenCalled();
  });
});

describe('workflow.run.list_attention — Plan 132v2 §Phase 4', () => {
  function makeAttentionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: '00000000-0000-0000-0000-000000000abc',
      tenantId: TENANT,
      userId: null,
      spaceId: SPACE,
      kind: 'workflow_run_paused',
      relatedRunId: RUN_ID,
      relatedResource: `workflow_run:${RUN_ID}`,
      payload: { taskId: 'task-a', contractRef: 'inline:contract=' },
      priority: 0,
      createdAt: new Date('2026-05-08T10:05:00Z'),
      consumedAt: null,
      consumedBySession: null,
      ...overrides,
    };
  }

  it('returns mapped items with hasMore=false when below limit', async () => {
    mockListPendingAttention.mockResolvedValueOnce([
      makeAttentionRow({ id: 'aaa', kind: 'workflow_run_paused' }),
      makeAttentionRow({ id: 'bbb', kind: 'workflow_run_failed' }),
    ]);

    await handleWorkflowCrudInline(
      makeArgs('workflow.run.list_attention', { includeConsumed: false, limit: 25 }),
    );

    expect(mockListPendingAttention).toHaveBeenCalledOnce();
    const callArgs = mockListPendingAttention.mock.calls[0]?.[2] as {
      kind?: string;
      limit: number;
    };
    expect(callArgs.limit).toBe(25);
    expect(callArgs.kind).toBeUndefined();

    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string };
    expect(result.status).toBe('SUCCEEDED');
    const output = JSON.parse(
      Buffer.from(result.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as { items: unknown[]; hasMore: boolean };
    expect(output.items.length).toBe(2);
    // Cap was 25, returned 2 → hasMore=false.
    expect(output.hasMore).toBe(false);

    const first = output.items[0] as Record<string, unknown>;
    expect(first).toMatchObject({
      id: 'aaa',
      kind: 'workflow_run_paused',
      relatedRunId: RUN_ID,
      payload: { taskId: 'task-a' },
      priority: 0,
      createdAt: '2026-05-08T10:05:00.000Z',
    });
    // The bulky inline contractRef is dropped from the list payload (the run id
    // points at it; the contract comes from run.detail when acting on the pause).
    expect((first.payload as Record<string, unknown>).contractRef).toBeUndefined();
  });

  it('forwards kind filter and reports hasMore=true when at cap', async () => {
    // 25 rows = limit cap → hasMore=true.
    mockListPendingAttention.mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) =>
        makeAttentionRow({ id: `id-${String(i)}`, kind: 'workflow_run_paused' }),
      ),
    );

    await handleWorkflowCrudInline(
      makeArgs('workflow.run.list_attention', {
        includeConsumed: false,
        limit: 25,
        kind: 'workflow_run_paused',
      }),
    );

    const callArgs = mockListPendingAttention.mock.calls[0]?.[2] as { kind?: string };
    expect(callArgs.kind).toBe('workflow_run_paused');

    const result = mockAddStepResult.mock.calls[0]![1] as { outputRef: string };
    const output = JSON.parse(
      Buffer.from(result.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as { hasMore: boolean };
    expect(output.hasMore).toBe(true);
  });

  it('rejects includeConsumed=true as NOT_IMPLEMENTED until the surfacing UI lands', async () => {
    await handleWorkflowCrudInline(
      makeArgs('workflow.run.list_attention', { includeConsumed: true, limit: 25 }),
    );

    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      error: { code: string };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.code).toBe('NOT_IMPLEMENTED');
    expect(mockListPendingAttention).not.toHaveBeenCalled();
  });
});

describe('workflow.run.cancel — Plan 132v2 §Phase 4', () => {
  it('cancels a running run end-to-end via harness.cancelRun (Plan 4.5c order)', async () => {
    mockLoadRunById.mockResolvedValue(makeRun({ status: 'running' }));
    mockListCompletionPendingForRun.mockResolvedValueOnce([
      {
        id: 'pending-1',
        runId: RUN_ID,
        taskId: 'task-a',
        attempt: 1,
        workerSessionId: '11111111-1111-1111-1111-111111111111',
        detectedAt: new Date(),
        dueAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
    ]);
    mockCancelNonTerminalTasksForRun.mockResolvedValueOnce({
      cancelledTaskIds: ['task-a'],
      interruptedSessions: [],
    });
    mockClearAllCompletionPendingForRun.mockResolvedValueOnce(undefined);
    mockLoadPendingWaiters.mockResolvedValue([]);

    await handleWorkflowCrudInline(
      makeArgs('workflow.run.cancel', { runId: RUN_ID, reason: 'user requested stop' }),
    );

    expect(mockListCompletionPendingForRun).toHaveBeenCalledOnce();
    expect(mockAddControlMessage).toHaveBeenCalledOnce();
    expect(mockCancelNonTerminalTasksForRun).toHaveBeenCalledOnce();
    expect(mockClearAllCompletionPendingForRun).toHaveBeenCalledOnce();
    expect(mockCompleteRun).toHaveBeenCalledOnce();
    expect(mockCompleteRun.mock.calls[0]?.[2]).toMatchObject({
      runId: RUN_ID,
      status: 'cancelled',
    });

    expect(mockAddAttentionItem).not.toHaveBeenCalled(); // canonical write happens via mockCompleteRun stub here

    // Handler emits SUCCEEDED with the cancellation summary.
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string };
    expect(result.status).toBe('SUCCEEDED');
    const output = JSON.parse(
      Buffer.from(result.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(output).toMatchObject({
      runId: RUN_ID,
      status: 'cancelled',
      cancelledTaskIds: ['task-a'],
      interruptedSessions: ['11111111-1111-1111-1111-111111111111'],
    });
  });

  it('rejects cancel against an already-terminal run with typed error', async () => {
    // Handler validates BEFORE calling the harness — surfaces a typed
    // error for the user instead of a silent harness no-op.
    mockLoadRunById.mockResolvedValueOnce(makeRun({ status: 'completed' }));

    await handleWorkflowCrudInline(makeArgs('workflow.run.cancel', { runId: RUN_ID }));

    expect(mockCancelNonTerminalTasksForRun).not.toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      error: { code: string };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.code).toBe('WORKFLOW_RUN_ALREADY_TERMINAL');
  });

  it('rejects cancel for a run not in this space', async () => {
    mockLoadRunById.mockResolvedValueOnce(null);

    await handleWorkflowCrudInline(makeArgs('workflow.run.cancel', { runId: RUN_ID }));

    expect(mockCancelNonTerminalTasksForRun).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      error: { code: string };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });
});

describe('workflow.manage.get / workflow.ledger.get — activeLearnings resolve the active campaign', () => {
  const CAMPAIGN_ID = '00000000-0000-0000-0000-0000000000aa';

  // The campaign resolution itself (active campaign in, ended campaign out)
  // is the skill-scoped selector's contract, tested with its query mocks in
  // @aflow/cybernetic-runtime. Here we pin the handler seam: both reads
  // delegate to that entry point (never the raw selector) and surface its
  // set verbatim.
  const activeSet = {
    selected: [
      {
        kind: 'trajectory',
        objective: { metricKey: 'rmsle', direction: 'minimize' },
        peak: 0.128,
        recentScores: [0.131, 0.128],
      },
      {
        kind: 'durable',
        learningId: '00000000-0000-0000-0000-00000000d001',
        statement: 'log-transform the target',
        learningKind: 'heuristic',
        confidence: 'high',
        scopeKind: 'campaign',
      },
      {
        kind: 'candidate',
        runId: RUN_ID,
        learningId: 'l-1',
        category: 'worked',
        observation: 'shrink the CV-LB gap',
        confidence: 'medium',
      },
    ],
    omittedDueToBudget: 0,
    consolidationDue: false,
  };

  function parseOutput(): Record<string, unknown> {
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string };
    expect(result.status).toBe('SUCCEEDED');
    return JSON.parse(
      Buffer.from(result.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
  }

  beforeEach(() => {
    mockGetRunStatistics.mockResolvedValue({ totalRuns: 2 });
    mockListRecentRuns.mockResolvedValue([]);
    mockListActiveRunsForWorkflow.mockResolvedValue([]);
    mockSelectActiveLearningSetForSkill.mockResolvedValue(activeSet);
    mockResolveWorkflowForStart.mockResolvedValue({
      id: 'wf-1',
      slug: 'lead-scoring',
      mode: 'process',
      tasks: [],
      stateVariables: [],
    });
  });

  it('manage.get delegates campaign resolution to the skill-scoped selector and surfaces its set', async () => {
    await handleWorkflowCrudInline(
      makeArgs('workflow.manage.get', {
        slug: 'lead-scoring',
        includeLedgerSummary: true,
        ledgerMaxEntries: 10,
      }),
    );

    expect(mockSelectActiveLearningSetForSkill).toHaveBeenCalledWith({
      db: {},
      tenantId: TENANT,
      spaceId: SPACE,
      skillSlug: 'lead-scoring',
    });
    const output = parseOutput();
    const ledgerSummary = output.ledgerSummary as Record<string, unknown>;
    expect(ledgerSummary.activeLearnings).toEqual(activeSet.selected);
    expect(ledgerSummary.omittedDueToBudget).toBe(0);
    expect(ledgerSummary.consolidationDue).toBe(false);
  });

  it('ledger.get delegates likewise and surfaces the set at the top level', async () => {
    await handleWorkflowCrudInline(
      makeArgs('workflow.ledger.get', {
        slug: 'lead-scoring',
        maxEntries: 10,
        includeEntries: false,
      }),
    );

    expect(mockSelectActiveLearningSetForSkill).toHaveBeenCalledWith({
      db: {},
      tenantId: TENANT,
      spaceId: SPACE,
      skillSlug: 'lead-scoring',
    });
    const output = parseOutput();
    expect(output.activeLearnings).toEqual(activeSet.selected);
  });

  it('an explicit campaignId forwards to the selector on both reads', async () => {
    await handleWorkflowCrudInline(
      makeArgs('workflow.ledger.get', {
        slug: 'lead-scoring',
        maxEntries: 10,
        includeEntries: false,
        campaignId: CAMPAIGN_ID,
      }),
    );

    expect(mockSelectActiveLearningSetForSkill).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );

    mockAddStepResult.mockClear();
    mockSelectActiveLearningSetForSkill.mockClear();
    await handleWorkflowCrudInline(
      makeArgs('workflow.manage.get', {
        slug: 'lead-scoring',
        includeLedgerSummary: true,
        ledgerMaxEntries: 10,
        campaignId: CAMPAIGN_ID,
      }),
    );

    expect(mockSelectActiveLearningSetForSkill).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN_ID }),
    );
  });
});

describe('workflow.run.detail — one task’s output on request (Plan 313 gap 15)', () => {
  const OUTPUT_REF = 'gs://bucket/task-a-output.json';

  function detailOutput(result: { status: string; outputRef: string }): Record<string, unknown> {
    expect(result.status).toBe('SUCCEEDED');
    return JSON.parse(
      Buffer.from(result.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
  }

  async function runDetail(
    input: Record<string, unknown>,
    payloads: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    mockLoadRunById.mockResolvedValueOnce(
      makeRun({ status: 'succeeded', tasks: [makeTaskRow({ status: 'succeeded' })] }),
    );
    mockLoadPendingWaiters.mockResolvedValueOnce([]);
    await handleWorkflowCrudInline(makeArgs('workflow.run.detail', input, payloads));
    return detailOutput(
      mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string },
    );
  }

  it('returns a small output parsed, under the named task id', async () => {
    mockGetTaskRow.mockResolvedValueOnce(makeTaskRow({ outputRef: OUTPUT_REF }));
    const findings = { verdict: 'request_changes', findings: [{ file: 'a.ts', line: 12 }] };

    const output = await runDetail(
      { runId: RUN_ID, taskOutput: 'task-a' },
      { [OUTPUT_REF]: findings },
    );

    expect(mockGetTaskRow).toHaveBeenCalledWith(expect.anything(), TENANT, RUN_ID, 'task-a');
    expect(output.taskOutput).toEqual({ taskId: 'task-a', output: findings });
  });

  it('truncates an output over the inline cap and says how big it was', async () => {
    mockGetTaskRow.mockResolvedValueOnce(makeTaskRow({ outputRef: OUTPUT_REF }));
    const big = { diff: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES + 5_000) };
    const wholeBytes = Buffer.byteLength(JSON.stringify(big), 'utf8');

    const output = await runDetail({ runId: RUN_ID, taskOutput: 'task-a' }, { [OUTPUT_REF]: big });

    const taskOutput = output.taskOutput as {
      taskId: string;
      truncated: boolean;
      bytes: number;
      output: string;
    };
    expect(taskOutput.taskId).toBe('task-a');
    expect(taskOutput.truncated).toBe(true);
    expect(taskOutput.bytes).toBe(wholeBytes);
    expect(typeof taskOutput.output).toBe('string');
    expect(Buffer.byteLength(taskOutput.output, 'utf8')).toBeLessThanOrEqual(
      MAX_INLINE_PAYLOAD_BYTES,
    );
    expect(JSON.stringify(big).startsWith(taskOutput.output)).toBe(true);
  });

  it('omits the field — without failing — for a task that recorded no output', async () => {
    mockGetTaskRow.mockResolvedValueOnce(makeTaskRow({ outputRef: null }));

    const output = await runDetail({ runId: RUN_ID, taskOutput: 'task-a' });

    expect(output.taskOutput).toBeUndefined();
    expect(output.run).toMatchObject({ runId: RUN_ID });
  });

  it('reads nothing when no task was named', async () => {
    const output = await runDetail({ runId: RUN_ID });

    expect(mockGetTaskRow).not.toHaveBeenCalled();
    expect(output.taskOutput).toBeUndefined();
  });
});
