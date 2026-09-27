import { describe, it, expect } from 'vitest';
import { CoachLearningSchema, TaskContextSpecSchema } from '../cybernetic/index.js';
import { WorkflowLearningSchema } from '../operations/workflow/learning.js';
import { LearnerLearningRecordInputSchema } from '../operations/learner.js';

const workflowLearning = {
  id: 'l-1',
  category: 'worked' as const,
  kind: 'search_heuristic' as const,
  observation: 'log-transform improved rmsle',
  evidence: { runId: '00000000-0000-0000-0000-000000000001' },
  confidence: 'high' as const,
  source: 'agent' as const,
};

const coachLearning = {
  learningId: '00000000-0000-0000-0000-00000000d001',
  coachSessionId: '00000000-0000-0000-0000-000000000099',
  scope: {
    kind: 'campaign' as const,
    campaignId: '00000000-0000-0000-0000-0000000000aa',
    skillSlug: 'kaggle-competition-optimizer',
  },
  kind: 'heuristic' as const,
  statement: 'log-transform the target',
  evidence: { citations: [{ runId: '00000000-0000-0000-0000-000000000001' }] },
  confidence: 'high' as const,
  createdAt: '2026-06-07T00:00:00.000Z',
};

describe('learning task targeting', () => {
  it('CoachLearning appliesTo stays optional and round-trips both variants', () => {
    expect(CoachLearningSchema.parse(coachLearning).appliesTo).toBeUndefined();
    expect(
      CoachLearningSchema.parse({ ...coachLearning, appliesTo: { kind: 'skill' } }).appliesTo,
    ).toEqual({ kind: 'skill' });
    expect(
      CoachLearningSchema.parse({
        ...coachLearning,
        appliesTo: { kind: 'tasks', taskIds: ['execute'] },
      }).appliesTo,
    ).toEqual({ kind: 'tasks', taskIds: ['execute'] });
  });

  it('CoachLearning appliesTo tasks requires 1-20 taskIds', () => {
    expect(
      CoachLearningSchema.safeParse({
        ...coachLearning,
        appliesTo: { kind: 'tasks', taskIds: [] },
      }).success,
    ).toBe(false);
    expect(
      CoachLearningSchema.safeParse({
        ...coachLearning,
        appliesTo: { kind: 'tasks', taskIds: Array.from({ length: 21 }, (_, i) => `t-${i}`) },
      }).success,
    ).toBe(false);
  });

  it('WorkflowLearning appliesToTaskIds stays optional and caps at 20', () => {
    expect(WorkflowLearningSchema.parse(workflowLearning).appliesToTaskIds).toBeUndefined();
    expect(
      WorkflowLearningSchema.parse({ ...workflowLearning, appliesToTaskIds: ['execute'] })
        .appliesToTaskIds,
    ).toEqual(['execute']);
    expect(
      WorkflowLearningSchema.safeParse({
        ...workflowLearning,
        appliesToTaskIds: Array.from({ length: 21 }, (_, i) => `t-${i}`),
      }).success,
    ).toBe(false);
  });

  it('learner.learning.record input accepts optional appliesTo', () => {
    const base = {
      scope: coachLearning.scope,
      kind: 'heuristic' as const,
      statement: 'log-transform the target',
      evidence: coachLearning.evidence,
      confidence: 'high' as const,
    };
    expect(LearnerLearningRecordInputSchema.parse(base).appliesTo).toBeUndefined();
    expect(
      LearnerLearningRecordInputSchema.parse({
        ...base,
        appliesTo: { kind: 'tasks', taskIds: ['execute'] },
      }).appliesTo,
    ).toEqual({ kind: 'tasks', taskIds: ['execute'] });
  });
});

describe('TaskContextSpec.learnings', () => {
  it("defaults to 'active' and accepts 'none'", () => {
    expect(TaskContextSpecSchema.parse({}).learnings).toBe('active');
    expect(TaskContextSpecSchema.parse({ learnings: 'none' }).learnings).toBe('none');
  });

  it("rejects 'all'", () => {
    expect(TaskContextSpecSchema.safeParse({ learnings: 'all' }).success).toBe(false);
  });
});
