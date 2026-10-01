/**
 * Contract: a workflow task can start a run and be answered when it ends.
 *
 * The task has no session of its own, so nothing parks and nothing is emitted
 * at the start; its step is the waiter, and the run executes as the session
 * that started the task's own run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockLoadRunById = vi.fn();
const mockListActiveRunsForWorkflow = vi.fn();
const mockRecordRunStart = vi.fn();
const mockGetRunStatistics = vi.fn();
const mockHandoffStartupPreflightPause = vi.fn();
const mockCheckWorkflowCredentialsPreflight = vi.fn();
const mockCheckWorkflowCapabilityPreflight = vi.fn();
const mockCheckWorkflowOperationGrantPreflight = vi.fn();
const mockStartRun = vi.fn();
const mockCompleteRun = vi.fn();
const mockAddWaiter = vi.fn();
const mockWaitForInput = vi.fn();
const mockStoreResumeContract = vi.fn();
const mockPauseRun = vi.fn();
const mockCheckCatalogSkillProjection = vi.fn();

vi.mock('@aflow/cybernetic-runtime', () => ({
  listActiveRunsForWorkflow: (...args: unknown[]) => mockListActiveRunsForWorkflow(...args),
  listActiveRunsForWorkflowWithLiveness: (...args: unknown[]) =>
    mockListActiveRunsForWorkflow(...args),
  deriveRunLivenessFromCounts: () => 'executing',
  recordRunStart: (...args: unknown[]) => mockRecordRunStart(...args),
  listRecentRuns: vi.fn().mockResolvedValue([]),
  getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
  addWaiter: (...args: unknown[]) => mockAddWaiter(...args),
  selectFirstTaskForParentInputs: vi.fn(),
  validateParentTaskInputs: vi.fn(),
  renderParentInputsValidationFailure: vi.fn(),
  resolveSkillForWorkflow: vi.fn().mockResolvedValue(null),
  listCampaigns: vi.fn().mockResolvedValue([]),
  loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
  checkCatalogSkillProjection: (...args: unknown[]) => mockCheckCatalogSkillProjection(...args),
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
  emitRunUpdated: vi.fn().mockResolvedValue(undefined),
  storeWorkflowResumeContract: (...args: unknown[]) => mockStoreResumeContract(...args),
  pauseRun: (...args: unknown[]) => mockPauseRun(...args),
  addAttentionItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
      cb({}),
    ),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    })),
    createMemoryDirRepository: vi.fn(() => ({
      mkdir: vi.fn(),
    })),
    ensureWorkflowRevisionSnapshot: vi.fn(),
    resolveWorkflowForStart: vi.fn().mockResolvedValue({
      slug: 'lead-scoring',
      revision: 1,
      status: 'approved',
      tasks: [{ taskId: 'task-a', name: 'A', goal: 'g' }],
    }),
  };
});

vi.mock('../../../helpers/workflowCredentialsPreflight.js', () => ({
  checkWorkflowCredentialsPreflight: (...args: unknown[]) =>
    mockCheckWorkflowCredentialsPreflight(...args),
  checkWorkflowCapabilityPreflight: (...args: unknown[]) =>
    mockCheckWorkflowCapabilityPreflight(...args),
  checkWorkflowOperationGrantPreflight: (...args: unknown[]) =>
    mockCheckWorkflowOperationGrantPreflight(...args),
  toBlockedBindingsForResumeContract: vi.fn((x: unknown) => x),
}));

vi.mock('../../../helpers/workflowRunStartupPause.js', async () => ({
  ...(await vi.importActual<object>('../../../helpers/workflowRunStartupPause.js')),
  handoffStartupPreflightPause: (...args: unknown[]) => mockHandoffStartupPreflightPause(...args),
  buildNeedsCredentialsStartupContract: vi.fn(() => ({ pauseCause: 'needs_credentials' })),
  buildNeedsCapabilityStartupContract: vi.fn(() => ({ pauseCause: 'needs_capability' })),
}));

const mockNotifyWaiters = vi.fn();
vi.mock('../../../../cybernetic/harness/waiters.js', () => ({
  notifyWaiters: (...args: unknown[]) => mockNotifyWaiters(...args),
}));

vi.mock('../../../../cybernetic/WorkflowRunHarness.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
  completeRun: (...args: unknown[]) => mockCompleteRun(...args),
}));

const mockAddStepResult = vi.fn();
const mockGetRunAccessGrant = vi.fn();
vi.mock('../../../../StepService/StepService.js', () => ({
  waitForInput: (...args: unknown[]) => mockWaitForInput(...args),
}));

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getRunAccessGrant: (...args: unknown[]) => mockGetRunAccessGrant(...args),
  getSessionState: vi.fn().mockResolvedValue({
    sessionId: '99999999-2222-3333-4444-555555555555',
    tenantId: 'a0000000-0000-0000-0000-000000000001',
    status: 'RUNNING',
    createdAt: 1,
    lastUpdatedAt: 1,
  }),
  addControlMessage: vi.fn(),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
}));

// Hoisted: the factory reads the class eagerly, so a plain top-level
// declaration would still be in its temporal dead zone.
const { FakeGrantRenewalRefused } = vi.hoisted(() => ({
  FakeGrantRenewalRefused: class extends Error {},
}));
const PRINCIPAL = {
  spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
  spaceRole: 'admin',
  userId: 'c0000000-0000-0000-0000-000000000001',
  tenantRole: 'member',
};
const mockRenewRunAccessGrant = vi.fn();
const mockResolveGrantRenewalSource = vi.fn();
vi.mock('../../../../gates/grantRenewal.js', () => ({
  GrantRenewalRefused: FakeGrantRenewalRefused,
  grantPrincipalSource: () => PRINCIPAL,
  renewRunAccessGrant: (...args: unknown[]) => mockRenewRunAccessGrant(...args),
  resolveGrantRenewalSource: (...args: unknown[]) => mockResolveGrantRenewalSource(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

import { handleWorkflowCrudInline } from '../workflowCrud.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';

/** The task's worker session, which is also its step: a task has no session of its own. */
const WORKER = '77777777-2222-3333-4444-555555555555';
/** The session that started the publication whose task this is. */
const DRIVER = '99999999-2222-3333-4444-555555555555';
const PARENT_RUN = 'parent-run-1';

function makeTaskArgs(wait?: string, extra: Record<string, unknown> = {}): InlineHandlerArgs {
  const input = { slug: 'lead-scoring', ...(wait ? { wait } : {}), ...extra };
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockResolvedValue(input),
      store: vi.fn(),
      shouldStore: () => false,
    } as never,
    context: {
      tenantId: TENANT,
      runId: WORKER,
      traceId: 'trace-1',
      spaceId: SPACE,
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: 'review-commit',
      stepType: 'workflow',
      operation: 'workflow.run.start',
      tags: [],
    } as never,
    stepExecutionId: WORKER as never,
    parentStepExecutionId: null as never,
    attempt: 1,
    idempotencyKey: 'dispatch:parent-run-1:review-commit:1' as never,
    resolvedInputRef: inputRef,
    workflowExecution: {
      runId: PARENT_RUN,
      taskId: 'review-commit',
      attempt: 1,
      dispatchAttemptToken: 'dispatch:parent-run-1:review-commit:1',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListActiveRunsForWorkflow.mockResolvedValue([]);
  mockGetRunStatistics.mockResolvedValue({ totalRuns: 0 });
  mockCheckWorkflowCredentialsPreflight.mockResolvedValue({ ok: true, missingBindings: [] });
  mockCheckWorkflowCapabilityPreflight.mockResolvedValue({ ok: true, missingCapabilities: [] });
  mockCheckWorkflowOperationGrantPreflight.mockReturnValue({ ok: true, ungrantedOperations: [] });
  mockHandoffStartupPreflightPause.mockResolvedValue(undefined);
  mockGetRunAccessGrant.mockResolvedValue(null);
  mockRenewRunAccessGrant.mockResolvedValue(null);
  // Default: a run with no actor context — no authority to establish, so the
  // gate is ungated by design rather than fail-closed.
  mockResolveGrantRenewalSource.mockReturnValue(null);
  mockAddWaiter.mockResolvedValue('waiter-1');
  mockWaitForInput.mockResolvedValue(undefined);
  mockStartRun.mockResolvedValue({ activeTasks: [] });
  mockStoreResumeContract.mockResolvedValue('gs://bucket/startup-contract');
  mockPauseRun.mockResolvedValue(1);
  mockNotifyWaiters.mockResolvedValue(undefined);
  mockLoadRunById.mockResolvedValue({ runId: PARENT_RUN, sessionId: DRIVER });
});

describe('workflow.run.start from a workflow task', () => {
  it('registers the task’s step as the waiter, emits nothing, and parks no session', async () => {
    await handleWorkflowCrudInline(makeTaskArgs('until_complete'));

    expect(mockAddWaiter).toHaveBeenCalledOnce();
    expect(mockAddWaiter.mock.calls[0]![2]).toEqual({
      runId: expect.any(String),
      waiterSessionId: WORKER,
      waiterStepExecutionId: WORKER,
    });
    expect(mockStartRun).toHaveBeenCalledOnce();
    // Registered before the run starts, so an ending that comes at once has a
    // waiter to answer.
    expect(mockAddWaiter.mock.invocationCallOrder[0]!).toBeLessThan(
      mockStartRun.mock.invocationCallOrder[0]!,
    );
    // The task stays claimed until the run ends: no result now, and no
    // session step to park.
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockWaitForInput).not.toHaveBeenCalled();
  });

  it('runs as the session that started the task’s own run, not the task’s synthetic one', async () => {
    await handleWorkflowCrudInline(makeTaskArgs('until_complete'));

    expect(mockLoadRunById).toHaveBeenCalledWith(expect.anything(), TENANT, SPACE, PARENT_RUN);
    expect(mockRecordRunStart.mock.calls[0]![2]).toMatchObject({ sessionId: DRIVER });
    expect(mockStartRun.mock.calls[0]![1]).toMatchObject({ callingHelmsmanSessionId: DRIVER });
  });

  it('refuses any wait but the one that ends with the run, before anything is recorded', async () => {
    for (const wait of [undefined, 'until_pause', 'none']) {
      vi.clearAllMocks();
      await handleWorkflowCrudInline(makeTaskArgs(wait));

      expect(mockRecordRunStart).not.toHaveBeenCalled();
      expect(mockAddWaiter).not.toHaveBeenCalled();
      const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
        [unknown, { status: string; workflowExecution?: unknown; error?: { code?: string } }]
      >;
      expect(result.status).toBe('FAILED');
      expect(result.error?.code).toBe('WORKFLOW_TASK_WAIT_UNSUPPORTED');
      // Answered to the task, not to a session.
      expect(result.workflowExecution).toMatchObject({
        runId: PARENT_RUN,
        taskId: 'review-commit',
      });
    }
  });

  it('pauses the run at a preflight and leaves the answer to its waiter, the task', async () => {
    mockCheckWorkflowCredentialsPreflight.mockResolvedValue({
      ok: false,
      missingBindings: [{ bindingId: 'b1', bindingName: 'CRM', missingFields: ['apiKey'] }],
    });

    await handleWorkflowCrudInline(makeTaskArgs('until_complete'));

    expect(mockStartRun).not.toHaveBeenCalled();
    expect(mockHandoffStartupPreflightPause).not.toHaveBeenCalled();
    expect(mockPauseRun).toHaveBeenCalledOnce();
    expect(mockNotifyWaiters).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'paused' }),
    );
    expect(mockAddWaiter.mock.invocationCallOrder[0]!).toBeLessThan(
      mockNotifyWaiters.mock.invocationCallOrder[0]!,
    );
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  it('fails the run and the task when the task cannot be registered as its waiter', async () => {
    mockAddWaiter.mockRejectedValueOnce(new Error('connection refused'));

    await handleWorkflowCrudInline(makeTaskArgs('until_complete'));

    expect(mockStartRun).not.toHaveBeenCalled();
    expect(mockCompleteRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      'failed',
    );
    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { status: string; error?: { code?: string } }]
    >;
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('WORKFLOW_RUN_START_WAITER_INSERT_FAILED');
  });

  it('records the run one level deeper than the run whose task started it', async () => {
    await handleWorkflowCrudInline(makeTaskArgs('until_complete'));

    expect(mockRecordRunStart.mock.calls[0]![2]).toMatchObject({ metadata: { runDepth: 2 } });
  });

  it('refuses to start a run past the deepest a chain of task-started runs may go, naming the depth', async () => {
    mockLoadRunById.mockResolvedValue({
      runId: PARENT_RUN,
      sessionId: DRIVER,
      metadata: { runDepth: 2 },
    });

    await handleWorkflowCrudInline(makeTaskArgs('until_complete'));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockAddWaiter).not.toHaveBeenCalled();
    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { status: string; error?: { code?: string; message?: string } }]
    >;
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('WORKFLOW_RUN_DEPTH_EXCEEDED');
    expect(result.error?.message).toContain('at depth 2');
    expect(result.error?.message).toContain('at most 2 deep');
    expect(result.error?.message).toContain('"lead-scoring" at depth 3');
  });

  it('refuses a workflow that is not the catalog skill it was named as, with the reason', async () => {
    const message =
      '"lead-scoring" in this space has been edited since the Store installed it from "lead-scoring", so it is no longer that skill. Update it from the Store, replacing the edits.';
    mockCheckCatalogSkillProjection.mockResolvedValue({ ok: false, reason: 'modified', message });

    await handleWorkflowCrudInline(makeTaskArgs('until_complete', { catalogId: 'lead-scoring' }));

    expect(mockCheckCatalogSkillProjection).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      spaceId: SPACE,
      catalogId: 'lead-scoring',
      slug: 'lead-scoring',
    });
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { status: string; error?: { code?: string; message?: string } }]
    >;
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('WORKFLOW_NOT_CATALOG_SKILL');
    expect(result.error?.message).toBe(message);
  });

  it('starts the catalog skill it was named as, and checks nothing when none is named', async () => {
    mockCheckCatalogSkillProjection.mockResolvedValue({ ok: true });
    await handleWorkflowCrudInline(makeTaskArgs('until_complete', { catalogId: 'lead-scoring' }));
    expect(mockStartRun).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    await handleWorkflowCrudInline(makeTaskArgs('until_complete'));
    expect(mockCheckCatalogSkillProjection).not.toHaveBeenCalled();
    expect(mockStartRun).toHaveBeenCalledOnce();
  });
});
