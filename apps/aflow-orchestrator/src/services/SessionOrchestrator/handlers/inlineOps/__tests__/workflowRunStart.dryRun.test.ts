import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveGoalRef } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

const mockListActiveRunsForWorkflow = vi.fn();
const mockRecordRunStart = vi.fn();
const mockGetRunStatistics = vi.fn();
const mockResolveSkillForWorkflow = vi.fn();
const mockListCampaigns = vi.fn();
const mockEnsureActiveCampaign = vi.fn();
const mockGetActiveCampaign = vi.fn();
const mockCreateContractedCampaign = vi.fn();
const mockResolveConnectionForRepoCoordinate = vi.fn();
const mockStartRun = vi.fn();
const mockMkdir = vi.fn();
const mockGetSessionState = vi.fn();
const mockGetSessionDryRunLink = vi.fn();
const mockReadDryRunSession = vi.fn();
const mockReadWorkflowRunDryRun = vi.fn();
const mockLoadRunById = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    recordRunStart: (...args: unknown[]) => mockRecordRunStart(...args),
    listActiveRunsForWorkflow: (...args: unknown[]) => mockListActiveRunsForWorkflow(...args),
    listActiveRunsForWorkflowWithLiveness: (...args: unknown[]) =>
      mockListActiveRunsForWorkflow(...args),
    deriveRunLivenessFromCounts: () => 'executing',
    listRecentRuns: vi.fn().mockResolvedValue([]),
    getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
    addWaiter: vi.fn().mockResolvedValue(undefined),
    resolveSkillForWorkflow: (...args: unknown[]) => mockResolveSkillForWorkflow(...args),
    listCampaigns: (...args: unknown[]) => mockListCampaigns(...args),
    ensureActiveCampaign: (...args: unknown[]) => mockEnsureActiveCampaign(...args),
    getActiveCampaign: (...args: unknown[]) => mockGetActiveCampaign(...args),
    createContractedCampaign: (...args: unknown[]) => mockCreateContractedCampaign(...args),
    resolveConnectionForRepoCoordinate: (...args: unknown[]) =>
      mockResolveConnectionForRepoCoordinate(...args),
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
    loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
    hashWorkflowConfig: () => 'mock-artifact-hash',
  };
});

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    readDryRunSession: (...args: unknown[]) => mockReadDryRunSession(...args),
    readWorkflowRunDryRun: (...args: unknown[]) => mockReadWorkflowRunDryRun(...args),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    })),
    createMemoryDirRepository: vi.fn(() => ({
      mkdir: (...args: unknown[]) => mockMkdir(...args),
    })),
    ensureWorkflowRevisionSnapshot: vi.fn(),
    resolveWorkflowForStart: vi.fn().mockResolvedValue({
      slug: 'kaggle-competition-optimizer',
      revision: 1,
      status: 'approved',
      tasks: [{ taskId: 'prepare', name: 'Prepare', goal: 'g' }],
    }),
  };
});

vi.mock('../../../helpers/workflowCredentialsPreflight.js', () => ({
  checkWorkflowCredentialsPreflight: vi.fn().mockResolvedValue({ ok: true, missingBindings: [] }),
  checkWorkflowCapabilityPreflight: vi
    .fn()
    .mockResolvedValue({ ok: true, missingCapabilities: [] }),
  toBlockedBindingsForResumeContract: vi.fn((x: unknown) => x),
}));

vi.mock('../../../helpers/workflowRunStartupPause.js', () => ({
  handoffStartupPreflightPause: vi.fn(),
  buildNeedsCredentialsStartupContract: vi.fn(() => ({ pauseCause: 'needs_credentials' })),
  buildNeedsCapabilityStartupContract: vi.fn(() => ({ pauseCause: 'needs_capability' })),
}));

vi.mock('../../../../cybernetic/WorkflowRunHarness.js', () => ({
  startRun: (...args: unknown[]) => mockStartRun(...args),
}));

vi.mock('../../../StepService/StepService.js', () => ({
  waitForInput: vi.fn().mockResolvedValue(undefined),
}));

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getSessionDryRunLink: (...args: unknown[]) => mockGetSessionDryRunLink(...args),
  addControlMessage: vi.fn(),
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
}));

import { handleWorkflowCrudInline } from '../workflowCrud.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const SLUG = 'kaggle-competition-optimizer';
const SESSION = '99999999-2222-3333-4444-555555555555';
const PARENT_RUN = '77777777-2222-4333-8444-555555555555';
const PLAN_NODE = '88888888-2222-4333-8444-555555555555';

const CONTRACT = {
  fields: {
    competitionSlug: {
      schema: { type: 'string', minLength: 1 },
      identity: true,
      label: 'Competition slug',
    },
  },
};

const CONTRACTED_SKILL = {
  manifest: {
    goal: { type: 'numeric', metricKey: 'lbValue', direction: 'maximize' },
    campaign: CONTRACT,
  },
};

const ACTIVE_CAMPAIGN = {
  campaignId: '33333333-3333-4333-8333-333333333333',
  spaceId: SPACE,
  workflowSlug: SLUG,
  goalRef: 'goal-ref',
  scoreMetricKey: 'lbValue',
  direction: 'maximize',
  config: { competitionSlug: 'titanic' },
  status: 'active',
  startedAt: '2026-06-11T00:00:00.000Z',
};

function makeStartArgs(
  input: Record<string, unknown>,
  workflowExecution?: Record<string, unknown>,
): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockResolvedValue(input),
      store: vi.fn(),
      shouldStore: vi.fn().mockReturnValue(false),
    } as never,
    context: {
      tenantId: TENANT,
      runId: SESSION,
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
    resolvedInputRef: 'inline:e30=',
    ...(workflowExecution ? { workflowExecution: workflowExecution as never } : {}),
  };
}

function lastStepResult(): Record<string, unknown> {
  const call = mockAddStepResult.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

function recordedRun(): Record<string, unknown> {
  expect(mockRecordRunStart).toHaveBeenCalledTimes(1);
  return mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListActiveRunsForWorkflow.mockResolvedValue([]);
  mockGetRunStatistics.mockResolvedValue({ totalRuns: 0 });
  mockStartRun.mockResolvedValue(undefined);
  mockRecordRunStart.mockResolvedValue(undefined);
  mockGetActiveCampaign.mockResolvedValue(null);
  mockResolveSkillForWorkflow.mockResolvedValue(CONTRACTED_SKILL);
  mockListCampaigns.mockResolvedValue([ACTIVE_CAMPAIGN]);
  mockGetSessionState.mockResolvedValue({
    sessionId: SESSION,
    tenantId: TENANT,
    status: 'RUNNING',
    createdAt: 1,
    lastUpdatedAt: 1,
  });
  mockLoadRunById.mockResolvedValue(null);
  mockGetSessionDryRunLink.mockResolvedValue(null);
  mockReadDryRunSession.mockResolvedValue(null);
  mockReadWorkflowRunDryRun.mockResolvedValue(false);
});

describe('workflow.run.start — dry run', () => {
  it('records the run as a dry run in the active campaign, and makes no run directory', async () => {
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, dryRun: true }));

    expect(recordedRun()).toMatchObject({ dryRun: true, campaignId: ACTIVE_CAMPAIGN.campaignId });
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockCreateContractedCampaign).not.toHaveBeenCalled();
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });

  it('records a live run as live, with its run directory', async () => {
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(recordedRun()['dryRun']).toBeUndefined();
    expect(mockMkdir).toHaveBeenCalledTimes(1);
  });

  it('refuses campaignConfig, because a dry run starts no campaign', async () => {
    await handleWorkflowCrudInline(
      makeStartArgs({ slug: SLUG, dryRun: true, campaignConfig: { competitionSlug: 'x' } }),
    );

    expect(mockCreateContractedCampaign).not.toHaveBeenCalled();
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    expect((result['error'] as Record<string, unknown>)['code']).toBe('DRY_RUN_CAMPAIGN_HELD');
  });

  it('neither waits for nor takes the slot of a live run', async () => {
    mockListActiveRunsForWorkflow.mockResolvedValue([
      { runId: PARENT_RUN, status: 'running', startedAt: new Date() },
    ]);
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, dryRun: true }));

    expect(mockListActiveRunsForWorkflow).not.toHaveBeenCalled();
    expect(recordedRun()['dryRun']).toBe(true);
  });

  it('starts a dry run from a session that works for one, whatever the input says', async () => {
    mockGetSessionDryRunLink.mockResolvedValue({ dryRunOf: PARENT_RUN });
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(recordedRun()['dryRun']).toBe(true);
  });

  it('starts a dry run from a session whose hash is corrupt, from the run row', async () => {
    // The caller's hash was quarantined and deleted, so it names no dry run.
    mockGetSessionState.mockResolvedValue(null);
    mockGetSessionDryRunLink.mockResolvedValue(null);
    mockReadDryRunSession.mockResolvedValue({ runId: PARENT_RUN, taskId: 'run-desk' });
    mockReadWorkflowRunDryRun.mockResolvedValue(true);
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockReadDryRunSession).toHaveBeenCalledWith(expect.anything(), TENANT, SESSION);
    expect(mockReadWorkflowRunDryRun).toHaveBeenCalledWith(expect.anything(), TENANT, PARENT_RUN);
    expect(recordedRun()['dryRun']).toBe(true);
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('starts nothing when the caller session’s dry-run status cannot be read', async () => {
    mockReadDryRunSession.mockResolvedValue({ runId: PARENT_RUN });
    mockReadWorkflowRunDryRun.mockRejectedValue(new Error('postgres unreachable'));
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    expect((result['error'] as Record<string, unknown>)['code']).toBe('DRY_RUN_STATE_UNAVAILABLE');
  });

  it('starts nothing when the caller task’s run row cannot be read', async () => {
    mockReadWorkflowRunDryRun.mockRejectedValue(new Error('no row'));
    await handleWorkflowCrudInline(
      makeStartArgs(
        { slug: SLUG, wait: 'until_complete' },
        { runId: PARENT_RUN, taskId: 'run-desk', attempt: 1, dispatchAttemptToken: 't' },
      ),
    );

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect((lastStepResult()['error'] as Record<string, unknown>)['code']).toBe(
      'DRY_RUN_STATE_UNAVAILABLE',
    );
  });

  it('starts a dry run from a task of a dry run', async () => {
    mockReadWorkflowRunDryRun.mockResolvedValue(true);
    mockLoadRunById.mockResolvedValue({
      runId: PARENT_RUN,
      sessionId: SESSION,
      dryRun: true,
      metadata: {},
    });
    await handleWorkflowCrudInline(
      makeStartArgs(
        { slug: SLUG, wait: 'until_complete' },
        { runId: PARENT_RUN, taskId: 'run-desk', attempt: 1, dispatchAttemptToken: 't' },
      ),
    );

    expect(recordedRun()['dryRun']).toBe(true);
  });

  it('serves no plan node, so no plan read counts it', async () => {
    mockReadWorkflowRunDryRun.mockResolvedValue(true);
    mockLoadRunById.mockResolvedValue({
      runId: PARENT_RUN,
      sessionId: SESSION,
      dryRun: true,
      planNodeId: PLAN_NODE,
      metadata: {},
    });
    await handleWorkflowCrudInline(
      makeStartArgs(
        { slug: SLUG, wait: 'until_complete' },
        { runId: PARENT_RUN, taskId: 'run-desk', attempt: 1, dispatchAttemptToken: 't' },
      ),
    );

    expect(recordedRun()['dryRun']).toBe(true);
    expect(recordedRun()['planNodeId']).toBeUndefined();
  });

  it('serves the node of a live parent run', async () => {
    mockLoadRunById.mockResolvedValue({
      runId: PARENT_RUN,
      sessionId: SESSION,
      planNodeId: PLAN_NODE,
      metadata: {},
    });
    await handleWorkflowCrudInline(
      makeStartArgs(
        { slug: SLUG, wait: 'until_complete' },
        { runId: PARENT_RUN, taskId: 'run-desk', attempt: 1, dispatchAttemptToken: 't' },
      ),
    );

    expect(recordedRun()['planNodeId']).toBe(PLAN_NODE);
  });
});

describe('workflow.run.start — a dry run and its campaign', () => {
  const NUMERIC_GOAL = { type: 'numeric', metricKey: 'lbValue', direction: 'maximize' } as const;
  const OBJECTIVE_GOAL = {
    type: 'objective',
    criteria: [{ id: 'filed', description: 'The report is filed.' }],
  } as const;

  function failureCode(): unknown {
    return (lastStepResult()['error'] as Record<string, unknown>)['code'];
  }

  it.each([
    ['numeric', NUMERIC_GOAL],
    ['objective', OBJECTIVE_GOAL],
  ] as const)(
    'refuses a %s goal under a contract when its campaign is not active',
    async (_kind, goal) => {
      mockResolveSkillForWorkflow.mockResolvedValue({ manifest: { goal, campaign: CONTRACT } });
      mockListCampaigns.mockResolvedValue([]);
      await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, dryRun: true }));

      expect(mockRecordRunStart).not.toHaveBeenCalled();
      expect(mockCreateContractedCampaign).not.toHaveBeenCalled();
      expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
      expect(failureCode()).toBe('CAMPAIGN_REQUIRED');
      // The remedy a dry run can take: it refuses campaignConfig.
      const message = (lastStepResult()['error'] as Record<string, unknown>)['message'];
      expect(message).toContain('workflow.campaign.start');
      expect(message).toContain('without campaignConfig');
    },
  );

  it.each([
    ['numeric', NUMERIC_GOAL],
    ['objective', OBJECTIVE_GOAL],
  ] as const)('joins the active campaign of a %s goal under a contract', async (_kind, goal) => {
    mockResolveSkillForWorkflow.mockResolvedValue({ manifest: { goal, campaign: CONTRACT } });
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, dryRun: true }));

    expect(recordedRun()).toMatchObject({
      dryRun: true,
      campaignId: ACTIVE_CAMPAIGN.campaignId,
    });
    expect(mockCreateContractedCampaign).not.toHaveBeenCalled();
  });

  it('refuses a numeric goal with no contract when no campaign for its goal is active', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue({ manifest: { goal: NUMERIC_GOAL } });
    mockListCampaigns.mockResolvedValue([{ ...ACTIVE_CAMPAIGN, goalRef: 'another-goal' }]);
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, dryRun: true }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
    expect(failureCode()).toBe('DRY_RUN_CAMPAIGN_HELD');
  });

  it('joins the active campaign of a numeric goal with no contract, and creates none', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue({ manifest: { goal: NUMERIC_GOAL } });
    mockListCampaigns.mockResolvedValue([
      { ...ACTIVE_CAMPAIGN, goalRef: deriveGoalRef(SLUG, NUMERIC_GOAL, {}) },
    ]);
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, dryRun: true }));

    expect(recordedRun()).toMatchObject({ dryRun: true, campaignId: ACTIVE_CAMPAIGN.campaignId });
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });

  it.each([
    ['a subjective goal', { goal: { type: 'subjective', rubric: ['Reads clearly.'] } }],
    ['no goal', {}],
  ] as const)('runs a skill with %s with no campaign', async (_kind, manifest) => {
    mockResolveSkillForWorkflow.mockResolvedValue({
      manifest: { ...manifest, campaign: CONTRACT },
    });
    mockListCampaigns.mockResolvedValue([]);
    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, dryRun: true }));

    expect(mockListCampaigns).not.toHaveBeenCalled();
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
    expect(mockCreateContractedCampaign).not.toHaveBeenCalled();
    const run = recordedRun();
    expect(run['dryRun']).toBe(true);
    expect(run['campaignId']).toBeUndefined();
  });
});
