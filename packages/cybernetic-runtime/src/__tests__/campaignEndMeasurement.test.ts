/**
 * Campaign-end measurement block: the synthesis packet folds the skill's
 * latest completed batch, the pinned baseline, and the paired delta between
 * them (real D12 compare mechanics over mocked store rows) — and the block
 * is ABSENT when no completed batch exists, never rendered empty-with-zeros.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Campaign } from '@aflow/schemas';
import {
  formatCampaignMeasurementLines,
  formatCampaignSynthesisForPrompt,
  loadCampaignMeasurementEvidence,
  type CampaignSynthesisEvidence,
} from '../coachTriggerCampaignEnd.js';
import {
  getEvalBaseline,
  getEvalBatchHead,
  getGoldenCaseRevisionsByIds,
  listEvalBatchMemberRevisionIds,
  listEvalBatches,
  listTrialRows,
} from '../evalBatchStore.js';

vi.mock('../evalBatchStore.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listEvalBatches: vi.fn(),
    getEvalBaseline: vi.fn(),
    getEvalBatchHead: vi.fn(),
    listEvalBatchMemberRevisionIds: vi.fn(),
    listTrialRows: vi.fn(),
    getGoldenCaseRevisionsByIds: vi.fn(),
  };
});

const listBatchesMock = vi.mocked(listEvalBatches);
const baselineMock = vi.mocked(getEvalBaseline);
const headMock = vi.mocked(getEvalBatchHead);
const membersMock = vi.mocked(listEvalBatchMemberRevisionIds);
const trialRowsMock = vi.mocked(listTrialRows);
const revisionsMock = vi.mocked(getGoldenCaseRevisionsByIds);

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = uuid(1);
const SLUG = 'summarize-weekly';
const LATEST_BATCH = uuid(10);
const BASELINE_BATCH = uuid(11);
const REV = uuid(20);
const CASE_ID = uuid(21);

const db = {} as never;

function summaryJson(passRate: number): unknown {
  return {
    cases: 2,
    trialsPerCase: 2,
    dispositions: { graded: 4 },
    verdicts: { pass: 3, fail: 1 },
    passRate,
    passAllTrialsRate: 0.5,
    passAnyTrialRate: 1,
    costSpentCents: 120,
  };
}

function batchRow(overrides: Record<string, unknown>): never {
  return {
    id: LATEST_BATCH,
    spaceId: SPACE,
    workflowSlug: SLUG,
    workflowRevision: 7,
    datasetId: uuid(30),
    datasetVersion: 3,
    status: 'completed',
    trialsPerCase: 2,
    costCeilingCents: 500,
    costSpentCents: 120,
    notes: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    startedAt: new Date('2026-08-01T00:01:00Z'),
    completedAt: new Date('2026-08-01T00:30:00Z'),
    summaryJson: summaryJson(0.75),
    ...overrides,
  } as never;
}

function trialRow(trial: number, verdict: 'pass' | 'fail', runPrefix: string): never {
  return {
    caseRevisionId: REV,
    trial,
    disposition: 'graded',
    verdict,
    outcomeClass: verdict === 'pass' ? 'behavior_pass' : 'behavior_fail',
    runId: `${runPrefix}-${String(trial)}`,
  } as never;
}

beforeEach(() => {
  listBatchesMock.mockReset();
  baselineMock.mockReset();
  headMock.mockReset();
  membersMock.mockReset();
  trialRowsMock.mockReset();
  revisionsMock.mockReset();
});

describe('loadCampaignMeasurementEvidence', () => {
  it('no completed batch → undefined (the block is absent, not zeros)', async () => {
    listBatchesMock.mockResolvedValue([]);
    expect(
      await loadCampaignMeasurementEvidence(db, TENANT, { spaceId: SPACE, workflowSlug: SLUG }),
    ).toBeUndefined();

    listBatchesMock.mockResolvedValue([batchRow({ status: 'running', summaryJson: null })]);
    expect(
      await loadCampaignMeasurementEvidence(db, TENANT, { spaceId: SPACE, workflowSlug: SLUG }),
    ).toBeUndefined();
    expect(baselineMock).not.toHaveBeenCalled();
  });

  it('latest completed batch with no pin → scorecard only, no baseline, no delta', async () => {
    listBatchesMock.mockResolvedValue([
      batchRow({ status: 'running', id: uuid(12), summaryJson: null }),
      batchRow({}),
    ]);
    baselineMock.mockResolvedValue(null);
    const evidence = await loadCampaignMeasurementEvidence(db, TENANT, {
      spaceId: SPACE,
      workflowSlug: SLUG,
    });
    expect(evidence).toEqual({
      latestBatch: {
        batchId: LATEST_BATCH,
        datasetVersion: 3,
        workflowRevision: 7,
        completedAt: '2026-08-01T00:30:00.000Z',
        summary: expect.objectContaining({ passRate: 0.75 }),
      },
    });
  });

  it('a pinned terminal baseline yields the paired delta via the real compare mechanics', async () => {
    const baselineHead = batchRow({
      id: BASELINE_BATCH,
      workflowRevision: 6,
      summaryJson: summaryJson(0.5),
    });
    listBatchesMock.mockResolvedValue([batchRow({})]);
    baselineMock.mockResolvedValue({
      spaceId: SPACE,
      workflowSlug: SLUG,
      batchId: BASELINE_BATCH,
      pinnedAt: new Date('2026-08-02T00:00:00Z'),
      pinnedByUserId: null,
    } as never);
    headMock.mockResolvedValue(baselineHead);
    membersMock.mockResolvedValue([REV]);
    trialRowsMock.mockImplementation(async (_db, _tenant, batchId) =>
      batchId === BASELINE_BATCH
        ? [trialRow(1, 'pass', 'a'), trialRow(2, 'fail', 'a')]
        : [trialRow(1, 'pass', 'b'), trialRow(2, 'pass', 'b')],
    );
    revisionsMock.mockResolvedValue(
      new Map([
        [
          REV,
          {
            caseId: CASE_ID,
            case: { title: 'Case A', stratum: { scenario: 'happy-path', tier: 'regression' } },
          } as never,
        ],
      ]),
    );

    const evidence = await loadCampaignMeasurementEvidence(db, TENANT, {
      spaceId: SPACE,
      workflowSlug: SLUG,
    });
    expect(evidence?.baseline).toMatchObject({
      batchId: BASELINE_BATCH,
      pinnedAt: '2026-08-02T00:00:00.000Z',
      summary: expect.objectContaining({ passRate: 0.5 }),
    });
    // Deltas read baseline → latest: the single paired case went fail-some → all-pass.
    expect(evidence?.baselineDelta).toMatchObject({
      baselineBatchId: BASELINE_BATCH,
      pairedCases: 1,
      failToPassFlips: 1,
      passToFailFlips: 0,
    });
    expect(evidence?.baselineDelta?.perCaseSuccess).toMatchObject({ rateA: 0, rateB: 1 });
    expect(evidence?.baselineDelta?.uncertaintyNote).toContain('Paired on 1');
  });

  it('the latest batch being the baseline itself carries the pin without a self-delta', async () => {
    listBatchesMock.mockResolvedValue([batchRow({})]);
    baselineMock.mockResolvedValue({
      spaceId: SPACE,
      workflowSlug: SLUG,
      batchId: LATEST_BATCH,
      pinnedAt: new Date('2026-08-02T00:00:00Z'),
      pinnedByUserId: null,
    } as never);
    const evidence = await loadCampaignMeasurementEvidence(db, TENANT, {
      spaceId: SPACE,
      workflowSlug: SLUG,
    });
    expect(evidence?.baseline?.batchId).toBe(LATEST_BATCH);
    expect(evidence?.baselineDelta).toBeUndefined();
    expect(headMock).not.toHaveBeenCalled();
  });
});

describe('the synthesis packet measurement section', () => {
  const campaign: Campaign = {
    campaignId: uuid(40),
    spaceId: SPACE,
    workflowSlug: SLUG,
    goalRef: `${SLUG}:numeric:score`,
    scoreMetricKey: 'score',
    direction: 'maximize',
    status: 'ended',
    startedAt: '2026-07-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:00:00.000Z',
    endedReason: 'goal_met',
  };
  const baseEvidence: CampaignSynthesisEvidence = {
    campaign,
    series: [0.4, 0.6],
    candidates: [],
    campaignSurvivors: [],
    skillAndSpaceSet: [],
  };

  it('no measurement → no section at all', () => {
    const packet = formatCampaignSynthesisForPrompt({ evidence: baseEvidence });
    expect(packet).not.toContain('Offline measurement');
  });

  it('renders scorecards and the delta with its interval, n, and flips', () => {
    const packet = formatCampaignSynthesisForPrompt({
      evidence: {
        ...baseEvidence,
        measurement: {
          latestBatch: {
            batchId: LATEST_BATCH,
            datasetVersion: 3,
            workflowRevision: 7,
            summary: {
              cases: 2,
              trialsPerCase: 2,
              dispositions: { graded: 4 },
              verdicts: { pass: 3, fail: 1 },
              passRate: 0.75,
              passAllTrialsRate: 0.5,
              passAnyTrialRate: 1,
              strata: [],
              advisoryJudgeCriteria: [],
              costSpentCents: 120,
            },
          },
          baseline: {
            batchId: BASELINE_BATCH,
            datasetVersion: 3,
            workflowRevision: 6,
            pinnedAt: '2026-08-02T00:00:00.000Z',
          },
          baselineDelta: {
            baselineBatchId: BASELINE_BATCH,
            pairedCases: 1,
            perCaseSuccess: {
              rateA: 0,
              rateB: 1,
              delta: 1,
              intervalLower: 1,
              intervalUpper: 1,
            },
            passToFailFlips: 0,
            failToPassFlips: 1,
            investigationFlips: 0,
            uncertaintyNote: 'Paired on 1 identical case revision(s).',
          },
        },
      },
    });
    expect(packet).toContain('### Offline measurement (frozen eval batches)');
    expect(packet).toContain(`latest completed batch ${LATEST_BATCH}`);
    expect(packet).toContain('pass rate 75.0%');
    expect(packet).toContain(`pinned baseline (pinned 2026-08-02T00:00:00.000Z) ${BASELINE_BATCH}`);
    expect(packet).toContain('pass^k 0.0% → 100.0%');
    expect(packet).toContain('95% CI');
    expect(packet).toContain('n=1 paired case(s)');
    expect(packet).toContain('flips 0 pass→fail / 1 fail→pass');
    expect(packet).toContain('Paired on 1 identical case revision(s).');
  });

  it('an unpinned skill says so instead of manufacturing a delta', () => {
    const lines = formatCampaignMeasurementLines({
      latestBatch: { batchId: LATEST_BATCH, datasetVersion: 3, workflowRevision: 7 },
    });
    expect(lines.join('\n')).toContain('no scorecard recorded');
    expect(lines.join('\n')).toContain('no baseline pinned');
  });
});
