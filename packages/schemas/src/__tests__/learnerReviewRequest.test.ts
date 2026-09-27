import { describe, it, expect } from 'vitest';
import { LearnerReviewRequestInputSchema } from '../operations/learner.js';

describe('LearnerReviewRequestInputSchema', () => {
  it('accepts a Helmsman call with runId set and the other two narrowing fields null', () => {
    const result = LearnerReviewRequestInputSchema.safeParse({
      runId: '00000000-0000-0000-0000-000000000001',
      skillSlug: null,
      taskId: null,
      focusAreas: null,
      rationale: 'User asked to investigate the failed train task.',
      requestedByKind: 'helmsman',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.runId).toBe('00000000-0000-0000-0000-000000000001');
    // focusAreas defaults to [] via transform when null.
    expect(result.data.focusAreas).toEqual([]);
  });

  it('accepts a call with only skillSlug set (cross-run review)', () => {
    const result = LearnerReviewRequestInputSchema.safeParse({
      runId: null,
      skillSlug: 'my-skill',
      taskId: null,
      rationale: 'Recurring noisy eval — audit the suite.',
      requestedByKind: 'operator',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when runId, skillSlug, and taskId are all null/absent', () => {
    const result = LearnerReviewRequestInputSchema.safeParse({
      runId: null,
      skillSlug: null,
      taskId: null,
      rationale: 'somehow asked without any narrowing field',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when runId is empty string (not just null)', () => {
    const result = LearnerReviewRequestInputSchema.safeParse({
      runId: null,
      skillSlug: '',
      taskId: null,
      rationale: 'empty slug should not count as set',
    });
    expect(result.success).toBe(false);
  });

  it('treats missing focusAreas as []', () => {
    const result = LearnerReviewRequestInputSchema.parse({
      runId: '00000000-0000-0000-0000-000000000001',
      rationale: 'no focus areas specified',
    });
    expect(result.focusAreas).toEqual([]);
  });

  it('accepts focusAreas as an empty array', () => {
    const result = LearnerReviewRequestInputSchema.parse({
      runId: '00000000-0000-0000-0000-000000000001',
      focusAreas: [],
      rationale: 'no focus areas specified',
    });
    expect(result.focusAreas).toEqual([]);
  });

  it('accepts focusAreas with valid entries', () => {
    const result = LearnerReviewRequestInputSchema.parse({
      runId: '00000000-0000-0000-0000-000000000001',
      focusAreas: ['task_breakdown', 'eval_suite'],
      rationale: 'narrow to specific concerns',
    });
    expect(result.focusAreas).toEqual(['task_breakdown', 'eval_suite']);
  });

  it('defaults requestedByKind to "operator" when omitted', () => {
    const result = LearnerReviewRequestInputSchema.parse({
      runId: '00000000-0000-0000-0000-000000000001',
      rationale: 'operator UI default',
    });
    expect(result.requestedByKind).toBe('operator');
  });
});
