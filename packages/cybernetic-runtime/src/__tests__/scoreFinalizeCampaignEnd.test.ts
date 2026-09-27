/**
 * materializeRunScore threads a `campaignEnded` signal to its caller exactly
 * when THIS finalize won the goal-met end (endCampaign CAS success) — the
 * caller (postRunHooks) dispatches the campaign-end synthesis review on it.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Campaign, MaterializedSkillGoal, Outcome } from '@aflow/schemas';
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
  workflowSlug: 'kaggle-competition-optimizer',
  goalRef: 'kaggle-competition-optimizer:numeric:lbValue',
  scoreMetricKey: 'lbValue',
  direction: 'maximize',
  status: 'active',
  startedAt: '2026-06-25T00:00:00.000Z',
};

const NUMERIC_GOAL: MaterializedSkillGoal = {
  type: 'numeric',
  metricKey: 'lbValue',
  direction: 'maximize',
};

const TARGET_BAR_OUTCOME: Outcome = {
  id: 'beat-target',
  name: 'Beat the target',
  evaluator: { type: 'threshold', metric: 'lbValue', operator: 'gte', target: 0.85 },
};

function goalMetParams() {
  return {
    db: DB,
    tenantId: 't-1',
    spaceId: CAMPAIGN.spaceId,
    workflowSlug: CAMPAIGN.workflowSlug,
    runId: 'run-1',
    goal: NUMERIC_GOAL,
    campaign: CAMPAIGN,
    outcomes: [TARGET_BAR_OUTCOME],
    runLevelMetrics: { lbValue: 0.9 },
    evalResult: null,
    learnings: [],
    runTerminalStatus: 'completed' as const,
  };
}

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('materializeRunScore — campaignEnded signal', () => {
  it('score meets the target bar and the end CAS wins ⇒ campaignEnded carries the campaign + goal_met', async () => {
    mockEndCampaign.mockResolvedValue({ ...CAMPAIGN, status: 'ended', endedReason: 'goal_met' });

    const result = await materializeRunScore(goalMetParams());

    expect(mockEndCampaign).toHaveBeenCalledWith(DB, 't-1', CAMPAIGN.campaignId, 'goal_met');
    expect(result.campaignEnded).toEqual({
      campaignId: CAMPAIGN.campaignId,
      reason: 'goal_met',
    });
  });

  it('the end CAS misses (already ended concurrently) ⇒ no campaignEnded signal', async () => {
    mockEndCampaign.mockResolvedValue(null);

    const result = await materializeRunScore(goalMetParams());

    expect(mockEndCampaign).toHaveBeenCalledTimes(1);
    expect(result.campaignEnded).toBeUndefined();
  });

  it('score below the bar ⇒ campaign keeps running, no signal', async () => {
    const result = await materializeRunScore({
      ...goalMetParams(),
      runLevelMetrics: { lbValue: 0.5 },
    });

    expect(mockEndCampaign).not.toHaveBeenCalled();
    expect(result.campaignEnded).toBeUndefined();
  });

  it('endCampaign throwing is swallowed (score write survives), no signal', async () => {
    mockEndCampaign.mockRejectedValue(new Error('db down'));

    const result = await materializeRunScore(goalMetParams());

    expect(result.score).toBe(0.9);
    expect(result.campaignEnded).toBeUndefined();
  });
});
