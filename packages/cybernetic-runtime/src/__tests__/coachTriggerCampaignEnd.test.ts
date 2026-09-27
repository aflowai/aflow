import { describe, it, expect } from 'vitest';
import type { Campaign, CandidateLearning, CoachLearning } from '@aflow/schemas';
import {
  buildCampaignEndReviewPromptParts,
  formatCampaignSynthesisForPrompt,
} from '../coachTriggerCampaignEnd.js';

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const SPACE_ID = '33333333-3333-3333-3333-333333333333';
const RUN_ID = '44444444-4444-4444-4444-444444444444';

const CAMPAIGN: Campaign = {
  campaignId: CAMPAIGN_ID,
  spaceId: SPACE_ID,
  workflowSlug: 'kaggle-competition-optimizer',
  goalRef: 'kaggle-competition-optimizer:numeric:rmsle',
  scoreMetricKey: 'rmsle',
  direction: 'minimize',
  config: { competition: 'titanic' },
  status: 'ended',
  startedAt: '2026-06-01T00:00:00.000Z',
  endedAt: '2026-07-06T00:00:00.000Z',
  endedReason: 'goal_met',
};

function durable(
  learningId: string,
  scope: CoachLearning['scope'],
  statement: string,
): CoachLearning {
  return {
    learningId,
    coachSessionId: '55555555-5555-5555-5555-555555555555',
    scope,
    kind: 'heuristic',
    statement,
    evidence: { citations: [{ runId: RUN_ID }] },
    confidence: 'high',
    supersedes: [],
    authorityLevel: 'auto_record',
    status: 'auto_recorded',
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

const CAMPAIGN_SURVIVORS: CoachLearning[] = [
  durable(
    'aaaaaaaa-0000-0000-0000-000000000001',
    { kind: 'campaign', campaignId: CAMPAIGN_ID, skillSlug: CAMPAIGN.workflowSlug },
    'log-transform the target before training',
  ),
];

const SKILL_AND_SPACE_SET: CoachLearning[] = [
  durable(
    'aaaaaaaa-0000-0000-0000-000000000003',
    { kind: 'skill', skillSlug: CAMPAIGN.workflowSlug },
    'always validate the submission format locally first',
  ),
  durable(
    'aaaaaaaa-0000-0000-0000-000000000004',
    { kind: 'space', spaceId: SPACE_ID },
    'the sandbox has no network access',
  ),
];

const PENDING_CANDIDATE: CandidateLearning = {
  entryId: 'bbbbbbbb-0000-0000-0000-000000000001',
  spaceId: SPACE_ID,
  skillSlug: CAMPAIGN.workflowSlug,
  campaignId: CAMPAIGN_ID,
  runId: RUN_ID,
  learning: {
    id: 'l-cv-gap',
    category: 'hypothesis',
    kind: 'observation',
    observation: 'shrinking the CV-LB gap may cost LB score',
    evidence: { runId: RUN_ID },
    confidence: 'low',
    source: 'agent',
  },
  status: 'pending',
  createdAt: '2026-07-05T00:00:00.000Z',
};

describe('formatCampaignSynthesisForPrompt', () => {
  const packet = formatCampaignSynthesisForPrompt({
    evidence: {
      campaign: CAMPAIGN,
      series: [0.42, 0.39, 0.128, 0.131],
      candidates: [PENDING_CANDIDATE],
      campaignSurvivors: CAMPAIGN_SURVIVORS,
      skillAndSpaceSet: SKILL_AND_SPACE_SET,
    },
    setState: { activeSetSize: 14, budget: 12, consolidationDue: true },
  });

  it('carries campaign identity, config, and the ended reason', () => {
    expect(packet).toContain('## Campaign synthesis packet');
    expect(packet).toContain(`Campaign ${CAMPAIGN_ID} of skill "${CAMPAIGN.workflowSlug}"`);
    expect(packet).toContain('ended (goal_met)');
    expect(packet).toContain('- objective: minimize rmsle');
    expect(packet).toContain('"competition":"titanic"');
  });

  it('carries the outcome: scored runs, series, final and best-by-direction peak', () => {
    expect(packet).toContain('- scored runs: 4');
    expect(packet).toContain('[0.42, 0.39, 0.128, 0.131]');
    expect(packet).toContain('- final: 0.131 · peak (best-by-direction): 0.128');
  });

  it("renders this campaign's survivors and the skill/space set in their own sections", () => {
    const [, survivorsOn] = packet.split('### Campaign-scope learnings');
    const [survivors, rest] = String(survivorsOn).split('### Candidate ledger');
    expect(survivors).toContain('log-transform the target before training');
    expect(survivors).not.toContain('always validate the submission format');

    const skillSpace = String(rest).split('### Current skill-scope + space-scope set')[1];
    expect(skillSpace).toContain('always validate the submission format locally first');
    expect(skillSpace).toContain('the sandbox has no network access');
    expect(skillSpace).not.toContain('log-transform the target');
  });

  it('carries the pending candidates with the ended-campaign resolve instruction', () => {
    expect(packet).toContain('shrinking the CV-LB gap may cost LB score');
    expect(packet).toContain('PENDING (decide: promote, reject, or noise)');
    expect(packet).toContain('recording a CoachLearning at skill scope');
    // The mid-campaign instruction would steer promotions to the just-ended
    // campaign's scope, where they retire on arrival.
    expect(packet).not.toContain('campaign scope (include `campaignId`)');
  });

  it('carries the set state so consolidation pressure survives the packet swap', () => {
    expect(packet).toContain('Active injected set: 14 of budget 12');
    expect(packet).toContain('consolidation due (learner.learning.consolidate)');
  });

  it('renders explicit placeholders when a section is empty', () => {
    const empty = formatCampaignSynthesisForPrompt({
      evidence: {
        campaign: { ...CAMPAIGN, config: {} },
        series: [],
        candidates: [],
        campaignSurvivors: [],
        skillAndSpaceSet: [],
      },
    });
    expect(empty).toContain('- no scored runs');
    expect(empty).toContain('(none)');
    expect(empty).toContain('(no unresolved candidates)');
    expect(empty).toContain('(none yet)');
  });
});

describe('buildCampaignEndReviewPromptParts', () => {
  it('frames the review as a campaign synthesis, not a run diagnosis', () => {
    const parts = buildCampaignEndReviewPromptParts({
      workflowSlug: CAMPAIGN.workflowSlug,
      campaignId: CAMPAIGN_ID,
      reason: 'campaign ended (goal_met)',
    });
    const text = parts.join('\n');
    expect(text).toContain(CAMPAIGN_ID);
    expect(text).toContain('campaign ended (goal_met)');
    expect(text).toContain('decide what survives the campaign');
    expect(text).toContain('not a run diagnosis');
  });
});
