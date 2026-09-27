/**
 * maybeTriggerCampaignEndReview — the one resolver every end-by-id site
 * (campaign.end inline op, REST end route) routes through: anchors the review
 * on the campaign's last run, and never throws (the campaign is already
 * ended; a failed dispatch must not fail the end).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTriggerCoachReview = vi.fn();
const mockListRecentRuns = vi.fn();
const mockGetRunStatistics = vi.fn();
const mockLoadSpaceDirectives = vi.fn();
const stubLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('../coachTrigger.js', () => ({
  triggerCoachReview: (...args: unknown[]) => mockTriggerCoachReview(...args),
}));
vi.mock('../ledger/queries.js', () => ({
  listRecentRuns: (...args: unknown[]) => mockListRecentRuns(...args),
  getRunStatistics: (...args: unknown[]) => mockGetRunStatistics(...args),
}));
vi.mock('../modelResolution.js', () => ({
  loadSpaceDirectives: (...args: unknown[]) => mockLoadSpaceDirectives(...args),
}));
vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => stubLogger,
}));

const { maybeTriggerCampaignEndReview } = await import('../coachTriggerCampaignEndDispatch.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const CAMPAIGN_ID = '00000000-0000-0000-0000-0000000000c1';
const LAST_RUN_ID = '00000000-0000-0000-0000-0000000000a9';
const SLUG = 'kaggle-competition-optimizer';

function params() {
  return {
    db: {} as never,
    redis: {} as never,
    tenantId: TENANT,
    spaceId: SPACE,
    workflowSlug: SLUG,
    campaignId: CAMPAIGN_ID,
    reason: 'explicit' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListRecentRuns.mockResolvedValue([{ runId: LAST_RUN_ID, status: 'completed' }]);
  mockGetRunStatistics.mockResolvedValue({
    totalRuns: 9,
    completedRuns: 8,
    failedRuns: 1,
    avgDurationMs: null,
  });
  mockLoadSpaceDirectives.mockResolvedValue(null);
  mockTriggerCoachReview.mockResolvedValue('coach-session-1');
});

describe('maybeTriggerCampaignEndReview', () => {
  it('anchors the review on the last campaign run and dispatches the synthesis trigger', async () => {
    const result = await maybeTriggerCampaignEndReview(params());

    expect(result).toBe('coach-session-1');
    expect(mockListRecentRuns).toHaveBeenCalledWith(expect.anything(), TENANT, SPACE, SLUG, {
      limit: 1,
      campaignId: CAMPAIGN_ID,
    });
    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
    expect(mockTriggerCoachReview.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: SLUG,
      runId: LAST_RUN_ID,
      totalRuns: 9,
      campaignId: CAMPAIGN_ID,
      reviewContextOverrides: {
        triggerKind: 'campaign_end_review',
        rationale: 'campaign ended (explicit)',
      },
    });
  });

  it('a campaign with no runs has nothing to synthesize — no dispatch', async () => {
    mockListRecentRuns.mockResolvedValue([]);

    const result = await maybeTriggerCampaignEndReview(params());

    expect(result).toBeNull();
    expect(mockTriggerCoachReview).not.toHaveBeenCalled();
    expect(stubLogger.debug).toHaveBeenCalled();
  });

  it('an anchor-resolution failure is swallowed with a warning', async () => {
    mockListRecentRuns.mockRejectedValue(new Error('db down'));

    const result = await maybeTriggerCampaignEndReview(params());

    expect(result).toBeNull();
    expect(mockTriggerCoachReview).not.toHaveBeenCalled();
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it('a failing trigger dispatch is swallowed with a warning', async () => {
    mockTriggerCoachReview.mockRejectedValue(new Error('control stream down'));

    const result = await maybeTriggerCampaignEndReview(params());

    expect(result).toBeNull();
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it('threads the explicit-summon fields (freshDispatch, requestedBy, rationale) into the dispatch', async () => {
    const result = await maybeTriggerCampaignEndReview({
      ...params(),
      freshDispatch: true,
      requestedBy: 'operator',
      rationale: 'Re-run the synthesis.',
    });

    expect(result).toBe('coach-session-1');
    expect(mockTriggerCoachReview.mock.calls[0]![0]).toMatchObject({
      freshDispatch: true,
      reviewContextOverrides: {
        triggerKind: 'campaign_end_review',
        requestedBy: 'operator',
        rationale: 'Re-run the synthesis.',
      },
    });
    // A re-summon dedupes on the idempotency key only — it never inherits the
    // rate-cap-bypassing force posture.
    expect(mockTriggerCoachReview.mock.calls[0]![0]).not.toHaveProperty('force');
  });

  it('omits freshDispatch from a natural end-transition dispatch (campaign-keyed idempotency preserved)', async () => {
    await maybeTriggerCampaignEndReview(params());

    expect(mockTriggerCoachReview.mock.calls[0]![0]).not.toHaveProperty('freshDispatch');
  });
});
