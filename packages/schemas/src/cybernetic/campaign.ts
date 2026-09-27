import { z } from 'zod';
// Deep import (not the `operations/workflow.js` barrel): the campaign-op
// schemas (`operations/workflow/campaignOps.ts`) import THIS module, so going
// through the barrel here would create an ESM evaluation cycle (barrel →
// campaignOps → campaign → barrel) and a TDZ crash on first import.
import { WorkflowLearningSchema } from '../operations/workflow/learning.js';

// ============================================================================

export const CampaignStatusSchema = z.enum(['active', 'ended']);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const CampaignEndedReasonSchema = z.enum(['goal_met', 'explicit', 'budget', 'inactivity']);
export type CampaignEndedReason = z.infer<typeof CampaignEndedReasonSchema>;

export const CampaignConfigChangeSchema = z
  .object({
    changedAt: z.string().datetime(),
    /** The mutated (non-identity, mutable) config keys. */
    changedKeys: z.array(z.string().min(1).max(64)).min(1).max(40),
    /** Prior values of `changedKeys` only (not the whole config). */
    previous: z.record(z.unknown()),
    /** New values of `changedKeys` only. */
    next: z.record(z.unknown()),
  })
  .strict();
export type CampaignConfigChange = z.infer<typeof CampaignConfigChangeSchema>;

/**
 * Fixed score-metric key for a PROCESS (objective-goal) campaign. A process run
 * earns no produced numeric metric, so its campaign is scored on completion:
 * `scoreFinalize` writes a 1/0 completion-default score under this metric key.
 * Every campaign carries a NOT-NULL `scoreMetricKey`; a numeric campaign uses
 * its goal's `metricKey`, a process campaign uses this sentinel. There is no
 * nullable-metric path.
 */
export const PROCESS_CAMPAIGN_SCORE_METRIC = 'completion';

export const CampaignSchema = z
  .object({
    campaignId: z.string().uuid(),
    spaceId: z.string().uuid(),
    /** The skill's workflow slug — runs link to the campaign via `campaign_id`. */
    workflowSlug: z.string().min(1).max(128),
    /** Stable campaign-identity key derived from the typed goal (`deriveGoalRef`). */
    goalRef: z.string().min(1).max(256),
    /** The campaign's score metric: a numeric goal's `metricKey`, or the
     * `PROCESS_CAMPAIGN_SCORE_METRIC` sentinel for a process (objective) campaign. */
    scoreMetricKey: z.string().min(1).max(128),
    /** A numeric goal's `direction`, or `maximize` for a process campaign (1=success). */
    direction: z.enum(['maximize', 'minimize']),
    config: z.record(z.unknown()).optional(),
    contractHash: z.string().min(1).max(128).optional(),
    configHistory: z.array(CampaignConfigChangeSchema).optional(),
    status: CampaignStatusSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    endedReason: CampaignEndedReasonSchema.optional(),
  })
  .strict();
export type Campaign = z.infer<typeof CampaignSchema>;

// ============================================================================

/**
 * `pending` — written on run complete (a fast-inject learning is also
 * co-injected into the next run; block-until-vetted kinds wait here).
 * `reviewed-promoted` — Coach promoted it to a durable `CoachLearning`.
 * `reviewed-rejected` / `reviewed-noise` — Coach rejected it: stops injecting
 * into the Runner, stays visible to the Coach as **negative evidence** (so it
 * won't re-propose the same bad learning).
 */
export const CandidateLearningStatusSchema = z.enum([
  'pending',
  'reviewed-promoted',
  'reviewed-rejected',
  'reviewed-noise',
]);
export type CandidateLearningStatus = z.infer<typeof CandidateLearningStatusSchema>;

export const CompactEvalOutcomeSchema = z
  .object({
    verdict: z.enum(['pass', 'fail', 'partial', 'error']).optional(),
    overallScore: z.number().optional(),
    /** The run's primary `workflow_runs.score` at candidate-write time. */
    score: z.number().optional(),
    regressionDetected: z.boolean().optional(),
  })
  .strict();
export type CompactEvalOutcome = z.infer<typeof CompactEvalOutcomeSchema>;

export const CandidateLearningRefSchema = z
  .object({
    runId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const CandidateLearningSchema = z
  .object({
    entryId: z.string().uuid(),
    spaceId: z.string().uuid(),
    skillSlug: z.string().min(1).max(128),
    /** Present when the producing run belonged to a campaign. */
    campaignId: z.string().uuid().optional(),
    /** Workflow run that produced the learning (text `run_id`). */
    runId: z.string().min(1).max(128),
    learning: WorkflowLearningSchema,
    status: CandidateLearningStatusSchema.default('pending'),
    compactEvalOutcome: CompactEvalOutcomeSchema.optional(),
    refs: z.array(CandidateLearningRefSchema).max(10).optional(),
    createdAt: z.string().datetime(),
    reviewedAt: z.string().datetime().optional(),
    coachSessionId: z.string().uuid().optional(),
  })
  .strict();
export type CandidateLearning = z.infer<typeof CandidateLearningSchema>;

// ============================================================================

/** A score derived from a real produced metric (the numeric-goal path). */
const MetricScoreProvenanceSchema = z
  .object({
    kind: z.literal('metric'),
    metricKey: z.string().min(1).max(128),
    rawValue: z.number(),
    normalizedScore: z.number().optional(),
    direction: z.enum(['maximize', 'minimize']),
    evalResultRef: z.string().max(512).optional(),
    whyPrimary: z.string().max(300).optional(),
  })
  .strict();

/**
 * A naive fallback score for a campaign run that produced no real metric — the
 * run's terminal outcome (completed ⇒ 1, else ⇒ 0). Distinguishable from a real
 * metric score on read; a future real scorer overrides it (additive, no rebuild).
 */
const CompletionDefaultScoreProvenanceSchema = z
  .object({
    kind: z.literal('completion_default'),
    terminalStatus: z.enum(['completed', 'failed', 'cancelled']),
  })
  .strict();

export const WorkflowRunScoreProvenanceSchema = z.discriminatedUnion('kind', [
  MetricScoreProvenanceSchema,
  CompletionDefaultScoreProvenanceSchema,
]);
export type WorkflowRunScoreProvenance = z.infer<typeof WorkflowRunScoreProvenanceSchema>;
