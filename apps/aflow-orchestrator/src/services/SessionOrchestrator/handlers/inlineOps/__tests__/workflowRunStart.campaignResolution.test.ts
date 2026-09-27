import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoConnectionResolveError } from '@aflow/cybernetic-runtime';
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
    hashWorkflowConfig: () => 'mock-artifact-hash',
  };
});

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

const CONTRACT = {
  fields: {
    competitionSlug: {
      schema: { type: 'string', minLength: 1 },
      identity: true,
      label: 'Competition slug',
    },
    targetScore: { schema: { type: 'number' }, label: 'Target score' },
  },
};

function skillWith(opts: { contract?: boolean } = {}): unknown {
  return {
    manifest: {
      goal: { type: 'numeric', metricKey: 'lbValue', direction: 'maximize' },
      ...(opts.contract ? { campaign: CONTRACT } : {}),
    },
  };
}

const PROCESS_CONTRACT = {
  fields: {
    repoBindingId: {
      schema: { type: 'string', minLength: 1 },
      identity: true,
      label: 'Repo binding id',
    },
  },
};

function processSkillWith(opts: { contract?: boolean } = {}): unknown {
  return {
    manifest: {
      goal: { type: 'objective', criteria: [{ id: 'pr-opened', description: 'A PR is opened.' }] },
      ...(opts.contract ? { campaign: PROCESS_CONTRACT } : {}),
    },
  };
}

function activeProcessCampaign(campaignId: string, goalRef: string): Record<string, unknown> {
  return {
    campaignId,
    spaceId: SPACE,
    workflowSlug: SLUG,
    goalRef,
    scoreMetricKey: 'completion',
    direction: 'maximize',
    config: { repoBindingId: 'repo-binding-123' },
    status: 'active',
    startedAt: '2026-06-11T00:00:00.000Z',
  };
}

const CODING_CONTRACT = {
  fields: {
    repo: {
      schema: { type: 'string', minLength: 1 },
      identity: true,
      label: 'Repo coordinate',
    },
  },
};

function codingSkill(): unknown {
  return {
    manifest: {
      goal: { type: 'objective', criteria: [{ id: 'pr-opened', description: 'A PR is opened.' }] },
      campaign: CODING_CONTRACT,
    },
  };
}

function activeCodingCampaign(
  campaignId: string,
  goalRef: string,
  repo = 'munchist/duality',
): Record<string, unknown> {
  return {
    campaignId,
    spaceId: SPACE,
    workflowSlug: SLUG,
    goalRef,
    scoreMetricKey: 'completion',
    direction: 'maximize',
    config: { repo },
    status: 'active',
    startedAt: '2026-06-11T00:00:00.000Z',
  };
}

function activeCampaign(campaignId: string, goalRef: string): Record<string, unknown> {
  return {
    campaignId,
    spaceId: SPACE,
    workflowSlug: SLUG,
    goalRef,
    scoreMetricKey: 'lbValue',
    direction: 'maximize',
    config: { competitionSlug: 'titanic', targetScore: 0.8 },
    status: 'active',
    startedAt: '2026-06-11T00:00:00.000Z',
  };
}

function makeStartArgs(input: Record<string, unknown>): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn().mockResolvedValue(input),
      store: vi.fn(),
      shouldStore: vi.fn().mockReturnValue(false),
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
    resolvedInputRef: 'inline:e30=',
  };
}

function lastStepResult(): Record<string, unknown> {
  const call = mockAddStepResult.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListActiveRunsForWorkflow.mockResolvedValue([]);
  mockGetRunStatistics.mockResolvedValue({ totalRuns: 0 });
  mockStartRun.mockResolvedValue(undefined);
  mockRecordRunStart.mockResolvedValue(undefined);
  mockGetActiveCampaign.mockResolvedValue(null);
  mockResolveConnectionForRepoCoordinate.mockResolvedValue('github-default');
});

describe('workflow.run.start — campaign resolution (Plan 195 §4.5)', () => {
  it('CAMPAIGN_REQUIRED: contracted skill with no active campaign rejects before the run row', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(skillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    const error = result['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CAMPAIGN_REQUIRED');
    const details = error['details'] as Record<string, unknown>;
    const contractSchema = details['campaignContract'] as Record<string, unknown>;
    expect(contractSchema['type']).toBe('object');
    expect(contractSchema['required']).toEqual(['competitionSlug', 'targetScore']);
    const suggested = details['suggestedAction'] as Record<string, unknown>;
    expect(suggested['op']).toBe('workflow.run.start');
  });

  it('create-on-first-run: campaignConfig creates the campaign and starts the run in one call', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(skillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([]);
    const config = { competitionSlug: 'titanic', targetScore: 0.8 };
    // createContractedCampaign is engine-owned (its identity/config validation
    // is covered by the engine's campaignOperations test); here we assert that
    // run.start calls it and binds the resulting campaign to the run row.
    mockCreateContractedCampaign.mockResolvedValue({
      ok: true,
      created: true,
      campaign: {
        ...activeCampaign('camp-new', 'kaggle-competition-optimizer:numeric:lbValue:maximize:abc'),
        config,
      },
    });

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, campaignConfig: config }));

    // The campaign is created and bound to the run row BEFORE dispatch — no
    // separate workflow.campaign.start. (The post-record dispatch/park path is
    // covered by other suites.)
    expect(mockCreateContractedCampaign).toHaveBeenCalledTimes(1);
    expect(mockRecordRunStart).toHaveBeenCalledTimes(1);
    expect(mockRecordRunStart.mock.calls[0]![2]).toMatchObject({ campaignId: 'camp-new' });
  });

  it('campaignConfig takes precedence over implicit selection (a second competition does not run the active one)', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(skillWith({ contract: true }));
    // create the campaign for the supplied config even though another campaign
    // is active. listCampaigns/implicit selection must NOT be consulted when
    // campaignConfig is supplied.
    const config = { competitionSlug: 'a-different-competition', targetScore: 0.8 };
    mockCreateContractedCampaign.mockResolvedValue({
      ok: true,
      created: true,
      campaign: {
        ...activeCampaign('camp-second', `${SLUG}:numeric:lbValue:maximize:zzz`),
        config,
      },
    });

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, campaignConfig: config }));

    expect(mockListCampaigns).not.toHaveBeenCalled();
    expect(mockCreateContractedCampaign).toHaveBeenCalledTimes(1);
    expect(mockRecordRunStart.mock.calls[0]![2]).toMatchObject({ campaignId: 'camp-second' });
  });

  it('implicit selection: exactly one active campaign is persisted on the run row', async () => {
    const c1 = activeCampaign(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      `${SLUG}:numeric:lbValue:maximize:abc`,
    );
    mockResolveSkillForWorkflow.mockResolvedValue(skillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([c1]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['campaignId']).toBe(c1['campaignId']);
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
  });

  it('CAMPAIGN_AMBIGUOUS: several active campaigns without explicit campaignId', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(skillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([
      activeCampaign(
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        `${SLUG}:numeric:lbValue:maximize:abc`,
      ),
      activeCampaign(
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        `${SLUG}:numeric:lbValue:maximize:def`,
      ),
    ]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const error = lastStepResult()['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CAMPAIGN_AMBIGUOUS');
    const details = error['details'] as { activeCampaigns: unknown[] };
    expect(details.activeCampaigns).toHaveLength(2);
  });

  it('explicit campaignId picks among several active campaigns', async () => {
    const c2 = activeCampaign(
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      `${SLUG}:numeric:lbValue:maximize:def`,
    );
    mockResolveSkillForWorkflow.mockResolvedValue(skillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([
      activeCampaign(
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        `${SLUG}:numeric:lbValue:maximize:abc`,
      ),
      c2,
    ]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, campaignId: c2['campaignId'] }));

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['campaignId']).toBe(c2['campaignId']);
  });

  it('config-less ensure: numeric goal without a contract mints the goalRef campaign at start', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(skillWith({ contract: false }));
    mockEnsureActiveCampaign.mockResolvedValue(
      activeCampaign('cccccccc-cccc-cccc-cccc-cccccccccccc', `${SLUG}:numeric:lbValue:maximize`),
    );

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockEnsureActiveCampaign).toHaveBeenCalledOnce();
    const ensureParams = mockEnsureActiveCampaign.mock.calls[0]![2] as Record<string, unknown>;
    expect(ensureParams['goalRef']).toBe(`${SLUG}:numeric:lbValue:maximize`);
    expect(ensureParams['scoreMetricKey']).toBe('lbValue');
    expect(ensureParams['direction']).toBe('maximize');
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['campaignId']).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('no skill / no goal: no campaign machinery, run row without campaignId', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(null);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockListCampaigns).not.toHaveBeenCalled();
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['campaignId']).toBeUndefined();
  });
});

describe('workflow.run.start — objective+contract process campaigns (Plan 219)', () => {
  it('create-on-first-run: an objective skill with a contract + config creates a process campaign', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(processSkillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([]);
    const config = { repoBindingId: 'repo-binding-123' };
    // createContractedCampaign is engine-owned; it derives scoreMetricKey =
    // 'completion' + direction 'maximize' for an objective goal. Here we assert
    // run.start routes an objective+contract skill through it and binds the
    // resulting process campaign to the run row.
    mockCreateContractedCampaign.mockResolvedValue({
      ok: true,
      created: true,
      campaign: activeProcessCampaign('camp-process-new', `${SLUG}:objective:abc`),
    });

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG, campaignConfig: config }));

    expect(mockCreateContractedCampaign).toHaveBeenCalledTimes(1);
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledTimes(1);
    expect(mockRecordRunStart.mock.calls[0]![2]).toMatchObject({ campaignId: 'camp-process-new' });
  });

  it('reuse-on-identity: an active process campaign is selected with no config', async () => {
    const existing = activeProcessCampaign('camp-process-existing', `${SLUG}:objective:abc`);
    mockResolveSkillForWorkflow.mockResolvedValue(processSkillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([existing]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockCreateContractedCampaign).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['campaignId']).toBe('camp-process-existing');
  });

  it('CAMPAIGN_REQUIRED: an objective+contract skill started without config errors with the contract fields', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(processSkillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    const error = lastStepResult()['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CAMPAIGN_REQUIRED');
    const details = error['details'] as Record<string, unknown>;
    const contractSchema = details['campaignContract'] as Record<string, unknown>;
    expect(contractSchema['required']).toEqual(['repoBindingId']);
  });

  it('objective goal WITHOUT a contract creates NO campaign (unchanged)', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(processSkillWith({ contract: false }));

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockListCampaigns).not.toHaveBeenCalled();
    expect(mockEnsureActiveCampaign).not.toHaveBeenCalled();
    expect(mockCreateContractedCampaign).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['campaignId']).toBeUndefined();
  });
});

describe('workflow.run.start — coding-run GitHub connection pin (Plan 222 P3c)', () => {
  it('valid designation + connection: pins run.metadata.connectionBindingId before recordRunStart', async () => {
    const camp = activeCodingCampaign('camp-coding', `${SLUG}:objective:abc`);
    mockResolveSkillForWorkflow.mockResolvedValue(codingSkill());
    mockListCampaigns.mockResolvedValue([camp]);
    mockResolveConnectionForRepoCoordinate.mockResolvedValue('github-conn-1');

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    // Resolved ONCE from the campaign's repo coordinate.
    expect(mockResolveConnectionForRepoCoordinate).toHaveBeenCalledTimes(1);
    expect(mockResolveConnectionForRepoCoordinate.mock.calls[0]!.slice(1)).toEqual([
      TENANT,
      SPACE,
      'munchist/duality',
    ]);
    // Pinned on the run's metadata at recordRunStart (i.e. before any dispatch).
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    expect(params['campaignId']).toBe('camp-coding');
    const metadata = params['metadata'] as Record<string, unknown>;
    expect(metadata['connectionBindingId']).toBe('github-conn-1');
  });

  it('CONNECTION_MISSING: coding coordinate with no designation fails before the run row', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(codingSkill());
    mockListCampaigns.mockResolvedValue([
      activeCodingCampaign('camp-coding', `${SLUG}:objective:abc`),
    ]);
    mockResolveConnectionForRepoCoordinate.mockRejectedValue(
      new RepoConnectionResolveError(
        'CONNECTION_MISSING',
        'No repo designation for the coordinate.',
      ),
    );

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
    const error = lastStepResult()['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CONNECTION_MISSING');
  });

  it('CONNECTION_INVALID: coding coordinate linked to a disabled/non-github connection fails before the run row', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(codingSkill());
    mockListCampaigns.mockResolvedValue([
      activeCodingCampaign('camp-coding', `${SLUG}:objective:abc`),
    ]);
    mockResolveConnectionForRepoCoordinate.mockRejectedValue(
      new RepoConnectionResolveError('CONNECTION_INVALID', 'The connection is disabled.'),
    );

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
    const error = lastStepResult()['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CONNECTION_INVALID');
  });

  it('non-coding campaign run (no repo coordinate): no resolve, no pin', async () => {
    const c1 = activeCampaign(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      `${SLUG}:numeric:lbValue:maximize:abc`,
    );
    mockResolveSkillForWorkflow.mockResolvedValue(skillWith({ contract: true }));
    mockListCampaigns.mockResolvedValue([c1]);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockResolveConnectionForRepoCoordinate).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    const metadata = (params['metadata'] ?? {}) as Record<string, unknown>;
    expect(metadata['connectionBindingId']).toBeUndefined();
  });

  it('no-campaign run (no skill / no goal): unaffected — no resolve, no pin', async () => {
    mockResolveSkillForWorkflow.mockResolvedValue(null);

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockResolveConnectionForRepoCoordinate).not.toHaveBeenCalled();
    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    const metadata = (params['metadata'] ?? {}) as Record<string, unknown>;
    expect(metadata['connectionBindingId']).toBeUndefined();
  });
});

describe('workflow.run.start — frozen-skill drift guard (Plan 222 P3d)', () => {
  it('a coding run whose resolved skill has an UNPINNED github task fails closed', async () => {
    const { resolveWorkflowForStart } = await import('@aflow/database');
    vi.mocked(resolveWorkflowForStart).mockResolvedValueOnce({
      slug: SLUG,
      revision: 1,
      status: 'approved',
      // A FROZEN installed skill copied before the connection model: the github
      // task carries no `connection_binding` pin, so it would scope-resolve.
      tasks: [
        {
          taskId: 'merge',
          type: 'operation',
          operation: 'api.http.call',
          inputTemplate: { apiId: 'github', endpointId: 'mergePullRequest', params: {} },
        },
      ],
    } as never);
    mockResolveSkillForWorkflow.mockResolvedValue(codingSkill());
    mockListCampaigns.mockResolvedValue([
      activeCodingCampaign('camp-coding', `${SLUG}:objective:abc`),
    ]);
    mockResolveConnectionForRepoCoordinate.mockResolvedValue('github-conn-1');

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    // The connection still resolved (so a healthy run would proceed), but the
    // unpinned github task makes us fail closed BEFORE the run row.
    expect(mockResolveConnectionForRepoCoordinate).toHaveBeenCalledTimes(1);
    expect(mockRecordRunStart).not.toHaveBeenCalled();
    expect(mockStartRun).not.toHaveBeenCalled();
    const error = lastStepResult()['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CODING_SKILL_PREDATES_CONNECTION_MODEL');
    const details = error['details'] as { taskIds: string[] };
    expect(details.taskIds).toEqual(['merge']);
  });

  it('a coding run whose github task IS connection-pinned passes the guard and pins the run', async () => {
    const { resolveWorkflowForStart } = await import('@aflow/database');
    vi.mocked(resolveWorkflowForStart).mockResolvedValueOnce({
      slug: SLUG,
      revision: 1,
      status: 'approved',
      tasks: [
        {
          taskId: 'merge',
          type: 'operation',
          operation: 'api.http.call',
          inputBindings: { githubConnection: { kind: 'connection_binding' } },
          inputTemplate: {
            apiId: 'github',
            endpointId: 'mergePullRequest',
            bindingId: { $bind: 'githubConnection' },
            params: {},
          },
        },
      ],
    } as never);
    mockResolveSkillForWorkflow.mockResolvedValue(codingSkill());
    mockListCampaigns.mockResolvedValue([
      activeCodingCampaign('camp-coding', `${SLUG}:objective:abc`),
    ]);
    mockResolveConnectionForRepoCoordinate.mockResolvedValue('github-conn-1');

    await handleWorkflowCrudInline(makeStartArgs({ slug: SLUG }));

    expect(mockRecordRunStart).toHaveBeenCalledOnce();
    const params = mockRecordRunStart.mock.calls[0]![2] as Record<string, unknown>;
    const metadata = params['metadata'] as Record<string, unknown>;
    expect(metadata['connectionBindingId']).toBe('github-conn-1');
  });
});
