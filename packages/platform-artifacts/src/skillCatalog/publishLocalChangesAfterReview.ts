import { AFTER_REVIEW_UNDECIDED, type WorkflowRunDecideRule } from '@aflow/schemas';
import { bind, ctx, out, SKIP } from './localPrShepherdWiring.js';
import {
  REVIEW_FINDINGS_MAX,
  REVIEW_SEVERITIES,
  type ReviewSeverity,
} from './reviewLocalChanges.js';

/**
 * An approving review whose findings are all nits — or that found nothing —
 * needs no decision: under the rounds rule nits alone end the rounds, so its
 * `publish_as_is` is a constant, settled by rules over the verdict and the
 * severities with no decision model asked and no confidence to fall below a
 * bar. The constant holds only on `approve`, the one verdict a publication
 * pushes on without asking: a review that commented or requested changes
 * reaches the decision model (`decide-after-review`) whatever its findings, as
 * does a minor or worse among an approving review's findings, and until an
 * answer clears the bar that review is `undecided`.
 */
export const NITS_ONLY_REASON = 'nits-only review: the rounds rule ends the rounds';

const ABOVE_NIT = (Object.keys(REVIEW_SEVERITIES) as ReviewSeverity[]).filter(
  (severity) => severity !== 'nit',
);

/** How many comparisons one rule's `anyOf` holds (`WorkflowRunDecideRuleWhenSchema`). */
const RULE_COMPARISONS_MAX = 10;
const FINDINGS_PER_RULE = Math.floor(RULE_COMPARISONS_MAX / ABOVE_NIT.length);

/**
 * Each severity above a nit is named rather than `!= 'nit'` compared: a path
 * past the last finding reads as null, which is not a nit either.
 */
function aboveNitAt(index: number): string[] {
  return ABOVE_NIT.map((severity) => `state.findings[${String(index)}].severity == '${severity}'`);
}

/** Every index a review can return a finding at, read a rule's worth at a time. */
const ABOVE_NIT_RULES: readonly WorkflowRunDecideRule[] = Array.from(
  { length: Math.ceil(REVIEW_FINDINGS_MAX / FINDINGS_PER_RULE) },
  (_, rule) => {
    const first = rule * FINDINGS_PER_RULE;
    const last = Math.min(first + FINDINGS_PER_RULE, REVIEW_FINDINGS_MAX);
    const indices = Array.from({ length: last - first }, (_, i) => first + i);
    return {
      when: { anyOf: indices.flatMap(aboveNitAt) },
      decision: AFTER_REVIEW_UNDECIDED,
      reason:
        "A minor or worse is among the review's findings: the decision model weighs whether they take a fix round, and until an answer clears its bar the decision is undecided.",
    };
  },
);

export const AFTER_REVIEW_SETTLE_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: "state.verdict != 'approve'" },
    decision: AFTER_REVIEW_UNDECIDED,
    reason:
      'The review did not approve: nits alone end the rounds only under an approving verdict, so the decision model weighs its findings, and until an answer clears its bar the decision is undecided.',
  },
  ...ABOVE_NIT_RULES,
];

export const AFTER_REVIEW_SETTLE_OTHERWISE = {
  decision: 'publish_as_is',
  reason: NITS_ONLY_REASON,
};

export const SETTLE_AFTER_REVIEW_TASK = {
  taskId: 'settle-after-review',
  name: 'Settle an approving nits-only review without a decision',
  goal: "Read the review's verdict and the severities of its findings: where it approved and none is more severe than a nit, none at all included, the rounds rule ends the rounds and the decision is publish_as_is, asked of no model; where it did not approve, whatever it found, or a minor or worse is among its findings, the decision model weighs them.",
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: ['review-commit'],
  // A review that did not finish returned no findings to read.
  when: { expression: 'tasks.review-commit.output.findings != null', onMissingRef: SKIP },
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    verdict: out('review-commit', 'verdict'),
    findings: out('review-commit', 'findings'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { verdict: bind('verdict'), findings: bind('findings') },
    rules: AFTER_REVIEW_SETTLE_RULES,
    otherwise: AFTER_REVIEW_SETTLE_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
};

/** The decision model is asked exactly where the verdict and the severities left the review undecided. */
export const ASK_AFTER_REVIEW = `tasks.${SETTLE_AFTER_REVIEW_TASK.taskId}.output.decision == '${AFTER_REVIEW_UNDECIDED}'`;

/**
 * The decision on the findings, as every task after it reads it: the model's
 * answer where it was asked — null below its bar — and otherwise what the
 * rules settled: `publish_as_is` over an approval of nits alone, `undecided` where the
 * model was to be asked and no answer came. Absent where the review did not
 * finish.
 */
export const AFTER_REVIEW_BINDINGS = {
  answeredAfterReview: out('decide-after-review', 'afterReview'),
  settledAfterReview: out(SETTLE_AFTER_REVIEW_TASK.taskId, 'decision'),
};
export const AFTER_REVIEW_VALUE = {
  $firstOf: [bind('answeredAfterReview'), bind('settledAfterReview')],
};
