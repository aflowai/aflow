import { describe, it, expect } from 'vitest';
import {
  ActiveCandidateLearningSchema,
  ActiveDurableLearningSchema,
  CoachLearningSchema,
} from '../cybernetic/index.js';
import { WorkflowLearningSchema } from '../operations/workflow/learning.js';
import { WorkflowRunResultLearningItemSchema } from '../operations/workflow/runResult.js';

const DETAIL_REF = '/coach/learnings/log-transform-notes.md';

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

describe('detailRef round-trip', () => {
  it('WorkflowLearning preserves detailRef and stays optional', () => {
    expect(WorkflowLearningSchema.parse(workflowLearning).detailRef).toBeUndefined();
    expect(
      WorkflowLearningSchema.parse({ ...workflowLearning, detailRef: DETAIL_REF }).detailRef,
    ).toBe(DETAIL_REF);
  });

  it('WorkflowLearning rejects a detailRef beyond 512 chars', () => {
    const parsed = WorkflowLearningSchema.safeParse({
      ...workflowLearning,
      detailRef: 'x'.repeat(513),
    });
    expect(parsed.success).toBe(false);
  });

  it('CoachLearning preserves detailRef and stays optional', () => {
    expect(CoachLearningSchema.parse(coachLearning).detailRef).toBeUndefined();
    expect(CoachLearningSchema.parse({ ...coachLearning, detailRef: DETAIL_REF }).detailRef).toBe(
      DETAIL_REF,
    );
  });

  it('ActiveLearning durable and candidate variants carry detailRef', () => {
    const durable = ActiveDurableLearningSchema.parse({
      kind: 'durable',
      learningId: '00000000-0000-0000-0000-00000000d001',
      statement: 'log-transform the target',
      learningKind: 'heuristic',
      confidence: 'high',
      scopeKind: 'campaign',
      detailRef: DETAIL_REF,
    });
    expect(durable.detailRef).toBe(DETAIL_REF);

    const candidate = ActiveCandidateLearningSchema.parse({
      kind: 'candidate',
      runId: 'run-1',
      learningId: 'l-1',
      category: 'worked',
      observation: 'log-transform improved rmsle',
      confidence: 'high',
      detailRef: DETAIL_REF,
    });
    expect(candidate.detailRef).toBe(DETAIL_REF);
  });

  it('WorkflowRunResult learning items derive detailRef from WorkflowLearning', () => {
    const item = WorkflowRunResultLearningItemSchema.parse({
      id: 'l-1',
      kind: 'search_heuristic',
      category: 'worked',
      observation: 'log-transform improved rmsle',
      confidence: 'high',
      detailRef: DETAIL_REF,
    });
    expect(item.detailRef).toBe(DETAIL_REF);
  });
});
