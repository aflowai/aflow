import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  CoachReviewOutcomeSchema,
  COACH_REVIEW_OUTCOME_JSON_SCHEMA,
} from '../cybernetic/coachReviewOutcome.js';

const RATIONALE = 'Run failed at render-card; correctness facet carries the diagnosis.';
const SUMMARY = 'Per-run evidence: render-card rejected the cardData shape.';

describe('CoachReviewOutcomeSchema.facets (Plan 183a Phase 4)', () => {
  it('accepts an envelope with both facet sections', () => {
    const p1 = randomUUID();
    const l1 = randomUUID();
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'with_proposals',
      proposalIds: [p1],
      learningIds: [l1],
      facets: [
        { facet: 'correctness', summary: SUMMARY, proposalIds: [p1] },
        {
          facet: 'trajectory',
          summary: 'Recent mean sits below the campaign peak; kill the CV-gap heuristic.',
          learningIds: [l1],
        },
      ],
      rationale: RATIONALE,
    });
    expect(result.success).toBe(true);
  });

  it('facets default to [] (legacy envelopes still parse)', () => {
    const result = CoachReviewOutcomeSchema.parse({
      outcome: 'silent',
      rationale: 'Clean run, no regression, nothing to record here.',
    });
    expect(result.facets).toEqual([]);
  });

  it('rejects two sections of the same facet kind (one envelope, typed sections)', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      facets: [
        { facet: 'correctness', summary: SUMMARY },
        { facet: 'correctness', summary: SUMMARY },
      ],
      rationale: RATIONALE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a facet claiming a proposalId the outcome does not carry', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'with_proposals',
      proposalIds: [randomUUID()],
      facets: [{ facet: 'correctness', summary: SUMMARY, proposalIds: [randomUUID()] }],
      rationale: RATIONALE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than two facet sections', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      facets: [
        { facet: 'correctness', summary: SUMMARY },
        { facet: 'trajectory', summary: SUMMARY },
        { facet: 'correctness', summary: SUMMARY },
      ],
      rationale: RATIONALE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown facet kind (V2 ships exactly two — no measurement facet)', () => {
    const result = CoachReviewOutcomeSchema.safeParse({
      outcome: 'silent',
      facets: [{ facet: 'measurement', summary: SUMMARY }],
      rationale: RATIONALE,
    });
    expect(result.success).toBe(false);
  });

  it('JSON Schema export carries the facets contract for the model', () => {
    const schema = COACH_REVIEW_OUTCOME_JSON_SCHEMA as {
      properties: {
        facets: { items: { properties: { facet: { enum: string[] } } }; maxItems: number };
      };
    };
    expect(schema.properties.facets.maxItems).toBe(2);
    expect(schema.properties.facets.items.properties.facet.enum).toEqual([
      'correctness',
      'trajectory',
    ]);
  });
});
