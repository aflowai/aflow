import { describe, it, expect } from 'vitest';
import {
  CoachReviewContextSchema,
  coachReviewContextDocPath,
} from '../cybernetic/coachReviewContext.js';

function validCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contextId: '11111111-1111-1111-1111-111111111111',
    spaceId: '22222222-2222-2222-2222-222222222222',
    tenantId: 'tenant',
    coachSessionId: '33333333-3333-3333-3333-333333333333',
    trigger: { kind: 'eval_signal', bypassesGate: false },
    target: { skillSlug: 'my-skill', focusAreas: [] },
    priorFailures: {
      recentRatificationErrors: [],
      recentApplyPreviewFailures: [],
      recentObservationsByReason: {},
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('CoachReviewContextSchema', () => {
  it('parses a well-formed context', () => {
    const ctx = CoachReviewContextSchema.parse(validCandidate());
    expect(ctx.trigger.kind).toBe('eval_signal');
    expect(ctx.target.skillSlug).toBe('my-skill');
    expect(ctx.trigger.bypassesGate).toBe(false);
  });

  it('rejects a target with neither skillSlug nor runId nor taskId', () => {
    const broken = validCandidate({ target: { focusAreas: [] } });
    const result = CoachReviewContextSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it('accepts a target with only runId', () => {
    const ctx = CoachReviewContextSchema.parse(
      validCandidate({
        target: { runId: '44444444-4444-4444-4444-444444444444', focusAreas: [] },
      }),
    );
    expect(ctx.target.runId).toBe('44444444-4444-4444-4444-444444444444');
  });

  it('rejects unknown trigger kinds (closed set guard)', () => {
    const broken = validCandidate({
      trigger: { kind: 'not_a_real_kind', bypassesGate: false },
    });
    const result = CoachReviewContextSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it('records bypassesGate=true for manual-retrigger audit', () => {
    const ctx = CoachReviewContextSchema.parse(
      validCandidate({
        trigger: { kind: 'operator_requested_review', bypassesGate: true, requestedBy: 'user-1' },
      }),
    );
    expect(ctx.trigger.bypassesGate).toBe(true);
    expect(ctx.trigger.requestedBy).toBe('user-1');
  });

  it('rejects unknown extra fields (strict)', () => {
    const broken = validCandidate({ rogueField: 'should-fail' });
    const result = CoachReviewContextSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });
});

describe('coachReviewContextDocPath', () => {
  it('returns /coach/contexts/{coachSessionId}.json', () => {
    expect(coachReviewContextDocPath('abc-123')).toBe('/coach/contexts/abc-123.json');
  });
});
