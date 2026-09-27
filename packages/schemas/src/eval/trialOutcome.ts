import { z } from 'zod';

/**
 * Plan 301 §5.1 — execution, setup, checks and quality are four independent
 * facts about a trial, folded into one class by a single ordered rule.
 *
 * The fold lives here and nowhere else. Before this module the UI, the batch
 * summary, comparison and Coach each derived their own answer from a
 * three-value verdict, and they disagreed: the trial rollup counted an
 * execution error as a behavioural failure while comparison excluded it.
 */

/**
 * What execution did, carried FROM execution rather than inferred from an
 * absent artifact downstream.
 *
 * Every value here has a producer. An earlier revision also declared
 * `no_usable_output` — a turn yielding neither usable text nor a valid tool
 * call — and nothing ever emitted it, so the axis advertised coverage it did
 * not have. It returns with the code that stamps it, not before.
 */
export const TrialExecutionStateSchema = z.enum([
  /** Ran to its observation boundary. A conversational pause IS this. */
  'completed',
  /**
   * The observation boundary was reached with no customer-facing answer.
   * Stamped where the pause contract is constructed — any placeholder prompt
   * applied afterwards makes this undetectable downstream.
   */
  'no_terminal_reply',
  'run_failed',
  'harness_error',
]);
export type TrialExecutionState = z.infer<typeof TrialExecutionStateSchema>;

/** Whether anything about the trial could be graded at all. */
export const TrialSetupOutcomeSchema = z.enum(['valid', 'invalid']);
export type TrialSetupOutcome = z.infer<typeof TrialSetupOutcomeSchema>;

/**
 * Deterministic expectations. `incomplete` is one expectation that could not
 * be decided while others could — missing evidence for one requirement, which
 * says nothing about an independently observed result elsewhere.
 */
/** Deterministic checks. `not_applicable` = the case has none. */
export const TrialCheckOutcomeSchema = z.enum(['passed', 'failed', 'incomplete', 'not_applicable']);
export type TrialCheckOutcome = z.infer<typeof TrialCheckOutcomeSchema>;

/**
 * Gating judge criteria. `not_applicable` = the case has none.
 *
 * A judge decides as a deterministic check decides. The two measure different
 * things — whether the world changed, and whether what was said to a person
 * was honest — and a case may carry either, or both. Neither is a commentary
 * on the other, so a disagreement between them is not a conflict to resolve:
 * each answers its own question and a failure on either is a failure.
 */
export const TrialQualityOutcomeSchema = z.enum([
  'passed',
  'failed',
  'unverified',
  'not_applicable',
]);
export type TrialQualityOutcome = z.infer<typeof TrialQualityOutcomeSchema>;

export const TrialQualityUnverifiedReasonSchema = z.enum([
  'abstained',
  'provider_error',
  'sampled_out',
  'budget_exhausted',
  'calibration_stale',
  'not_run',
]);
export type TrialQualityUnverifiedReason = z.infer<typeof TrialQualityUnverifiedReasonSchema>;

export const TrialOutcomeClassSchema = z.enum([
  'invalid_case',
  'execution_error',
  'behavior_fail',
  'incomplete_evidence',
  'behavior_pass',
]);
export type TrialOutcomeClass = z.infer<typeof TrialOutcomeClassSchema>;

/** Only these two classes carry a behavioural claim and reach `pass^k`. */
const SCORED_CLASSES: ReadonlySet<TrialOutcomeClass> = new Set<TrialOutcomeClass>([
  'behavior_pass',
  'behavior_fail',
]);

export function isScoredOutcome(outcomeClass: TrialOutcomeClass): boolean {
  return SCORED_CLASSES.has(outcomeClass);
}

/**
 * Bumped whenever the ordered rule below changes. Stored beside every class so
 * a surface reading an older row knows which rule produced it, and so changing
 * the rule is an explicit recompute rather than a silent divergence.
 */
export const TRIAL_AGGREGATION_VERSION = 'ordered-four-axis-1';

export const TrialAxesSchema = z.object({
  executionState: TrialExecutionStateSchema,
  setupOutcome: TrialSetupOutcomeSchema,
  checkOutcome: TrialCheckOutcomeSchema,
  qualityOutcome: TrialQualityOutcomeSchema,
  qualityUnverifiedReason: TrialQualityUnverifiedReasonSchema.optional(),
});
export type TrialAxes = z.infer<typeof TrialAxesSchema>;

export const TrialOutcomeSchema = TrialAxesSchema.extend({
  outcomeClass: TrialOutcomeClassSchema,
  aggregationVersion: z.string().min(1).max(64),
});
export type TrialOutcome = z.infer<typeof TrialOutcomeSchema>;

/**
 * The single ordered rule (§5.1).
 *
 * Rule 3 precedes rule 4 deliberately: a definitive failure outranks missing
 * evidence anywhere else. A judge criterion that failed stays a failure when a
 * sibling expectation could not be decided, and a failed expectation stays a
 * failure when a judge abstains — missing evidence for one requirement does not
 * retract an independently observed failure of another.
 */
export function classifyTrialOutcome(axes: TrialAxes): TrialOutcome {
  const outcomeClass = ((): TrialOutcomeClass => {
    if (axes.setupOutcome === 'invalid') return 'invalid_case';
    if (axes.executionState !== 'completed') return 'execution_error';
    if (axes.checkOutcome === 'failed' || axes.qualityOutcome === 'failed') return 'behavior_fail';
    if (axes.checkOutcome === 'incomplete' || axes.qualityOutcome === 'unverified') {
      return 'incomplete_evidence';
    }
    return 'behavior_pass';
  })();
  return { ...axes, outcomeClass, aggregationVersion: TRIAL_AGGREGATION_VERSION };
}

// ============================================================================
// Case-level fold — pass^k at the configured k
// ============================================================================

export interface CaseOutcomeSummary {
  /** Trials carrying a behavioural claim. */
  scored: number;
  passed: number;
  /** Trials excluded from the behavioural claim, by class. */
  excluded: Record<Exclude<TrialOutcomeClass, 'behavior_pass' | 'behavior_fail'>, number>;
  /**
   * Every one of the configured `k` trials was scored. A case short of `k`
   * cannot carry a pass^k claim however well its recorded trials did.
   */
  complete: boolean;
  /** pass^k — complete AND every scored trial passed. */
  passAllTrials: boolean;
}

/**
 * `trialsPerCase` is the CONFIGURED k, not the number of rows that arrived.
 * Two passes and one execution error is an incomplete three-trial case, never
 * a pass^3 success — deriving k from the rows present would make every case
 * complete by construction.
 */
export function summariseCaseOutcome(
  classes: readonly TrialOutcomeClass[],
  trialsPerCase: number,
): CaseOutcomeSummary {
  const excluded = {
    invalid_case: 0,
    execution_error: 0,
    incomplete_evidence: 0,
  };
  let scored = 0;
  let passed = 0;
  for (const outcomeClass of classes) {
    if (outcomeClass === 'behavior_pass') {
      scored += 1;
      passed += 1;
    } else if (outcomeClass === 'behavior_fail') {
      scored += 1;
    } else {
      excluded[outcomeClass] += 1;
    }
  }
  const complete = trialsPerCase > 0 && scored === trialsPerCase;
  return { scored, passed, excluded, complete, passAllTrials: complete && passed === scored };
}

/**
 * The one verdict, folded from every axis.
 *
 * `verdict` used to be computed from deterministic checks alone, so a trial a
 * judge had failed was stored as `pass` beside an `outcomeClass` of
 * `behavior_fail` — two fields answering the same question differently, and a
 * reader's choice of field deciding whether a suite looked healthy. A judge
 * decides as a check decides; the fold already says so, and this reads it.
 *
 * `incomplete_evidence` is neither pass nor fail: the trial ran and produced no
 * usable claim, which is what `error` means to every consumer of this field.
 */
export function verdictForOutcomeClass(outcomeClass: TrialOutcomeClass): 'pass' | 'fail' | 'error' {
  if (outcomeClass === 'behavior_pass') return 'pass';
  if (outcomeClass === 'behavior_fail') return 'fail';
  return 'error';
}
