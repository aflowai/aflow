/**
 * learner.review.request with campaignId — the operator's summon (and
 * re-summon) affordance for the campaign-end synthesis of an ALREADY-ended
 * campaign: routes through the campaign-end dispatch with a fresh idempotency
 * key (the rate cap still applies — the op is agent-callable), resolves the
 * skill slug from the campaign, and rejects a still-active campaign with a
 * teaching error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
    // The run asking for the review, which a person is present for.
    getSessionState: () => Promise.resolve({ activatedByPerson: true }),
  };
});

const mockGetCampaignById = vi.fn();
const mockMaybeTriggerCampaignEndReview = vi.fn();
const mockTriggerCoachReview = vi.fn();

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    getCampaignById: (...args: unknown[]) => mockGetCampaignById(...args),
    maybeTriggerCampaignEndReview: (...args: unknown[]) =>
      mockMaybeTriggerCampaignEndReview(...args),
    triggerCoachReview: (...args: unknown[]) => mockTriggerCoachReview(...args),
  };
});

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return { ...actual, getDatabase: () => ({}) };
});

vi.mock('../coachCrudMemory.js', () => ({
  getCoachCrudRepos: () => ({ db: {}, tenantCtx: {}, docRepo: {}, dirRepo: {} }),
  writeCoachJsonDoc: vi.fn(),
}));

const { handleCoachCrudInline } = await import('../coachCrud.js');
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const CAMPAIGN_ID = '00000000-0000-0000-0000-0000000000c1';
const COACH_SESSION = '00000000-0000-0000-0000-0000000000dd';
const SLUG = 'kaggle-competition-optimizer';

const ENDED_CAMPAIGN = {
  campaignId: CAMPAIGN_ID,
  spaceId: SPACE,
  workflowSlug: SLUG,
  goalRef: `${SLUG}:numeric:rmsle`,
  scoreMetricKey: 'rmsle',
  direction: 'minimize',
  status: 'ended',
  startedAt: '2026-06-01T00:00:00.000Z',
  endedAt: '2026-07-06T00:00:00.000Z',
  endedReason: 'goal_met',
};

function makeArgs(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  return {
    redis: {} as never,
    payloadStore: {
      shouldStore: vi.fn(() => false),
      store: vi.fn(),
      retrieve: vi.fn(async (ref: string) =>
        JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')),
      ),
    } as never,
    context: {
      tenantId: TENANT,
      runId: 'session-1',
      traceId: 'trace-review-request',
      spaceId: SPACE,
    } as never,
    stepDef: {
      stepId: 'request-review',
      stepType: 'learner',
      operation: 'learner.review.request',
    } as unknown as StepDefinition,
    stepExecutionId: 'exec-1' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: inputRef,
    attempt: 1,
    scheduledAtMs: 0,
  };
}

function resultMessage(): Record<string, unknown> {
  expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  return mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
}

function decodedOutput(): Record<string, unknown> {
  const msg = resultMessage();
  const ref = msg['outputRef'] as string;
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCampaignById.mockResolvedValue(ENDED_CAMPAIGN);
  mockMaybeTriggerCampaignEndReview.mockResolvedValue(COACH_SESSION);
});

describe('learner.review.request — campaignId synthesis routing', () => {
  it('summons the campaign-end synthesis for an ended campaign with a fresh, rate-capped dispatch', async () => {
    await handleCoachCrudInline(
      makeArgs({
        campaignId: CAMPAIGN_ID,
        rationale: 'Re-run the synthesis after the exit-contract fix.',
      }),
    );

    expect(mockMaybeTriggerCampaignEndReview).toHaveBeenCalledOnce();
    expect(mockMaybeTriggerCampaignEndReview.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: SLUG,
      campaignId: CAMPAIGN_ID,
      reason: 'goal_met',
      activatedByPerson: true,
      freshDispatch: true,
      requestedBy: 'operator',
      rationale: 'Re-run the synthesis after the exit-contract fix.',
    });
    expect(mockMaybeTriggerCampaignEndReview.mock.calls[0]![0]).not.toHaveProperty('force');
    expect(mockTriggerCoachReview).not.toHaveBeenCalled();

    expect(resultMessage()['status']).toBe('SUCCEEDED');
    expect(decodedOutput()).toMatchObject({
      coachSessionId: COACH_SESSION,
      skillSlug: SLUG,
      status: 'dispatched',
    });
  });

  it('a still-active campaign is rejected with a teaching error (end it first)', async () => {
    mockGetCampaignById.mockResolvedValue({ ...ENDED_CAMPAIGN, status: 'active' });

    await handleCoachCrudInline(makeArgs({ campaignId: CAMPAIGN_ID, rationale: 'synthesize' }));

    expect(mockMaybeTriggerCampaignEndReview).not.toHaveBeenCalled();
    const msg = resultMessage();
    expect(msg['status']).toBe('FAILED');
    const error = msg['error'] as { code: string; message: string };
    expect(error.code).toBe('CAMPAIGN_STILL_ACTIVE');
    expect(error.message).toContain('End it first');
  });

  it('an unknown campaign (or one from another space) is CAMPAIGN_NOT_FOUND', async () => {
    mockGetCampaignById.mockResolvedValue(null);

    await handleCoachCrudInline(makeArgs({ campaignId: CAMPAIGN_ID, rationale: 'synthesize' }));

    expect(mockMaybeTriggerCampaignEndReview).not.toHaveBeenCalled();
    const msg = resultMessage();
    expect(msg['status']).toBe('FAILED');
    expect((msg['error'] as { code: string }).code).toBe('CAMPAIGN_NOT_FOUND');
  });

  it('a campaign in another space is invisible', async () => {
    mockGetCampaignById.mockResolvedValue({
      ...ENDED_CAMPAIGN,
      spaceId: '00000000-0000-0000-0000-0000000000ee',
    });

    await handleCoachCrudInline(makeArgs({ campaignId: CAMPAIGN_ID, rationale: 'synthesize' }));

    expect(mockMaybeTriggerCampaignEndReview).not.toHaveBeenCalled();
    expect((resultMessage()['error'] as { code: string }).code).toBe('CAMPAIGN_NOT_FOUND');
  });

  it('an asserted skillSlug must match the campaign', async () => {
    await handleCoachCrudInline(
      makeArgs({ campaignId: CAMPAIGN_ID, skillSlug: 'some-other-skill', rationale: 'synthesize' }),
    );

    expect(mockMaybeTriggerCampaignEndReview).not.toHaveBeenCalled();
    expect((resultMessage()['error'] as { code: string }).code).toBe('WORKFLOW_SLUG_MISMATCH');
  });

  it('a suppressed dispatch reports skipped instead of failing the op', async () => {
    mockMaybeTriggerCampaignEndReview.mockResolvedValue(null);

    await handleCoachCrudInline(makeArgs({ campaignId: CAMPAIGN_ID, rationale: 'synthesize' }));

    expect(resultMessage()['status']).toBe('SUCCEEDED');
    expect(decodedOutput()).toMatchObject({ coachSessionId: null, status: 'skipped' });
  });

  it('helmsman-attributed requests thread requestedBy through', async () => {
    await handleCoachCrudInline(
      makeArgs({ campaignId: CAMPAIGN_ID, rationale: 'synthesize', requestedByKind: 'helmsman' }),
    );

    expect(mockMaybeTriggerCampaignEndReview.mock.calls[0]![0]).toMatchObject({
      requestedBy: 'helmsman',
    });
  });
});
