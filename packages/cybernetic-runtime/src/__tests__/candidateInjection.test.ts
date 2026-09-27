import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { CandidateLearning, WorkflowLearning, WorkflowLearningKind } from '@aflow/schemas';
import { TaskContextSpecSchema } from '@aflow/schemas';
import { formatCandidateLedgerForPrompt } from '../candidateEvidence.js';
import { buildRunnerDelegationContext } from '../delegationContextBuilder.js';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mocks = vi.hoisted(() => ({
  getRunLearningScope: vi.fn(),
  getCampaignById: vi.fn(),
  getCampaignScoreSeries: vi.fn(),
  listCandidatesByCampaign: vi.fn(),
  listTerminalRunLearningsForCampaign: vi.fn(),
  listDurableCoachLearnings: vi.fn(),
  countDurableCoachLearnings: vi.fn(),
  loadSpaceDirectives: vi.fn(),
}));

vi.mock('../ledger/queries.js', () => ({
  getRunLearningScope: mocks.getRunLearningScope,
  listTerminalRunLearningsForCampaign: mocks.listTerminalRunLearningsForCampaign,
}));

vi.mock('../campaigns.js', () => ({
  getCampaignById: mocks.getCampaignById,
  getCampaignScoreSeries: mocks.getCampaignScoreSeries,
}));

vi.mock('../candidateLearnings.js', () => ({
  listCandidatesByCampaign: mocks.listCandidatesByCampaign,
}));

vi.mock('../coachLearningsStore.js', () => ({
  listDurableCoachLearnings: mocks.listDurableCoachLearnings,
  countDurableCoachLearnings: mocks.countDurableCoachLearnings,
}));

vi.mock('../modelResolution.js', () => ({
  loadSpaceDirectives: mocks.loadSpaceDirectives,
}));

function learning(kind: WorkflowLearningKind, observation: string): WorkflowLearning {
  return {
    id: `l-${kind}`,
    category: 'worked',
    kind,
    observation,
    evidence: { runId: '00000000-0000-0000-0000-000000000001' },
    confidence: 'medium',
    source: 'agent',
  };
}

function candidate(
  kind: WorkflowLearningKind,
  observation: string,
  status: CandidateLearning['status'] = 'pending',
): CandidateLearning {
  return {
    entryId: `00000000-0000-0000-0000-0000000000${kind.length.toString().padStart(2, '0')}`,
    spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
    skillSlug: 'kaggle-competition-optimizer',
    campaignId: '00000000-0000-0000-0000-0000000000aa',
    runId: 'run-1',
    learning: learning(kind, observation),
    status,
    createdAt: '2026-06-07T00:00:00.000Z',
  };
}

describe('formatCandidateLedgerForPrompt (§3.7)', () => {
  it('surfaces pending entries with their gate, rejected as negative evidence, and the trajectory', () => {
    const block = formatCandidateLedgerForPrompt(
      [
        candidate('search_heuristic', 'shrink the CV-LB gap', 'pending'),
        candidate('eval_semantics', 'reinterpret the metric', 'pending'),
        candidate('constraint', 'avoid heavy L2', 'reviewed-rejected'),
      ],
      {
        trajectory: {
          direction: 'maximize',
          metricKey: 'lbValue',
          series: [0.785, 0.78708, 0.78468],
        },
      },
    );
    expect(block).toContain('PENDING');
    expect(block).toContain('fast-inject');
    expect(block).toContain('block-until-vetted');
    expect(block).toContain('shrink the CV-LB gap');
    expect(block).toContain('ALREADY REJECTED');
    expect(block).toContain('avoid heavy L2');
    expect(block).toContain('peak=0.78708');
    expect(block).toContain('resolve_candidate');
  });

  it('returns empty string when there is nothing to surface', () => {
    expect(formatCandidateLedgerForPrompt([])).toBe('');
  });

  it('frames a process (non-campaign) ledger and teaches the skill-scope promote', () => {
    const processCandidate = candidate('observation', 'the repo pins node 22');
    delete processCandidate.campaignId;
    const block = formatCandidateLedgerForPrompt([processCandidate]);
    expect(block).toContain("Candidate learnings from this skill's runs");
    expect(block).not.toContain('Campaign candidate learnings');
    expect(block).toContain('skill scope');
    expect(block).toContain('the repo pins node 22');
  });

  it('an ended campaign steers promotions to skill scope, never fresh campaign scope', () => {
    const block = formatCandidateLedgerForPrompt(
      [candidate('search_heuristic', 'shrink the CV-LB gap', 'pending')],
      { campaignEnded: true },
    );
    expect(block).toContain('this campaign is over');
    expect(block).toContain('recording a CoachLearning at skill scope');
    expect(block).toContain('resolve_candidate');
    expect(block).not.toContain('campaign scope (include `campaignId`)');
  });
});

describe('assembleContext → buildRunnerDelegationContext (campaign injection reaches taskLearnings)', () => {
  const CAMPAIGN = '00000000-0000-0000-0000-0000000000aa';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSpaceDirectives.mockResolvedValue(null);
    mocks.listTerminalRunLearningsForCampaign.mockResolvedValue([]);
    mocks.listDurableCoachLearnings.mockResolvedValue([]);
    mocks.countDurableCoachLearnings.mockResolvedValue(0);
  });

  it('formats the trajectory line and a seeded pending fast-inject candidate into taskLearnings', async () => {
    mocks.getRunLearningScope.mockResolvedValue({ campaignId: CAMPAIGN, evalBatchId: null });
    mocks.getCampaignById.mockResolvedValue({
      campaignId: CAMPAIGN,
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      direction: 'minimize',
      scoreMetricKey: 'rmsle',
    });
    mocks.getCampaignScoreSeries.mockResolvedValue([
      { runId: 'run-a', score: 0.131, startedAt: '2026-06-07T00:00:00.000Z' },
      { runId: 'run-b', score: 0.128, startedAt: '2026-06-07T01:00:00.000Z' },
    ]);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate('search_heuristic', 'shrink the CV-LB gap'),
    ]);

    const wdc = await buildRunnerDelegationContext({
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      task: { taskId: 'execute', name: 'Execute', goal: 'improve the score' },
      contextSpec: TaskContextSpecSchema.parse({ learnings: 'active' }),
      runId: 'run-c',
      db: {} as never,
    });

    expect(wdc.taskLearnings).toContain('[trajectory] objective: minimize rmsle');
    expect(wdc.taskLearnings).toContain('peak so far: 0.128');
    expect(wdc.taskLearnings).toContain('shrink the CV-LB gap');
  });

  it('run N records into learnings_json only (hooks not landed): run N+1 still injects it', async () => {
    mocks.getRunLearningScope.mockResolvedValue({ campaignId: CAMPAIGN, evalBatchId: null });
    mocks.getCampaignById.mockResolvedValue({
      campaignId: CAMPAIGN,
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      direction: 'minimize',
      scoreMetricKey: 'rmsle',
    });
    mocks.getCampaignScoreSeries.mockResolvedValue([]);
    mocks.listCandidatesByCampaign.mockResolvedValue([]);
    mocks.listTerminalRunLearningsForCampaign.mockResolvedValue([
      {
        runId: 'run-b',
        completedAt: new Date('2026-06-07T04:00:00.000Z'),
        learningsJson: [learning('next_direction', 'try target encoding next')],
      },
    ]);

    const wdc = await buildRunnerDelegationContext({
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      task: { taskId: 'execute', name: 'Execute', goal: 'improve the score' },
      contextSpec: TaskContextSpecSchema.parse({ learnings: 'active' }),
      runId: 'run-c',
      db: {} as never,
    });

    expect(wdc.taskLearnings).toContain('try target encoding next');
  });

  it('promoted durable learning keeps injecting (tier change, not disappearance)', async () => {
    mocks.getRunLearningScope.mockResolvedValue({ campaignId: CAMPAIGN, evalBatchId: null });
    mocks.getCampaignById.mockResolvedValue({
      campaignId: CAMPAIGN,
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      direction: 'minimize',
      scoreMetricKey: 'rmsle',
    });
    mocks.getCampaignScoreSeries.mockResolvedValue([]);
    mocks.listCandidatesByCampaign.mockResolvedValue([]);
    mocks.listDurableCoachLearnings.mockResolvedValue([
      {
        learningId: '00000000-0000-0000-0000-00000000d001',
        coachSessionId: '00000000-0000-0000-0000-000000000001',
        scope: {
          kind: 'campaign',
          campaignId: CAMPAIGN,
          skillSlug: 'kaggle-competition-optimizer',
        },
        kind: 'heuristic',
        statement: 'log-transform the target improved rmsle',
        evidence: { citations: [{ runId: '00000000-0000-0000-0000-000000000111' }] },
        confidence: 'high',
        supersedes: [],
        authorityLevel: 'auto_record',
        status: 'auto_recorded',
        createdAt: '2026-06-07T02:00:00.000Z',
      },
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);

    const wdc = await buildRunnerDelegationContext({
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      task: { taskId: 'execute', name: 'Execute', goal: 'improve the score' },
      contextSpec: TaskContextSpecSchema.parse({ learnings: 'active' }),
      runId: 'run-c',
      db: {} as never,
    });

    expect(wdc.taskLearnings).toContain('[heuristic] log-transform the target improved rmsle');
  });

  it('appends the detail ref to rendered candidate and durable lines when present', async () => {
    mocks.getRunLearningScope.mockResolvedValue({ campaignId: CAMPAIGN, evalBatchId: null });
    mocks.getCampaignById.mockResolvedValue({
      campaignId: CAMPAIGN,
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      direction: 'minimize',
      scoreMetricKey: 'rmsle',
    });
    mocks.getCampaignScoreSeries.mockResolvedValue([]);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      {
        ...candidate('search_heuristic', 'shrink the CV-LB gap'),
        learning: {
          ...learning('search_heuristic', 'shrink the CV-LB gap'),
          recommendation: 'compare CV to LB each run',
          detailRef: '/coach/learnings/cv-lb-gap.md',
        },
      },
    ]);
    mocks.listDurableCoachLearnings.mockResolvedValue([
      {
        learningId: '00000000-0000-0000-0000-00000000d001',
        coachSessionId: '00000000-0000-0000-0000-000000000001',
        scope: {
          kind: 'campaign',
          campaignId: CAMPAIGN,
          skillSlug: 'kaggle-competition-optimizer',
        },
        kind: 'heuristic',
        statement: 'log-transform the target improved rmsle',
        detailRef: '/coach/learnings/log-transform.md',
        evidence: { citations: [{ runId: '00000000-0000-0000-0000-000000000111' }] },
        confidence: 'high',
        supersedes: [],
        authorityLevel: 'auto_record',
        status: 'auto_recorded',
        createdAt: '2026-06-07T02:00:00.000Z',
      },
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);

    const wdc = await buildRunnerDelegationContext({
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      task: { taskId: 'execute', name: 'Execute', goal: 'improve the score' },
      contextSpec: TaskContextSpecSchema.parse({ learnings: 'active' }),
      runId: 'run-c',
      db: {} as never,
    });

    expect(wdc.taskLearnings).toContain(
      'shrink the CV-LB gap → compare CV to LB each run (detail: /coach/learnings/cv-lb-gap.md)',
    );
    expect(wdc.taskLearnings).toContain(
      'log-transform the target improved rmsle (detail: /coach/learnings/log-transform.md)',
    );
  });

  it('no campaign for the run: durable-only, never placeholder prose', async () => {
    mocks.getRunLearningScope.mockResolvedValue(null);

    const wdc = await buildRunnerDelegationContext({
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      workflowSlug: 'kaggle-competition-optimizer',
      task: { taskId: 'execute', name: 'Execute', goal: 'improve the score' },
      contextSpec: TaskContextSpecSchema.parse({ learnings: 'active' }),
      runId: 'run-c',
      db: {} as never,
    });

    expect(wdc.taskLearnings).toBe('');
    expect(wdc.taskContext).toBe('');
  });
});
