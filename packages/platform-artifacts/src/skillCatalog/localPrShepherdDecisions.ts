import type { DecisionChoiceQuestionSchema } from '@aflow/schemas';
import type { z } from 'zod';

/**
 * The one judgement the Local PR Shepherd asks a decision model (Plan 321
 * D8): which remedy a red check wants. Defined once, here, so a measurement
 * of it on the loop's labelled failures asks exactly what the skill asks.
 *
 * Every other decision of a pass is a rule over data (`workflow.run.decide`).
 * This one reads what no rule can — a log — and is routed: a confident answer
 * takes its remedy, and anything else takes the fix commission, which is what
 * a pass did with every failure before the question was asked. The bar is not
 * yet measured for this question; abstaining costs only that default.
 */
export const REMEDY_MIN_CONFIDENCE = 0.8;

export const REMEDY_QUESTION_NAME = 'remedy';

export const REMEDY_ROUTES = [
  'flaky_or_timeout',
  'code_defect',
  'dependency_advisory',
  'base_conflict',
  'ci_outage',
] as const;
export type Remedy = (typeof REMEDY_ROUTES)[number];

export const REMEDY_QUESTION = {
  type: 'choice',
  instructions:
    "A pull request's CI failed. From the failing jobs' names, the end of each one's log, the pull request's title and description, and the record of earlier attempts on it: what put the failure there, and so what clears it.",
  options: {
    flaky_or_timeout:
      'Nothing in the change is at fault: a test that passes and fails on the same code, a timing assertion, a job that ran out of its time or lost a runner. Running the failed jobs again on the same commit is expected to pass.',
    code_defect:
      'The change itself is wrong: a failing assertion it caused, a type error, a lint or format finding, a build that no longer compiles. A coding agent fixes it in the repository from what the log printed.',
    dependency_advisory:
      'A dependency audit reports a security advisory against a package the repository resolves, which the change did not add: it arrived in the registry since the last green run. Bumping that package to a fixed version — through `resolutions` where it is transitive — clears it.',
    base_conflict:
      'The branch no longer merges into its base, or the workflow refused to run on it for that reason. Merging the base into the branch and resolving what conflicts clears it.',
    ci_outage:
      "GitHub Actions or a service CI reaches was down: the checkout, the runner, the registry or an action failed for every job alike, with nothing of the repository's code reached. Nothing in the repository clears it; CI is waited on.",
  },
  minConfidence: REMEDY_MIN_CONFIDENCE,
} as const satisfies z.input<typeof DecisionChoiceQuestionSchema>;
