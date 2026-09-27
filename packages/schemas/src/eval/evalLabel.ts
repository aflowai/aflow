/**
 * Human label for a judged run (Plan 269 D10) — the `eval_labels` record,
 * absorbing the judge-calibration path. Only human labels are ground truth;
 * `labeledBy` is server-stamped from the authenticated principal, never
 * caller-supplied.
 */
import { z } from 'zod';
import { JudgeRubricEntrySchema } from '../cybernetic/eval.js';

export const EvalLabelVerdictSchema = z.enum(['pass', 'fail']);
export type EvalLabelVerdict = z.infer<typeof EvalLabelVerdictSchema>;

/**
 * Assigned at label creation by the stream the label arrived through, and
 * never crosses: `validation` labels come only from the uniform random slice
 * (they power scorecards); disagreement-routed / judge-fail / feedback labels
 * are `exemplar` — they find failure modes and seed few-shots, and they never
 * enter a scorecard.
 */
export const EvalLabelPartitionSchema = z.enum(['exemplar', 'validation']);
export type EvalLabelPartition = z.infer<typeof EvalLabelPartitionSchema>;

/**
 * How a pending label-queue item was minted. The stream decides the label's
 * partition (D10): `random_slice` is the ONLY validation minter — every other
 * source is enriched (it found the item because something looked wrong) and
 * produces exemplar material that never enters a scorecard.
 */
export const EvalLabelQueueSourceSchema = z.enum([
  'random_slice',
  'judge_disagreement',
  'judge_fail',
  'operator_flag',
]);
export type EvalLabelQueueSource = z.infer<typeof EvalLabelQueueSourceSchema>;

export const EvalLabelQueueStatusSchema = z.enum(['pending', 'labeled', 'dismissed']);
export type EvalLabelQueueStatus = z.infer<typeof EvalLabelQueueStatusSchema>;

/**
 * The judge criterion under judgement, as the labeler must read it — the
 * QUESTION, never the judge's answer. `entries` empty with `unresolved` set
 * is the honest outcome when the criterion no longer resolves; the item still
 * lists so the operator can dismiss it.
 */
export const EvalLabelQueueRubricSchema = z.object({
  criterionId: z.string(),
  scopeKey: z.string(),
  /** The resolved criterion's own name; absent when it did not resolve. */
  name: z.string().optional(),
  entries: z.array(JudgeRubricEntrySchema),
  /** Reference answer the judge's prompt carries, when the criterion has one. */
  referenceAnswer: z.string().optional(),
  /** Why `entries` is empty — set only then. */
  unresolved: z.string().optional(),
  /**
   * Set when the criterion resolved but no longer hashes to the judge version
   * this item's label will be stamped with: the entries above are then a
   * different question from the one the judge was asked, and a label filed
   * under the old version would enter a confusion matrix it never belonged to.
   */
  judgeVersionDrift: z.string().optional(),
});
export type EvalLabelQueueRubric = z.infer<typeof EvalLabelQueueRubricSchema>;

/**
 * The evidence the JUDGE received for the trial, replayed for the human.
 *
 * A judge scorecard measures agreement between the judge and the human, so a
 * human labeling from different material than the judge saw confounds the
 * confusion matrix and precision/recall/kappa stop measuring the judge. That
 * is why absence is a typed outcome here: a blank panel would read as "the
 * run produced nothing" and would be labeled as such.
 */
export const EvalLabelQueueEvidenceSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    taskSummaries: z.array(
      z.object({ taskId: z.string(), status: z.string(), summary: z.string().optional() }),
    ),
    taskOutputs: z.array(z.object({ taskId: z.string(), content: z.string() })),
    /**
     * What the reviewer actually reads: the message that opened the trial and
     * the answer it produced. The judge's own evidence pack is task outputs
     * and summaries, which is the right material for a model and unreadable
     * as a conversation — a reviewer asked to grade a reply from a JSON blob
     * labelled by character count grades the blob.
     */
    conversation: z
      .object({
        request: z.string().max(20_000).nullable(),
        reply: z.string().max(20_000).nullable(),
      })
      .optional(),
    /**
     * True when the trial's fixture space is gone and only the exchange kept
     * at mint survives. The judge read more than this, so agreement measured
     * from it is weaker evidence — stated rather than implied.
     */
    conversationOnly: z.boolean().optional(),
    /**
     * What the tools returned to the agent, as the judge saw it.
     *
     * A label scored against a NARROWER pack than the judge read does not
     * measure the judge — it measures the difference in evidence. The judge is
     * given tool results so it can decide whether a stated fact is supported;
     * a reviewer without them is guessing at exactly the question the label is
     * meant to settle.
     */
    toolResults: z
      .array(
        z.object({
          sequence: z.number().int().nonnegative(),
          endpointId: z.string().max(200),
          status: z.number().int(),
          body: z.string().max(20_000),
        }),
      )
      .max(12)
      .optional(),
    referenceOutput: z.string().optional(),
    /**
     * Referenced artifacts that no longer retrieve. Above zero the pack is
     * NARROWER than the judge's, which reads as summaries-only — the same
     * confound as labeling from different evidence, one level down from a
     * reaped run, and just as invisible unless it is counted here.
     */
    unresolvedArtifacts: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum([
      'no_trial_run',
      'run_reaped',
      'case_revision_missing',
      'payload_store_unavailable',
      'rebuild_failed',
    ]),
    detail: z.string(),
  }),
]);
export type EvalLabelQueueEvidence = z.infer<typeof EvalLabelQueueEvidenceSchema>;

/** One queue row as the operator listing surface renders it. */
export const EvalLabelQueueListItemSchema = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid(),
  workflowSlug: z.string().nullable(),
  caseRevisionId: z.string().uuid(),
  caseTitle: z.string().nullable(),
  trial: z.number().int(),
  runId: z.string().nullable(),
  criterionId: z.string(),
  scopeKey: z.string(),
  /**
   * Stream provenance — null on a PENDING row. Every stream but the uniform
   * draw is minted only from a judged 'fail', so partition 'exemplar', an
   * enriched source and a null inclusionProbability each name the judge's
   * verdict exactly; a row that names it beside the Pass/Fail buttons anchors
   * the labeler. The group returns in full once the item resolves.
   */
  partition: EvalLabelPartitionSchema.nullable(),
  source: EvalLabelQueueSourceSchema.nullable(),
  inclusionProbability: z.number().min(0).max(1).nullable(),
  status: EvalLabelQueueStatusSchema,
  createdAt: z.string().datetime(),
  /** Hydrated for pending items only — the labeling surface's question… */
  rubric: EvalLabelQueueRubricSchema.optional(),
  /** …and its material. */
  evidence: EvalLabelQueueEvidenceSchema.optional(),
});
export type EvalLabelQueueListItem = z.infer<typeof EvalLabelQueueListItemSchema>;

export const EvalLabelSchema = z.object({
  /** The run the labeled verdict is about — present even for case-scoped labels. */
  runId: z.string().min(1).max(256),
  /** Absent for run-scoped labels (the judge-calibration path — a label with no case). */
  caseRevisionId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  trial: z.number().int().nonnegative().optional(),
  /** Suite the criterion lives in, for suite-scoped labels. */
  evalSuitePath: z.string().min(1).max(512).optional(),
  criterionId: z.string().min(1).max(200),
  /** 'goal' | 'trajectory' | 'task:{taskId}' — disambiguates same-named criteria. */
  scopeKey: z.string().min(1).max(300),
  verdict: EvalLabelVerdictSchema,
  /** The critique is the point — raw material for judge few-shots (critique shadowing). */
  critique: z.string().min(1).max(8000),
  /** hash(rubric, judge model, prompt template version) the label graded against. */
  judgeVersion: z.string().min(1).max(128).optional(),
  partition: EvalLabelPartitionSchema,
  /** Server-stamped principal user id. */
  labeledBy: z.string().uuid(),
  labeledAt: z.string().datetime(),
});
export type EvalLabel = z.infer<typeof EvalLabelSchema>;
