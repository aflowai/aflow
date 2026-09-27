import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Outcome,
  SkillCampaignContract,
  SkillGoal,
  WorkflowPutInput,
  WorkflowTask,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

const mockResolveCampaignManifestParams = vi.fn();
const mockListActiveRuns = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    // DB-touching reads are mocked; materializeAndValidateSkillConfig and
    // renderSkillDiagnostics stay REAL so the rules genuinely fire.
    resolveCampaignManifestParams: (...args: unknown[]) =>
      mockResolveCampaignManifestParams(...args),
    listActiveRuns: (...args: unknown[]) => mockListActiveRuns(...args),
  };
});

const mockGetByPath = vi.fn();
const mockDocPut = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createMemoryDocRepository: vi.fn(() => ({
      getByPath: (...args: unknown[]) => mockGetByPath(...args),
      put: (...args: unknown[]) => mockDocPut(...args),
    })),
    createMemoryDirRepository: vi.fn(() => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      ensureParentDirs: vi.fn().mockResolvedValue(undefined),
    })),
    ensureWorkflowRevisionSnapshot: vi.fn(),
  };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(),
  addControlMessage: vi.fn(),
  updateSessionState: vi.fn(),
  appendSessionEvent: vi.fn(),
  markSessionDirty: vi.fn(),
}));

vi.mock('../../../../StepService/StepService.js', () => ({
  waitForInput: vi.fn().mockResolvedValue(undefined),
}));

import { handleWorkflowPut } from '../workflowCrud/create.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const SLUG = 'kaggle-competition-optimizer';

const CONTRACT: SkillCampaignContract = {
  fields: {
    competitionSlug: {
      schema: { type: 'string', minLength: 1 },
      identity: true,
      label: 'Competition slug',
    },
    metricDirection: {
      schema: { type: 'string', enum: ['maximize', 'minimize'] },
      label: 'Metric direction',
    },
    targetScore: { schema: { type: 'number' }, label: 'Target score' },
  },
};

const PARAM_GOAL: SkillGoal = {
  type: 'numeric',
  metricKey: 'lbValue',
  direction: { $campaign: 'metricDirection' },
};

/** The §1b failure: a literal numeric goal-tier target baked into the doc. */
const LITERAL_OUTCOME: Outcome = {
  id: 'lb-target',
  name: 'Leaderboard target',
  evaluator: { type: 'threshold', metric: 'lbValue', operator: 'gte', target: 0.5 },
};

const PARAM_OUTCOME: Outcome = {
  id: 'lb-target',
  name: 'Leaderboard target',
  evaluator: {
    type: 'threshold',
    metric: 'lbValue',
    operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
    target: { $campaign: 'targetScore' },
  },
};

const TASK: WorkflowTask = { taskId: 'do-thing', name: 'do-thing', goal: 'g', type: 'agent' };

function putInput(outcomes: Outcome[]): WorkflowPutInput {
  return {
    slug: SLUG,
    writeMode: 'upsert',
    name: 'Kaggle optimizer',
    outcomes,
    mode: 'optimization',
    tasks: [TASK],
    stateVariables: [],
    status: 'draft',
  };
}

function makeArgs(): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn(),
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
      operation: 'workflow.manage.put',
      tags: [],
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: 'inline:e30=',
    scheduledAtMs: Date.now(),
  };
}

function lastStepResult(): Record<string, unknown> {
  const call = mockAddStepResult.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

function failureDiagnosticCodes(result: Record<string, unknown>): string[] {
  const error = result['error'] as Record<string, unknown>;
  const details = error['details'] as { diagnostics: { code: string }[] };
  return details.diagnostics.map((d) => d.code);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByPath.mockResolvedValue(null); // no existing doc → create path
  mockDocPut.mockResolvedValue({ id: 'doc-1', path: 'p', currentVersion: 1 });
  mockListActiveRuns.mockResolvedValue([]);
});

describe('workflow.manage.put — campaign gate (Plan 195 §4.3 / §1b)', () => {
  it('fires: literal goal-tier target on a campaign-contracted skill is rejected, nothing persisted', async () => {
    mockResolveCampaignManifestParams.mockResolvedValue({ contract: CONTRACT, goal: PARAM_GOAL });

    await handleWorkflowPut(makeArgs(), putInput([LITERAL_OUTCOME]), Date.now());

    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    expect((result['error'] as Record<string, unknown>)['code']).toBe('GRAPH_INVALID');
    expect(failureDiagnosticCodes(result)).toContain('placeholder_constant_in_parameterized_skill');
    expect(mockDocPut).not.toHaveBeenCalled();
  });

  it('fires: $campaign ref to an undeclared contract field is rejected', async () => {
    mockResolveCampaignManifestParams.mockResolvedValue({ contract: CONTRACT, goal: PARAM_GOAL });
    const outcome: Outcome = {
      ...PARAM_OUTCOME,
      evaluator: {
        type: 'threshold',
        metric: 'lbValue',
        operator: 'gte',
        target: { $campaign: 'noSuchField' },
      },
    };

    await handleWorkflowPut(makeArgs(), putInput([outcome]), Date.now());

    const result = lastStepResult();
    expect(result['status']).toBe('FAILED');
    expect(failureDiagnosticCodes(result)).toContain('campaign_ref_unknown_field');
    expect(mockDocPut).not.toHaveBeenCalled();
  });

  it('does not fire: parameterized outcomes on a contracted skill persist with refs verbatim', async () => {
    mockResolveCampaignManifestParams.mockResolvedValue({ contract: CONTRACT, goal: PARAM_GOAL });

    await handleWorkflowPut(makeArgs(), putInput([PARAM_OUTCOME]), Date.now());

    expect(lastStepResult()['status']).toBe('SUCCEEDED');
    expect(mockDocPut).toHaveBeenCalledOnce();
    const written = JSON.parse(
      (mockDocPut.mock.calls[0]![0] as { inlineContent: string }).inlineContent,
    ) as { outcomes: Outcome[] };
    expect(written.outcomes[0]?.evaluator).toMatchObject({
      target: { $campaign: 'targetScore' },
      operator: { $campaign: 'metricDirection' },
    });
  });

  it('does not fire: workflow with no owning skill keeps literal targets (rules vacuous)', async () => {
    mockResolveCampaignManifestParams.mockResolvedValue(undefined);

    await handleWorkflowPut(makeArgs(), putInput([LITERAL_OUTCOME]), Date.now());

    expect(lastStepResult()['status']).toBe('SUCCEEDED');
    expect(mockDocPut).toHaveBeenCalledOnce();
  });
});
