import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockListActiveRunsForWorkflow = vi.fn();
const mockDeriveRunLivenessFromCounts = vi.fn();
const mockRecordRunStart = vi.fn();
const mockGetRunStatistics = vi.fn();
const mockCancelRun = vi.fn();
const mockResolveSkillForWorkflow = vi.fn();

const { SkillConcurrencyPolicySchema } = await vi.hoisted(() => import('@aflow/schemas'));

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadRunById: vi.fn(),
  loadPendingWaiters: vi.fn(),
  listAttentionItems: vi.fn(),
  surfaceWorkflowResumeContract: vi.fn(),
  cancelNonTerminalTasksForRun: vi.fn(),
  listCompletionPendingForRun: vi.fn(),
  clearAllCompletionPendingForRun: vi.fn(),
  completeRun: vi.fn(),
  addAttentionItem: vi.fn(),
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  recoverStalledRun: vi.fn(),
  recordTaskResult: vi.fn(),
  updateRunMetadata: vi.fn(),
  recordRunStart: (...args: unknown[]) => mockRecordRunStart(...args),
  resolveSkillForWorkflow: (...args: unknown[]) => mockResolveSkillForWorkflow(...args),
  resolveEffectiveConcurrencyPolicy: (policy: unknown) =>
    SkillConcurrencyPolicySchema.parse(policy ?? {}),
  listCampaigns: vi.fn().mockResolvedValue([]),
  ensureActiveCampaign: vi.fn(),
  selectCampaignForRunStart: vi.fn(),
  buildCampaignRequiredErrorDetails: vi.fn(),
  materializeAndValidateSkillConfig: (input: { tasks: unknown[] }) => ({
    materializedTasks: input.tasks,
    validity: {
      status: 'valid',
      diagnostics: [],
      advisories: [],
      validatedAt: '2026-01-01T00:00:00.000Z',
    },
  }),
  renderSkillDiagnostics: () => '',
  hashWorkflowConfig: () => 'mock-artifact-hash',
  WorkflowArchivedError: class extends Error {},
  isCyberneticSpace: vi.fn().mockResolvedValue(false),
  cyberneticHookSafe: vi.fn(),
  triggerCoachReview: vi.fn(),
  runEvaluation: vi.fn(),
  listActiveRuns: vi.fn(),
  listActiveRunsForWorkflow: (...args: unknown[]) => mockListActiveRunsForWorkflow(...args),
  listActiveRunsForWorkflowWithLiveness: (...args: unknown[]) =>
    mockListActiveRunsForWorkflow(...args),
  deriveRunLivenessFromCounts: (...args: unknown[]) => mockDeriveRunLivenessFromCounts(...args),
  listRecentRuns: vi.fn().mockResolvedValue([]),
  getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
  onSkillRunCompleted: vi.fn(),
  validateWorkflowGraph: vi.fn(),
  patchTouchesGraph: vi.fn(),
  deriveRunLiveness: vi.fn(),
  claimResumeLease: vi.fn(),
  releaseResumeClaim: vi.fn(),
  resumeRunWithClaim: vi.fn(),
  bumpResumeAttemptCount: vi.fn(),
  commitReplaceOutputAndResume: vi.fn(),
  addWaiter: vi.fn().mockResolvedValue(undefined),
  markWaiterNotified: vi.fn(),
  computeReadyTasksWithWhen: vi.fn().mockReturnValue({ ready: [], skipped: [], errors: [] }),
  claimAndSchedule: vi.fn(),
  claimHumanTask: vi.fn(),
  casCompleteTask: vi.fn(),
  clearCompletionPending: vi.fn(),
  recordTaskSkipped: vi.fn(),
  blockDescendantTasks: vi.fn(),
  computeDescendants: vi.fn(),
}));

const mockResolveWorkflowForStart = vi.fn();
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

vi.mock('../../../helpers/workflowCredentialsPreflight.js', () => ({
  checkWorkflowCredentialsPreflight: vi.fn().mockResolvedValue({ ok: true }),
  checkWorkflowCapabilityPreflight: vi.fn().mockResolvedValue({ ok: true }),
  toBlockedBindingsForResumeContract: vi.fn((x: unknown) => x),
  renderPreflightFailureMessage: vi.fn(),
}));

// Mock the harness module so we can assert cancelRun was invoked from
// the replace_active branch without dragging the full harness in.
// The path is relative to the test file (one level deeper than the
// handler that imports it dynamically); both resolve to the same module.
vi.mock('../../../../cybernetic/WorkflowRunHarness.js', () => ({
  cancelRun: (...args: unknown[]) => mockCancelRun(...args),
  startRun: vi.fn().mockResolvedValue({ activeTasks: [] }),
}));

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  addControlMessage: vi.fn(),
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

import { handleWorkflowCrudInline } from '../workflowCrud.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const SESSION_RUN_ID = '99999999-2222-3333-4444-555555555555';

function makeStartArgs(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockImplementation((ref: string) => {
        if (ref === inputRef) return Promise.resolve(input);
        return Promise.resolve(null);
      }),
      store: vi.fn().mockResolvedValue('inline:stored='),
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
      operation: 'workflow.run.start',
      tags: [],
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    parentStepExecutionId: null as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inputRef,
  };
}

function approvedWorkflow() {
  return {
    slug: 'lead-scoring',
    revision: 1,
    status: 'approved',
    tasks: [{ taskId: 'task-a', name: 'A', goal: 'g' }],
    budget: undefined,
  };
}

beforeEach(() => {
  // `clearAllMocks` resets call history but preserves the implementations
  // installed via the module-level `vi.mock(...)` factories above. Using
  // `resetAllMocks` would wipe those (cancelRun, addWaiter, etc.) and the
  // handler would dereference undefined returns mid-flow.
  vi.clearAllMocks();
  mockResolveWorkflowForStart.mockResolvedValue(approvedWorkflow());
  mockResolveSkillForWorkflow.mockResolvedValue(null);
  mockGetRunStatistics.mockResolvedValue({ totalRuns: 0 });
  // Default: every active run is live, so the liveness filter is a no-op and
  // the gate behaves as a pure count. Individual tests override per-run.
  mockDeriveRunLivenessFromCounts.mockReturnValue('executing');
});

function decodeError(call: { errorRef: string }): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(call.errorRef.slice('inline:'.length), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
}

describe('workflow.run.start — concurrency: fail_if_active (default)', () => {
  it('emits CONCURRENCY_LIMIT_EXCEEDED with error.details.activeRunIds when an active run exists', async () => {
    const activeRunId1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const activeRunId2 = 'aaaaaaaa-2222-2222-2222-222222222222';
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([
      { runId: activeRunId1, status: 'running' },
      { runId: activeRunId2, status: 'paused' },
    ]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      errorRef: string;
    };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('CONCURRENCY_LIMIT_EXCEEDED');
    expect(error['classification']).toBe('validation');
    // Structured `details.activeRunIds` — agent branches on this, not prose.
    const details = error['details'] as Record<string, unknown>;
    expect(details).toBeDefined();
    expect(details['activeRunIds']).toEqual([activeRunId1, activeRunId2]);
  });

  it('proceeds normally when no active run exists', async () => {
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    expect(mockCancelRun).not.toHaveBeenCalled();
    // Gate passed → recordRunStart fired.
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });

  it('discounts a stalled (zombie) active run so the gate does not deadlock', async () => {
    // A durable `running` row whose work is dead must not pin the slot. The
    // liveness filter drops it, the gate passes, and a fresh run starts —
    // the orphaned-run reconciler fails the zombie out of band.
    const zombieRunId = 'dddddddd-1111-1111-1111-111111111111';
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([
      { runId: zombieRunId, status: 'running' },
    ]);
    mockDeriveRunLivenessFromCounts.mockReturnValue('stalled');

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    // Gate passed (zombie discounted): recordRunStart fired and no
    // CONCURRENCY_LIMIT_EXCEEDED was emitted. (The full start path then
    // can't complete in this unit harness — no Redis hot state — but that
    // is past the gate, which is what this test exercises.)
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const concurrencyErrors = mockAddStepResult.mock.calls.filter((c) => {
      const r = c[1] as { errorRef?: string };
      return r.errorRef ? decodeError(r as { errorRef: string })['code'] : undefined;
    });
    for (const c of concurrencyErrors) {
      const err = decodeError(c[1] as { errorRef: string });
      expect(err['code']).not.toBe('CONCURRENCY_LIMIT_EXCEEDED');
    }
  });

  it('stamps run provenance (Plan 190 Slice 5b) into recordRunStart metadata', async () => {
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    // recordRunStart(db, tenantId, params) — provenance rides on params.metadata.
    const params = mockRecordRunStart.mock.calls[0]![2] as {
      metadata?: { contractValidity?: Record<string, unknown> };
    };
    const provenance = params.metadata?.contractValidity;
    expect(provenance).toEqual({
      status: 'valid',
      artifactHash: 'mock-artifact-hash',
      validatedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('workflow.run.start — concurrency: replace_active', () => {
  it('cancels every existing active run via harness cancelRun BEFORE recordRunStart', async () => {
    const activeRunId1 = 'bbbbbbbb-1111-1111-1111-111111111111';
    const activeRunId2 = 'bbbbbbbb-2222-2222-2222-222222222222';
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([
      { runId: activeRunId1, status: 'running' },
      { runId: activeRunId2, status: 'paused' },
    ]);
    mockCancelRun.mockResolvedValue({
      cancelledAt: new Date(),
      cancelledTaskIds: [],
      interruptedSessions: [],
    });

    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'lead-scoring', concurrency: 'replace_active' }),
    );

    // Both active runs cancelled, in order.
    expect(mockCancelRun).toHaveBeenCalledTimes(2);
    const cancelArgs1 = mockCancelRun.mock.calls[0]!;
    expect(cancelArgs1[1]).toBe(TENANT);
    expect(cancelArgs1[2]).toBe(activeRunId1);
    // Operator-cancel legibility — replace_active attributes the cancel to
    // the agent with the replaced-by reason.
    expect(cancelArgs1[3]).toMatchObject({
      cancelledBy: 'agent',
      reason: expect.stringMatching(/replaced_by_new_run/) as unknown,
    });
    const cancelArgs2 = mockCancelRun.mock.calls[1]!;
    expect(cancelArgs2[2]).toBe(activeRunId2);

    // recordRunStart followed.
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    // Sequence: both cancels happen before recordRunStart.
    const cancelInvocations = mockCancelRun.mock.invocationCallOrder;
    const recordInvocation = mockRecordRunStart.mock.invocationCallOrder[0]!;
    expect(Math.max(...cancelInvocations)).toBeLessThan(recordInvocation);
  });

  it('emits REPLACE_ACTIVE_CANCEL_FAILED and does not start when cancelRun throws', async () => {
    const activeRunId = 'cccccccc-1111-1111-1111-111111111111';
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([
      { runId: activeRunId, status: 'running' },
    ]);
    mockCancelRun.mockRejectedValueOnce(new Error('redis ECONNRESET'));

    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'lead-scoring', concurrency: 'replace_active' }),
    );

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      errorRef: string;
    };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('REPLACE_ACTIVE_CANCEL_FAILED');
    const details = error['details'] as Record<string, unknown>;
    expect(details['failedRunId']).toBe(activeRunId);
    expect(details['activeRunIds']).toEqual([activeRunId]);
  });

  it('proceeds straight to recordRunStart when no active run exists', async () => {
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([]);

    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'lead-scoring', concurrency: 'replace_active' }),
    );

    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });
});

describe('workflow.run.start — concurrency: allow_concurrent', () => {
  it('skips the active-run lookup entirely and proceeds to recordRunStart', async () => {
    // listActiveRunsForWorkflow is stubbed so a stray unintended call (the
    // bug we're guarding against) wouldn't return undefined and crash the
    // handler — it would just go through. The assertion is that it never
    // gets called in the first place.
    mockListActiveRunsForWorkflow.mockResolvedValue([]);

    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'lead-scoring', concurrency: 'allow_concurrent' }),
    );

    // Gate fully bypassed.
    expect(mockListActiveRunsForWorkflow).not.toHaveBeenCalled();
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });
});

describe('workflow.run.start — manifest-declared concurrency policy', () => {
  function skillWithMaxConcurrentRuns(maxConcurrentRuns: number | 'unlimited') {
    return {
      manifest: {
        skillId: 'lead-scoring',
        concurrency: {
          maxParallelTasksPerRun: 4,
          maxConcurrentRuns,
          failureMode: 'isolate',
          perUserSerial: false,
        },
      },
    };
  }

  it('a manifest-pinned limit is a hard cap: allow_concurrent does not bypass it', async () => {
    const activeRunId = 'eeeeeeee-1111-1111-1111-111111111111';
    mockResolveSkillForWorkflow.mockResolvedValue(skillWithMaxConcurrentRuns(1));
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([
      { runId: activeRunId, status: 'running' },
    ]);

    await handleWorkflowCrudInline(
      makeStartArgs({ slug: 'lead-scoring', concurrency: 'allow_concurrent' }),
    );

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; errorRef: string };
    expect(result.status).toBe('FAILED');
    const error = decodeError(result);
    expect(error['code']).toBe('CONCURRENCY_LIMIT_EXCEEDED');
    expect((error['details'] as Record<string, unknown>)['activeRunIds']).toEqual([activeRunId]);
  });

  // The write end of the pin. Without this, deleting the resolve-and-pass lines
  // in start.ts leaves the suite green while every run silently falls back to
  // the default limit — a manifest declaring 8 would quietly run at 4.
  it('pins the manifest concurrency policy onto the run row', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(skillWithMaxConcurrentRuns(2));
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    expect(mockRecordRunStart).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        effectiveConcurrencyPolicy: expect.objectContaining({ maxParallelTasksPerRun: 4 }),
      }),
    );
  });

  it('a manifest limit above 1 raises the default gate', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(skillWithMaxConcurrentRuns(2));
    mockListActiveRunsForWorkflow.mockResolvedValueOnce([
      { runId: 'eeeeeeee-2222-2222-2222-222222222222', status: 'running' },
    ]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });

  it("'unlimited' disables the gate without the caller opting in", async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(skillWithMaxConcurrentRuns('unlimited'));
    mockListActiveRunsForWorkflow.mockResolvedValue([]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: 'lead-scoring' }));

    expect(mockListActiveRunsForWorkflow).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
  });
});
