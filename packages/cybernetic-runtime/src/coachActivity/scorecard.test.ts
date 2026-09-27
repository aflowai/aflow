import { describe, it, expect } from 'vitest';
import type { CoachActivityRow } from '@aflow/database';
import { computeCoachScorecard } from './scorecard.js';

function row(over: Partial<CoachActivityRow>): CoachActivityRow {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    spaceId: '00000000-0000-0000-0000-000000000001',
    coachSessionId: null,
    skillSlug: 'optimize-x',
    triggerKind: 'eval_signal',
    triggerCause: null,
    outcome: 'with_proposals',
    status: 'completed',
    proposalCount: 0,
    observationCount: 0,
    learningCount: 0,
    previewFailedCount: 0,
    bypassesGate: false,
    costCents: null,
    durationMs: null,
    contextDocPath: null,
    factsDocPath: null,
    rationale: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    ...over,
  } as CoachActivityRow;
}

describe('computeCoachScorecard (Plan 201 §11 — dev telemetry)', () => {
  it('aggregates outcome mix, volumes, preview-fail + suppressed rates', () => {
    const rows = [
      row({ outcome: 'with_proposals', proposalCount: 2, costCents: '1.5', durationMs: 1000 }),
      row({ outcome: 'with_proposals', proposalCount: 1, previewFailedCount: 2, durationMs: 3000 }),
      row({ outcome: 'silent' }),
      row({ outcome: 'observation_only', observationCount: 1 }),
      row({ outcome: 'suppressed', status: 'suppressed:rate_cap' }),
    ];
    const s = computeCoachScorecard(rows);
    expect(s.totalReviews).toBe(5);
    expect(s.byOutcome['with_proposals']).toBe(2);
    expect(s.byOutcome['suppressed']).toBe(1);
    expect(s.proposalCount).toBe(3);
    expect(s.observationCount).toBe(1);
    // 1 review had a preview-failed proposal, out of 4 completed (non-suppressed).
    expect(s.previewFailedReviews).toBe(1);
    expect(s.previewFailedRate).toBeCloseTo(0.25);
    expect(s.suppressedRate).toBeCloseTo(0.2);
    expect(s.avgCostCents).toBeCloseTo(1.5);
    expect(s.avgDurationMs).toBeCloseTo(2000);
  });

  it('is zero-safe on an empty ledger', () => {
    const s = computeCoachScorecard([]);
    expect(s.totalReviews).toBe(0);
    expect(s.previewFailedRate).toBe(0);
    expect(s.suppressedRate).toBe(0);
    expect(s.avgCostCents).toBeNull();
  });
});
