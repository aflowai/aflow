import { z } from 'zod';

import { cappedText } from '../modelOutput/cappedText.js';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  DigestCitationSchema,
  IssueCategorySchema,
  CoachProposableOpSchema,
} from '../cybernetic/stagedChange.js';
import { AnomalyKindSchema, AnomalySeveritySchema } from '../cybernetic/anomalyReport.js';
import { SkillDiagnosticSchema } from '../cybernetic/skillValidity.js';
import { ReflectionFieldSchema } from '../cybernetic/runnerReflection.js';
import {
  COACH_LEARNING_SUPERSEDES_MAX,
  CoachLearningAppliesToSchema,
} from '../cybernetic/coachLearning.js';
import { LearnerLearningResolveCandidateRegistration } from './learnerLearningResolveCandidate.js';
import { LearnerLearningResolveRegistration } from './learnerLearningResolve.js';
import { LearnerLearningConsolidateRegistration } from './learnerLearningConsolidate.js';

// ============================================================================
// Operation Input/Output Schemas
// ============================================================================

// --- learner.propose.workflow_change ---

export const LearnerProposeWorkflowChangeInputSchema = z.object({
  targetSlug: z.string().min(1).max(64),
  ops: z.array(CoachProposableOpSchema).min(1).max(10),
  rationale: z.string().min(1).max(1000),
  confidence: z.enum(['low', 'medium', 'high']),
  diagnosis: z
    .object({
      issueCategory: IssueCategorySchema,
    })
    .optional(),
  evidence: z.object({
    sourceSessionIds: z.array(z.string().uuid()),
    /** Reflection-origin references cited by this proposal (104e §4.1). */
    reflectionRefs: z
      .array(
        z.object({
          runId: z.string(),
          taskId: z.string(),
          reflectionField: ReflectionFieldSchema,
          excerpt: z.string().max(500),
        }),
      )
      .max(10)
      .optional(),
    digestRef: z.string().max(512).optional(),
    digestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    digestCitations: z.array(DigestCitationSchema).max(20).optional(),
    validityDiagnostics: z.array(SkillDiagnosticSchema).max(200).optional(),
    warrant: z
      .object({
        claim: z.string().min(1).max(500),
        evidenceSummary: z.string().min(1).max(1000),
        warrant: z.string().min(1).max(500),
        causeStatus: z.enum(['observed', 'inferred']),
        confirmation: z.string().min(1).max(500).optional(),
        expectedEffect: z.string().min(1).max(500),
        metric: z.string().min(1).max(128).optional(),
        evaluationWindowMs: z
          .number()
          .int()
          .min(60 * 1000)
          .optional(),
        risk: z.string().max(500).optional(),
        rollback: z.string().max(500).optional(),
      })
      .optional(),
    artifactRefs: z
      .array(
        z.object({
          targetKind: z.enum(['session', 'run', 'task']),
          targetId: z.string().min(1).max(200),
          path: z.string().min(1).max(300),
          note: cappedText(800, 'A short note on this piece of evidence.').optional(),
        }),
      )
      .max(20)
      .optional(),
  }),
});
export type LearnerProposeWorkflowChangeInput = z.infer<
  typeof LearnerProposeWorkflowChangeInputSchema
>;

export const LearnerProposeWorkflowChangeOutputSchema = z.object({
  stagedChangeId: z.string().uuid(),
  authorityLevel: z.string(),
  status: z.string(),
});
export type LearnerProposeWorkflowChangeOutput = z.infer<
  typeof LearnerProposeWorkflowChangeOutputSchema
>;

// --- learner.flag.pattern ---

export const LearnerFlagPatternInputSchema = z.object({
  patternDescription: z.string().min(1).max(500),
  evidence: z.object({
    sourceSessionIds: z.array(z.string().uuid()),
    observedPatternCount: z.number().int().nonnegative().optional(),
  }),
  suggestedScope: z.string().max(300).optional(),
});
export type LearnerFlagPatternInput = z.infer<typeof LearnerFlagPatternInputSchema>;

export const LearnerFlagPatternOutputSchema = z.object({
  flagId: z.string().uuid(),
  status: z.literal('flagged'),
});
export type LearnerFlagPatternOutput = z.infer<typeof LearnerFlagPatternOutputSchema>;

/**
 * Coach proposes publishing a freshly-generated draft as the new version
 * of a bundle-shipped artifact. The Coach has already called
 * `ui.artifact.generate({ artifactId, prompt, dataSchema })` to produce
 * the `draftId`; this op stages an `artifact_update` proposal that the
 * operator ratifies via the standard `/coach/staged/` route. On
 * ratification, `applyArtifactUpdateOps` promotes the draft to a new
 * published version (mirroring `ui.artifact.publish` SQL).
 *
 * Runtime skills must NOT carry this op in their tool surface — Coach
 * is the only authorized author. Operator-side artifact iteration uses
 * the existing `ui.artifact.generate` + `ui.artifact.publish` pair
 * directly (no proposal).
 */
export const LearnerProposeArtifactUpdateInputSchema = z.object({
  /** UUID of the existing published artifact this proposal refreshes. */
  artifactId: z.string().uuid(),
  /** Draft id produced by the prior `ui.artifact.generate` call. */
  draftId: z.string().uuid(),
  /** Short rationale shown in the operator UI's staged-change list. */
  diffSummary: z.string().min(1).max(2048),
  /** Run that surfaced the defect — usually a runner reflection or a
   *  data-schema validation failure inside a render task. */
  triggeringRunId: z.string().uuid().optional(),
  /** Evidence shape mirrors `learner.propose.workflow_change` — Coach
   *  proposals must cite the source sessions that motivated the
   *  refresh. Diagnosis fields are not required for v1 (the diff
   *  summary + reflection refs carry the rationale). */
  evidence: z.object({
    sourceSessionIds: z.array(z.string().uuid()),
    reflectionRefs: z
      .array(
        z.object({
          runId: z.string(),
          taskId: z.string(),
          reflectionField: ReflectionFieldSchema,
          excerpt: z.string().max(500),
        }),
      )
      .max(10)
      .optional(),
    digestRef: z.string().max(512).optional(),
    digestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    digestCitations: z.array(DigestCitationSchema).max(20).optional(),
    /** Inspect-read provenance — required when artifact.inspect.read shaped
     *  this refresh (validate-outcome enforces it on the session). */
    artifactRefs: z
      .array(
        z.object({
          targetKind: z.enum(['session', 'run', 'task']),
          targetId: z.string().min(1).max(200),
          path: z.string().min(1).max(300),
          note: cappedText(800, 'A short note on this piece of evidence.').optional(),
        }),
      )
      .max(20)
      .optional(),
  }),
});
export type LearnerProposeArtifactUpdateInput = z.infer<
  typeof LearnerProposeArtifactUpdateInputSchema
>;

export const LearnerProposeArtifactUpdateOutputSchema = z.object({
  stagedChangeId: z.string().uuid(),
  /** Always `'proposed'` — `determineAuthorityLevel` routes every
   *  artifact_update to require_operator, so auto-apply is impossible. */
  status: z.literal('proposed'),
});
export type LearnerProposeArtifactUpdateOutput = z.infer<
  typeof LearnerProposeArtifactUpdateOutputSchema
>;

// --- learner.propose.anomaly ---

export const LearnerProposeAnomalyInputSchema = z.object({
  kind: AnomalyKindSchema,
  severity: AnomalySeveritySchema,
  summary: z.string().min(1).max(500),
  detail: z.string().min(1).max(2000),
  evidence: z.object({
    sessionIds: z.array(z.string().uuid()),
  }),
  affectedWorkflowSlug: z.string().max(64).optional(),
});
export type LearnerProposeAnomalyInput = z.infer<typeof LearnerProposeAnomalyInputSchema>;

export const LearnerProposeAnomalyOutputSchema = z.object({
  anomalyId: z.string().uuid(),
  severity: z.string(),
});
export type LearnerProposeAnomalyOutput = z.infer<typeof LearnerProposeAnomalyOutputSchema>;

import { CoachObservationReasonSchema } from '../cybernetic/coachObservation.js';

export const LearnerObservationRecordInputSchema = z.object({
  /** Closed-set reason for the observation. */
  reason: CoachObservationReasonSchema,
  /** Short summary of what was noticed (≤ 500 chars, required). */
  summary: z.string().min(1).max(500),
  /** Optional longer detail (≤ 2000 chars). */
  detail: z.string().max(2000).optional(),
  /** Pointer to the persisted Coach digest, when one was assembled. */
  digestRef: z.string().max(512).optional(),
  /** sha256 of the persisted digest, paired with digestRef. */
  digestSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type LearnerObservationRecordInput = z.infer<typeof LearnerObservationRecordInputSchema>;

export const LearnerObservationRecordOutputSchema = z.object({
  observationId: z.string().uuid(),
  observationRef: z.string(),
});
export type LearnerObservationRecordOutput = z.infer<typeof LearnerObservationRecordOutputSchema>;

import { CoachReviewOutcomeSchema } from '../cybernetic/coachReviewOutcome.js';

/**
 * Input is the structured CoachReviewOutcome the agent built up across its
 * review session. The orchestrator validates this against `inputZod` before
 * the handler even runs — invalid shapes fail at dispatch time, route via
 * onFailure back to the review step.
 *
 * The handler additionally cross-checks proposalIds against the
 * `/coach/staged/{id}.json` docs and observationId against the
 * `/coach/observations/{id}.json` doc actually persisted in this Coach
 * session, so the agent cannot fake IDs.
 */
export const LearnerReviewFinalizeInputSchema = CoachReviewOutcomeSchema;
export type LearnerReviewFinalizeInput = z.infer<typeof CoachReviewOutcomeSchema>;

export const LearnerReviewFinalizeOutputSchema = z.object({
  /** True if validation + cross-check passed. */
  finalized: z.literal(true),
  /** Echo of the validated outcome. */
  outcome: z.enum(['with_proposals', 'observation_only', 'learning_only', 'silent']),
  /** Number of proposals cited and confirmed. */
  proposalCount: z.number().int().nonnegative(),
  /** Whether an observation was cited and confirmed. */
  hasObservation: z.boolean(),
  learningCount: z.number().int().nonnegative().default(0),
});
export type LearnerReviewFinalizeOutput = z.infer<typeof LearnerReviewFinalizeOutputSchema>;

export const LearnerReviewRetriggerInputSchema = z.object({
  /** Workflow run UUID to re-review. Must be a terminal run (completed/failed/cancelled). */
  runId: z.string().uuid(),
  /**
   * Optional workflow slug. If omitted, the handler resolves it from the run record.
   * Provide it explicitly when you want to assert a particular workflow.
   */
  workflowSlug: z.string().min(1).max(64).optional(),
});
export type LearnerReviewRetriggerInput = z.infer<typeof LearnerReviewRetriggerInputSchema>;

export const LearnerReviewRequestInputSchema = z
  .object({
    /** Run to review. Optional when `skillSlug` covers cross-run review. */
    runId: z.string().uuid().nullable().optional(),
    /** Skill the review should focus on. */
    skillSlug: z.string().min(1).max(64).nullable().optional(),
    /** Task narrowing. Only meaningful when `runId` is also set. */
    taskId: z.string().min(1).max(120).nullable().optional(),
    /**
     * Ended campaign to (re-)synthesize. Routes the request through the
     * campaign-end synthesis review (`campaign_end_review`) instead of a
     * run diagnosis, so an operator can summon the synthesis for a campaign
     * that already ended — including one already synthesized once. A
     * still-active campaign is rejected: end it first.
     */
    campaignId: z.string().uuid().nullable().optional(),
    /**
     * Operator-selected focus areas, fed verbatim into
     * `CoachReviewContext.target.focusAreas` so the prompt can tailor.
     */
    focusAreas: z
      .array(
        z.enum([
          'task_breakdown',
          'context_spec',
          'eval_suite',
          'tool_capabilities',
          'skill_scope',
          'platform_issues',
        ]),
      )
      .max(6)
      .nullable()
      .optional()
      .default([])
      .transform((v) => v ?? []),
    /** Free-form reason captured on the context for audit display. */
    rationale: z.string().min(1).max(1000),
    /**
     * Whether the caller is the Helmsman (`'helmsman'`) or an operator
     * (`'operator'`). The handler maps this to the correct
     * `trigger.kind` on the `CoachReviewContext`. Defaulting to
     * `'operator'` keeps the schema usable from the UI without an
     * explicit caller field.
     */
    requestedByKind: z.enum(['helmsman', 'operator']).default('operator'),
  })
  .refine(
    (input) => {
      const hasRun = typeof input.runId === 'string' && input.runId.length > 0;
      const hasSkill = typeof input.skillSlug === 'string' && input.skillSlug.length > 0;
      const hasTask = typeof input.taskId === 'string' && input.taskId.length > 0;
      const hasCampaign = typeof input.campaignId === 'string' && input.campaignId.length > 0;
      return hasRun || hasSkill || hasTask || hasCampaign;
    },
    {
      message:
        'learner.review.request requires at least one of runId, skillSlug, taskId, or campaignId',
    },
  )
  .refine(
    (input) => {
      const hasCampaign = typeof input.campaignId === 'string' && input.campaignId.length > 0;
      const hasRun = typeof input.runId === 'string' && input.runId.length > 0;
      const hasTask = typeof input.taskId === 'string' && input.taskId.length > 0;
      return !hasCampaign || (!hasRun && !hasTask);
    },
    {
      message:
        'campaignId requests a campaign-end synthesis, not a run diagnosis — it cannot be ' +
        'combined with runId or taskId (skillSlug is allowed and must match the campaign).',
    },
  );
export type LearnerReviewRequestInput = z.infer<typeof LearnerReviewRequestInputSchema>;

export const LearnerReviewRequestOutputSchema = z.object({
  /** Coach session id dispatched (null when the gate suppressed the request). */
  coachSessionId: z.string().uuid().nullable(),
  /** Skill the Coach is reviewing (resolved from runId if input omitted slug). */
  skillSlug: z.string(),
  /** Whether the gate accepted the request or suppressed it. */
  status: z.enum(['dispatched', 'skipped']),
  /** Why the gate skipped or accepted. */
  reason: z.string().optional(),
  /** Persisted CoachReviewContext id when status === 'dispatched'. */
  contextId: z.string().uuid().nullable().optional(),
});
export type LearnerReviewRequestOutput = z.infer<typeof LearnerReviewRequestOutputSchema>;

export const LearnerReviewRetriggerOutputSchema = z.object({
  /** Coach session ID dispatched (null if the run could not be re-reviewed). */
  coachSessionId: z.string().uuid().nullable(),
  /** Workflow slug the Coach is reviewing. */
  workflowSlug: z.string(),
  /** Why the retrigger was accepted or skipped. */
  status: z.enum(['dispatched', 'skipped']),
  reason: z.string().optional(),
});
export type LearnerReviewRetriggerOutput = z.infer<typeof LearnerReviewRetriggerOutputSchema>;

export const LearnerLearningRecordInputSchema = z.object({
  scope: z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('campaign'),
        campaignId: z.string().uuid(),
        skillSlug: z.string().min(1).max(128),
      })
      .strict(),
    z
      .object({
        kind: z.literal('skill'),
        skillSlug: z.string().min(1).max(128),
      })
      .strict(),
    z
      .object({
        kind: z.literal('space'),
        spaceId: z.string().uuid(),
      })
      .strict(),
  ]),
  kind: z.enum(['observation', 'heuristic', 'constraint', 'parameter_range']),
  appliesTo: CoachLearningAppliesToSchema.optional().describe(
    'Which workflow tasks this learning is for; absent = all tasks.',
  ),
  /** The claim. Required, ≤800 chars. */
  statement: z.string().min(1).max(800),
  /** Run this learning was synthesized from (optional for cross-run summaries). */
  runId: z.string().uuid().optional(),
  evidence: z.object({
    digestRef: z.string().max(512).optional(),
    digestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    citations: z
      .array(
        z.object({
          runId: z.string().uuid(),
          taskId: z.string().min(1).max(200).optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
  confidence: z.enum(['low', 'medium', 'high']),
  supersedes: z.array(z.string().uuid()).max(COACH_LEARNING_SUPERSEDES_MAX).optional(),
  promotedFrom: z
    .object({
      campaignId: z.string().uuid().optional(),
      candidateLedgerEntryId: z.string().uuid(),
    })
    .optional(),
});
export type LearnerLearningRecordInput = z.infer<typeof LearnerLearningRecordInputSchema>;

export const LearnerLearningRecordOutputSchema = z.object({
  /** Persisted learning id. */
  learningId: z.string().uuid(),
  /** Authority level the handler assigned (derived from scope). */
  authorityLevel: z.enum(['auto_record', 'stage_for_review']),
  status: z.enum(['auto_recorded', 'proposed', 'ratified', 'rejected']),
});
export type LearnerLearningRecordOutput = z.infer<typeof LearnerLearningRecordOutputSchema>;

// ============================================================================
// learner.propose.withdraw — Coach retracts its own still-proposed change
// ============================================================================

/**
 * When the Coach proposes an approximation (because the schema cannot
 * express its real fix), then correctly escalates to a platform_issue,
 * the stale approximation would stay open and confuse the operator. This op
 * lets the Coach retract its OWN still-`proposed` StagedChange; the finalize
 * coherence check teaches when to use it.
 */
export const LearnerProposeWithdrawInputSchema = z.object({
  stagedChangeId: z.string().uuid(),
  /** Why the proposal is being retracted (e.g. superseded by a platform_issue). */
  reason: z.string().min(1).max(2000),
});
export type LearnerProposeWithdrawInput = z.infer<typeof LearnerProposeWithdrawInputSchema>;

export const LearnerProposeWithdrawOutputSchema = z.object({
  stagedChangeId: z.string().uuid(),
  status: z.literal('withdrawn'),
});
export type LearnerProposeWithdrawOutput = z.infer<typeof LearnerProposeWithdrawOutputSchema>;

// ============================================================================
// Operation Registrations
// ============================================================================

export const LearnerOperationRegistrations: OperationRegistration[] = [
  // --- learner.propose.* ---
  {
    stepType: 'learner',
    group: 'propose',
    verb: 'workflow_change',
    name: 'Propose Workflow Change',
    actionLabel: 'Staging workflow refinement\u2026',
    semanticDescription:
      'Stage a refinement to an existing workflow. Creates a StagedChange document ' +
      'under /learner/staged/ with typed change operations. Authority level is determined ' +
      'by the change kind, confidence, and governance directives.',
    tags: ['learner', 'propose', 'workflow', 'cybernetic'],
    groupDisplayName: 'Learner Proposals',
    groupDescription:
      'Propose workflow refinements, flag patterns, and report anomalies through the Learner feedback loop.',
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Stage a refinement proposal for an existing workflow.',
      whenToUse: [
        'After reviewing execution artifacts and identifying an improvement',
        'When a task goal, context spec, or iteration policy should be adjusted',
        'When outcome thresholds need calibration based on observed performance',
      ],
      whenNotToUse: [
        'Creating a brand new workflow — that is Executive-owned',
        'Flagging a pattern without a specific change — use learner.flag.pattern',
      ],
      pitfalls: [
        'Ops that modify eval criteria (outcome thresholds) always stage for review — evals cannot gate changes to their own success criteria',
        'High confidence required for auto-apply; medium/low always stage for review',
        'If the schema cannot express your intended fix (e.g. a binding kind that does not exist), do NOT approximate with goal-text or context-spec edits — file learner.flag.anomaly as a platform_issue and withdraw any approximation via learner.propose.withdraw',
      ],
      minimalExampleInput: {
        targetSlug: 'lead-scoring-optimizer',
        ops: [
          {
            op: 'update_task_goal',
            taskId: 'train-model',
            newGoal: 'Train calibrated ensemble model',
          },
        ],
        rationale: 'Calibrated ensembles consistently improved the target metric on recent runs',
        confidence: 'high',
        evidence: { sourceSessionIds: ['00000000-0000-0000-0000-000000000000'] },
      },
    },
    accessMode: 'write',
    inputZod: LearnerProposeWorkflowChangeInputSchema,
    outputZod: LearnerProposeWorkflowChangeOutputSchema,
  },
  {
    stepType: 'learner',
    group: 'propose',
    verb: 'withdraw',
    name: 'Withdraw Proposal',
    actionLabel: 'Withdrawing proposal…',
    semanticDescription:
      'Retract a still-proposed StagedChange this Coach authored. Use when a proposal ' +
      'is superseded (e.g. the root cause turned out to be a platform issue) so stale ' +
      'approximations never reach the operator. Only `proposed` status can be withdrawn; ' +
      'ratified/rejected decisions are immutable.',
    tags: ['learner', 'propose', 'withdraw', 'cybernetic'],
    groupDisplayName: 'Learner Proposals',
    groupDescription:
      'Propose workflow refinements, flag patterns, and report anomalies through the Learner feedback loop.',
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Retract your own still-proposed change (supersession).',
      whenToUse: [
        'You filed a platform_issue for the same failure a pending refinement tried to approximate',
        'New evidence invalidated a proposal you staged earlier in this session or a prior one',
      ],
      whenNotToUse: [
        'Reversing an operator decision — ratified/rejected/dismissed proposals are immutable',
      ],
      pitfalls: [
        'Withdrawal is neutral — it does NOT teach via fingerprint suppression; re-propose properly when you know the right fix',
      ],
      minimalExampleInput: {
        stagedChangeId: '00000000-0000-0000-0000-000000000000',
        reason: 'Superseded by platform_issue: the binding system cannot express this fix.',
      },
    },
    accessMode: 'write',
    inputZod: LearnerProposeWithdrawInputSchema,
    outputZod: LearnerProposeWithdrawOutputSchema,
  },
  {
    stepType: 'learner',
    group: 'propose',
    verb: 'artifact_update',
    name: 'Propose Artifact Update',
    actionLabel: 'Staging artifact refresh…',
    semanticDescription:
      'Stage a refresh of a bundle-shipped UI artifact. The Coach has already ' +
      'called ui.artifact.generate to produce a draftId; this op stages an artifact_update ' +
      'proposal carrying the draftId + diff rationale. On operator ratification, the apply ' +
      'path promotes the draft to a new published version (same SQL as ui.artifact.publish). ' +
      'Authority is ALWAYS require_operator — rendered output is user-facing and there is no ' +
      'automated regression layer for it yet.',
    tags: ['learner', 'propose', 'artifact', 'cybernetic', 'plan-158'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Stage a Coach-authored refresh of a bundle-shipped UI artifact.',
      whenToUse: [
        'Runner reflections cite a rendered card as unhelpful, wrong, or visually broken',
        'Renderer diagnostics flag dataSchema mismatches against the live data shape',
        "Catalog drift makes the bundled card's pinned catalogVersion obsolete",
      ],
      whenNotToUse: [
        'Coach is generating a brand-new artifact — use ui.artifact.generate + a manual publish',
        'The change targets a workflow or eval — use learner.propose.workflow_change',
      ],
      pitfalls: [
        'Always require_operator — never auto-applied regardless of confidence',
        'The draft must already exist (call ui.artifact.generate first)',
        "Coach attribution drift: the draft's artifact_id must match the proposal's",
      ],
      minimalExampleInput: {
        artifactId: '00000000-0000-0000-0000-000000000001',
        draftId: '00000000-0000-0000-0000-000000000002',
        diffSummary: 'Switched chart x-axis to time-series; fixes runner reflection on 2026-05-23.',
        triggeringRunId: '00000000-0000-0000-0000-000000000003',
        evidence: { sourceSessionIds: ['00000000-0000-0000-0000-000000000000'] },
      },
    },
    accessMode: 'write',
    inputZod: LearnerProposeArtifactUpdateInputSchema,
    outputZod: LearnerProposeArtifactUpdateOutputSchema,
  },
  {
    stepType: 'learner',
    group: 'propose',
    verb: 'anomaly',
    name: 'Report Anomaly',
    actionLabel: 'Reporting anomaly\u2026',
    semanticDescription:
      'Report a system anomaly detected during artifact review. Creates an AnomalyReport ' +
      'under /learner/anomalies/. Critical anomalies trigger Executive supervisory sessions.',
    tags: ['learner', 'anomaly', 'cybernetic'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Report a detected system anomaly for tracking and review.',
      whenToUse: [
        'Workflow failing repeatedly (repeated_failure)',
        'Outcome scores trending downward (performance_degradation)',
        'Run cost significantly above historical average (cost_anomaly)',
        'External dependencies down or rate-limited (external_dependency)',
      ],
      whenNotToUse: [
        'Proposing a fix — use learner.propose.workflow_change instead',
        'Flagging a pattern that is not an anomaly — use learner.flag.pattern',
      ],
      pitfalls: ['Severity >= warning emits an entity event for Executive attention'],
      minimalExampleInput: {
        kind: 'repeated_failure',
        severity: 'warning',
        summary: 'Workflow lead-scoring-optimizer failed 3 consecutive runs',
        detail: 'The training step fails with OOM errors on the current dataset size.',
        evidence: { sessionIds: ['00000000-0000-0000-0000-000000000000'] },
        affectedWorkflowSlug: 'lead-scoring-optimizer',
      },
    },
    accessMode: 'write',
    inputZod: LearnerProposeAnomalyInputSchema,
    outputZod: LearnerProposeAnomalyOutputSchema,
  },

  // --- learner.flag.* ---
  {
    stepType: 'learner',
    group: 'flag',
    verb: 'pattern',
    name: 'Flag Pattern',
    actionLabel: 'Flagging pattern\u2026',
    semanticDescription:
      'Flag a recurring pattern for Executive consideration. Creates a StagedChange ' +
      'with kind "pattern_flag" under /learner/staged/. Pattern flags are informational ' +
      'only and always staged for review.',
    tags: ['learner', 'pattern', 'cybernetic'],
    groupDisplayName: 'Learner Flags',
    groupDescription: 'Flag recurring patterns and observations for Executive review.',
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Flag a recurring pattern observed across multiple sessions.',
      whenToUse: [
        'Noticing a pattern that spans multiple workflow runs',
        'Observing user behavior that could inform new workflows',
        'Seeing repeated tool usage patterns that suggest automation opportunities',
      ],
      whenNotToUse: [
        'Have a specific change proposal — use learner.propose.workflow_change',
        'Reporting an anomaly — use learner.propose.anomaly',
      ],
      pitfalls: ['Pattern flags are always staged for review — never auto-applied'],
      minimalExampleInput: {
        patternDescription:
          'Users consistently request feature engineering tips before model training',
        evidence: {
          sourceSessionIds: ['00000000-0000-0000-0000-000000000000'],
          observedPatternCount: 5,
        },
      },
    },
    accessMode: 'write',
    inputZod: LearnerFlagPatternInputSchema,
    outputZod: LearnerFlagPatternOutputSchema,
  },

  {
    stepType: 'learner',
    group: 'review',
    verb: 'finalize',
    name: 'Finalize Coach Review',
    actionLabel: 'Finalizing Coach review\u2026',
    semanticDescription:
      'Validate the structured CoachReviewOutcome and cross-check the cited artifact IDs ' +
      'against actually-persisted proposals and observations for this Coach session. The ' +
      "operation's input schema enforces shape (CoachReviewOutcomeSchema). The handler " +
      'additionally verifies that every proposalId resolves to a /coach/staged/{id}.json ' +
      'doc whose coachSessionId matches this session, and that observationId resolves ' +
      'similarly. Failure routes via onFailure back to the review step with diagnostic ' +
      'feedback in state.outcome_feedback. This is the graph-enforced exit contract for ' +
      'the Coach — no narrative output, no faked IDs.',
    tags: ['learner', 'review', 'cybernetic', 'coach', 'graph-validation'],
    groupDisplayName: 'Coach Review',
    groupDescription: 'Operator-driven Coach review controls and graph-level exit validation.',
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: "Validate Coach's structured outcome and cross-check cited artifact IDs.",
      whenToUse: ['As the post-`review` graph step in the Coach flow definition'],
      whenNotToUse: [
        'Manual operator invocation — this is wired into the Coach graph as the exit gate',
      ],
      pitfalls: [
        'proposalIds must reference docs created in THIS coach session — older proposals are rejected',
        'shape failures (missing rationale, wrong outcome, etc.) auto-fail at dispatch via inputZod',
      ],
      minimalExampleInput: {
        outcome: 'silent',
        rationale: 'Eval pass with no anomalous metrics; nothing to propose.',
      },
    },
    accessMode: 'write',
    inputZod: LearnerReviewFinalizeInputSchema,
    outputZod: LearnerReviewFinalizeOutputSchema,
  },
  {
    stepType: 'learner',
    group: 'review',
    verb: 'retrigger',
    name: 'Re-trigger Coach Review',
    actionLabel: 'Re-running Coach review\u2026',
    semanticDescription:
      'Manually re-trigger a Coach review for an existing terminal workflow run. Bypasses ' +
      "the Coach's activation gate and per-skill rate cap (this is a deliberate operator " +
      'call). Loads directives, run statistics, and the eval result from existing data, ' +
      'then dispatches a fresh Coach session with a unique idempotency key. Useful when ' +
      'iterating on Coach prompts/policies and want to re-review the same run, or when ' +
      'an operator wants a second opinion.',
    tags: ['learner', 'review', 'operator', 'cybernetic', 'coach'],
    groupDisplayName: 'Coach Review',
    groupDescription: 'Operator-driven Coach review controls.',
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Manually re-trigger a Coach review for an existing terminal workflow run.',
      whenToUse: [
        'After updating the Coach prompt or policy and want to see the same run reviewed under the new behavior',
        'Operator wants a second Coach review on a run with no actionable proposal',
        'A prior Coach session failed or produced an invalid outcome',
      ],
      whenNotToUse: [
        'The run is still active — wait for terminal status',
        'You want a different skill reviewed — start a new run of that skill instead',
      ],
      pitfalls: [
        'Bypasses rate cap by design; do not call repeatedly for the same run without intent',
        'Each retrigger dispatches a new Coach session and incurs a separate LLM cost',
      ],
      minimalExampleInput: {
        runId: '00000000-0000-0000-0000-000000000000',
      },
    },
    accessMode: 'write',
    inputZod: LearnerReviewRetriggerInputSchema,
    outputZod: LearnerReviewRetriggerOutputSchema,
  },
  {
    stepType: 'learner',
    group: 'review',
    verb: 'request',
    // A review is dispatched deliberately, by an operator or by a platform
    // workflow — never picked up by an agent mid-conversation. One session
    // reached 33,383 steps because nothing stopped a review from asking for
    // another, and learning about a run is not a move inside it.
    agentTool: false,
    opTaskOnly: true,
    name: 'Request Coach Review',
    actionLabel: 'Dispatching Coach review…',
    semanticDescription:
      'Structured request to dispatch a Coach review. Goes through the standard activation ' +
      'gate (rate cap, cost ceiling, mode × posture policy) and constructs a typed ' +
      'CoachReviewContext. Distinct from learner.review.retrigger, which bypasses the gate ' +
      'as an explicit operator-only escape hatch. Use this from the Helmsman ' +
      "(`requestedByKind: 'helmsman'`) or from operator-driven review surfaces. " +
      'With campaignId, summons the campaign-end synthesis review for an ENDED campaign ' +
      '(re-summon works — each request dispatches fresh); a still-active campaign is rejected.',
    tags: ['learner', 'review', 'cybernetic', 'coach', 'plan-163'],
    groupDisplayName: 'Coach Review',
    groupDescription: 'Operator- and Helmsman-driven Coach review controls.',
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Dispatch a Coach review through the standard activation gate.',
      whenToUse: [
        'Helmsman concludes the user wants a Coach review of a specific run or skill',
        'Operator selects "Review with Coach" from a run / task inspector',
        'A focus-area-narrowed review is desired (e.g. eval_suite, tool_capabilities)',
        'Summoning (or re-summoning) the campaign-end synthesis for an ended campaign (campaignId)',
      ],
      whenNotToUse: [
        'Bypass-gate retrigger is required — use learner.review.retrigger',
        'Run not yet terminal — wait until completed/failed/cancelled',
      ],
      pitfalls: [
        'Rate cap and cost ceiling still apply; result.status === "skipped" is possible',
        'Deliberate evidence tier requires explicit operator rationale; the gate may downgrade it',
        'campaignId requires the campaign to be ENDED — end it first, then request the synthesis',
      ],
      minimalExampleInput: {
        runId: '00000000-0000-0000-0000-000000000000',
        rationale: 'User asked to investigate the failed train task.',
        requestedByKind: 'helmsman',
      },
    },
    accessMode: 'write',
    inputZod: LearnerReviewRequestInputSchema,
    outputZod: LearnerReviewRequestOutputSchema,
  },

  {
    stepType: 'learner',
    group: 'observation',
    verb: 'record',
    name: 'Record Coach Observation',
    actionLabel: 'Recording Coach observation\u2026',
    semanticDescription:
      'Record a typed CoachObservation for a review that produced no actionable proposal. ' +
      'Use ONLY for observations under /coach/observations/{id}.json — do not write narrative ' +
      'review reports. Closed-set reason field; observations accumulate as pattern signal ' +
      'across reviews and never enter the ratification flow.',
    tags: ['learner', 'observation', 'cybernetic', 'coach'],
    groupDisplayName: 'Coach Observations',
    groupDescription:
      'Typed observation records for Coach reviews that produce no actionable proposal.',
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Record a typed observation when a Coach review yields no proposal.',
      whenToUse: [
        'Run completed but metrics looked off (anomalous_metrics) and no clear category fits',
        "Run failed but the digest doesn't carry enough signal to attribute (unattributable_failure)",
        'Digest assembly hit budget pressure (context_pressure) and the operator should know',
      ],
      whenNotToUse: [
        'Have a categorized issue — use learner.propose.workflow_change instead',
        'Need to write a narrative review — do not write narrative reviews; observations are short and structured',
      ],
      pitfalls: [
        'summary is required and capped at 500 chars; pick the diagnostic phrase, not a paragraph',
        'Observations are not actionable; they have no ops and no ratification flow',
      ],
      minimalExampleInput: {
        reason: 'anomalous_metrics',
        summary: 'CV-LB gap 0.174 vs baseline 0.07 despite eval pass on CV criterion',
      },
    },
    accessMode: 'write',
    inputZod: LearnerObservationRecordInputSchema,
    outputZod: LearnerObservationRecordOutputSchema,
  },

  {
    stepType: 'learner',
    group: 'learning',
    verb: 'record',
    name: 'Record Coach Learning',
    actionLabel: 'Recording Coach learning…',
    semanticDescription:
      'Record a durable Coach learning — distinct from observations (anomalies without action) ' +
      'and proposals (workflow / eval mutations). Use for claims the Coach wants to compound ' +
      'across runs / campaigns: heuristics, constraints, parameter ranges, cross-iteration ' +
      'observations. Campaign-scope learnings auto-record (no durable mutation); skill- and ' +
      'space-scope learnings stage for operator review. Candidate ledger entries are ' +
      'PROMOTED into learnings via `promotedFrom`.',
    tags: ['learner', 'learning', 'cybernetic', 'coach', 'plan-163'],
    groupDisplayName: 'Coach Learnings',
    groupDescription:
      'Durable, compounding Coach learning records (heuristics, constraints, ranges).',
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Record a durable Coach learning for cross-run compounding.',
      whenToUse: [
        'Optimization campaign yielded a heuristic worth carrying to the next attempt',
        'A constraint emerged — "approach X consistently fails on Y-shaped inputs"',
        'A parameter range was found to work / not work',
        'Promoting a candidate-ledger entry into a ratified learning',
      ],
      whenNotToUse: [
        'The signal is a one-off anomaly — use learner.observation.record',
        'The signal motivates a workflow mutation — use learner.propose.workflow_change',
        'Authoring a campaign-internal candidate (those live on the campaign ledger, not here)',
      ],
      pitfalls: [
        'Skill / space scope learnings stage for review — they do not auto-apply',
        'evidence.citations must include at least one runId',
        'supersedes lets you replace older learnings on the same scope — use it during sweeps',
      ],
      minimalExampleInput: {
        scope: {
          kind: 'campaign',
          campaignId: '00000000-0000-0000-0000-000000000010',
          skillSlug: 'kaggle-housing',
        },
        kind: 'heuristic',
        statement:
          'Gradient boosting outperformed random forest on this dataset by 0.08 RMSE; default to GBM next iteration.',
        evidence: {
          citations: [{ runId: '00000000-0000-0000-0000-000000000030' }],
        },
        confidence: 'medium',
      },
    },
    accessMode: 'write',
    inputZod: LearnerLearningRecordInputSchema,
    outputZod: LearnerLearningRecordOutputSchema,
  },

  LearnerLearningResolveCandidateRegistration,
  LearnerLearningResolveRegistration,
  LearnerLearningConsolidateRegistration,
];
