import { describe, it, expect } from 'vitest';
import {
  LearnerLearningRecordInputSchema,
  LearnerProposeArtifactUpdateInputSchema,
} from '../operations/learner.js';

const RUN_ID = '00000000-0000-0000-0000-000000000001';
const ARTIFACT_ID = '00000000-0000-0000-0000-000000000002';

describe('Plan 201 — Coach evidence is citation-only (no persisted digest)', () => {
  it('learner.learning.record accepts evidence without digestRef/digestSha256', () => {
    const result = LearnerLearningRecordInputSchema.safeParse({
      scope: { kind: 'skill', skillSlug: 'kaggle-housing' },
      kind: 'heuristic',
      statement: 'GBM beat RF by 0.08 RMSE; default to GBM.',
      evidence: { citations: [{ runId: RUN_ID }] },
      confidence: 'medium',
    });
    expect(result.success).toBe(true);
  });

  it('learner.propose.artifact_update accepts artifactRefs (inspect-read provenance)', () => {
    const result = LearnerProposeArtifactUpdateInputSchema.safeParse({
      artifactId: ARTIFACT_ID,
      draftId: '00000000-0000-0000-0000-000000000003',
      diffSummary: 'Convert y-axis cents → dollars to match the legend.',
      evidence: {
        sourceSessionIds: [RUN_ID],
        artifactRefs: [{ targetKind: 'run', targetId: RUN_ID, path: 'tasks/render-card/output' }],
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.evidence.artifactRefs).toHaveLength(1);
  });
});
