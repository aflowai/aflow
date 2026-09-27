/**
 * workflow.campaign.end — the operator/agent end site dispatches the
 * campaign-end synthesis review exactly when THIS call ended the campaign
 * (endedNow); the dispatch is best-effort and never fails the op.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
  atomicCompleteStep: vi.fn(),
}));

const mockEndCampaignInSpace = vi.fn();
const mockMaybeTriggerCampaignEndReview = vi.fn();
const stubLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('@aflow/cybernetic-runtime', () => ({
  endCampaignInSpace: (...args: unknown[]) => mockEndCampaignInSpace(...args),
  maybeTriggerCampaignEndReview: (...args: unknown[]) => mockMaybeTriggerCampaignEndReview(...args),
  getCyberneticLogger: () => stubLogger,
}));

vi.mock('@aflow/database', () => ({
  getDatabase: () => ({}),
}));

import { handleWorkflowCampaignEnd } from '../workflowCrud/campaign/end.js';
import type { InlineHandlerArgs } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const CAMPAIGN_ID = '00000000-0000-0000-0000-0000000000c1';
const SLUG = 'kaggle-competition-optimizer';

const CAMPAIGN = {
  campaignId: CAMPAIGN_ID,
  spaceId: SPACE,
  workflowSlug: SLUG,
  goalRef: `${SLUG}:numeric:rmsle`,
  scoreMetricKey: 'rmsle',
  direction: 'minimize',
  status: 'ended',
  startedAt: '2026-06-01T00:00:00.000Z',
  endedAt: '2026-07-06T00:00:00.000Z',
  endedReason: 'explicit',
};

function makeArgs(): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn(),
      shouldStore: vi.fn(() => false),
      store: vi.fn(),
    } as never,
    context: {
      tenantId: TENANT,
      runId: 'session-1',
      traceId: 'trace-campaign-end',
      spaceId: SPACE,
    } as never,
    stepDef: {
      stepId: 'end-campaign',
      stepType: 'workflow',
      operation: 'workflow.campaign.end',
    } as unknown as StepDefinition,
    stepExecutionId: 'exec-1' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEndCampaignInSpace.mockResolvedValue({ ok: true, campaign: CAMPAIGN, endedNow: true });
  mockMaybeTriggerCampaignEndReview.mockResolvedValue('coach-session-1');
});

describe('handleWorkflowCampaignEnd — campaign-end review dispatch', () => {
  it('a campaign this call ended dispatches the synthesis review', async () => {
    await handleWorkflowCampaignEnd(makeArgs(), { campaignId: CAMPAIGN_ID, reason: 'explicit' }, 0);

    expect(mockMaybeTriggerCampaignEndReview).toHaveBeenCalledOnce();
    expect(mockMaybeTriggerCampaignEndReview.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: SLUG,
      campaignId: CAMPAIGN_ID,
      reason: 'explicit',
    });

    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('SUCCEEDED');
  });

  it('an already-ended campaign (idempotent reply) does NOT re-dispatch', async () => {
    mockEndCampaignInSpace.mockResolvedValue({ ok: true, campaign: CAMPAIGN, endedNow: false });

    await handleWorkflowCampaignEnd(makeArgs(), { campaignId: CAMPAIGN_ID, reason: 'explicit' }, 0);

    expect(mockMaybeTriggerCampaignEndReview).not.toHaveBeenCalled();
    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('SUCCEEDED');
  });

  it('a failing dispatch is best-effort — the op still succeeds', async () => {
    mockMaybeTriggerCampaignEndReview.mockRejectedValue(new Error('control stream down'));

    await handleWorkflowCampaignEnd(makeArgs(), { campaignId: CAMPAIGN_ID, reason: 'explicit' }, 0);

    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('SUCCEEDED');
    expect(stubLogger.warn).toHaveBeenCalled();
  });

  it('a failed end emits a step error and never dispatches', async () => {
    mockEndCampaignInSpace.mockResolvedValue({
      ok: false,
      code: 'CAMPAIGN_NOT_FOUND',
      message: 'No campaign found',
    });

    await handleWorkflowCampaignEnd(makeArgs(), { campaignId: CAMPAIGN_ID, reason: 'explicit' }, 0);

    expect(mockMaybeTriggerCampaignEndReview).not.toHaveBeenCalled();
    const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(msg['status']).toBe('FAILED');
  });
});
