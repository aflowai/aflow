import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type {
  CandidateLearning,
  CoachLearning,
  WorkflowLearning,
  WorkflowLearningKind,
} from '@aflow/schemas';
import {
  selectActiveLearningSet,
  selectActiveLearningSetForRun,
  selectActiveLearningSetForSkill,
  resolveActiveSetBudget,
} from '../activeLearningSet.js';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mocks = vi.hoisted(() => ({
  getCampaignById: vi.fn(),
  getCampaignScoreSeries: vi.fn(),
  getRunLearningScope: vi.fn(),
  listCampaigns: vi.fn(),
  listCandidatesByCampaign: vi.fn(),
  listTerminalRunLearningsForCampaign: vi.fn(),
  listDurableCoachLearnings: vi.fn(),
  countDurableCoachLearnings: vi.fn(),
  loadSpaceDirectives: vi.fn(),
}));

vi.mock('../campaigns.js', () => ({
  getCampaignById: mocks.getCampaignById,
  getCampaignScoreSeries: mocks.getCampaignScoreSeries,
  listCampaigns: mocks.listCampaigns,
}));

vi.mock('../candidateLearnings.js', () => ({
  listCandidatesByCampaign: mocks.listCandidatesByCampaign,
}));

vi.mock('../ledger/queries.js', () => ({
  listTerminalRunLearningsForCampaign: mocks.listTerminalRunLearningsForCampaign,
  getRunLearningScope: mocks.getRunLearningScope,
}));

vi.mock('../modelResolution.js', () => ({
  loadSpaceDirectives: mocks.loadSpaceDirectives,
}));

vi.mock('../coachLearningsStore.js', () => ({
  listDurableCoachLearnings: mocks.listDurableCoachLearnings,
  countDurableCoachLearnings: mocks.countDurableCoachLearnings,
}));

const DB = {} as never;
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const CAMPAIGN = '00000000-0000-0000-0000-0000000000aa';
const SLUG = 'kaggle-competition-optimizer';

function learning(id: string, kind: WorkflowLearningKind, observation: string): WorkflowLearning {
  return {
    id,
    category: 'worked',
    kind,
    observation,
    evidence: { runId: '00000000-0000-0000-0000-000000000001' },
    confidence: 'medium',
    source: 'agent',
  };
}

function candidate(
  runId: string,
  l: WorkflowLearning,
  status: CandidateLearning['status'] = 'pending',
  createdAt = '2026-06-07T00:00:00.000Z',
): CandidateLearning {
  return {
    entryId: '00000000-0000-0000-0000-000000000042',
    spaceId: SPACE,
    skillSlug: SLUG,
    campaignId: CAMPAIGN,
    runId,
    learning: l,
    status,
    createdAt,
  };
}

function durable(learningId: string, statement: string, createdAt: string): CoachLearning {
  return {
    learningId,
    coachSessionId: '00000000-0000-0000-0000-000000000001',
    scope: { kind: 'campaign', campaignId: CAMPAIGN, skillSlug: SLUG },
    kind: 'heuristic',
    statement,
    evidence: { citations: [{ runId: '00000000-0000-0000-0000-000000000111' }] },
    confidence: 'high',
    supersedes: [],
    authorityLevel: 'auto_record',
    status: 'auto_recorded',
    createdAt,
  };
}

function select(params: { campaignId?: string; budget?: number; taskId?: string }) {
  return selectActiveLearningSet({
    db: DB,
    tenantId: TENANT,
    spaceId: SPACE,
    skillSlug: SLUG,
    ...(params.campaignId !== undefined ? { campaignId: params.campaignId } : {}),
    ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
    budget: params.budget ?? 20,
  });
}

function candidateObservations(set: Awaited<ReturnType<typeof select>>): string[] {
  return set.selected.flatMap((e) => (e.kind === 'candidate' ? [e.observation] : []));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCampaignById.mockResolvedValue({
    campaignId: CAMPAIGN,
    spaceId: SPACE,
    workflowSlug: SLUG,
    direction: 'minimize',
    scoreMetricKey: 'rmsle',
  });
  mocks.getCampaignScoreSeries.mockResolvedValue([
    { runId: 'run-a', score: 0.131, startedAt: '2026-06-07T00:00:00.000Z' },
    { runId: 'run-b', score: 0.128, startedAt: '2026-06-07T01:00:00.000Z' },
  ]);
  mocks.getRunLearningScope.mockResolvedValue(null);
  mocks.listCampaigns.mockResolvedValue([]);
  mocks.listCandidatesByCampaign.mockResolvedValue([]);
  mocks.listTerminalRunLearningsForCampaign.mockResolvedValue([]);
  mocks.listDurableCoachLearnings.mockResolvedValue([]);
  mocks.countDurableCoachLearnings.mockResolvedValue(0);
  mocks.loadSpaceDirectives.mockResolvedValue(null);
});

describe('selectActiveLearningSet — composition order', () => {
  it('trajectory first, then durable, then candidates', async () => {
    mocks.listDurableCoachLearnings.mockResolvedValue([
      durable(
        '00000000-0000-0000-0000-00000000d001',
        'log-transform the target',
        '2026-06-07T02:00:00.000Z',
      ),
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate('run-b', learning('l-1', 'search_heuristic', 'shrink the CV-LB gap')),
    ]);

    const set = await select({ campaignId: CAMPAIGN });
    expect(set.selected.map((e) => e.kind)).toEqual(['trajectory', 'durable', 'candidate']);
    const trajectory = set.selected[0];
    expect(trajectory).toMatchObject({
      kind: 'trajectory',
      objective: { metricKey: 'rmsle', direction: 'minimize' },
      peak: 0.128,
      recentScores: [0.131, 0.128],
    });
    expect(set.omittedDueToBudget).toBe(0);
    expect(set.consolidationDue).toBe(false);
  });

  it('no campaign: durable tier only, candidate reads never issued', async () => {
    mocks.listDurableCoachLearnings.mockResolvedValue([
      durable('00000000-0000-0000-0000-00000000d001', 'a skill fact', '2026-06-07T02:00:00.000Z'),
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);

    const set = await select({});
    expect(set.selected.map((e) => e.kind)).toEqual(['durable']);
    expect(mocks.getCampaignById).not.toHaveBeenCalled();
    expect(mocks.listCandidatesByCampaign).not.toHaveBeenCalled();
    expect(mocks.listTerminalRunLearningsForCampaign).not.toHaveBeenCalled();
    expect(mocks.listDurableCoachLearnings.mock.calls[0]?.[2]?.campaignScope).toEqual({
      mode: 'exclude',
    });
  });
});

describe('selectActiveLearningSet — campaign scoping', () => {
  async function expectCampaignTiersDropped(): Promise<void> {
    const set = await select({ campaignId: CAMPAIGN });
    expect(set.selected).toEqual([]);
    expect(mocks.getCampaignScoreSeries).not.toHaveBeenCalled();
    expect(mocks.listCandidatesByCampaign).not.toHaveBeenCalled();
    expect(mocks.listTerminalRunLearningsForCampaign).not.toHaveBeenCalled();
    expect(mocks.listDurableCoachLearnings.mock.calls[0]?.[2]?.campaignScope).toEqual({
      mode: 'exclude',
    });
  }

  it('drops a campaignId belonging to another space', async () => {
    mocks.getCampaignById.mockResolvedValue({
      campaignId: CAMPAIGN,
      spaceId: '00000000-0000-0000-0000-0000000000ff',
      workflowSlug: SLUG,
      direction: 'minimize',
      scoreMetricKey: 'rmsle',
    });
    await expectCampaignTiersDropped();
  });

  it('drops a campaignId belonging to another skill', async () => {
    mocks.getCampaignById.mockResolvedValue({
      campaignId: CAMPAIGN,
      spaceId: SPACE,
      workflowSlug: 'some-other-skill',
      direction: 'minimize',
      scoreMetricKey: 'rmsle',
    });
    await expectCampaignTiersDropped();
  });

  it('drops an unknown campaignId', async () => {
    mocks.getCampaignById.mockResolvedValue(null);
    await expectCampaignTiersDropped();
  });
});

describe('selectActiveLearningSet — budget', () => {
  it('truncates candidates bottom-up, never the trajectory, and reports the omission', async () => {
    mocks.listDurableCoachLearnings.mockResolvedValue([
      durable('00000000-0000-0000-0000-00000000d001', 'durable one', '2026-06-07T02:00:00.000Z'),
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate(
        'run-a',
        learning('l-old', 'observation', 'older hypothesis'),
        'pending',
        '2026-06-07T00:00:00.000Z',
      ),
      candidate(
        'run-b',
        learning('l-new', 'search_heuristic', 'newer hypothesis'),
        'pending',
        '2026-06-07T03:00:00.000Z',
      ),
    ]);

    const set = await select({ campaignId: CAMPAIGN, budget: 2 });
    expect(set.selected.map((e) => e.kind)).toEqual(['trajectory', 'durable', 'candidate']);
    expect(set.selected[2]).toMatchObject({ observation: 'newer hypothesis' });
    expect(set.omittedDueToBudget).toBe(1);
    expect(set.consolidationDue).toBe(false);
  });

  it('consolidationDue when the durable tier alone exceeds the budget', async () => {
    mocks.listDurableCoachLearnings.mockResolvedValue([
      durable('00000000-0000-0000-0000-00000000d001', 'durable one', '2026-06-07T03:00:00.000Z'),
      durable('00000000-0000-0000-0000-00000000d002', 'durable two', '2026-06-07T02:00:00.000Z'),
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(5);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate('run-b', learning('l-1', 'search_heuristic', 'a hypothesis')),
    ]);

    const set = await select({ campaignId: CAMPAIGN, budget: 2 });
    expect(set.consolidationDue).toBe(true);
    expect(set.selected.filter((e) => e.kind === 'durable')).toHaveLength(2);
    expect(set.selected.filter((e) => e.kind === 'candidate')).toHaveLength(0);
    expect(set.omittedDueToBudget).toBe(4);
  });
});

describe('selectActiveLearningSet — fast-inject filter', () => {
  it('injects fast-inject kinds and drops block-until-vetted kinds', async () => {
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate('run-b', learning('l-1', 'search_heuristic', 'shrink the CV-LB gap')),
      candidate('run-b', learning('l-2', 'eval_semantics', 'reinterpret the metric')),
      candidate('run-b', learning('l-3', 'constraint', 'avoid heavy L2')),
      candidate('run-b', learning('l-4', 'doctrine', 'always trust CV')),
      candidate('run-b', learning('l-5', 'observation', 'LB tracks CV loosely')),
      candidate('run-b', learning('l-6', 'next_direction', 'try feature X')),
    ]);

    const set = await select({ campaignId: CAMPAIGN });
    const observations = candidateObservations(set);
    expect(observations).toContain('shrink the CV-LB gap');
    expect(observations).toContain('avoid heavy L2');
    expect(observations).toContain('LB tracks CV loosely');
    expect(observations).toContain('try feature X');
    expect(observations).not.toContain('reinterpret the metric');
    expect(observations).not.toContain('always trust CV');
  });

  it('drops non-pending candidates from injection', async () => {
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate('run-b', learning('l-1', 'search_heuristic', 'rejected one'), 'reviewed-rejected'),
      candidate('run-b', learning('l-2', 'search_heuristic', 'pending one'), 'pending'),
    ]);

    const set = await select({ campaignId: CAMPAIGN });
    expect(candidateObservations(set)).toEqual(['pending one']);
  });
});

describe('selectActiveLearningSet — read-through union (hook race)', () => {
  it('injects a terminal run learning with no candidate row yet, deduped by (runId, learningId)', async () => {
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate(
        'run-a',
        learning('l-1', 'search_heuristic', 'already materialized'),
        'pending',
        '2026-06-07T00:00:00.000Z',
      ),
      candidate(
        'run-a',
        learning('l-2', 'search_heuristic', 'already rejected'),
        'reviewed-rejected',
        '2026-06-07T00:00:00.000Z',
      ),
    ]);
    mocks.listTerminalRunLearningsForCampaign.mockResolvedValue([
      {
        runId: 'run-b',
        completedAt: new Date('2026-06-07T04:00:00.000Z'),
        learningsJson: [
          learning('l-3', 'search_heuristic', 'fresh, hooks not landed'),
          learning('l-4', 'eval_semantics', 'blocked kind stays blocked'),
        ],
      },
      {
        runId: 'run-a',
        completedAt: new Date('2026-06-07T01:00:00.000Z'),
        learningsJson: [
          learning('l-1', 'search_heuristic', 'already materialized'),
          learning('l-2', 'search_heuristic', 'already rejected'),
        ],
      },
    ]);

    const set = await select({ campaignId: CAMPAIGN });
    const observations = candidateObservations(set);
    expect(observations).toEqual(['fresh, hooks not landed', 'already materialized']);
    // The resolved row suppresses read-through re-entry; the pending row is not duplicated.
    expect(observations.filter((o) => o === 'already materialized')).toHaveLength(1);
    expect(observations).not.toContain('already rejected');
    expect(observations).not.toContain('blocked kind stays blocked');
  });
});

describe('selectActiveLearningSet — task targeting', () => {
  // The store applies the taskId predicate in SQL, before limit and count —
  // the mock mirrors that so the fetch window never holds inapplicable rows.
  function durableApplies(l: CoachLearning, taskId: string | undefined): boolean {
    if (taskId === undefined || l.appliesTo === undefined) return true;
    return l.appliesTo.kind === 'skill' || l.appliesTo.taskIds.includes(taskId);
  }

  function mockDurableStore(rows: CoachLearning[]): void {
    mocks.listDurableCoachLearnings.mockImplementation(
      async (_db: never, _tenant: string, filter: { taskId?: string; limit: number }) =>
        rows.filter((l) => durableApplies(l, filter.taskId)).slice(0, filter.limit),
    );
    mocks.countDurableCoachLearnings.mockImplementation(
      async (_db: never, _tenant: string, filter: { taskId?: string }) =>
        rows.filter((l) => durableApplies(l, filter.taskId)).length,
    );
  }

  beforeEach(() => {
    mockDurableStore([
      {
        ...durable(
          '00000000-0000-0000-0000-00000000d001',
          'execute only',
          '2026-06-07T04:00:00.000Z',
        ),
        appliesTo: { kind: 'tasks', taskIds: ['execute'] },
      },
      {
        ...durable(
          '00000000-0000-0000-0000-00000000d002',
          'whole skill',
          '2026-06-07T03:00:00.000Z',
        ),
        appliesTo: { kind: 'skill' },
      },
      durable('00000000-0000-0000-0000-00000000d003', 'untargeted', '2026-06-07T02:00:00.000Z'),
    ]);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate('run-a', {
        ...learning('l-1', 'search_heuristic', 'targeted candidate'),
        appliesToTaskIds: ['execute'],
      }),
      candidate('run-a', learning('l-2', 'search_heuristic', 'untargeted candidate')),
    ]);
    mocks.listTerminalRunLearningsForCampaign.mockResolvedValue([
      {
        runId: 'run-b',
        completedAt: new Date('2026-06-07T05:00:00.000Z'),
        learningsJson: [
          {
            ...learning('l-3', 'next_direction', 'targeted read-through'),
            appliesToTaskIds: ['execute'],
          },
        ],
      },
    ]);
  });

  function statements(set: Awaited<ReturnType<typeof select>>): string[] {
    return set.selected.flatMap((e) =>
      e.kind === 'durable' ? [e.statement] : e.kind === 'candidate' ? [e.observation] : [],
    );
  }

  it('a targeted learning reaches only its task', async () => {
    const set = await select({ campaignId: CAMPAIGN, taskId: 'execute' });
    expect(statements(set)).toEqual([
      'execute only',
      'whole skill',
      'untargeted',
      'targeted read-through',
      'targeted candidate',
      'untargeted candidate',
    ]);
    expect(set.omittedDueToBudget).toBe(0);
    expect(mocks.listDurableCoachLearnings).toHaveBeenCalledWith(
      DB,
      TENANT,
      expect.objectContaining({ taskId: 'execute' }),
    );
  });

  it('another task never sees learnings targeted elsewhere; untargeted reach all', async () => {
    const set = await select({ campaignId: CAMPAIGN, taskId: 'prepare' });
    expect(statements(set)).toEqual(['whole skill', 'untargeted', 'untargeted candidate']);
    expect(set.omittedDueToBudget).toBe(0);
  });

  it('omitted taskId (operator / ledger / Coach reads) filters nothing', async () => {
    const set = await select({ campaignId: CAMPAIGN });
    expect(statements(set)).toEqual([
      'execute only',
      'whole skill',
      'untargeted',
      'targeted read-through',
      'targeted candidate',
      'untargeted candidate',
    ]);
  });

  it('consolidationDue stays a corpus property under targeting', async () => {
    const set = await select({ campaignId: CAMPAIGN, taskId: 'prepare', budget: 2 });
    expect(set.consolidationDue).toBe(true);
  });

  it('over-budget: rows targeted elsewhere never occupy fetch-window or budget slots', async () => {
    const targetedElsewhere = Array.from({ length: 5 }, (_, i) => ({
      ...durable(
        `00000000-0000-0000-0000-00000000e00${String(i)}`,
        `execute tactic ${String(i)}`,
        `2026-06-08T0${String(9 - i)}:00:00.000Z`,
      ),
      appliesTo: { kind: 'tasks' as const, taskIds: ['execute'] },
    }));
    const untargeted = Array.from({ length: 5 }, (_, i) =>
      durable(
        `00000000-0000-0000-0000-00000000f00${String(i)}`,
        `general fact ${String(i)}`,
        `2026-06-08T0${String(4 - i)}:00:00.000Z`,
      ),
    );
    mockDurableStore([...targetedElsewhere, ...untargeted]);
    mocks.listCandidatesByCampaign.mockResolvedValue([]);
    mocks.listTerminalRunLearningsForCampaign.mockResolvedValue([]);

    const set = await select({ campaignId: CAMPAIGN, taskId: 'prepare', budget: 3 });
    expect(statements(set)).toEqual(['general fact 0', 'general fact 1', 'general fact 2']);
    expect(set.omittedDueToBudget).toBe(2);
    expect(set.consolidationDue).toBe(true);
    expect(mocks.listDurableCoachLearnings).toHaveBeenCalledWith(
      DB,
      TENANT,
      expect.objectContaining({ taskId: 'prepare', limit: 3 }),
    );
  });
});

describe('selectActiveLearningSet — detailRef carry-through', () => {
  it('carries detailRef from durable, candidate, and read-through learnings', async () => {
    mocks.listDurableCoachLearnings.mockResolvedValue([
      {
        ...durable(
          '00000000-0000-0000-0000-00000000d001',
          'log-transform the target',
          '2026-06-07T02:00:00.000Z',
        ),
        detailRef: '/coach/learnings/log-transform.md',
      },
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate('run-a', {
        ...learning('l-1', 'search_heuristic', 'shrink the CV-LB gap'),
        detailRef: '/coach/learnings/cv-lb-gap.md',
      }),
    ]);
    mocks.listTerminalRunLearningsForCampaign.mockResolvedValue([
      {
        runId: 'run-b',
        completedAt: new Date('2026-06-07T04:00:00.000Z'),
        learningsJson: [
          {
            ...learning('l-2', 'next_direction', 'try target encoding'),
            detailRef: '/coach/learnings/target-encoding.md',
          },
        ],
      },
    ]);

    const set = await select({ campaignId: CAMPAIGN });
    expect(set.selected.find((e) => e.kind === 'durable')).toMatchObject({
      detailRef: '/coach/learnings/log-transform.md',
    });
    const candidateRefs = set.selected.flatMap((e) =>
      e.kind === 'candidate' ? [e.detailRef] : [],
    );
    expect(candidateRefs).toEqual(
      expect.arrayContaining([
        '/coach/learnings/target-encoding.md',
        '/coach/learnings/cv-lb-gap.md',
      ]),
    );
  });
});

describe('selectActiveLearningSetForRun — run-scoped entry point', () => {
  const RUN_ID = '00000000-0000-0000-0000-00000000ab01';

  it('resolves the campaign from the run, the budget from the space directives, and threads taskId', async () => {
    mocks.getRunLearningScope.mockResolvedValue({ campaignId: CAMPAIGN, evalBatchId: null });
    mocks.loadSpaceDirectives.mockResolvedValue({ learningPolicy: { activeSetBudget: 2 } });
    mocks.listDurableCoachLearnings.mockResolvedValue([
      durable('00000000-0000-0000-0000-00000000d001', 'durable one', '2026-06-07T02:00:00.000Z'),
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate(
        'run-a',
        learning('l-old', 'observation', 'older hypothesis'),
        'pending',
        '2026-06-07T00:00:00.000Z',
      ),
      candidate(
        'run-b',
        learning('l-new', 'search_heuristic', 'newer hypothesis'),
        'pending',
        '2026-06-07T03:00:00.000Z',
      ),
    ]);

    const set = await selectActiveLearningSetForRun({
      db: DB,
      tenantId: TENANT,
      spaceId: SPACE,
      skillSlug: SLUG,
      runId: RUN_ID,
      taskId: 'implement',
    });

    expect(mocks.getRunLearningScope).toHaveBeenCalledWith(DB, TENANT, RUN_ID);
    expect(mocks.loadSpaceDirectives).toHaveBeenCalledWith(DB, TENANT, SPACE);
    expect(mocks.getCampaignById).toHaveBeenCalledWith(DB, TENANT, CAMPAIGN);
    expect(mocks.listDurableCoachLearnings).toHaveBeenCalledWith(
      DB,
      TENANT,
      expect.objectContaining({ taskId: 'implement' }),
    );
    expect(set.selected.map((e) => e.kind)).toEqual(['trajectory', 'durable', 'candidate']);
    expect(set.selected[2]).toMatchObject({ observation: 'newer hypothesis' });
    expect(set.omittedDueToBudget).toBe(1);
  });

  it('no runId: never looks up a campaign, reads durable-only with the default budget', async () => {
    mocks.loadSpaceDirectives.mockResolvedValue(null);
    mocks.listDurableCoachLearnings.mockResolvedValue([
      durable('00000000-0000-0000-0000-00000000d001', 'a skill fact', '2026-06-07T02:00:00.000Z'),
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);

    const set = await selectActiveLearningSetForRun({
      db: DB,
      tenantId: TENANT,
      spaceId: SPACE,
      skillSlug: SLUG,
    });

    expect(mocks.getRunLearningScope).not.toHaveBeenCalled();
    expect(mocks.getCampaignById).not.toHaveBeenCalled();
    expect(set.selected.map((e) => e.kind)).toEqual(['durable']);
    expect(mocks.listDurableCoachLearnings).toHaveBeenCalledWith(
      DB,
      TENANT,
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('run without a campaign: campaign tiers dropped, durable read stays campaign-excluded', async () => {
    mocks.getRunLearningScope.mockResolvedValue(null);
    mocks.loadSpaceDirectives.mockResolvedValue(null);

    const set = await selectActiveLearningSetForRun({
      db: DB,
      tenantId: TENANT,
      spaceId: SPACE,
      skillSlug: SLUG,
      runId: RUN_ID,
    });

    expect(mocks.getCampaignById).not.toHaveBeenCalled();
    expect(mocks.listCandidatesByCampaign).not.toHaveBeenCalled();
    expect(set.selected).toEqual([]);
    expect(mocks.listDurableCoachLearnings.mock.calls[0]?.[2]?.campaignScope).toEqual({
      mode: 'exclude',
    });
  });
});

describe('selectActiveLearningSetForSkill — skill-scoped entry point', () => {
  function selectForSkill(campaignId?: string) {
    return selectActiveLearningSetForSkill({
      db: DB,
      tenantId: TENANT,
      spaceId: SPACE,
      skillSlug: SLUG,
      ...(campaignId !== undefined ? { campaignId } : {}),
    });
  }

  it('resolves the active campaign: trajectory, campaign durable, and pending candidate all surface', async () => {
    mocks.listCampaigns.mockResolvedValue([
      { campaignId: CAMPAIGN, spaceId: SPACE, workflowSlug: SLUG, status: 'active' },
    ]);
    mocks.listDurableCoachLearnings.mockResolvedValue([
      durable(
        '00000000-0000-0000-0000-00000000d001',
        'log-transform the target',
        '2026-06-07T02:00:00.000Z',
      ),
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);
    mocks.listCandidatesByCampaign.mockResolvedValue([
      candidate('run-b', learning('l-1', 'search_heuristic', 'shrink the CV-LB gap')),
    ]);

    const set = await selectForSkill();

    expect(mocks.listCampaigns).toHaveBeenCalledWith(DB, TENANT, {
      spaceId: SPACE,
      workflowSlug: SLUG,
      status: 'active',
      limit: 1,
    });
    expect(set.selected.map((e) => e.kind)).toEqual(['trajectory', 'durable', 'candidate']);
    expect(set.selected[1]).toMatchObject({ statement: 'log-transform the target' });
    expect(set.selected[2]).toMatchObject({ observation: 'shrink the CV-LB gap' });
    expect(mocks.listDurableCoachLearnings.mock.calls[0]?.[2]?.campaignScope).toEqual({
      mode: 'campaign',
      campaignId: CAMPAIGN,
    });
  });

  it('no active campaign (e.g. ended): skill+space scope only, campaign tiers dropped', async () => {
    mocks.listCampaigns.mockResolvedValue([]);
    mocks.listDurableCoachLearnings.mockResolvedValue([
      durable('00000000-0000-0000-0000-00000000d001', 'a skill fact', '2026-06-07T02:00:00.000Z'),
    ]);
    mocks.countDurableCoachLearnings.mockResolvedValue(1);

    const set = await selectForSkill();

    expect(set.selected.map((e) => e.kind)).toEqual(['durable']);
    expect(mocks.getCampaignById).not.toHaveBeenCalled();
    expect(mocks.listCandidatesByCampaign).not.toHaveBeenCalled();
    expect(mocks.listDurableCoachLearnings.mock.calls[0]?.[2]?.campaignScope).toEqual({
      mode: 'exclude',
    });
  });

  it('an explicit campaignId wins and skips the active-campaign lookup', async () => {
    const set = await selectForSkill(CAMPAIGN);

    expect(mocks.listCampaigns).not.toHaveBeenCalled();
    expect(mocks.getCampaignById).toHaveBeenCalledWith(DB, TENANT, CAMPAIGN);
    expect(set.selected.map((e) => e.kind)).toEqual(['trajectory']);
  });

  it('resolves the budget from the space learning policy', async () => {
    mocks.loadSpaceDirectives.mockResolvedValue({ learningPolicy: { activeSetBudget: 3 } });

    await selectForSkill();

    expect(mocks.loadSpaceDirectives).toHaveBeenCalledWith(DB, TENANT, SPACE);
    expect(mocks.listDurableCoachLearnings).toHaveBeenCalledWith(
      DB,
      TENANT,
      expect.objectContaining({ limit: 3 }),
    );
  });
});

describe('resolveActiveSetBudget', () => {
  it('falls back to the schema default when directives are absent or malformed', () => {
    expect(resolveActiveSetBudget(null)).toBe(20);
    expect(
      resolveActiveSetBudget({
        learningPolicy: { activeSetBudget: 'not-a-number' },
      } as never),
    ).toBe(20);
  });

  it('honors the operator knob', () => {
    expect(resolveActiveSetBudget({ learningPolicy: { activeSetBudget: 7 } } as never)).toBe(7);
  });
});

describe('selectActiveLearningSet — ratification gate', () => {
  it('the Runner-facing durable reads never opt into proposed rows', async () => {
    await select({ campaignId: CAMPAIGN });
    await select({});

    const durableReads = [
      ...mocks.listDurableCoachLearnings.mock.calls,
      ...mocks.countDurableCoachLearnings.mock.calls,
    ];
    expect(durableReads.length).toBeGreaterThan(0);
    for (const call of durableReads) {
      expect(call[2]).not.toHaveProperty('includeProposed');
    }
  });
});
