/**
 * Judge scorecard (Plan 269 D11) — the judge measured as a classifier, per
 * (criterionId, judgeVersion, subject configuration), recomputed at read
 * over VALIDATION-partition labels only. Advisory throughout V1: the gate
 * readout reports distance to the trust knobs; nothing graduates, demotes,
 * or counts toward a regression finding on it.
 */
import { z } from 'zod';
import { EvalBatchSubjectModelSchema } from './evalBatch.js';

/**
 * The positive class is `fail`: the judge exists to catch rubric violations,
 * so precision answers "when the judge fails a trial, was it truly bad" and
 * recall (TPR) answers "how many truly-bad trials does it catch". Human
 * labels are truth; judge verdicts are predictions.
 */
export const JudgeConfusionMatrixSchema = z.object({
  /** Human fail, judge fail. */
  truePositive: z.number().int().nonnegative(),
  /** Human pass, judge fail. */
  falsePositive: z.number().int().nonnegative(),
  /** Human pass, judge pass. */
  trueNegative: z.number().int().nonnegative(),
  /** Human fail, judge pass. */
  falseNegative: z.number().int().nonnegative(),
});
export type JudgeConfusionMatrix = z.infer<typeof JudgeConfusionMatrixSchema>;

/** Wilson score interval for a binomial proportion (D11: intervals match the statistic). */
export const WilsonIntervalSchema = z.object({
  estimate: z.number().min(0).max(1),
  lower: z.number().min(0).max(1),
  upper: z.number().min(0).max(1),
  /** Denominator the proportion was computed over. */
  n: z.number().int().positive(),
});
export type WilsonInterval = z.infer<typeof WilsonIntervalSchema>;

/**
 * Cohen's κ with a bootstrap percentile interval (Wilson does not apply to
 * κ). `estimate` is absent when κ is undefined — both raters constant (the
 * degenerate all-pass / all-fail matrix has no chance-agreement baseline).
 */
export const JudgeKappaSchema = z.object({
  estimate: z.number().min(-1).max(1).optional(),
  lower: z.number().min(-1).max(1).optional(),
  upper: z.number().min(-1).max(1).optional(),
  resamples: z.number().int().nonnegative(),
});
export type JudgeKappa = z.infer<typeof JudgeKappaSchema>;

/**
 * Distance-to-gate readout against the named trust knobs
 * (`judgeTrustKappa` / `judgeTrustMinLabels`). ADVISORY ONLY — the
 * graduation gate itself is inert in V1 (D11): `wouldPass` informs the
 * operator and drives nothing.
 */
export const JudgeTrustGateReadoutSchema = z.object({
  judgeTrustKappa: z.number().min(0).max(1),
  judgeTrustMinLabels: z.number().int().positive(),
  /** Validation labels still needed before the κ gate is even evaluable. */
  labelsShort: z.number().int().nonnegative(),
  /** Bootstrap κ lower bound, when computable. */
  kappaLowerBound: z.number().min(-1).max(1).optional(),
  wouldPass: z.boolean(),
});
export type JudgeTrustGateReadout = z.infer<typeof JudgeTrustGateReadoutSchema>;

export const JudgeScorecardSchema = z.object({
  criterionId: z.string().min(1).max(300),
  /** Slot scope — a judge's identity is (criterionId, scopeKey), so same-named criteria at different scopes hold separate scorecards. */
  scopeKey: z.string().min(1).max(300),
  /** D9 hash the verdicts in this group were produced under. */
  judgeVersion: z.string().min(1).max(200),
  /** Stable digest of the subject model configuration (D11 calibration scope). */
  subjectConfigKey: z.string().min(1).max(128),
  subjectModels: z.array(EvalBatchSubjectModelSchema).max(100),
  /** Validation labels for the criterion in this subject-config group. */
  validationLabels: z.number().int().nonnegative(),
  /** Labels with a judge verdict at this judgeVersion — the matrix rows. */
  pairedLabels: z.number().int().nonnegative(),
  /** Labels with no verdict at this version (e.g. sampled out) — never dropped silently. */
  unpairedLabels: z.number().int().nonnegative(),
  confusion: JudgeConfusionMatrixSchema,
  /** P(human fail | judge fail); absent when the judge never failed a trial. */
  precision: WilsonIntervalSchema.optional(),
  /** TPR — P(judge fail | human fail); absent when no human-failed labels exist. */
  recall: WilsonIntervalSchema.optional(),
  /** TNR — P(judge pass | human pass); absent when no human-passed labels exist. */
  tnr: WilsonIntervalSchema.optional(),
  kappa: JudgeKappaSchema,
  gate: JudgeTrustGateReadoutSchema,
});
export type JudgeScorecard = z.infer<typeof JudgeScorecardSchema>;
