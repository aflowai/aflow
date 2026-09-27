import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { ActiveLearning, Workflow, WorkflowLearning } from '@aflow/schemas';
import type { WorkflowRunDetail } from '../ledger/types.js';

const mocks = vi.hoisted(() => ({
  getRunCampaignId: vi.fn(),
  getCampaignById: vi.fn(),
  getCampaignScoreSeries: vi.fn(),
  resolveSkillForWorkflow: vi.fn(),
  selectActiveLearningSet: vi.fn(),
  resolveActiveSetBudget: vi.fn(),
  loadSpaceDirectives: vi.fn(),
}));

vi.mock('../ledger/queries.js', () => ({
  getRunCampaignId: mocks.getRunCampaignId,
}));

vi.mock('../campaigns.js', () => ({
  getCampaignById: mocks.getCampaignById,
  getCampaignScoreSeries: mocks.getCampaignScoreSeries,
}));

vi.mock('../skill.js', () => ({
  resolveSkillForWorkflow: mocks.resolveSkillForWorkflow,
}));

vi.mock('../activeLearningSet.js', () => ({
  selectActiveLearningSet: mocks.selectActiveLearningSet,
  resolveActiveSetBudget: mocks.resolveActiveSetBudget,
}));

vi.mock('../modelResolution.js', () => ({
  loadSpaceDirectives: mocks.loadSpaceDirectives,
}));

// `@aflow/database` stays real: the pre-resolved `workflow` argument keeps
// `resolveWorkflowForRunRevision` (its only use here) from ever being called.
import { buildWorkflowRunResult } from '../runResult.js';

const DB = {} as unknown as PostgresJsDatabase;
const PAYLOAD_STORE = {} as unknown as PayloadStore;
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const CAMPAIGN = '00000000-0000-0000-0000-0000000000aa';
const RUN_ID = '00000000-0000-0000-0000-000000000042';
const SLUG = 'kaggle-competition-optimizer';

const WORKFLOW = {
  goal: 'minimize rmsle',
  tasks: [],
  stateVariables: [],
  outcomes: [],
} as unknown as Workflow;

function learning(id: string, recommendation?: string): WorkflowLearning {
  return {
    id,
    category: 'worked',
    kind: 'search_heuristic',
    observation: `observation for ${id}`,
    ...(recommendation ? { recommendation } : {}),
    evidence: { runId: RUN_ID },
    confidence: 'medium',
    source: 'agent',
  };
}

function runDetail(overrides: Partial<WorkflowRunDetail> = {}): WorkflowRunDetail {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    spaceId: SPACE,
    workflowSlug: SLUG,
    runId: RUN_ID,
    sessionId: null,
    status: 'completed',
    workflowRevision: 1,
    startedAt: new Date('2026-06-07T00:00:00.000Z'),
    completedAt: new Date('2026-06-07T01:00:00.000Z'),
    totalCostCents: null,
    totalTokens: null,
    pausedReason: null,
    pausedPayloadRef: null,
    pauseVersion: 0,
    resumeAttemptCount: 0,
    cancelledBy: null,
    cancelReason: null,
    learningCount: 0,
    score: null,
    evaluationJson: null,
    failureJson: null,
    learningsJson: null,
    schedulerCursorAt: null,
    metadata: null,
    tasks: [],
    ...overrides,
  };
}

function activeSet(selected: ActiveLearning[], consolidationDue = false) {
  return { selected, omittedDueToBudget: 0, consolidationDue };
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRunCampaignId.mockResolvedValue(CAMPAIGN);
  mocks.getCampaignById.mockResolvedValue({ campaignId: CAMPAIGN, config: {} });
  mocks.getCampaignScoreSeries.mockResolvedValue([]);
  mocks.resolveSkillForWorkflow.mockResolvedValue(null);
  mocks.loadSpaceDirectives.mockResolvedValue(null);
  mocks.resolveActiveSetBudget.mockReturnValue(20);
  mocks.selectActiveLearningSet.mockResolvedValue(activeSet([]));
});

describe('buildWorkflowRunResult — learnings block', () => {
  it('carries the run-recorded items and the selector set state at terminal', async () => {
    mocks.selectActiveLearningSet.mockResolvedValue(
      activeSet([
        {
          kind: 'trajectory',
          objective: { metricKey: 'rmsle', direction: 'minimize' },
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
          observation: 'observation for l-1',
          confidence: 'medium',
        },
      ]),
    );

    const result = await buildWorkflowRunResult(
      { db: DB, payloadStore: PAYLOAD_STORE },
      {
        tenantId: TENANT,
        run: runDetail({
          learningsJson: [learning('l-1', 'try log-transform'), learning('l-2')],
        }),
        workflow: WORKFLOW,
        scope: 'full',
      },
    );

    expect(result?.learnings).toEqual({
      items: [
        {
          id: 'l-1',
          kind: 'search_heuristic',
          category: 'worked',
          observation: 'observation for l-1',
          recommendation: 'try log-transform',
          confidence: 'medium',
        },
        {
          id: 'l-2',
          kind: 'search_heuristic',
          category: 'worked',
          observation: 'observation for l-2',
          confidence: 'medium',
        },
      ],
      setState: { activeSetSize: 2, budget: 20, pendingCount: 1, consolidationDue: false },
    });
    expect(mocks.selectActiveLearningSet).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: SPACE,
        skillSlug: SLUG,
        campaignId: CAMPAIGN,
        budget: 20,
      }),
    );
  });

  it('reports the skill-scope set for non-campaign runs', async () => {
    mocks.getRunCampaignId.mockResolvedValue(null);
    mocks.selectActiveLearningSet.mockResolvedValue(
      activeSet(
        [
          {
            kind: 'durable',
            learningId: '00000000-0000-0000-0000-00000000d001',
            statement: 'a skill fact',
            learningKind: 'observation',
            confidence: 'high',
            scopeKind: 'skill',
          },
        ],
        true,
      ),
    );

    const result = await buildWorkflowRunResult(
      { db: DB, payloadStore: PAYLOAD_STORE },
      { tenantId: TENANT, run: runDetail(), workflow: WORKFLOW, scope: 'full' },
    );

    expect(result?.learnings).toEqual({
      items: [],
      setState: { activeSetSize: 1, budget: 20, pendingCount: 0, consolidationDue: true },
    });
    const call = mocks.selectActiveLearningSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('campaignId' in call).toBe(false);
  });

  it('carries detailRef on recorded items', async () => {
    const result = await buildWorkflowRunResult(
      { db: DB, payloadStore: PAYLOAD_STORE },
      {
        tenantId: TENANT,
        run: runDetail({
          learningsJson: [{ ...learning('l-1'), detailRef: '/coach/learnings/l-1-notes.md' }],
        }),
        workflow: WORKFLOW,
        scope: 'full',
      },
    );
    expect(result?.learnings?.items[0]).toMatchObject({
      detailRef: '/coach/learnings/l-1-notes.md',
    });
  });

  it('omits the block when the run recorded nothing and the set is empty', async () => {
    const result = await buildWorkflowRunResult(
      { db: DB, payloadStore: PAYLOAD_STORE },
      { tenantId: TENANT, run: runDetail(), workflow: WORKFLOW, scope: 'full' },
    );
    expect(result?.learnings).toBeUndefined();
  });

  it('a learnings-fill failure never breaks the rest of the result', async () => {
    mocks.selectActiveLearningSet.mockRejectedValue(new Error('selector down'));

    const result = await buildWorkflowRunResult(
      { db: DB, payloadStore: PAYLOAD_STORE },
      {
        tenantId: TENANT,
        run: runDetail({ learningsJson: [learning('l-1')] }),
        workflow: WORKFLOW,
        scope: 'full',
      },
    );

    expect(result?.learnings).toBeUndefined();
    expect(result?.goal).toBe('minimize rmsle');
  });

  it('does not touch learnings on partial (in-flight) reads', async () => {
    const result = await buildWorkflowRunResult(
      { db: DB, payloadStore: PAYLOAD_STORE },
      {
        tenantId: TENANT,
        run: runDetail({ status: 'running', learningsJson: [learning('l-1')] }),
        workflow: WORKFLOW,
        scope: 'partial',
      },
    );
    expect(result?.learnings).toBeUndefined();
    expect(mocks.selectActiveLearningSet).not.toHaveBeenCalled();
  });
});
