import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Campaign, MaterializedSkillGoal, WorkflowLearning } from '@aflow/schemas';
import { configureLogging } from '@aflow/observability';

const mockUpdateRunMetadata = vi.fn();
const mockEndCampaign = vi.fn();
const mockWriteCandidateLearnings = vi.fn().mockResolvedValue([]);

vi.mock('../ledger/runs.js', () => ({
  updateRunMetadata: (...args: unknown[]) => mockUpdateRunMetadata(...args),
}));

vi.mock('../campaigns.js', () => ({
  getCampaignById: vi.fn(),
  getActiveCampaign: vi.fn(),
  getCampaignScoreSeries: vi.fn(),
  endCampaign: (...args: unknown[]) => mockEndCampaign(...args),
  listCampaigns: vi.fn(),
}));

vi.mock('../candidateLearnings.js', () => ({
  writeCandidateLearnings: (...args: unknown[]) => mockWriteCandidateLearnings(...args),
}));

vi.mock('../ledger/queries.js', () => ({
  getRunCampaignId: vi.fn(),
}));

vi.mock('../skill.js', () => ({ resolveSkillForWorkflow: vi.fn() }));
vi.mock('@aflow/database', () => ({ resolveWorkflowForStart: vi.fn() }));

import { materializeRunScore } from '../scoreFinalize.js';

const DB = {} as unknown as PostgresJsDatabase;

const CAMPAIGN: Campaign = {
  campaignId: '33333333-3333-3333-3333-333333333333',
  spaceId: '22222222-2222-2222-2222-222222222222',
  workflowSlug: 'open-pr-from-request',
  goalRef: 'open-pr-from-request:objective:abc',
  scoreMetricKey: 'goal_met',
  direction: 'maximize',
  status: 'active',
  startedAt: '2026-06-25T00:00:00.000Z',
};

const OBJECTIVE_GOAL: MaterializedSkillGoal = {
  type: 'objective',
  criteria: [{ id: 'pr-opened', description: 'A PR was opened against the bound repo' }],
};

const NUMERIC_GOAL: MaterializedSkillGoal = {
  type: 'numeric',
  metricKey: 'lbValue',
  direction: 'maximize',
};

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('materializeRunScore — completion-default score (additive fallback)', () => {
  it('a campaign run with NO produced metric + succeeded ⇒ score 1 with completion_default provenance', async () => {
    const result = await materializeRunScore({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-1',
      goal: OBJECTIVE_GOAL,
      campaign: CAMPAIGN,
      outcomes: [],
      runLevelMetrics: {},
      evalResult: null,
      learnings: [],
      runTerminalStatus: 'completed',
    });

    expect(result.score).toBe(1);
    expect(mockUpdateRunMetadata).toHaveBeenCalledTimes(1);
    const [, , patch] = mockUpdateRunMetadata.mock.calls[0] as [
      unknown,
      unknown,
      { runId: string; score: number; scoreProvenance: unknown },
    ];
    expect(patch.runId).toBe('run-1');
    expect(patch.score).toBe(1);
    expect(patch.scoreProvenance).toEqual({
      kind: 'completion_default',
      terminalStatus: 'completed',
    });
    // A process/objective goal has no numeric target bar — never ends on goal_met.
    expect(mockEndCampaign).not.toHaveBeenCalled();
  });

  it('a campaign run with NO produced metric + failed ⇒ score 0 with completion_default provenance', async () => {
    const result = await materializeRunScore({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-2',
      goal: OBJECTIVE_GOAL,
      campaign: CAMPAIGN,
      outcomes: [],
      runLevelMetrics: {},
      evalResult: null,
      learnings: [],
      runTerminalStatus: 'failed',
    });

    expect(result.score).toBe(0);
    const [, , patch] = mockUpdateRunMetadata.mock.calls[0] as [
      unknown,
      unknown,
      { score: number; scoreProvenance: unknown },
    ];
    expect(patch.score).toBe(0);
    expect(patch.scoreProvenance).toEqual({ kind: 'completion_default', terminalStatus: 'failed' });
  });

  it('a produced metric ALWAYS wins — the completion default is not used (additive proof)', async () => {
    const result = await materializeRunScore({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-3',
      goal: NUMERIC_GOAL,
      campaign: { ...CAMPAIGN, scoreMetricKey: 'lbValue' },
      outcomes: [],
      runLevelMetrics: { lbValue: 0.873 },
      evalResult: null,
      learnings: [],
      // Even when the run "succeeded", a real metric overrides the default.
      runTerminalStatus: 'completed',
    });

    expect(result.score).toBe(0.873);
    expect(mockUpdateRunMetadata).toHaveBeenCalledTimes(1);
    const [, , patch] = mockUpdateRunMetadata.mock.calls[0] as [
      unknown,
      unknown,
      { score: number; scoreProvenance: { metricKey?: string; kind?: string } },
    ];
    expect(patch.score).toBe(0.873);
    // Real metric provenance — NOT the completion default.
    expect(patch.scoreProvenance.metricKey).toBe('lbValue');
    expect(patch.scoreProvenance.kind).toBe('metric');
  });

  it('a NUMERIC campaign run with NO produced metric stays null — the default never fabricates a Kaggle score', async () => {
    const result = await materializeRunScore({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-5',
      goal: NUMERIC_GOAL,
      campaign: { ...CAMPAIGN, scoreMetricKey: 'lbValue' },
      outcomes: [],
      runLevelMetrics: {}, // metric not produced (e.g. submission never scored)
      evalResult: null,
      learnings: [],
      runTerminalStatus: 'completed',
    });

    // A numeric goal with no metric is "no score yet", excluded from the series —
    // never a synthetic 1 that would perturb regression or trip goal-met.
    expect(result.score).toBeNull();
    expect(mockUpdateRunMetadata).not.toHaveBeenCalled();
    expect(mockEndCampaign).not.toHaveBeenCalled();
  });

  it('does NOT fire for a non-campaign run even when no score is produced', async () => {
    const result = await materializeRunScore({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-4',
      goal: OBJECTIVE_GOAL,
      campaign: null,
      outcomes: [],
      runLevelMetrics: {},
      evalResult: null,
      learnings: [],
      runTerminalStatus: 'completed',
    });

    expect(result.score).toBeNull();
    expect(mockUpdateRunMetadata).not.toHaveBeenCalled();
  });
});

describe('materializeRunScore — candidate ledger writes', () => {
  const LEARNING: WorkflowLearning = {
    id: 'l-repo-fact',
    category: 'worked',
    kind: 'observation',
    observation: 'the typecheck step needs the schemas package built first',
    evidence: { runId: '00000000-0000-0000-0000-000000000001' },
    confidence: 'medium',
    source: 'agent',
  };

  it('a NON-campaign run with learnings writes skill-keyed candidates', async () => {
    await materializeRunScore({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-6',
      goal: OBJECTIVE_GOAL,
      campaign: null,
      outcomes: [],
      runLevelMetrics: {},
      evalResult: { verdict: 'pass', overall: 0.9 },
      learnings: [LEARNING],
      runTerminalStatus: 'completed',
    });

    expect(mockWriteCandidateLearnings).toHaveBeenCalledTimes(1);
    const [, , params] = mockWriteCandidateLearnings.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params).toMatchObject({
      spaceId: CAMPAIGN.spaceId,
      skillSlug: CAMPAIGN.workflowSlug,
      runId: 'run-6',
      learnings: [LEARNING],
      compactEvalOutcome: { verdict: 'pass', overallScore: 0.9 },
    });
    expect(params).not.toHaveProperty('campaignId');
  });

  it('a campaign run with learnings writes campaign-keyed candidates', async () => {
    await materializeRunScore({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-7',
      goal: OBJECTIVE_GOAL,
      campaign: CAMPAIGN,
      outcomes: [],
      runLevelMetrics: {},
      evalResult: null,
      learnings: [LEARNING],
      runTerminalStatus: 'completed',
    });

    expect(mockWriteCandidateLearnings).toHaveBeenCalledTimes(1);
    const [, , params] = mockWriteCandidateLearnings.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params).toMatchObject({
      spaceId: CAMPAIGN.spaceId,
      skillSlug: CAMPAIGN.workflowSlug,
      campaignId: CAMPAIGN.campaignId,
      runId: 'run-7',
    });
  });

  it('a run with no learnings writes nothing', async () => {
    await materializeRunScore({
      db: DB,
      tenantId: 't-1',
      spaceId: CAMPAIGN.spaceId,
      workflowSlug: CAMPAIGN.workflowSlug,
      runId: 'run-8',
      goal: OBJECTIVE_GOAL,
      campaign: null,
      outcomes: [],
      runLevelMetrics: {},
      evalResult: null,
      learnings: [],
      runTerminalStatus: 'completed',
    });

    expect(mockWriteCandidateLearnings).not.toHaveBeenCalled();
  });
});
