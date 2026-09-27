import { describe, it, expect } from 'vitest';
import { getOperation, getOperationCapability } from '../catalog/registry.js';
import { LearnerLearningResolveInputSchema, LearnerReviewRequestInputSchema } from '../index.js';

const UUID = '00000000-0000-0000-0000-000000000001';

describe('learner.learning.resolve registration', () => {
  it('is registered as an opTaskOnly, mutating, write operation', () => {
    const op = getOperation('learner.learning.resolve');
    expect(op).toBeDefined();
    expect(op?.stepType).toBe('learner');
    expect(op?.group).toBe('learning');
    expect(op?.opTaskOnly).toBe(true);
    expect(op?.mutates).toBe(true);
    expect(op?.accessMode).toBe('write');
  });

  it('reuses the existing learner.learning capability group (no new profile entry)', () => {
    const cap = getOperationCapability('learner.learning.resolve');
    expect(cap?.capabilityGroupId).toBe('learner.learning');
    expect(getOperationCapability('learner.learning.record')?.capabilityGroupId).toBe(
      'learner.learning',
    );
  });

  it('accepts ratify/reject and nothing else', () => {
    expect(
      LearnerLearningResolveInputSchema.safeParse({ learningId: UUID, action: 'ratify' }).success,
    ).toBe(true);
    expect(
      LearnerLearningResolveInputSchema.safeParse({ learningId: UUID, action: 'reject' }).success,
    ).toBe(true);
    expect(
      LearnerLearningResolveInputSchema.safeParse({ learningId: UUID, action: 'dismiss' }).success,
    ).toBe(false);
    expect(
      LearnerLearningResolveInputSchema.safeParse({ learningId: 'not-a-uuid', action: 'ratify' })
        .success,
    ).toBe(false);
  });
});

describe('learner.review.request campaignId routing contract', () => {
  it('campaignId alone is a valid request (skillSlug optional, resolved from the campaign)', () => {
    const parsed = LearnerReviewRequestInputSchema.safeParse({
      campaignId: UUID,
      rationale: 'Re-run the campaign-end synthesis.',
    });
    expect(parsed.success).toBe(true);
  });

  it('campaignId + matching skillSlug is allowed', () => {
    const parsed = LearnerReviewRequestInputSchema.safeParse({
      campaignId: UUID,
      skillSlug: 'kaggle-competition-optimizer',
      rationale: 'Re-run the campaign-end synthesis.',
    });
    expect(parsed.success).toBe(true);
  });

  it('campaignId conflicts with runId and taskId (synthesis, not run diagnosis)', () => {
    expect(
      LearnerReviewRequestInputSchema.safeParse({
        campaignId: UUID,
        runId: '00000000-0000-0000-0000-000000000002',
        rationale: 'x',
      }).success,
    ).toBe(false);
    expect(
      LearnerReviewRequestInputSchema.safeParse({
        campaignId: UUID,
        taskId: 'train',
        rationale: 'x',
      }).success,
    ).toBe(false);
  });

  it('still requires at least one target', () => {
    expect(LearnerReviewRequestInputSchema.safeParse({ rationale: 'x' }).success).toBe(false);
  });
});
