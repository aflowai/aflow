/**
 * campaign_end_review producer semantics on triggerCoachReview:
 * - bypasses the sampling gate (an ended campaign is always review-worthy),
 * - still respects the per-skill rate limiter,
 * - dispatches with a CAMPAIGN-keyed idempotency key (never collides with the
 *   same run's regular review),
 * - the brief opens with the campaign synthesis packet instead of the
 *   run-diagnosis framing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Campaign, CandidateLearning, CoachLearning } from '@aflow/schemas';
import { EntityDirectivesSchema } from '@aflow/schemas';
import { configureLogging } from '@aflow/observability';

const mockAddControlMessage = vi.fn();
const mockAppendEntityEvent = vi.fn();
const mockRecordCoachActivity = vi.fn(async () => undefined);
const mockClaimStartRunIdempotency = vi.fn(
  async (): Promise<{ claimed: boolean; existingRunId: string | null }> => ({
    claimed: true,
    existingRunId: null,
  }),
);

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: async () => {
    throw new Error('no db in this test');
  },
  sessions: {},
  spaces: {},
}));

vi.mock('@aflow/redis', () => ({
  addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
  appendEntityEvent: (...args: unknown[]) => mockAppendEntityEvent(...args),
  claimControlDispatchIdempotency: (...args: unknown[]) => mockClaimStartRunIdempotency(...args),
  getSessionStateSafe: async () => ({ ok: false }),
}));

vi.mock('../coachActivity/recordActivity.js', () => ({
  recordCoachActivity: (...args: unknown[]) => mockRecordCoachActivity(...args),
}));

vi.mock('@aflow/platform-artifacts', () => ({
  getPlatformAgentBySystemRole: () => ({ slug: 'cybernetic-coach' }),
}));

vi.mock('../interactionPhase.js', () => ({ emitPhaseIfChanged: vi.fn() }));
vi.mock('../coachFeedback.js', () => ({
  loadCoachFeedback: async () => [],
  formatCoachFeedbackForPrompt: () => '',
}));
vi.mock('../userFeedback.js', () => ({
  loadUserFeedbackForSkill: async () => [],
  formatUserFeedbackForPrompt: () => '',
}));
vi.mock('../evalRunner.js', () => ({ loadEvalSuite: async () => null }));
vi.mock('../coachReviewContext.js', () => ({
  buildCoachReviewContext: vi.fn((input: unknown) => input),
  persistCoachReviewContext: vi.fn(async () => ({ path: '/coach/contexts/x.json' })),
}));
vi.mock('../facts/index.js', () => ({
  compileCoachFacts: vi.fn(),
  formatCoachFactsForPrompt: () => '',
  formatLearningsForPrompt: () => 'DURABLE LEARNINGS RUN BLOCK',
  formatLearningLine: (l: CoachLearning) => `- ${l.learningId} ${l.statement}`,
  loadRecentLearnings: async (): Promise<CoachLearning[]> => DURABLE_LEARNINGS,
  persistCoachReviewFacts: vi.fn(),
}));
vi.mock('../activeLearningSet.js', () => ({
  resolveActiveSetBudget: () => 12,
  selectActiveLearningSet: async () => ({
    selected: [],
    omittedDueToBudget: 0,
    consolidationDue: false,
  }),
}));
vi.mock('../coachTriggerAppliedChanges.js', () => ({
  loadAppliedChangeOutcomes: async () => [],
  formatAppliedChangeOutcomesForPrompt: () => '',
}));
vi.mock('../reflectionCapture.js', () => ({
  resolveReflectionEvidenceSnapshot: async () => 'none',
}));
vi.mock('../coachTriggerReflections.js', () => ({
  loadReflections: async () => [],
  formatReflectionsForPrompt: () => '',
}));
vi.mock('../coachTriggerCandidateEvidence.js', () => ({
  loadCandidateEvidenceForPrompt: async () => 'CANDIDATE RUN BLOCK',
}));
vi.mock('../coachTriggerBreadth.js', () => ({
  resolveBreadthForReview: async () => ({
    resolvedSkillMode: undefined,
    breadthEvidence: undefined,
  }),
  formatBreadthEvidenceForPrompt: () => '',
}));
vi.mock('../coachTriggerEvalQuality.js', () => ({
  loadEvalQualityReportForReview: async () => null,
  formatEvalSuiteForPrompt: () => '',
}));
vi.mock('../campaigns.js', () => ({
  getCampaignById: async () => campaignForTest,
  getCampaignScoreSeries: async () => [
    { runId: 'r1', score: 0.42, startedAt: '2026-06-01T00:00:00.000Z' },
    { runId: 'r2', score: 0.128, startedAt: '2026-06-02T00:00:00.000Z' },
  ],
}));
vi.mock('../candidateLearnings.js', () => ({
  listCandidatesByCampaign: async (): Promise<CandidateLearning[]> => [PENDING_CANDIDATE],
}));

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';
const SPACE_ID = '33333333-3333-3333-3333-333333333333';
const RUN_ID = '44444444-4444-4444-4444-444444444444';
const SLUG = 'kaggle-competition-optimizer';

let campaignForTest: Campaign | null;

const CAMPAIGN: Campaign = {
  campaignId: CAMPAIGN_ID,
  spaceId: SPACE_ID,
  workflowSlug: SLUG,
  goalRef: `${SLUG}:numeric:rmsle`,
  scoreMetricKey: 'rmsle',
  direction: 'minimize',
  status: 'ended',
  startedAt: '2026-06-01T00:00:00.000Z',
  endedAt: '2026-07-06T00:00:00.000Z',
  endedReason: 'goal_met',
};

const DURABLE_LEARNINGS: CoachLearning[] = [
  {
    learningId: 'aaaaaaaa-0000-0000-0000-000000000001',
    coachSessionId: '55555555-5555-5555-5555-555555555555',
    scope: { kind: 'campaign', campaignId: CAMPAIGN_ID, skillSlug: SLUG },
    kind: 'heuristic',
    statement: 'log-transform the target before training',
    evidence: { citations: [{ runId: RUN_ID }] },
    confidence: 'high',
    supersedes: [],
    authorityLevel: 'auto_record',
    status: 'auto_recorded',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
];

const PENDING_CANDIDATE: CandidateLearning = {
  entryId: 'bbbbbbbb-0000-0000-0000-000000000001',
  spaceId: SPACE_ID,
  skillSlug: SLUG,
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

const { triggerCoachReview } = await import('../coachTrigger.js');
const { triggerCampaignEndReview } = await import('../coachTriggerCampaignEndDispatch.js');

function makeRedis(overrides: Record<string, unknown> = {}) {
  return {
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ...overrides,
  } as never;
}

// Parameters that match NO gate source: past bootstrap, no eval result,
// no trajectory, no maturity transition, default sampling (codified_only).
function quietGateParams(redis: unknown) {
  return {
    tenantId: 'a0000000-0000-0000-0000-000000000001',
    spaceId: SPACE_ID,
    workflowSlug: SLUG,
    runId: RUN_ID,
    totalRuns: 50,
    reflections: [],
    db: {} as never,
    redis: redis as never,
  };
}

function dispatchedPrompt(): string {
  const msg = mockAddControlMessage.mock.calls[0]![1] as { inputRef: string };
  const decoded = JSON.parse(
    Buffer.from(msg.inputRef.slice('inline:'.length), 'base64').toString('utf-8'),
  ) as { input: { prompt: string } };
  return decoded.input.prompt;
}

beforeEach(() => {
  configureLogging({ service: 'test', level: 'silent' });
  vi.clearAllMocks();
  campaignForTest = CAMPAIGN;
});

describe('triggerCoachReview — campaign_end_review producer', () => {
  it('control: the same quiet params WITHOUT the override match no gate and dispatch nothing', async () => {
    const result = await triggerCoachReview(quietGateParams(makeRedis()));
    expect(result).toBeNull();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
  });

  it('campaign_end_review bypasses the sampling gate and dispatches with a campaign-keyed idempotency key', async () => {
    const redis = makeRedis();
    const result = await triggerCampaignEndReview({
      ...quietGateParams(redis),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });

    expect(result).not.toBeNull();
    expect(mockAddControlMessage).toHaveBeenCalledTimes(1);
    const msg = mockAddControlMessage.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['idempotencyKey']).toBe(`coach:${SLUG}:campaign-end:${CAMPAIGN_ID}`);
    expect(msg['type']).toBe('start_run');
  });

  it('the brief is the campaign synthesis packet, replacing the run-diagnosis framing', async () => {
    await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });

    const prompt = dispatchedPrompt();
    expect(prompt).toContain('campaign ended (goal_met)');
    expect(prompt).toContain('## Campaign synthesis packet');
    expect(prompt).toContain('log-transform the target before training');
    expect(prompt).toContain('shrinking the CV-LB gap may cost LB score');
    // Run-diagnosis surfaces the packet subsumes must not render twice.
    expect(prompt).not.toContain('Review workflow');
    expect(prompt).not.toContain('DURABLE LEARNINGS RUN BLOCK');
    expect(prompt).not.toContain('CANDIDATE RUN BLOCK');
  });

  it('degrades to the run-review framing when the campaign cannot be read (no phantom packet)', async () => {
    campaignForTest = null;
    await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });

    expect(mockAddControlMessage).toHaveBeenCalledTimes(1);
    const prompt = dispatchedPrompt();
    // No campaign-end framing without the packet it promises.
    expect(prompt).not.toContain('## Campaign synthesis packet');
    expect(prompt).not.toContain('campaign-end synthesis review');
    // The ordinary run-review brief renders, run blocks intact.
    expect(prompt).toContain('Review workflow');
    expect(prompt).toContain('DURABLE LEARNINGS RUN BLOCK');
    expect(prompt).toContain('CANDIDATE RUN BLOCK');
  });

  it('still respects the per-skill rate limiter (suppressed over the cap)', async () => {
    const redis = makeRedis({ incr: vi.fn(async () => 11) });
    const result = await triggerCampaignEndReview({
      ...quietGateParams(redis),
      campaignId: CAMPAIGN_ID,
      reason: 'explicit',
    });

    expect(result).toBeNull();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
    const suppressed = mockAppendEntityEvent.mock.calls.find(
      (call) =>
        (call[1] as { event: { eventType: string } }).event.eventType === 'entity.coach.suppressed',
    );
    expect(suppressed).toBeDefined();
  });

  it('persists the campaignId on the review-context target', async () => {
    const { buildCoachReviewContext } = await import('../coachReviewContext.js');
    await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });

    expect(buildCoachReviewContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildCoachReviewContext).mock.calls[0]![0]).toMatchObject({
      triggerKind: 'campaign_end_review',
      campaignId: CAMPAIGN_ID,
      skillSlug: SLUG,
      runId: RUN_ID,
    });
  });

  it('labels the dispatch campaign_end_review everywhere gate.source lands — never directive_sampled', async () => {
    await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });

    const msg = mockAddControlMessage.mock.calls[0]![1] as { inputRef: string };
    const decoded = JSON.parse(
      Buffer.from(msg.inputRef.slice('inline:'.length), 'base64').toString('utf-8'),
    ) as { input: { trigger_source: string } };
    expect(decoded.input.trigger_source).toBe('campaign_end_review');

    const activated = mockAppendEntityEvent.mock.calls.find(
      (call) =>
        (call[1] as { event: { eventType: string } }).event.eventType === 'entity.coach.activated',
    );
    expect(activated).toBeDefined();
    const event = (activated![1] as { event: { payload: { triggerSource: string } } }).event;
    expect(event.payload.triggerSource).toBe('campaign_end_review');
  });

  it('a re-summon (freshDispatch) dispatches fresh instead of deduping against the first synthesis', async () => {
    await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
      freshDispatch: true,
      requestedBy: 'operator',
      rationale: 'Re-run the synthesis after the exit-contract fix.',
    });
    await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
      freshDispatch: true,
    });

    expect(mockAddControlMessage).toHaveBeenCalledTimes(2);
    const keyOf = (i: number) =>
      (mockAddControlMessage.mock.calls[i]![1] as { idempotencyKey: string }).idempotencyKey;
    expect(keyOf(0)).toContain(`coach:${SLUG}:campaign-end:${CAMPAIGN_ID}:retrigger:`);
    expect(keyOf(1)).toContain(`coach:${SLUG}:campaign-end:${CAMPAIGN_ID}:retrigger:`);
    expect(keyOf(0)).not.toBe(keyOf(1));
    // The natural end-transition key would dedupe — the fresh ones never equal it.
    expect(keyOf(0)).not.toBe(`coach:${SLUG}:campaign-end:${CAMPAIGN_ID}`);

    const { buildCoachReviewContext } = await import('../coachReviewContext.js');
    expect(vi.mocked(buildCoachReviewContext).mock.calls[0]![0]).toMatchObject({
      triggerKind: 'campaign_end_review',
      requestedBy: 'operator',
      rationale: 'Re-run the synthesis after the exit-contract fix.',
      bypassesGate: false,
    });
  });

  it('a re-summon still respects the per-skill rate limiter — freshDispatch never bypasses the cap', async () => {
    const redis = makeRedis({ incr: vi.fn(async () => 11) });
    const result = await triggerCampaignEndReview({
      ...quietGateParams(redis),
      campaignId: CAMPAIGN_ID,
      reason: 'explicit',
      freshDispatch: true,
    });

    expect(result).toBeNull();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
  });

  it('a re-summon still carries the campaign synthesis packet and label', async () => {
    await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'explicit',
      freshDispatch: true,
    });

    const prompt = dispatchedPrompt();
    expect(prompt).toContain('## Campaign synthesis packet');
    const msg = mockAddControlMessage.mock.calls[0]![1] as { inputRef: string };
    const decoded = JSON.parse(
      Buffer.from(msg.inputRef.slice('inline:'.length), 'base64').toString('utf-8'),
    ) as { input: { trigger_source: string } };
    expect(decoded.input.trigger_source).toBe('campaign_end_review');
  });
});

describe('Plan 237 P2 — per-run-off directives do not gate campaign-end / explicit review', () => {
  function perRunOffDirectives() {
    const parsed = EntityDirectivesSchema.parse({ version: 1, responsibility: 'Test workspace.' });
    // Per-run auto-review off (the Plan 237 default) must not touch the
    // campaign-end / explicit paths, which never call shouldActivateCoach.
    expect(parsed.learningPolicy.coachAutoReviewPerRun).toBe(false);
    return parsed;
  }

  it('control: a per-run signal WITH per-run off matches no gate and dispatches nothing', async () => {
    const result = await triggerCoachReview({
      ...quietGateParams(makeRedis()),
      totalRuns: 1, // bootstrap would fire eval_signal if per-run were on
      directives: perRunOffDirectives(),
    });
    expect(result).toBeNull();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
  });

  it('campaign_end_review still dispatches with per-run off (bypasses shouldActivateCoach)', async () => {
    const result = await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
      directives: perRunOffDirectives(),
    });
    expect(result).not.toBeNull();
    expect(mockAddControlMessage).toHaveBeenCalledTimes(1);
    const msg = mockAddControlMessage.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['idempotencyKey']).toBe(`coach:${SLUG}:campaign-end:${CAMPAIGN_ID}`);
  });

  it('an explicit helmsman-requested review still dispatches with per-run off', async () => {
    const result = await triggerCoachReview({
      ...quietGateParams(makeRedis()),
      directives: perRunOffDirectives(),
      reviewContextOverrides: { triggerKind: 'helmsman_requested_review' },
    });
    expect(result).not.toBeNull();
    expect(mockAddControlMessage).toHaveBeenCalledTimes(1);
    const decoded = JSON.parse(
      Buffer.from(
        (mockAddControlMessage.mock.calls[0]![1] as { inputRef: string }).inputRef.slice(
          'inline:'.length,
        ),
        'base64',
      ).toString('utf-8'),
    ) as { input: { trigger_source: string } };
    expect(decoded.input.trigger_source).toBe('helmsman_requested_review');
  });
});

describe('triggerCoachReview — dispatch guards', () => {
  it('aborts the dispatch when review-context persistence fails: no control message, suppressed trace', async () => {
    const { persistCoachReviewContext } = await import('../coachReviewContext.js');
    vi.mocked(persistCoachReviewContext).mockRejectedValueOnce(new Error('persist failed'));

    const result = await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });

    expect(result).toBeNull();
    expect(mockAddControlMessage).not.toHaveBeenCalled();

    const suppressed = mockAppendEntityEvent.mock.calls.find(
      (call) =>
        (call[1] as { event: { eventType: string } }).event.eventType === 'entity.coach.suppressed',
    );
    expect(suppressed).toBeDefined();
    const payload = (suppressed![1] as { event: { payload: Record<string, unknown> } }).event
      .payload;
    expect(payload['reason']).toBe('context_persist_failed');
    expect(mockRecordCoachActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'suppressed',
        status: 'suppressed:context_persist_failed',
        triggerKind: 'campaign_end_review',
      }),
    );
  });

  it('claims the start_run idempotency key for the dispatched session', async () => {
    const result = await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });

    expect(result).not.toBeNull();
    expect(mockClaimStartRunIdempotency).toHaveBeenCalledWith(
      expect.anything(),
      `coach:${SLUG}:campaign-end:${CAMPAIGN_ID}`,
      result,
    );
  });

  it('a duplicate idempotency claim suppresses the dispatch instead of double-starting', async () => {
    mockClaimStartRunIdempotency.mockResolvedValueOnce({
      claimed: false,
      existingRunId: '99999999-9999-9999-9999-999999999999',
    });

    const result = await triggerCampaignEndReview({
      ...quietGateParams(makeRedis()),
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
    });

    expect(result).toBeNull();
    expect(mockAddControlMessage).not.toHaveBeenCalled();
    expect(mockRecordCoachActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'suppressed', status: 'suppressed:dedup' }),
    );
  });
});
