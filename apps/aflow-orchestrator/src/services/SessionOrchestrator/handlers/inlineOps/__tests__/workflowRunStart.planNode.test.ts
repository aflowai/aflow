/**
 * workflow.run.start and the plan node a run serves (Plan 322 D5): named, it is
 * checked and stored; unnamed in a run a task starts, it is the parent's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

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
const mockFindPlanNode = vi.fn();
const mockLoadRunById = vi.fn();

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
  createPlanNodeStore: () => ({ find: (...args: unknown[]) => mockFindPlanNode(...args) }),
  loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
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

const NODE_ID = '7b0c4b52-58a4-4c39-9a51-0d3f3c0b8a11';
const PARENT_NODE_ID = '8c1d5c63-69b5-4d4a-8b62-1e4f4d1c9b22';
const PARENT_RUN = 'f0000000-0000-4000-8000-0000000000aa';

function makeStartArgs(
  fields: Record<string, unknown>,
  workflowExecution?: InlineHandlerArgs['workflowExecution'],
): InlineHandlerArgs {
  const input = { slug: 'lead-scoring', ...fields };
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
      runId: '99999999-2222-3333-4444-555555555555',
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
    ...(workflowExecution !== undefined ? { workflowExecution } : {}),
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
});

function recordedStart(): Record<string, unknown> {
  return mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
}

describe('workflow.run.start — the plan node a run serves', () => {
  beforeEach(() => {
    mockFindPlanNode.mockResolvedValue({ nodeId: NODE_ID });
    mockLoadRunById.mockResolvedValue({
      runId: PARENT_RUN,
      sessionId: '99999999-2222-3333-4444-555555555555',
      planNodeId: PARENT_NODE_ID,
      metadata: {},
    });
  });

  it('stores the node a run is started for, once it is found in this space', async () => {
    await handleWorkflowCrudInline(makeStartArgs({ wait: 'none', planNodeId: NODE_ID }));

    expect(mockFindPlanNode).toHaveBeenCalledWith(SPACE, NODE_ID);
    expect(recordedStart()).toMatchObject({ planNodeId: NODE_ID });
  });

  it('starts nothing for a node that is not in this space, and says so', async () => {
    mockFindPlanNode.mockResolvedValue(null);

    await handleWorkflowCrudInline(makeStartArgs({ wait: 'none', planNodeId: NODE_ID }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { status: string; error?: { code?: string; message?: string; details?: unknown } }]
    >;
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatchObject({
      code: 'PLAN_NODE_NOT_FOUND',
      details: { planNodeId: NODE_ID },
    });
    expect(result.error?.message).toContain('Nothing was started');
  });

  it('stores no node for a run started for none', async () => {
    await handleWorkflowCrudInline(makeStartArgs({ wait: 'none' }));

    expect(mockFindPlanNode).not.toHaveBeenCalled();
    expect(recordedStart()).not.toHaveProperty('planNodeId');
  });

  it('gives a run a task starts the node its parent serves — a publication’s review carries the publication’s', async () => {
    await handleWorkflowCrudInline(
      makeStartArgs(
        { wait: 'until_complete' },
        { runId: PARENT_RUN, taskId: 'review-commit', attempt: 1 },
      ),
    );

    expect(mockFindPlanNode).not.toHaveBeenCalled();
    expect(recordedStart()).toMatchObject({ planNodeId: PARENT_NODE_ID });
  });

  it('lets a run a task starts name a node of its own', async () => {
    await handleWorkflowCrudInline(
      makeStartArgs(
        { wait: 'until_complete', planNodeId: NODE_ID },
        { runId: PARENT_RUN, taskId: 'review-commit', attempt: 1 },
      ),
    );

    expect(recordedStart()).toMatchObject({ planNodeId: NODE_ID });
  });
});
