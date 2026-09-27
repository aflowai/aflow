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

vi.mock('@aflow/cybernetic-runtime', () => ({
  listActiveRunsForWorkflow: (...args: unknown[]) => mockListActiveRunsForWorkflow(...args),
  listActiveRunsForWorkflowWithLiveness: (...args: unknown[]) =>
    mockListActiveRunsForWorkflow(...args),
  deriveRunLivenessFromCounts: () => 'executing',
  recordRunStart: (...args: unknown[]) => mockRecordRunStart(...args),
  listRecentRuns: vi.fn().mockResolvedValue([]),
  getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
  addWaiter: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../../helpers/workflowRunStartupPause.js', () => ({
  handoffStartupPreflightPause: (...args: unknown[]) => mockHandoffStartupPreflightPause(...args),
  buildNeedsCredentialsStartupContract: vi.fn(() => ({ pauseCause: 'needs_credentials' })),
  buildNeedsCapabilityStartupContract: vi.fn(() => ({ pauseCause: 'needs_capability' })),
}));

vi.mock('../../../../cybernetic/WorkflowRunHarness.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
  completeRun: (...args: unknown[]) => mockCompleteRun(...args),
}));

const mockAddStepResult = vi.fn();
const mockGetRunAccessGrant = vi.fn();
vi.mock('../../../../StepService/StepService.js', () => ({
  waitForInput: vi.fn().mockResolvedValue(undefined),
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

function makeStartArgs(): InlineHandlerArgs {
  const input = { slug: 'lead-scoring' };
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: { retrieve: vi.fn(), store: vi.fn() } as never,
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
});

describe('workflow.run.start — preflight pause', () => {
  it('pauses with needs_credentials contract instead of calling startRun', async () => {
    mockCheckWorkflowCredentialsPreflight.mockResolvedValueOnce({
      ok: false,
      missingBindings: [
        {
          apiId: 'kaggle',
          bindingId: 'bind-1',
          reason: 'credentials-missing',
          consumingTaskIds: ['task-a'],
        },
      ],
    });

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    expect(mockHandoffStartupPreflightPause).toHaveBeenCalledOnce();
    expect(mockStartRun).not.toHaveBeenCalled();
  });

  it('pauses with needs_capability contract when credentials pass', async () => {
    mockCheckWorkflowCapabilityPreflight.mockResolvedValueOnce({
      ok: false,
      missingCapabilities: ['cap:missing'],
    });

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    expect(mockHandoffStartupPreflightPause).toHaveBeenCalledOnce();
    expect(mockStartRun).not.toHaveBeenCalled();
  });

  it('pauses pre-dispatch when the run grant refuses a declared operation (Plan 302)', async () => {
    mockCheckWorkflowOperationGrantPreflight.mockReturnValueOnce({
      ok: false,
      ungrantedOperations: [
        {
          operationId: 'compute.sandbox.exec',
          reason: 'the "Personal Safe" capability profile does not include compute.sandbox',
          consumingTaskIds: ['task-a'],
        },
      ],
    });

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    expect(mockHandoffStartupPreflightPause).toHaveBeenCalledOnce();
    expect(mockStartRun).not.toHaveBeenCalled();
  });

  it('starts the run when every preflight passes', async () => {
    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockHandoffStartupPreflightPause).not.toHaveBeenCalled();
    expect(mockStartRun).toHaveBeenCalledOnce();
  });

  it('refuses to start when the principal no longer holds the run access', async () => {
    // A refusal is evidence about authority: preflighting on the stale copy
    // would clear the run to start on access that no longer exists.
    mockGetRunAccessGrant.mockResolvedValue({ spaceId: SPACE, expiresAt: 'x' });
    mockRenewRunAccessGrant.mockRejectedValue(
      new FakeGrantRenewalRefused('principal is no longer a member of this space'),
    );

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockStartRun).not.toHaveBeenCalled();
    expect(mockCheckWorkflowOperationGrantPreflight).not.toHaveBeenCalled();
    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { error?: { code?: string; classification?: string; retryable?: boolean } }]
    >;
    expect(result.error?.code).toBe('RUN_ACCESS_REVOKED');
    expect(result.error?.classification).toBe('permission');
    expect(result.error?.retryable).toBe(false);
    expect(mockCompleteRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      'failed',
    );
  });

  it('refuses to start when renewal fails transiently rather than trusting the stored grant', async () => {
    // Judging against the stored copy would be fail-open: op tasks face no
    // later gate, so a snapshot taken before the profile or ceiling narrowed
    // would authorize a direct dispatch. A failed renewal means current
    // authority is unknown, which is not the same as unchanged.
    mockGetRunAccessGrant.mockResolvedValue({ spaceId: SPACE, expiresAt: 'x' });
    mockRenewRunAccessGrant.mockRejectedValue(new Error('ECONNRESET'));

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockStartRun).not.toHaveBeenCalled();
    expect(mockCheckWorkflowOperationGrantPreflight).not.toHaveBeenCalled();
    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { error?: { code?: string; classification?: string } }]
    >;
    expect(result.error?.code).toBe('RUN_ACCESS_UNAVAILABLE');
    expect(result.error?.classification).toBe('permission');
  });

  it('establishes authority when the grant is absent but the run has a principal', async () => {
    // startRun leaves compiledGrant null when compilation threw despite an
    // actorContext. Op tasks never pass step gating, so nothing downstream
    // would recompile on their behalf — the gate has to do it here.
    mockGetRunAccessGrant.mockResolvedValue(null);
    mockResolveGrantRenewalSource.mockReturnValue(PRINCIPAL);
    mockRenewRunAccessGrant.mockResolvedValue({ spaceId: SPACE, expiresAt: 'x' });

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockRenewRunAccessGrant).toHaveBeenCalledOnce();
    expect(mockCheckWorkflowOperationGrantPreflight).toHaveBeenCalledOnce();
    expect(mockCheckWorkflowOperationGrantPreflight.mock.calls[0]?.[0]).not.toBeNull();
    expect(mockStartRun).toHaveBeenCalledOnce();
  });

  it('refuses to start when a principal exists but no grant can be established', async () => {
    mockGetRunAccessGrant.mockResolvedValue(null);
    mockResolveGrantRenewalSource.mockReturnValue(PRINCIPAL);
    mockRenewRunAccessGrant.mockRejectedValue(new Error('capability profile row missing'));

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockStartRun).not.toHaveBeenCalled();
    expect(mockCheckWorkflowOperationGrantPreflight).not.toHaveBeenCalled();
    const [[, result]] = mockAddStepResult.mock.calls as unknown as Array<
      [unknown, { error?: { code?: string; classification?: string; retryable?: boolean } }]
    >;
    expect(result.error?.code).toBe('RUN_ACCESS_UNAVAILABLE');
    expect(result.error?.classification).toBe('permission');
    expect(result.error?.retryable).toBe(false);
    expect(mockCompleteRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      'failed',
    );
  });

  it('terminalizes the run BEFORE reporting, so a reporting failure cannot strand it', async () => {
    // `recordRunStart` has already landed by this point. Left `running` with
    // no tasks and no waiter, the run is exactly what `reconcileOrphanedRuns`
    // treats as recoverable — and it recovers by dispatching, which would run
    // the work this refused. Ordering the terminalize first means even an
    // `emitStepError` throw cannot leave that shape behind.
    mockGetRunAccessGrant.mockResolvedValue({ spaceId: SPACE, expiresAt: 'x' });
    mockRenewRunAccessGrant.mockRejectedValue(
      new FakeGrantRenewalRefused('principal is no longer a member of this space'),
    );
    mockAddStepResult.mockRejectedValueOnce(new Error('result stream unavailable'));

    await handleWorkflowCrudInline(makeStartArgs()).catch(() => undefined);

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    expect(mockCompleteRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      'failed',
    );
    expect(mockStartRun).not.toHaveBeenCalled();
  });

  it('starts a run that has no principal at all — ungated by design', async () => {
    // Schedules and system runs carry no actorContext, so startRun never
    // compiles a grant for them. Failing those closed would break scheduling.
    mockGetRunAccessGrant.mockResolvedValue(null);
    mockResolveGrantRenewalSource.mockReturnValue(null);

    await handleWorkflowCrudInline(makeStartArgs());

    expect(mockRenewRunAccessGrant).not.toHaveBeenCalled();
    expect(mockStartRun).toHaveBeenCalledOnce();
  });
});
