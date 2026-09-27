/**
 * Eval batch operations (Plan 269 D7/D17) — the Helmsman-permitted batch
 * slice of the eval plane. `eval.batch.run` spends money and is invoked only
 * on explicit operator request; the reads narrate batch state. Skill runs
 * never see any `eval.*` operation (`isEvalPlaneOperation` — the subject
 * must not see the ruler), and batch cancellation is an operator-only REST
 * action (`POST /spaces/:spaceId/eval-batches/:batchId/cancel`),
 * deliberately absent from this registry.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  EvalBatchProvenanceManifestSchema,
  EvalBatchStatusSchema,
  EvalBatchSummarySchema,
  EvalCaseResultDispositionSchema,
  EvalCaseTrialVerdictSchema,
} from '../eval/evalBatch.js';
import { TrialOutcomeClassSchema } from '../eval/trialOutcome.js';
import {
  EvalBatchComparisonSchema,
  EvalBatchDeltaSchema,
  EvalGraduationCandidateSchema,
} from '../eval/evalBatchCompare.js';
import { JudgeScorecardSchema } from '../eval/judgeScorecard.js';

// ============================================================================
// eval.batch.run
// ============================================================================

export const EvalBatchRunInputSchema = z.object({
  workflowSlug: z.string().min(1).max(128).describe('The skill to measure.'),
  datasetVersion: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Golden dataset version to run; omit for the latest version.'),
  trialsPerCase: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Trials per case. Defaults to 1 (smoke batch); use >= 3 for baseline batches.'),
  costCeilingCents: z
    .number()
    .int()
    .positive()
    .describe(
      'Hard spend ceiling in cents — dispatch halts and the batch fails when crossed. ' +
        'Operator-supplied; ask the operator for a budget before launching.',
    ),
  validationSliceSize: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe(
      'How many graded trials the batch samples uniformly at completion into the ' +
        'validation label queue (the only stream that can mint scorecard labels). ' +
        'Defaults to a small fraction of cases × trials with a floor; 0 opts out.',
    ),
  notes: z.string().max(2000).optional().describe('Why this batch is being run, for the record.'),
});
export type EvalBatchRunInput = z.infer<typeof EvalBatchRunInputSchema>;

export const EvalBatchPreflightSchema = z.object({
  perRunMedianCents: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe('Median cost of the skill’s recent production runs; null with no cost history.'),
  sampleSize: z
    .number()
    .int()
    .nonnegative()
    .describe('How many recent runs the median derives from.'),
  estimatedCostCents: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe('median × cases × trials; null with no cost history.'),
  costCeilingCents: z.number().int().positive(),
  /**
   * Which models the batch is about to use, resolved before it spends.
   *
   * The subject's model and the judge's are set in three different places —
   * the space default, the agent definition, the case's own criterion — so
   * before this the only way to learn what a run measured was to read its
   * provenance manifest afterwards, having already paid for it.
   */
  models: z
    .object({
      subject: z
        .array(z.object({ scope: z.string().max(200), modelRef: z.string().max(200) }))
        .max(50),
      judges: z.array(z.string().max(200)).max(50),
    })
    .optional(),
});
export type EvalBatchPreflight = z.infer<typeof EvalBatchPreflightSchema>;

export const EvalBatchRunOutputSchema = z.object({
  batchId: z.string().uuid(),
  workflowSlug: z.string(),
  /** The exact immutable skill revision every trial runs at. */
  workflowRevision: z.number().int().nonnegative(),
  datasetId: z.string().uuid(),
  /** The dataset version whose case set was frozen into the batch. */
  datasetVersion: z.number().int().nonnegative(),
  caseCount: z.number().int().positive(),
  trialsPerCase: z.number().int().positive(),
  totalTrials: z.number().int().positive(),
  status: z
    .literal('queued')
    .describe('The batch engine picks it up asynchronously — check progress with eval.batch.get.'),
  preflight: EvalBatchPreflightSchema,
  summary: z.string().describe('One-paragraph account for relaying to the operator.'),
});
export type EvalBatchRunOutput = z.infer<typeof EvalBatchRunOutputSchema>;

// ============================================================================
// eval.batch.get
// ============================================================================

export const EvalBatchGetInputSchema = z.object({
  batchId: z.string().uuid(),
});
export type EvalBatchGetInput = z.infer<typeof EvalBatchGetInputSchema>;

export const EvalBatchCaseResultViewSchema = z.object({
  caseRevisionId: z.string().uuid(),
  caseTitle: z.string().optional(),
  /** The case's own stratum, so a result reads without a second lookup. */
  scenario: z.string().max(200).optional(),
  tier: z.string().max(60).optional(),
  trial: z.number().int().positive(),
  disposition: EvalCaseResultDispositionSchema,
  verdict: EvalCaseTrialVerdictSchema.optional(),
  /**
   * The stored fold. Readers aggregate on this rather than folding `verdict`
   * themselves — absent only on rows graded before it was stored, which a
   * reader must treat as unknown rather than as a pass or a failure.
   */
  outcomeClass: TrialOutcomeClassSchema.optional(),
  aggregationVersion: z.string().max(64).optional(),
  /**
   * Requirement ids this case declares that no check claims. Carried on the
   * result rather than left to the case editor: a gap that only shows where
   * cases are authored is a gap nobody reads while looking at a green batch.
   */
  uncoveredRequirements: z.array(z.string().min(1).max(64)).max(20).optional(),
  runId: z.string().optional(),
  /** Fraction of binary expectations passed (partial credit, D3). */
  fractionPassed: z.number().min(0).max(1).optional(),
  costCents: z.number().int().nonnegative().optional(),
  gradingError: z.string().optional(),
});
export type EvalBatchCaseResultView = z.infer<typeof EvalBatchCaseResultViewSchema>;

export const EvalBatchHeadViewSchema = z.object({
  batchId: z.string().uuid(),
  workflowSlug: z.string(),
  workflowRevision: z.number().int().nonnegative(),
  datasetId: z.string().uuid(),
  datasetVersion: z.number().int().nonnegative(),
  status: EvalBatchStatusSchema,
  trialsPerCase: z.number().int().positive(),
  caseCount: z.number().int().nonnegative(),
  costCeilingCents: z.number().int().positive(),
  costSpentCents: z.number().int().nonnegative(),
  notes: z.string().optional(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type EvalBatchHeadView = z.infer<typeof EvalBatchHeadViewSchema>;

/** The skill's pinned baseline (D12), as batch reads narrate it. */
export const EvalBaselineViewSchema = z.object({
  batchId: z.string().uuid(),
  pinnedAt: z.string().datetime(),
});
export type EvalBaselineView = z.infer<typeof EvalBaselineViewSchema>;

/**
 * Compact vs-baseline delta folded into eval.batch.get when a baseline is
 * pinned. Deltas read baseline → this batch; the full paired report is
 * eval.batch.compare.
 */
export const EvalBatchBaselineDeltaSchema = z.object({
  baselineBatchId: z.string().uuid(),
  pairedCases: z.number().int().nonnegative(),
  perCaseSuccess: EvalBatchDeltaSchema.optional(),
  trialPass: EvalBatchDeltaSchema.optional(),
  passToFailFlips: z.number().int().nonnegative(),
  failToPassFlips: z.number().int().nonnegative(),
  /** Regression-tier flips demanding transcript investigation. */
  investigationFlips: z.number().int().nonnegative(),
  uncertaintyNote: z.string().max(2000),
});
export type EvalBatchBaselineDelta = z.infer<typeof EvalBatchBaselineDeltaSchema>;

export const EvalBatchGetOutputSchema = z.object({
  batch: EvalBatchHeadViewSchema,
  provenanceManifest: EvalBatchProvenanceManifestSchema,
  /** Terminal scorecard; absent until the batch terminalizes. */
  summary: EvalBatchSummarySchema.optional(),
  caseResults: z.array(EvalBatchCaseResultViewSchema),
  /**
   * D11 judge scorecards for the batch's criteria — present only when
   * validation labels exist for the batch's subject configuration. Advisory:
   * they inform the operator about the judges and never gate anything.
   */
  judgeScorecards: z.array(JudgeScorecardSchema).max(200).optional(),
  /** The skill's pinned baseline; absent when the operator has not pinned one. */
  baseline: EvalBaselineViewSchema.optional(),
  /** True when THIS batch is the pinned baseline. */
  isBaseline: z.boolean().optional(),
  /** Present when a baseline is pinned, this batch is not it, and both are terminal. */
  baselineDelta: EvalBatchBaselineDeltaSchema.optional(),
  /** Capability-tier cases saturating pass^k across consecutive batches (D12 graduation flag). */
  graduationCandidates: z.array(EvalGraduationCandidateSchema).max(200).optional(),
});
export type EvalBatchGetOutput = z.infer<typeof EvalBatchGetOutputSchema>;

// ============================================================================
// eval.batch.compare
// ============================================================================

export const EvalBatchCompareInputSchema = z
  .object({
    batchIdA: z.string().uuid().optional().describe('Earlier/reference batch (deltas read A → B).'),
    batchIdB: z.string().uuid().optional().describe('The batch under judgment.'),
    batchId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "With against: 'baseline' — the batch compared against the skill's pinned baseline.",
      ),
    against: z
      .literal('baseline')
      .optional()
      .describe('Compare batchId against the pinned baseline (the baseline is side A).'),
  })
  .superRefine((input, ctx) => {
    const explicitPair = input.batchIdA !== undefined || input.batchIdB !== undefined;
    const baselineForm = input.batchId !== undefined || input.against !== undefined;
    if (explicitPair && baselineForm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Pick one form: {batchIdA, batchIdB} for an explicit pair, or {batchId, against: 'baseline'}.",
      });
      return;
    }
    if (explicitPair && (input.batchIdA === undefined || input.batchIdB === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An explicit pair needs both batchIdA and batchIdB.',
      });
      return;
    }
    if (baselineForm && (input.batchId === undefined || input.against === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The baseline form needs both batchId and against: 'baseline'.",
      });
      return;
    }
    if (!explicitPair && !baselineForm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Supply {batchIdA, batchIdB} or {batchId, against: 'baseline'} — there is nothing to compare.",
      });
    }
  });
export type EvalBatchCompareInput = z.infer<typeof EvalBatchCompareInputSchema>;

export const EvalBatchCompareOutputSchema = z.object({
  comparison: EvalBatchComparisonSchema,
  /** Set when the baseline form resolved side A from the pinned baseline. */
  baselineBatchId: z.string().uuid().optional(),
  graduationCandidates: z.array(EvalGraduationCandidateSchema).max(200),
  summary: z
    .string()
    .describe(
      'One-paragraph account for relaying to the operator — deltas WITH their intervals and n.',
    ),
});
export type EvalBatchCompareOutput = z.infer<typeof EvalBatchCompareOutputSchema>;

// ============================================================================
// eval.batch.list
// ============================================================================

export const EvalBatchListInputSchema = z.object({
  workflowSlug: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Filter to one skill; omit for every batch in the space.'),
  limit: z.number().int().min(1).max(50).optional().describe('Defaults to 20, newest first.'),
});
export type EvalBatchListInput = z.infer<typeof EvalBatchListInputSchema>;

export const EvalBatchListOutputSchema = z.object({
  batches: z.array(EvalBatchHeadViewSchema),
});
export type EvalBatchListOutput = z.infer<typeof EvalBatchListOutputSchema>;

// ============================================================================

export const EvalBatchOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'eval',
    group: 'batch',
    verb: 'run',
    name: 'Run Eval Batch',
    actionLabel: 'Launching eval batch…',
    groupDisplayName: 'Eval Batches',
    groupDescription:
      'Run and inspect eval batches — frozen replays of a skill’s golden dataset that grade each trial deterministically.',
    semanticDescription:
      'Launch an eval batch: every active case of the skill’s golden dataset (at a chosen version) is ' +
      'replayed as real frozen workflow runs at the skill’s current pinned revision, then graded ' +
      'deterministically against the cases’ expectations. Validates and persists the batch, returns the ' +
      'cost preflight, and hands execution to the durable batch engine. Spends real money — invoke only ' +
      'on explicit operator request and relay the preflight estimate.',
    tags: ['eval', 'batch', 'measurement'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Launch a frozen-replay eval batch over a skill’s golden dataset — operator-requested, cost-ceilinged.',
      whenToUse: [
        'The operator explicitly asks to measure a skill against its golden dataset.',
        'The operator wants a before/after comparison around a skill edit — one batch per side.',
      ],
      whenNotToUse: [
        'On your own initiative — a batch spends the operator’s money; only launch when asked.',
        'Checking an existing batch — use eval.batch.get.',
      ],
      pitfalls: [
        'costCeilingCents is a hard halt, not a target — a crossed ceiling fails the batch with trials unstarted.',
        'The batch runs asynchronously; report the batchId and preflight, then check eval.batch.get for progress.',
        'There is no cancel operation — stopping a launched batch is an operator action on the batch surface; relay the batchId if the operator wants it stopped.',
      ],
      minimalExampleInput: { workflowSlug: 'daily-metrics', costCeilingCents: 500 },
    },
    accessMode: 'write',
    inputZod: EvalBatchRunInputSchema,
    outputZod: EvalBatchRunOutputSchema,
  },
  {
    stepType: 'eval',
    group: 'batch',
    verb: 'get',
    name: 'Get Eval Batch',
    actionLabel: 'Reading eval batch…',
    semanticDescription:
      'Read one eval batch: status, cost spent vs ceiling, the frozen provenance manifest, per-trial ' +
      'dispositions and verdicts, and the terminal scorecard once the batch completes.',
    tags: ['eval', 'batch', 'measurement'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Read an eval batch’s status, per-trial verdicts, and scorecard.',
      whenToUse: [
        'Narrating a running batch’s progress or a finished batch’s scorecard to the operator.',
      ],
      whenNotToUse: ['Enumerating batches — use eval.batch.list.'],
      minimalExampleInput: { batchId: '00000000-0000-4000-8000-000000000000' },
    },
    accessMode: 'read',
    inputZod: EvalBatchGetInputSchema,
    outputZod: EvalBatchGetOutputSchema,
  },
  {
    stepType: 'eval',
    group: 'batch',
    verb: 'compare',
    name: 'Compare Eval Batches',
    actionLabel: 'Comparing eval batches…',
    semanticDescription:
      'Paired comparison of two eval batches of one skill (D12): pairs on the intersection of ' +
      'identical case revisions, reports per-case flips with trial runIds, pass^k / pass@k / ' +
      'per-trial deltas with case-clustered bootstrap intervals, and lists added/removed/edited ' +
      'cases excluded from the paired stats. With {batchId, against: "baseline"} the pinned ' +
      'baseline is side A. A flip is an investigation finding, never a verdict.',
    tags: ['eval', 'batch', 'measurement', 'regression'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Paired per-case comparison of two batches (or one batch vs the pinned baseline).',
      whenToUse: [
        'The operator asks whether a skill edit helped — compare the before/after batches.',
        'A completed batch should be read against the pinned baseline.',
      ],
      whenNotToUse: [
        'Reading one batch in isolation — use eval.batch.get.',
        'Batches of different skills — the comparison refuses; it measures one skill across time.',
      ],
      pitfalls: [
        'Always relay the interval and paired-case n with any delta — a bare mean overstates certainty.',
        'Regression-tier flips carry runIds for transcript reading; they flag investigation, never auto-verdict.',
        'Both batches must be terminal — a running batch still has verdicts arriving.',
      ],
      minimalExampleInput: {
        batchId: '00000000-0000-4000-8000-000000000000',
        against: 'baseline',
      },
    },
    accessMode: 'read',
    inputZod: EvalBatchCompareInputSchema,
    outputZod: EvalBatchCompareOutputSchema,
  },
  {
    stepType: 'eval',
    group: 'batch',
    verb: 'list',
    name: 'List Eval Batches',
    actionLabel: 'Listing eval batches…',
    semanticDescription:
      'List the space’s eval batches, newest first, optionally filtered to one skill.',
    tags: ['eval', 'batch', 'measurement'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List eval batches in this space, newest first.',
      whenToUse: ['Surveying a skill’s measurement history before proposing a new batch.'],
      whenNotToUse: ['Reading one batch’s verdicts — use eval.batch.get.'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: EvalBatchListInputSchema,
    outputZod: EvalBatchListOutputSchema,
  },
];
