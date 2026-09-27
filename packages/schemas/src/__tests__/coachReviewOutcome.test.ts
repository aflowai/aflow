import { describe, expect, it } from 'vitest';
import {
  CoachReviewOutcomeSchema,
  COACH_REVIEW_OUTCOME_JSON_SCHEMA,
} from '../cybernetic/coachReviewOutcome.js';
import {
  LearnerObservationRecordInputSchema,
  LearnerObservationRecordOutputSchema,
  LearnerProposeArtifactUpdateInputSchema,
  LearnerProposeArtifactUpdateOutputSchema,
} from '../operations/learner.js';

const A_RATIONALE = 'Eval pass with no anomalous metrics observed.';
const PROP_ID = '11111111-1111-1111-1111-111111111111';
const OBS_ID = '22222222-2222-2222-2222-222222222222';

describe('CoachReviewOutcomeSchema', () => {
  it('accepts a valid silent outcome', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      rationale: A_RATIONALE,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid with_proposals outcome', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'with_proposals',
      proposalIds: [PROP_ID],
      rationale: 'Failed eval, two procedure issues attributed to task graph.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid observation_only outcome', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'observation_only',
      observationId: OBS_ID,
      rationale: 'CV-LB gap anomalous but no clear category to attribute.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects with_proposals without any proposalIds', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'with_proposals',
      proposalIds: [],
      rationale: A_RATIONALE,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('proposalIds'))).toBe(true);
    }
  });

  it('rejects observation_only without observationId', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'observation_only',
      rationale: A_RATIONALE,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('observationId'))).toBe(true);
    }
  });

  it('rejects silent with proposalIds set', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      proposalIds: [PROP_ID],
      rationale: A_RATIONALE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects silent with observationId set', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      observationId: OBS_ID,
      rationale: A_RATIONALE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects rationale shorter than 20 chars', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      rationale: 'ok',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown outcome value', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'maybe_propose',
      rationale: A_RATIONALE,
    });
    expect(result.success).toBe(false);
  });

  it('JSON Schema export has the same enum values', () => {
    const schema = COACH_REVIEW_OUTCOME_JSON_SCHEMA as {
      properties: { outcome: { enum: string[] } };
    };
    expect(schema.properties.outcome.enum).toEqual([
      'with_proposals',
      'observation_only',
      'learning_only',
      'silent',
    ]);
  });
});

describe('LearnerObservationRecordInputSchema', () => {
  it('accepts a minimal valid input', () => {
    const result = LearnerObservationRecordInputSchema.safeParse({
      reason: 'anomalous_metrics',
      summary: 'CV accuracy 0.949 vs LB 0.775 — gap 0.174 vs baseline 0.07',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing reason', () => {
    const result = LearnerObservationRecordInputSchema.safeParse({
      summary: 'something looked off',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty summary', () => {
    const result = LearnerObservationRecordInputSchema.safeParse({
      reason: 'anomalous_metrics',
      summary: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown reason', () => {
    const result = LearnerObservationRecordInputSchema.safeParse({
      reason: 'guessing',
      summary: 'something',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed digestSha256', () => {
    const result = LearnerObservationRecordInputSchema.safeParse({
      reason: 'anomalous_metrics',
      summary: 'short',
      digestSha256: 'not-a-hash',
    });
    expect(result.success).toBe(false);
  });
});

describe('LearnerObservationRecordOutputSchema', () => {
  it('accepts a valid output', () => {
    const result = LearnerObservationRecordOutputSchema.safeParse({
      observationId: OBS_ID,
      observationRef: '/coach/observations/22222222-2222-2222-2222-222222222222.json',
    });
    expect(result.success).toBe(true);
  });
});

describe('LearnerProposeArtifactUpdateInputSchema', () => {
  const ARTIFACT_ID = '33333333-3333-3333-3333-333333333333';
  const DRAFT_ID = '44444444-4444-4444-4444-444444444444';
  const SESSION_ID = '55555555-5555-5555-5555-555555555555';

  it('accepts a minimal valid input', () => {
    const result = LearnerProposeArtifactUpdateInputSchema.safeParse({
      artifactId: ARTIFACT_ID,
      draftId: DRAFT_ID,
      diffSummary: 'Switch chart axis to time-series',
      evidence: { sourceSessionIds: [SESSION_ID] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts the full input with triggeringRunId + reflection refs', () => {
    const result = LearnerProposeArtifactUpdateInputSchema.safeParse({
      artifactId: ARTIFACT_ID,
      draftId: DRAFT_ID,
      diffSummary: 'Fix runner-reported chart legend overflow',
      triggeringRunId: SESSION_ID,
      evidence: {
        sourceSessionIds: [SESSION_ID],
        reflectionRefs: [
          {
            runId: 'run-1',
            taskId: 'render-card',
            reflectionField: 'blockers',
            excerpt: 'Legend overlaps the data points',
          },
        ],
        digestRef: '/coach/digests/abc.json',
        digestSha256: 'a'.repeat(64),
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-uuid artifactId / draftId', () => {
    expect(
      LearnerProposeArtifactUpdateInputSchema.safeParse({
        artifactId: 'not-a-uuid',
        draftId: DRAFT_ID,
        diffSummary: 'x',
        evidence: { sourceSessionIds: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects empty diffSummary', () => {
    expect(
      LearnerProposeArtifactUpdateInputSchema.safeParse({
        artifactId: ARTIFACT_ID,
        draftId: DRAFT_ID,
        diffSummary: '',
        evidence: { sourceSessionIds: [SESSION_ID] },
      }).success,
    ).toBe(false);
  });
});

describe('LearnerProposeArtifactUpdateOutputSchema', () => {
  it("returns stagedChangeId + status='proposed'", () => {
    const result = LearnerProposeArtifactUpdateOutputSchema.safeParse({
      stagedChangeId: '11111111-1111-1111-1111-111111111111',
      status: 'proposed',
    });
    expect(result.success).toBe(true);
  });

  it("rejects status other than 'proposed' (artifact_update is always require_operator)", () => {
    // determineAuthorityLevel always returns require_operator for
    // artifact_update; the output schema pins this so a future handler
    // refactor that tries to claim auto_applied fails loud.
    expect(
      LearnerProposeArtifactUpdateOutputSchema.safeParse({
        stagedChangeId: '11111111-1111-1111-1111-111111111111',
        status: 'auto_applied',
      }).success,
    ).toBe(false);
  });
});
