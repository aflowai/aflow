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

function makeStartArgs(wait?: string): InlineHandlerArgs {
  const input = { slug: 'lead-scoring', ...(wait ? { wait } : {}) };
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

function decodeInline(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('workflow.run.start — wait: none', () => {
  it('returns started with the run id at once, the session registered as the waiter', async () => {
    await handleWorkflowCrudInline(makeStartArgs('none'));

    expect(mockStartRun).toHaveBeenCalledOnce();
    expect(mockWaitForInput).not.toHaveBeenCalled();

    expect(mockAddWaiter).toHaveBeenCalledOnce();
    const waiter = mockAddWaiter.mock.calls[0]![2] as Record<string, unknown>;
    expect(waiter['waiterSessionId']).toBe('99999999-2222-3333-4444-555555555555');
    expect(waiter).not.toHaveProperty('waiterStepExecutionId');

    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { status: string; outputRef: string }]
    >;
    expect(result.status).toBe('SUCCEEDED');
    const output = decodeInline(result.outputRef);
    expect(output).toEqual({ status: 'started', runId: expect.any(String), slug: 'lead-scoring' });
    const runStartParams = mockRecordRunStart.mock.calls[0]![2] as { runId: string };
    expect(output['runId']).toBe(runStartParams.runId);
  });

  it('fails the run and the call when the session cannot be registered as its waiter', async () => {
    mockAddWaiter.mockRejectedValueOnce(new Error('connection refused'));

    await handleWorkflowCrudInline(makeStartArgs('none'));

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

  it('returns started when a preflight pauses the run, and the pause reaches the session as a wakeup', async () => {
    mockCheckWorkflowCredentialsPreflight.mockResolvedValue({
      ok: false,
      missingBindings: [{ bindingId: 'b1', bindingName: 'CRM', missingFields: ['apiKey'] }],
    });

    await handleWorkflowCrudInline(makeStartArgs('none'));

    // Nothing parks: the caller is not a blocking waiter, and no step joins it.
    expect(mockWaitForInput).not.toHaveBeenCalled();
    expect(mockHandoffStartupPreflightPause).not.toHaveBeenCalled();
    expect(mockAddWaiter).toHaveBeenCalledOnce();
    expect(mockAddWaiter.mock.calls[0]![2]).not.toHaveProperty('waiterStepExecutionId');

    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { status: string; outputRef: string }]
    >;
    expect(result.status).toBe('SUCCEEDED');
    const output = decodeInline(result.outputRef);
    expect(output).toMatchObject({ status: 'started', slug: 'lead-scoring' });

    // The run pauses on its own, and its waiters — this session — hear it.
    expect(mockStartRun).not.toHaveBeenCalled();
    expect(mockPauseRun).toHaveBeenCalledOnce();
    expect(mockNotifyWaiters).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      runId: output['runId'],
      outcome: 'paused',
      pauseVersion: 1,
      payloadRef: 'gs://bucket/startup-contract',
    });
    // Registered before the run paused, so the notification had someone to reach.
    expect(mockAddWaiter.mock.invocationCallOrder[0]!).toBeLessThan(
      mockNotifyWaiters.mock.invocationCallOrder[0]!,
    );
  });

  it('a blocking start still parks on a preflight pause', async () => {
    mockCheckWorkflowCapabilityPreflight.mockResolvedValue({
      ok: false,
      missingCapabilities: ['crm:write'],
    });

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockHandoffStartupPreflightPause).toHaveBeenCalledOnce();
    expect(mockHandoffStartupPreflightPause.mock.calls[0]![0]).toMatchObject({
      contract: { pauseCause: 'needs_capability' },
    });
    expect(mockAddWaiter).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  it('keeps parking the calling step by default', async () => {
    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockWaitForInput).toHaveBeenCalledOnce();
    expect(mockAddWaiter.mock.calls[0]![2]).toHaveProperty('waiterStepExecutionId', 'step-exec-1');
    expect(mockStartRun).toHaveBeenCalledOnce();
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });
});
