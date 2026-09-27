/**
 * Post-run hooks — operator-cancel gate.
 *
 * An operator-cancelled run carries no behavioral signal: the eval → Coach →
 * skill-projection pipeline must NOT fire (otherwise aborted runs mint
 * full Coach reviews — e.g. over "no chat thread captured").
 * Completed runs keep firing both; non-operator cancels keep the existing
 * path (no new machinery).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoadRunById = vi.fn();
const mockRunEvaluation = vi.fn();
const mockTriggerCoachReview = vi.fn();
const mockTriggerCampaignEndReview = vi.fn();
const mockOnSkillRunCompleted = vi.fn();
const mockMaterializeRunScore = vi.fn();
const mockPrepareRunScoring = vi.fn();
const mockWriteRunEvaluationEnvelope = vi.fn();
const mockOnEvalCompleted = vi.fn();
const mockFinalizeExpiredWindows = vi.fn();
const mockCountProductionRuns = vi.fn();

const stubLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('@aflow/cybernetic-runtime', () => ({
  getCyberneticLogger: () => stubLogger,
  // Mocking the module replaces every export, so the real gate has to be
  // restated or it reads as "off" and the dispatch under test never runs.
  backgroundCoachReviewEnabled: () => process.env['COACH_AUTO_REVIEW_ENABLED'] === '1',
  isCyberneticSpace: () => true,
  loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
  countProductionRuns: (...args: unknown[]) => mockCountProductionRuns(...args),
  buildEvalTaskResultsFromRows: async () => [],
  prepareRunScoring: (...args: unknown[]) => mockPrepareRunScoring(...args),
  computeFailedRequiredTaskIds: () => [],
  runEvaluation: (...args: unknown[]) => mockRunEvaluation(...args),
  onEvalCompleted: (...args: unknown[]) => mockOnEvalCompleted(...args),
  parseRunEvaluationEnvelope: () => undefined,
  writeRunEvaluationEnvelope: (...args: unknown[]) => mockWriteRunEvaluationEnvelope(...args),
  materializeRunScore: (...args: unknown[]) => mockMaterializeRunScore(...args),
  finalizeExpiredWindows: (...args: unknown[]) => mockFinalizeExpiredWindows(...args),
  onSkillRunCompleted: (...args: unknown[]) => mockOnSkillRunCompleted(...args),
  getCampaignScoreSeries: async () => [],
  triggerCoachReview: (...args: unknown[]) => mockTriggerCoachReview(...args),
  triggerCampaignEndReview: (...args: unknown[]) => mockTriggerCampaignEndReview(...args),
}));

const SPACES_TABLE = { __table: 'spaces' };

vi.mock('@aflow/database', () => ({
  spaces: SPACES_TABLE,
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ mode: 'cybernetic', directives: {} }]),
          }),
        }),
      }),
    }),
}));

const mockAppendEntityEvent = vi.fn();
vi.mock('@aflow/redis', () => ({
  appendEntityEvent: (...args: unknown[]) => mockAppendEntityEvent(...args),
}));

const { fireCyberneticPostRunHooksStandalone } = await import('../postRunHooks.js');

const TENANT = '00000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const RUN_ID = '00000000-0000-0000-0000-0000000000a1';

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    spaceId: SPACE,
    workflowSlug: 'test-skill',
    sessionId: null,
    status: 'completed',
    cancelledBy: null,
    cancelReason: null,
    learningsJson: [],
    tasks: [],
    ...overrides,
  };
}

function params() {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    workflowSlug: 'test-skill',
    runId: RUN_ID,
    db: {} as never,
    redis: {} as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // These assert what the dispatch DOES, so they ask for it. Background review
  // is off by default now — that default has its own test below.
  process.env['COACH_AUTO_REVIEW_ENABLED'] = '1';
  mockCountProductionRuns.mockResolvedValue(3);
  mockPrepareRunScoring.mockResolvedValue({
    goal: null,
    campaign: null,
    runLevelMetrics: {},
    workflow: null,
  });
  mockRunEvaluation.mockResolvedValue({ decision: 'no_suite' });
  mockWriteRunEvaluationEnvelope.mockResolvedValue({ written: true });
  mockOnSkillRunCompleted.mockResolvedValue({ maturityTransition: undefined });
  mockTriggerCoachReview.mockResolvedValue(undefined);
  mockTriggerCampaignEndReview.mockResolvedValue(undefined);
  mockMaterializeRunScore.mockResolvedValue({ score: null, candidates: [] });
  mockFinalizeExpiredWindows.mockResolvedValue(undefined);
});

describe('fireCyberneticPostRunHooksStandalone — frozen-mode gate (Plan 269 D5)', () => {
  it('an eval-batch trial: NO eval, NO Coach, no score/candidate materialization', async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ evalBatchId: 'batch-1' }));

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockRunEvaluation).not.toHaveBeenCalled();
    expect(mockTriggerCoachReview).not.toHaveBeenCalled();
    expect(mockTriggerCampaignEndReview).not.toHaveBeenCalled();
    expect(mockMaterializeRunScore).not.toHaveBeenCalled();
    expect(mockOnSkillRunCompleted).not.toHaveBeenCalled();
  });

  it("an eval-batch trial STILL gets a typed envelope decision: 'eval_batch'", async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ evalBatchId: 'batch-1' }));

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockWriteRunEvaluationEnvelope).toHaveBeenCalledOnce();
    expect(mockWriteRunEvaluationEnvelope.mock.calls[0]![2]).toMatchObject({
      runId: RUN_ID,
      write: { kind: 'decision', decision: 'eval_batch' },
    });
  });

  it('the frozen gate outranks the operator-cancel gate', async () => {
    mockLoadRunById.mockResolvedValue(
      buildRun({ evalBatchId: 'batch-1', status: 'cancelled', cancelledBy: 'operator' }),
    );

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockWriteRunEvaluationEnvelope.mock.calls[0]![2]).toMatchObject({
      write: { kind: 'decision', decision: 'eval_batch' },
    });
  });
});

describe('fireCyberneticPostRunHooksStandalone — operator-cancel gate', () => {
  it('operator-cancelled run: NO eval, NO Coach activation, no score materialization', async () => {
    mockLoadRunById.mockResolvedValue(
      buildRun({ status: 'cancelled', cancelledBy: 'operator', cancelReason: 'stop' }),
    );

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockRunEvaluation).not.toHaveBeenCalled();
    expect(mockTriggerCoachReview).not.toHaveBeenCalled();
    expect(mockMaterializeRunScore).not.toHaveBeenCalled();
    expect(mockOnSkillRunCompleted).not.toHaveBeenCalled();
  });

  it('operator-cancelled run STILL gets an envelope, written before the early return', async () => {
    mockLoadRunById.mockResolvedValue(
      buildRun({ status: 'cancelled', cancelledBy: 'operator', cancelReason: 'stop' }),
    );

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockWriteRunEvaluationEnvelope).toHaveBeenCalledOnce();
    expect(mockWriteRunEvaluationEnvelope.mock.calls[0]![2]).toMatchObject({
      runId: RUN_ID,
      write: { kind: 'decision', decision: 'operator_cancelled' },
    });
  });

  it('completed run: still fires eval AND Coach review', async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockRunEvaluation).toHaveBeenCalledOnce();
    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
  });

  it('the Coach gate totalRuns comes from the production-run count — frozen batch trials excluded', async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));
    mockCountProductionRuns.mockResolvedValue(7);

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockCountProductionRuns).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      SPACE,
      'test-skill',
    );
    expect(mockTriggerCoachReview.mock.calls[0]![0]).toMatchObject({ totalRuns: 7 });
  });

  it('non-operator cancel keeps the existing path (no new machinery)', async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'cancelled', cancelledBy: 'system' }));

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockRunEvaluation).toHaveBeenCalledOnce();
    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
  });
});

describe('fireCyberneticPostRunHooksStandalone — evaluation envelope', () => {
  it("a 'ran' outcome writes the envelope with the summary the Runs surface reads", async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));
    mockRunEvaluation.mockResolvedValue({
      decision: 'ran',
      suiteContentHash: 'sha256:abc',
      result: {
        resultId: '00000000-0000-0000-0000-0000000000e1',
        verdict: 'pass',
        scores: { overall: 0.9 },
        regressionDetected: false,
      },
      judgeSelection: [{ scope: 'goal', criterionName: 'quality', selection: 'not_selected' }],
    });

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockWriteRunEvaluationEnvelope).toHaveBeenCalledOnce();
    expect(mockWriteRunEvaluationEnvelope.mock.calls[0]![2]).toMatchObject({
      runId: RUN_ID,
      write: {
        kind: 'decision',
        decision: 'ran',
        suiteContentHash: 'sha256:abc',
        summary: {
          verdict: 'pass',
          scores: { overall: 0.9 },
          faultLayer: null,
          regressionDetected: false,
        },
        judgeSelection: [{ scope: 'goal', criterionName: 'quality', selection: 'not_selected' }],
      },
    });
  });

  it('a no-scorable outcome still records judgeSelection — sampled-out criteria are never silent', async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));
    mockRunEvaluation.mockResolvedValue({
      decision: 'no_scorable_criteria',
      suiteContentHash: 'sha256:abc',
      judgeSelection: [{ scope: 'goal', criterionName: 'quality', selection: 'not_selected' }],
    });

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockWriteRunEvaluationEnvelope).toHaveBeenCalledOnce();
    expect(mockWriteRunEvaluationEnvelope.mock.calls[0]![2]).toMatchObject({
      runId: RUN_ID,
      write: {
        kind: 'decision',
        decision: 'no_scorable_criteria',
        suiteContentHash: 'sha256:abc',
        judgeSelection: [{ scope: 'goal', criterionName: 'quality', selection: 'not_selected' }],
      },
    });
  });

  it("a suite-less run writes decision 'no_suite'", async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));
    mockRunEvaluation.mockResolvedValue({ decision: 'no_suite' });

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockWriteRunEvaluationEnvelope).toHaveBeenCalledOnce();
    expect(mockWriteRunEvaluationEnvelope.mock.calls[0]![2]).toMatchObject({
      runId: RUN_ID,
      write: { kind: 'decision', decision: 'no_suite' },
    });
  });

  it("an eval dispatch error writes decision 'error' with the message", async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));
    mockRunEvaluation.mockRejectedValue(new Error('boom'));

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockWriteRunEvaluationEnvelope).toHaveBeenCalledOnce();
    expect(mockWriteRunEvaluationEnvelope.mock.calls[0]![2]).toMatchObject({
      runId: RUN_ID,
      write: { kind: 'decision', decision: 'error', errorMessage: 'boom' },
    });
    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
  });
});

describe('fireCyberneticPostRunHooksStandalone — campaign-end synthesis dispatch', () => {
  const CAMPAIGN_ID = '00000000-0000-0000-0000-0000000000c1';

  it('goal-met finalize (materializeRunScore signals campaignEnded) dispatches the campaign-end review IN ADDITION to the run review', async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));
    mockMaterializeRunScore.mockResolvedValue({
      score: 0.9,
      candidates: [],
      campaignEnded: { campaignId: CAMPAIGN_ID, reason: 'goal_met' },
    });

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
    expect(mockTriggerCampaignEndReview).toHaveBeenCalledOnce();
    expect(mockTriggerCampaignEndReview.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: 'test-skill',
      runId: RUN_ID,
      totalRuns: 3,
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });
  });

  it('no campaignEnded signal ⇒ no campaign-end dispatch', async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
    expect(mockTriggerCampaignEndReview).not.toHaveBeenCalled();
  });

  it('a failing campaign-end dispatch never breaks the hook pipeline', async () => {
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));
    mockMaterializeRunScore.mockResolvedValue({
      score: 0.9,
      candidates: [],
      campaignEnded: { campaignId: CAMPAIGN_ID, reason: 'goal_met' },
    });
    mockTriggerCampaignEndReview.mockRejectedValue(new Error('control stream down'));

    await expect(fireCyberneticPostRunHooksStandalone(params())).resolves.toBeUndefined();
  });
});

describe('fireCyberneticPostRunHooksStandalone — background review is not automatic', () => {
  it('raises no Coach review when nothing asked for one', async () => {
    // The default. A review after every run, able to ask for another, took one
    // three-message conversation to 33,383 steps.
    delete process.env['COACH_AUTO_REVIEW_ENABLED'];

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockTriggerCoachReview).not.toHaveBeenCalled();
  });

  it('still evaluates the run, which is not the same thing as reviewing it', async () => {
    // Evaluation is deterministic and cheap; review spends model calls. Turning
    // one off must not quietly turn the other off with it.
    delete process.env['COACH_AUTO_REVIEW_ENABLED'];
    mockLoadRunById.mockResolvedValue(buildRun({ status: 'completed' }));

    await fireCyberneticPostRunHooksStandalone(params());

    expect(mockRunEvaluation).toHaveBeenCalledOnce();
    expect(mockTriggerCoachReview).not.toHaveBeenCalled();
  });
});
