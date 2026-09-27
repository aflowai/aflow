import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CoachReviewOutcomeKindSchema = z.enum([
  'with_proposals',
  'observation_only',
  'learning_only',
  'silent',
]);
export type CoachReviewOutcomeKind = z.infer<typeof CoachReviewOutcomeKindSchema>;

// ---------------------------------------------------------------------------

export const CoachReviewFacetKindSchema = z.enum(['correctness', 'trajectory']);
export type CoachReviewFacetKind = z.infer<typeof CoachReviewFacetKindSchema>;

/**
 * One typed facet section of the SINGLE review envelope (never a separate
 * Coach session). `proposalIds`/`learningIds` attribute the review's outputs
 * to the facet that surfaced them; cross-field refinements pin them as
 * subsets of the outcome-level arrays.
 */
export const CoachReviewFacetSchema = z
  .object({
    facet: CoachReviewFacetKindSchema,
    /** What this facet concluded — substantive (≥ 20 chars). */
    summary: z.string().min(20).max(1000),
    /** Proposals surfaced by THIS facet (subset of outcome.proposalIds). */
    proposalIds: z.array(z.string().uuid()).max(20).default([]),
    /** Learnings surfaced by THIS facet (subset of outcome.learningIds). */
    learningIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict();
export type CoachReviewFacet = z.infer<typeof CoachReviewFacetSchema>;

export const CoachReviewOutcomeSchema = z
  .object({
    outcome: CoachReviewOutcomeKindSchema,
    /** UUIDs returned by `learner.propose.workflow_change` calls in this review. */
    proposalIds: z.array(z.string().uuid()).max(20).default([]),
    /** UUID returned by `learner.observation.record` when outcome='observation_only'. */
    observationId: z.string().uuid().optional(),
    learningIds: z.array(z.string().uuid()).max(20).default([]),
    facets: z.array(CoachReviewFacetSchema).max(2).default([]),
    /** Why the Coach chose this outcome — must be substantive (≥ 20 chars). */
    rationale: z.string().min(20).max(2000),
  })
  .refine(
    (o) => {
      if (o.outcome === 'with_proposals') return o.proposalIds.length >= 1;
      return true;
    },
    {
      message: "outcome='with_proposals' requires at least one proposalId",
      path: ['proposalIds'],
    },
  )
  .refine(
    (o) => {
      if (o.outcome === 'observation_only') {
        return typeof o.observationId === 'string' && o.observationId.length > 0;
      }
      return true;
    },
    {
      message: "outcome='observation_only' requires observationId",
      path: ['observationId'],
    },
  )
  .refine(
    (o) => {
      // observation_only forbids proposalIds — the name claims no proposals.
      if (o.outcome === 'observation_only') return o.proposalIds.length === 0;
      return true;
    },
    {
      message: "outcome='observation_only' must not include proposalIds",
      path: ['proposalIds'],
    },
  )
  .refine(
    (o) => {
      if (o.outcome === 'learning_only') {
        return (
          o.learningIds.length >= 1 && o.proposalIds.length === 0 && o.observationId === undefined
        );
      }
      return true;
    },
    {
      message:
        "outcome='learning_only' requires ≥1 learningId and forbids proposalIds / observationId",
      path: ['learningIds'],
    },
  )
  .refine(
    (o) => {
      if (o.outcome === 'silent') {
        return (
          o.proposalIds.length === 0 && o.observationId === undefined && o.learningIds.length === 0
        );
      }
      return true;
    },
    {
      message: "outcome='silent' must not include proposalIds, observationId, or learningIds",
      path: ['outcome'],
    },
  )
  .refine((o) => new Set(o.facets.map((f) => f.facet)).size === o.facets.length, {
    message: 'facets must contain at most one section per facet kind',
    path: ['facets'],
  })
  .refine(
    (o) => {
      const proposals = new Set(o.proposalIds);
      const learnings = new Set(o.learningIds);
      return o.facets.every(
        (f) =>
          f.proposalIds.every((id) => proposals.has(id)) &&
          f.learningIds.every((id) => learnings.has(id)),
      );
    },
    {
      message:
        'facet proposalIds/learningIds must be subsets of the outcome-level proposalIds/learningIds',
      path: ['facets'],
    },
  );

export type CoachReviewOutcome = z.infer<typeof CoachReviewOutcomeSchema>;

// ---------------------------------------------------------------------------
// JSON Schema (for ai.agent.turn finalOutputSchema)
// ---------------------------------------------------------------------------

/**
 * Hand-derived JSON Schema for `CoachReviewOutcomeSchema`. The agent runtime
 * passes `finalOutputSchema` to the model as a JSON Schema; we don't run
 * Zod inside the model, so we provide both representations and keep them
 * in sync. The Zod schema is the source of truth for the inline handler;
 * the JSON Schema is the source of truth for the model contract.
 *
 * Cross-field invariants (with_proposals → ≥1 proposalIds, etc.) are not
 * expressible in plain JSON Schema; the model is told about them via
 * `completionPrompt`, and the orchestrator's Zod parse on the final
 * result enforces them on the ingest path.
 */
export const COACH_REVIEW_OUTCOME_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['outcome', 'rationale'],
  additionalProperties: false,
  properties: {
    outcome: {
      type: 'string',
      enum: ['with_proposals', 'observation_only', 'learning_only', 'silent'],
      description:
        'with_proposals: ≥1 proposalIds (learnings + observation optional); observation_only: observationId set, no proposalIds (learnings optional); learning_only: ≥1 learningIds, no proposalIds, no observationId; silent: nothing — clean run.',
    },
    proposalIds: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      maxItems: 20,
      default: [],
      description:
        "UUIDs returned by learner.propose.workflow_change calls. Required when outcome='with_proposals'.",
    },
    observationId: {
      type: 'string',
      format: 'uuid',
      description:
        "UUID returned by learner.observation.record. Required when outcome='observation_only'.",
    },
    learningIds: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      maxItems: 20,
      default: [],
      description:
        "UUIDs returned by learner.learning.record calls. Required when outcome='learning_only'; additive on with_proposals / observation_only.",
    },
    facets: {
      type: 'array',
      maxItems: 2,
      default: [],
      description:
        'Typed facet sections of this ONE review. A run review MUST include a ' +
        "{ facet: 'correctness' } section (the per-run read). Include a { facet: 'trajectory' } section " +
        'ONLY when the brief carried a campaign-trajectory block (campaign boundaries) — it states the ' +
        'direction read (peak vs recent, learnings to keep/kill). Attribute each proposalId/learningId ' +
        'to the facet that surfaced it; eval-change proposals ride whichever facet surfaced them. ' +
        'At most one section per kind.',
      items: {
        type: 'object',
        required: ['facet', 'summary'],
        additionalProperties: false,
        properties: {
          facet: { type: 'string', enum: ['correctness', 'trajectory'] },
          summary: {
            type: 'string',
            minLength: 20,
            maxLength: 1000,
            description: 'What this facet concluded — substantive.',
          },
          proposalIds: {
            type: 'array',
            items: { type: 'string', format: 'uuid' },
            maxItems: 20,
            default: [],
            description: 'Subset of the outcome-level proposalIds this facet surfaced.',
          },
          learningIds: {
            type: 'array',
            items: { type: 'string', format: 'uuid' },
            maxItems: 20,
            default: [],
            description: 'Subset of the outcome-level learningIds this facet surfaced.',
          },
        },
      },
    },
    rationale: {
      type: 'string',
      minLength: 20,
      maxLength: 2000,
      description: 'Why this outcome was chosen — substantive, not a placeholder.',
    },
  },
};
