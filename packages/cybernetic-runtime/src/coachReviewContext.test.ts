import { describe, it, expect } from 'vitest';
import { buildCoachReviewContext } from './coachReviewContext.js';

describe('buildCoachReviewContext', () => {
  it('produces a parsed context with sensible defaults', () => {
    const ctx = buildCoachReviewContext({
      spaceId: '00000000-0000-0000-0000-000000000001',
      tenantId: 'tenant',
      coachSessionId: '00000000-0000-0000-0000-000000000002',
      triggerKind: 'eval_signal',
      skillSlug: 'my-skill',
      runId: '00000000-0000-0000-0000-000000000003',
    });
    expect(ctx.contextId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.trigger.kind).toBe('eval_signal');
    expect(ctx.trigger.bypassesGate).toBe(false);
    expect(ctx.target.skillSlug).toBe('my-skill');
    expect(ctx.target.focusAreas).toEqual([]);
    expect(ctx.priorFailures.recentRatificationErrors).toEqual([]);
  });

  it('records bypassesGate when set (manual retrigger audit-trail)', () => {
    const ctx = buildCoachReviewContext({
      spaceId: '00000000-0000-0000-0000-000000000001',
      tenantId: 'tenant',
      coachSessionId: '00000000-0000-0000-0000-000000000002',
      triggerKind: 'operator_requested_review',
      requestedBy: 'user-123',
      bypassesGate: true,
      skillSlug: 'my-skill',
    });
    expect(ctx.trigger.bypassesGate).toBe(true);
    expect(ctx.trigger.requestedBy).toBe('user-123');
  });
});
