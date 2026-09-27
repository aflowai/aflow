import { describe, it, expect } from 'vitest';
import { CoachReviewOutcomeSchema } from '../cybernetic/coachReviewOutcome.js';

const RATIONALE = 'A substantive rationale that is at least twenty characters long for sure.';
const UUID = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('CoachReviewOutcomeSchema — outcome combination matrix', () => {
  // -- with_proposals ----------------------------------------------------

  it('with_proposals + proposalIds: valid', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'with_proposals',
      proposalIds: [UUID(1)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(true);
  });

  it('with_proposals + proposalIds + learningIds: valid (additive)', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'with_proposals',
      proposalIds: [UUID(1)],
      learningIds: [UUID(10)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(true);
  });

  it('with_proposals + proposalIds + observationId + learningIds: valid (full additive)', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'with_proposals',
      proposalIds: [UUID(1)],
      observationId: UUID(5),
      learningIds: [UUID(10)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(true);
  });

  it('with_proposals with empty proposalIds: rejected', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'with_proposals',
      proposalIds: [],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });

  // -- observation_only --------------------------------------------------

  it('observation_only + observationId: valid', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'observation_only',
      observationId: UUID(5),
      rationale: RATIONALE,
    });
    expect(r.success).toBe(true);
  });

  it('observation_only + observationId + learningIds: valid (additive)', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'observation_only',
      observationId: UUID(5),
      learningIds: [UUID(10)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(true);
  });

  it('observation_only without observationId: rejected', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'observation_only',
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });

  it('observation_only + proposalIds: rejected (name claims no proposals)', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'observation_only',
      observationId: UUID(5),
      proposalIds: [UUID(1)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });

  // -- learning_only -----------------------------------------------------

  it('learning_only + learningIds: valid', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'learning_only',
      learningIds: [UUID(10)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(true);
  });

  it('learning_only without learningIds: rejected', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'learning_only',
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });

  it('learning_only + proposalIds: rejected', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'learning_only',
      learningIds: [UUID(10)],
      proposalIds: [UUID(1)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });

  it('learning_only + observationId: rejected', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'learning_only',
      learningIds: [UUID(10)],
      observationId: UUID(5),
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });

  // -- silent ------------------------------------------------------------

  it('silent with nothing else set: valid', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      rationale: RATIONALE,
    });
    expect(r.success).toBe(true);
  });

  it('silent + learningIds: rejected', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      learningIds: [UUID(10)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });

  it('silent + proposalIds: rejected', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      proposalIds: [UUID(1)],
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });

  it('silent + observationId: rejected', () => {
    const r = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      observationId: UUID(5),
      rationale: RATIONALE,
    });
    expect(r.success).toBe(false);
  });
});
