import { AFTER_REVIEW_DECIDED, type DecisionChoiceQuestionSchema } from '@aflow/schemas';
import type { z } from 'zod';

/**
 * The judgements Publish Local Changes is measured on — what follows a failed
 * check, and whether a review's findings are worth a fix round — as the
 * questions a decision model is asked. Defined once, here, so the measurement
 * of decision quality on the loop's own history (`yarn decisions:measure-loop`,
 * Plan 316 §7) asks exactly what the skill asks.
 *
 * Only the question after a review is the skill's, and its answer is only
 * recorded — on the pull request and as the run's `afterReview`, `undecided`
 * below its bar, Jev's, measured over 17 cases — never acted on by the run:
 * a fix round is the conversation's or the shepherd's. The question after a
 * failed check is asked by the
 * measurement alone until it has labelled `operator_install_mismatch` cases
 * (Plan 316 §7); a failed check fails the run.
 */
export const AFTER_CHECK_MIN_CONFIDENCE = 0.8;
export const AFTER_REVIEW_MIN_CONFIDENCE = 0.8;

export const AFTER_CHECK_ROUTES = [
  'recheck_on_timeout',
  'fix_commission',
  'operator_install_mismatch',
] as const;
export type AfterCheckRoute = (typeof AFTER_CHECK_ROUTES)[number];

/** The answers the after-review question offers: the ones the pull request records as decided. */
export const AFTER_REVIEW_ROUTES = AFTER_REVIEW_DECIDED;
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

export const AFTER_REVIEW_QUESTION = {
  type: 'choice',
  instructions:
    'These are the findings of the review of a branch about to be published. Whether they are fixed on this branch before it merges, or it merges as it stands with them recorded.',
  options: {
    fix_before_merge:
      'At least one of them should not merge as it is: a fix round on this branch is worth its cost before the branch merges.',
    publish_as_is:
      'They are narrow enough to merge as they stand and be fixed later, if at all; the pull request records them.',
  },
  minConfidence: AFTER_REVIEW_MIN_CONFIDENCE,
} as const satisfies z.input<typeof DecisionChoiceQuestionSchema>;
