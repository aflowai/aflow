import { z } from 'zod';

import { SkillDiagnosticSchema } from './skillValidity.js';
import { CoachBreadthEvidenceSchema } from './coachBreadth.js';

// ============================================================================

export const CoachReviewTriggerKindSchema = z.enum([
  'eval_signal',
  'maturity_signal',
  'directive_sampled',
  'trajectory_signal',
  'validity_signal',
  'agent_signal',
  'training_review',
  'regression_review',
  'terminal_failure_review',
  'helmsman_requested_review',
  'operator_requested_review',
  'scheduled_supervisory_review',
  'iteration_batch_review',
  'campaign_end_review',
  'eval_suite_audit',
]);
export type CoachReviewTriggerKind = z.infer<typeof CoachReviewTriggerKindSchema>;

// ============================================================================

// ============================================================================

/**
 * Skill mode hint for the Coach. `project` is reserved per §8.5 — its
 * full runtime is not built; Phase 2 defaults project-mode skills to
 * `interventionLevel: 'silent'` until §8.5 lands.
 */
export const CoachSkillModeSchema = z.enum(['optimization', 'process', 'project']);
export type CoachSkillMode = z.infer<typeof CoachSkillModeSchema>;

// ============================================================================

export const CoachFocusAreaSchema = z.enum([
  'task_breakdown',
  'context_spec',
  'eval_suite',
  'tool_capabilities',
  'skill_scope',
  'platform_issues',
]);
export type CoachFocusArea = z.infer<typeof CoachFocusAreaSchema>;

// ============================================================================

/**
 * The measured outcome of a recently-applied ratified proposal on this skill:
 * the warrant's `expectedEffect` (what the Coach claimed would happen) paired
 * with the causal substrate's measured lift (what actually happened — Plan
 * 104e §4.6 `causal_measurements`). Fed into the NEXT review so the Coach can
 * see "my last change did/didn't move the metric", stop re-proposing
 * ineffective fixes, and escalate `procedure → platform_issue` when a
 * skill-side fix demonstrably failed. Evidence only — no auto-revert.
 */
export const AppliedChangeOutcomeSchema = z.object({
  proposalId: z.string().min(1).max(120),
  ratifiedAt: z.string().datetime(),
  /** Issue category captured at ratification (from the measurement metadata). */
  issueCategory: z.string().max(64).optional(),
  /** Proposal kind + summary from the staged record, when still resolvable. */
  kind: z.string().max(64).optional(),
  summary: z.string().max(300).optional(),
  /** The warrant's claimed effect (`evidence.warrant.expectedEffect`). */
  expectedEffect: z.string().max(500).optional(),
  metric: z.string().max(128).optional(),
  measured: z.object({
    baselineAvg: z.number().optional(),
    postAvg: z.number().optional(),
    delta: z.number().optional(),
    baselineSamples: z.number().int().nonnegative(),
    postSamples: z.number().int().nonnegative(),
    /** True once the post window elapsed and the delta was finalized. */
    finalized: z.boolean(),
  }),
});
export type AppliedChangeOutcome = z.infer<typeof AppliedChangeOutcomeSchema>;

// ============================================================================
// CoachReviewContext envelope
// ============================================================================

export const CoachReviewContextSchema = z
  .object({
    /** Globally unique context identifier (UUID v4). */
    contextId: z.string().uuid(),

    /** Space the review runs in. */
    spaceId: z.string().uuid(),

    /** Tenant the space belongs to. */
    tenantId: z.string().min(1),

    /** Coach session that consumes this context (linked back at activation). */
    coachSessionId: z.string().uuid(),

    trigger: z.object({
      kind: CoachReviewTriggerKindSchema,
      /**
       * For operator/helmsman-requested reviews, who asked. `userId` for
       * operators, `'helmsman'` for the cybernetic helmsman, `'cron'`
       * for scheduled reviews.
       */
      requestedBy: z.string().min(1).max(120).optional(),
      /**
       * Short free-form reason the gate captured at trigger time, used as
       * operator-facing audit context (e.g. "K=3 consecutive eval breaches").
       */
      rationale: z.string().max(1000).optional(),
      /**
       * `true` ONLY when the activation gate was deliberately bypassed by
       * a manual retrigger (`learner.review.retrigger` with `force: true`).
       * Used for the audit-trail badge in the Coach Surface.
       */
      bypassesGate: z.boolean().default(false),
    }),

    target: z
      .object({
        skillSlug: z.string().min(1).max(64).optional(),
        runId: z.string().uuid().optional(),
        taskId: z.string().min(1).max(120).optional(),
        /**
         * The campaign a campaign-keyed review reads against. For
         * `campaign_end_review` it identifies the campaign being synthesized;
         * `runId` then points at the campaign's last run, not a run under
         * diagnosis.
         */
        campaignId: z.string().uuid().optional(),
        focusAreas: z.array(CoachFocusAreaSchema).default([]),
      })
      .refine((t) => t.skillSlug || t.runId || t.taskId, {
        message: 'target requires at least one of skillSlug, runId, or taskId',
      }),

    /**
     * Skill mode (`optimization` | `process` | `project`). Read from the
     * skill manifest at gate time; undefined for triggers that don't have
     * a concrete skill (e.g. space-level scheduled reviews). Informational —
     * drives breadth-evidence resolution, not review posture.
     */
    skillMode: CoachSkillModeSchema.optional(),

    validityDiagnostics: z.array(SkillDiagnosticSchema).max(200).optional(),

    appliedChangeOutcomes: z.array(AppliedChangeOutcomeSchema).max(20).optional(),

    breadthEvidence: CoachBreadthEvidenceSchema.optional(),

    /**
     * Recent failures the gate loaded for cross-review feedback. Counts
     * + ids only — the proposal handler dereferences full failure detail
     * on demand. Capped to keep the persisted context small.
     */
    priorFailures: z
      .object({
        /** Recent `entity.coach.apply_failed` event ids (cross-review envelope). */
        recentRatificationErrors: z.array(z.string()).max(5).default([]),
        /** Recent `entity.coach.preview_failed` event ids (telemetry; for operator audit only). */
        recentApplyPreviewFailures: z.array(z.string()).max(5).default([]),
        /** Counts of prior observations grouped by reason. */
        recentObservationsByReason: z
          .record(z.string(), z.number().int().nonnegative())
          .default({}),
      })
      .default({
        recentRatificationErrors: [],
        recentApplyPreviewFailures: [],
        recentObservationsByReason: {},
      }),

    /** When the context was assembled (ISO 8601). */
    createdAt: z.string().datetime(),
  })
  .strict();

export type CoachReviewContext = z.infer<typeof CoachReviewContextSchema>;

// ============================================================================
// Storage path
// ============================================================================

export function coachReviewContextDocPath(coachSessionId: string): string {
  return `/coach/contexts/${coachSessionId}.json`;
}
