/**
 * The validity-repair dispatch is anchored at the skill's last run (or the
 * blocked session) purely for actor/trace resolution — that run's own
 * post-run review may already hold the plain run idempotency key, so the
 * repair review must dispatch with a fresh key or it is silently deduped
 * for the claim's lifetime. Repair cadence is owned by the open-proposal
 * check and the pending-repair fingerprint, not the start_run key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDiagnostic } from '@aflow/schemas';

const mockTriggerCoachReview = vi.fn();
const mockRecordPendingRepairFingerprint = vi.fn();
const mockWithTenantSchema = vi.fn();

vi.mock('../coachTrigger.js', () => ({
  triggerCoachReview: (...args: unknown[]) => mockTriggerCoachReview(...args),
  // Mocking the module replaces every export, so the real gate has to be
  // restated here or it reads as "off" and the dispatch under test never runs.
  backgroundCoachReviewEnabled: () => process.env['COACH_AUTO_REVIEW_ENABLED'] === '1',
}));

vi.mock('../coachTriggerValidity.js', () => ({
  checkPendingRepairFingerprint: async () => false,
  computeValidityRepairFingerprint: () => 'fp-1',
  recordPendingRepairFingerprint: (...args: unknown[]) =>
    mockRecordPendingRepairFingerprint(...args),
}));

const stubLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => stubLogger,
}));

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    withTenantSchema: (...args: unknown[]) => mockWithTenantSchema(...args),
    createMemoryDocRepository: () => ({ list: async () => [] }),
  };
});

const { maybeTriggerValidityRepairReview } = await import('../coachTriggerValidityDispatch.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-000000000002';
const ANCHOR_RUN = '00000000-0000-0000-0000-0000000000aa';
const SLUG = 'kaggle-competition-optimizer';

const DIAGNOSTIC: SkillDiagnostic = {
  code: 'missing_dependency',
  dimension: 'graph',
  severity: 'error',
  detail: 'task "submit" depends on "train" which does not exist',
};

beforeEach(() => {
  vi.clearAllMocks();
  // A repair review is the unasked-for kind and is off by default; these
  // assert what it does once asked for.
  process.env['COACH_AUTO_REVIEW_ENABLED'] = '1';
  mockTriggerCoachReview.mockResolvedValue('coach-session-1');
  mockWithTenantSchema
    .mockResolvedValueOnce([{ directives: { version: 1, responsibility: 'test' } }])
    .mockResolvedValueOnce([{ count: 7 }]);
});

describe('maybeTriggerValidityRepairReview — dispatch wiring', () => {
  it('dispatches with a fresh idempotency key so the anchor run key never dedupes it', async () => {
    const sessionId = await maybeTriggerValidityRepairReview({
      db: {} as never,
      redis: {} as never,
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: SLUG,
      diagnostics: [DIAGNOSTIC],
      anchorRunId: ANCHOR_RUN,
    });

    expect(sessionId).toBe('coach-session-1');
    expect(mockTriggerCoachReview).toHaveBeenCalledOnce();
    const params = mockTriggerCoachReview.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: SLUG,
      runId: ANCHOR_RUN,
      freshDispatch: true,
      validity: expect.objectContaining({ diagnostics: [DIAGNOSTIC] }),
    });
    expect(params).not.toHaveProperty('force');
    expect(mockRecordPendingRepairFingerprint).toHaveBeenCalledOnce();
  });

  it('a suppressed dispatch records no pending-repair fingerprint', async () => {
    mockTriggerCoachReview.mockResolvedValue(null);

    const sessionId = await maybeTriggerValidityRepairReview({
      db: {} as never,
      redis: {} as never,
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: SLUG,
      diagnostics: [DIAGNOSTIC],
      anchorRunId: ANCHOR_RUN,
    });

    expect(sessionId).toBeNull();
    expect(mockRecordPendingRepairFingerprint).not.toHaveBeenCalled();
  });
});

describe('maybeTriggerValidityRepairReview — nobody asked for this one', () => {
  it('raises nothing when background review is off', async () => {
    delete process.env['COACH_AUTO_REVIEW_ENABLED'];

    const sessionId = await maybeTriggerValidityRepairReview({
      db: {} as never,
      redis: {} as never,
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: SLUG,
      diagnostics: [DIAGNOSTIC],
      anchorRunId: ANCHOR_RUN,
    });

    expect(sessionId).toBe(null);
    expect(mockTriggerCoachReview).not.toHaveBeenCalled();
  });
});
