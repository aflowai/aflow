import { z } from 'zod';
import { CandidateLearningStatusSchema } from './campaign.js';
import { WORKFLOW_LEARNING_TEXT_MAX_CHARS } from '../operations/workflow/learning.js';

// ============================================================================
// Optimization — campaign trajectory
// ============================================================================

/** Compact learnings-history entry (statement + ledger status), never the full payload. */
export const TrajectoryLearningEntrySchema = z
  .object({
    /** The learning's observation, quoted verbatim — the cap is derived
     *  from the source field's. */
    statement: z.string().min(1).max(WORKFLOW_LEARNING_TEXT_MAX_CHARS),
    /** Typed learning kind (`WorkflowLearning.kind`). */
    kind: z.string().min(1).max(64),
    status: CandidateLearningStatusSchema,
  })
  .strict();
export type TrajectoryLearningEntry = z.infer<typeof TrajectoryLearningEntrySchema>;

export const CampaignTrajectoryEvidenceSchema = z
  .object({
    campaignId: z.string().uuid(),
    /** The campaign's materialized objective (183f chain: a copy of the typed goal). */
    objective: z
      .object({
        metricKey: z.string().min(1).max(128),
        direction: z.enum(['maximize', 'minimize']),
        threshold: z.number().optional(),
      })
      .strict(),
    /** Score series in run order (`workflow_runs.score` over the campaign). */
    series: z.array(z.number()).max(500),
    /** Best-by-direction over the series; absent when the series is empty. */
    peak: z.number().optional(),
    /** Learnings history — compact candidate-ledger entries, capped at load. */
    learnings: z.array(TrajectoryLearningEntrySchema).max(50).default([]),
  })
  .strict();
export type CampaignTrajectoryEvidence = z.infer<typeof CampaignTrajectoryEvidenceSchema>;

// ============================================================================
// Process — case-distribution stub (183f §3 stub depth)
// ============================================================================

export const CaseClassDistributionSchema = z
  .object({
    /**
     * The input class the cases are grouped by. Today runs carry no input
     * taxonomy, so every run falls in `'default'`; a run whose
     * `metadata.inputClass` is a string lands in that class (the forward
     * seam for real input classification).
     */
    inputClass: z.string().min(1).max(64),
    runs: z.number().int().positive(),
    /** Goal-acceptance pass rate over the class (eval verdict, else run status). */
    passRate: z.number().min(0).max(1),
  })
  .strict();
export type CaseClassDistribution = z.infer<typeof CaseClassDistributionSchema>;

export const CaseFailureModeSchema = z
  .object({
    /** Deterministic failure category: `taskId[:errorCode]` of the failed task. */
    category: z.string().min(1).max(200),
    count: z.number().int().positive(),
  })
  .strict();
export type CaseFailureMode = z.infer<typeof CaseFailureModeSchema>;

export const CaseDistributionEvidenceSchema = z
  .object({
    /** Recent-runs window actually aggregated (≤ the window knob). */
    sampleSize: z.number().int().nonnegative(),
    classes: z.array(CaseClassDistributionSchema).max(20).default([]),
    failureModes: z.array(CaseFailureModeSchema).max(20).default([]),
  })
  .strict();
export type CaseDistributionEvidence = z.infer<typeof CaseDistributionEvidenceSchema>;

// ============================================================================
// The (mode)-parameterized union
// ============================================================================

export const CoachBreadthEvidenceSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('optimization'),
      trajectory: CampaignTrajectoryEvidenceSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('process'),
      caseDistribution: CaseDistributionEvidenceSchema,
    })
    .strict(),
]);
export type CoachBreadthEvidence = z.infer<typeof CoachBreadthEvidenceSchema>;
