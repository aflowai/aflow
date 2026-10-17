import type { DecisionChoiceQuestionSchema, DecisionYesNoQuestionSchema } from '@aflow/schemas';
import type { z } from 'zod';

/**
 * The two judgements Publish Local Changes makes for itself — what follows a
 * failed check, and whether a review's findings are worth a fix round — as the
 * questions it asks a decision model. Defined once, here, so the measurement
 * of decision quality on the loop's own history (`yarn decisions:measure-loop`,
 * Plan 316 §7) asks exactly what the skill asks.
 *
 * Each threshold is where its decision abstains, and an abstention is not the
 * same on every path:
 * - after a failed check, the run fails as a failed check always did;
 * - a finding judged below its bar is left out of a fix round's brief;
 * - after a review, the fix round is taken — fixing what was judged a defect
 *   costs a commission, and merging it unfixed costs more — so a high bar here
 *   means more fix rounds, not fewer.
 * They are provisional until Plan 316 §7's measurement has run on the loop's
 * own records; §7 says what it is waiting on.
 */
export const AFTER_CHECK_MIN_CONFIDENCE = 0.8;
export const FINDING_MIN_CONFIDENCE = 0.8;
export const AFTER_REVIEW_MIN_CONFIDENCE = 0.9;

export const AFTER_CHECK_ROUTES = [
  'recheck_on_timeout',
  'fix_commission',
  'operator_install_mismatch',
] as const;
export type AfterCheckRoute = (typeof AFTER_CHECK_ROUTES)[number];

export const AFTER_REVIEW_ROUTES = ['fix_before_merge', 'publish_as_is', 'ask'] as const;
export type AfterReviewRoute = (typeof AFTER_REVIEW_ROUTES)[number];

/** The question name each decision's answer is read under: `answers.<name>`. */
export const AFTER_CHECK_QUESTION_NAME = 'next_step';
export const AFTER_REVIEW_QUESTION_NAME = 'after_review';

export const AFTER_CHECK_QUESTION = {
  type: 'choice',
  instructions:
    "The folder's checks did not pass on this publication's commit. From what they printed, what follows: running them again, a fix to the change, or the operator putting the machine right.",
  options: {
    recheck_on_timeout:
      "Nothing failed but time: tests ran out of their time under a loaded machine, or the checks were still running when the folder's time ran out, and nothing printed is an assertion, a type error, a lint finding or a guard refusing the change. Run on the same commit again, they are expected to pass.",
    fix_commission:
      'The checks found something wrong in the change itself — a failing assertion, a type error, a lint or format finding, a guard the change trips — which a coding agent can put right in the repository from what they printed.',
    operator_install_mismatch:
      'The checks could not run as the folder declares them on this machine — a missing tool or dependency, a version out of step with the lockfile, a sandbox or permission refusal, a service the checks reach that is not there — which only the operator can put right on the machine.',
  },
  minConfidence: AFTER_CHECK_MIN_CONFIDENCE,
} as const satisfies z.input<typeof DecisionChoiceQuestionSchema>;

export const FINDING_QUESTION = {
  type: 'yes_no',
  instructions:
    "The finding names a defect in the change's behaviour, established by evidence shown.",
  criteria: {
    true: 'The claim is about what the changed code does — a wrong result, a crash, a race, a leak, a hole, a broken contract or a test that does not test what it says — and the evidence quoted shows it in this change.',
    false:
      'The claim is a preference, a name, a style or a wording; or a defect the evidence does not show; or about code this change did not touch.',
  },
  minConfidence: FINDING_MIN_CONFIDENCE,
} as const satisfies z.input<typeof DecisionYesNoQuestionSchema>;

export const AFTER_REVIEW_QUESTION = {
  type: 'choice',
  instructions:
    'These are the findings of the review of a branch about to be published that name defects in its behaviour. Whether they are fixed on this branch before it merges.',
  options: {
    fix_before_merge:
      'At least one of them should not merge as it is: a fix round on this branch is worth its cost before the branch merges.',
    publish_as_is:
      'They are narrow enough to merge as they stand and be fixed later, if at all; the pull request records them.',
    ask: 'Whether to fix them first turns on something only the operator knows — scope, a deadline, what the change was for.',
  },
  minConfidence: AFTER_REVIEW_MIN_CONFIDENCE,
} as const satisfies z.input<typeof DecisionChoiceQuestionSchema>;

/**
 * The opening of each fix brief. What follows it is data the run already
 * holds — the checks' own account, the findings that passed — so no model
 * writes a brief and none can be argued with as one.
 */
export const FIX_CHECKS_BRIEF_LEAD =
  "The folder's declared checks failed on this commit. Their account follows, naming the step that failed where they named one, with the end of what they printed. Make them pass by fixing what they found in the change; change no check, guard or test to pass it, and leave the change otherwise as it is. Run the failing step again in this checkout before you finish, and report what you changed and what it printed.\n\n";

export const FIX_FINDINGS_BRIEF_LEAD =
  "Local Code Review read this branch, and these of its findings name defects in the change's behaviour, each with the evidence for it. Fix each of them in the change, with a test that would have caught it where one can; change nothing else. Run the folder's own checks over what you touched before you finish, and report, finding by finding, what you changed.\n\nThe findings, as the review returned them:\n";
