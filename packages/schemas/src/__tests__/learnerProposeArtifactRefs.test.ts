import { describe, it, expect } from 'vitest';
import { LearnerProposeWorkflowChangeInputSchema } from '../operations/learner.js';

const RUN_ID = '00000000-0000-0000-0000-000000000001';

function validInput(): Record<string, unknown> {
  return {
    targetSlug: 'kaggle-housing',
    ops: [
      {
        op: 'update_task_goal',
        taskId: 'train',
        newGoal: 'Train calibrated ensemble model',
      },
    ],
    rationale: 'CV-LB gap suggests calibration helps.',
    confidence: 'medium',
    diagnosis: { issueCategory: 'procedure' },
    evidence: {
      sourceSessionIds: [RUN_ID],
      digestRef: '/coach/digests/' + RUN_ID + '.json',
      digestSha256: 'a'.repeat(64),
      digestCitations: [{ runId: RUN_ID }],
      warrant: {
        claim: 'Train task needs ensemble calibration',
        evidenceSummary: 'Reflection cited large CV-LB gap.',
        warrant: 'Calibrated ensembles close such gaps.',
        causeStatus: 'observed',
        expectedEffect: 'next run reduces gap below 0.05',
      },
    },
  };
}

describe('LearnerProposeWorkflowChangeInputSchema — artifactRefs (Plan 163 §10.3)', () => {
  it('accepts a proposal with artifactRefs[]', () => {
    const input = validInput();
    (input.evidence as Record<string, unknown>)['artifactRefs'] = [
      {
        targetKind: 'run',
        targetId: RUN_ID,
        path: 'run/tasks/train/reflection',
        note: 'reflection cited the calibration gap directly',
      },
    ];
    const r = LearnerProposeWorkflowChangeInputSchema.safeParse(input);
    expect(r.success).toBe(true);
  });

  it('accepts a proposal without artifactRefs (optional)', () => {
    const r = LearnerProposeWorkflowChangeInputSchema.safeParse(validInput());
    expect(r.success).toBe(true);
  });

  it('rejects unknown targetKind in artifactRefs', () => {
    const input = validInput();
    (input.evidence as Record<string, unknown>)['artifactRefs'] = [
      { targetKind: 'workflow', targetId: RUN_ID, path: 'run/header' },
    ];
    const r = LearnerProposeWorkflowChangeInputSchema.safeParse(input);
    expect(r.success).toBe(false);
  });

  it('caps artifactRefs at 20 entries', () => {
    const input = validInput();
    (input.evidence as Record<string, unknown>)['artifactRefs'] = Array.from(
      { length: 21 },
      () => ({ targetKind: 'run', targetId: RUN_ID, path: 'run/header' }),
    );
    const r = LearnerProposeWorkflowChangeInputSchema.safeParse(input);
    expect(r.success).toBe(false);
  });

  it('round-trips artifactRefs through parse', () => {
    const input = validInput();
    (input.evidence as Record<string, unknown>)['artifactRefs'] = [
      { targetKind: 'task', targetId: 'train', path: 'task/reflection' },
    ];
    const r = LearnerProposeWorkflowChangeInputSchema.parse(input);
    expect(r.evidence.artifactRefs).toEqual([
      { targetKind: 'task', targetId: 'train', path: 'task/reflection' },
    ]);
  });
});
