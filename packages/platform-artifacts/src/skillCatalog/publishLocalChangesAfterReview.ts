import { NEEDS_SETUP_FINDING_KIND, type WorkflowRunDecideRule } from '@aflow/schemas';
import { bind, ctx, out, runInput } from './localPrShepherdWiring.js';
import {
  REVIEW_TASK_IDS,
  reviewBindings,
  reviewHas,
  reviewValue,
} from './publishLocalChangesReview.js';
import {
  REVIEW_FINDINGS_MAX,
  REVIEW_SEVERITIES,
  type ReviewSeverity,
} from './reviewLocalChanges.js';

/**
 * The rounds rule, as ordered rules over the review's verdict, the severities
 * of its findings and the publication's `round` (Plan 315 D22). A slice gets
 * one fix round: a review that did not approve is fixed before it merges; an
 * approving review of nits alone, or of nothing, ends the rounds; an approving
 * review with a minor or worse takes the one fix round on the slice's first
 * publication, and once that round has run it publishes as it is, its
 * findings carried open on the pull request. Whether a round ran is the
 * `round` the caller declares — never inferred — and a missing one reads as
 * null, which no `>` holds, so it is the first.
 *
 * Every review that finished is decided here and nowhere else: no model is
 * asked, and no answer can fall below a bar.
 */
export const NOT_APPROVED_REASON =
  'The review did not approve: under the rounds rule a review short of approve is fixed before the branch merges.';
export const AFTER_FIX_ROUND_REASON =
  'The review approved, and a fix round of this slice already ran: the rounds rule allows one, so the branch merges as it stands and the pull request carries the findings open.';
export const FIRST_ROUND_REASON =
  "The review approved with a minor or worse among its findings on the slice's first publication: the rounds rule gives it one fix round before the branch merges.";
export const NITS_ONLY_REASON = 'nits-only review: the rounds rule ends the rounds';

/**
 * The severities above a minor. Each is named rather than `!= 'nit'`
 * compared: a path past the last finding reads as null, which is not a nit
 * either.
 */
const ABOVE_MINOR = (Object.keys(REVIEW_SEVERITIES) as ReviewSeverity[]).filter(
  (severity) => severity !== 'nit' && severity !== 'minor',
);

/** How many comparisons one rule's `anyOf` holds (`WorkflowRunDecideRuleWhenSchema`). */
const RULE_COMPARISONS_MAX = 10;
const FINDINGS_PER_RULE = Math.floor(RULE_COMPARISONS_MAX / ABOVE_MINOR.length);

const at = (index: number) => `state.findings[${String(index)}]`;

/** A blocker or a major at each index, a rule's worth of indices at a time. */
const ABOVE_MINOR_RULES: readonly WorkflowRunDecideRule[] = Array.from(
  { length: Math.ceil(REVIEW_FINDINGS_MAX / FINDINGS_PER_RULE) },
  (_, rule) => {
    const first = rule * FINDINGS_PER_RULE;
    const last = Math.min(first + FINDINGS_PER_RULE, REVIEW_FINDINGS_MAX);
    const indices = Array.from({ length: last - first }, (_, i) => first + i);
    return {
      when: {
        anyOf: indices.flatMap((index) =>
          ABOVE_MINOR.map((severity) => `${at(index)}.severity == '${severity}'`),
        ),
      },
      decision: 'fix_before_merge',
      reason: FIRST_ROUND_REASON,
    };
  },
);

/**
 * A minor at each index, unless it is the review's `needs_setup` finding
 * (Plan 320 D21): setup the operator gives once on the machine, which no fix
 * round on the branch can, so it never takes one. It always follows every
 * finding of the reviewer's, so these indices read all of theirs.
 */
const MINOR_RULES: readonly WorkflowRunDecideRule[] = Array.from(
  { length: REVIEW_FINDINGS_MAX },
  (_, index) => ({
    when: {
      allOf: [
        `${at(index)}.severity == 'minor'`,
        `${at(index)}.kind != '${NEEDS_SETUP_FINDING_KIND}'`,
      ],
    },
    decision: 'fix_before_merge',
    reason: FIRST_ROUND_REASON,
  }),
);

/** Every index a review can return a finding at: a blocker or a major first, then a minor. */
const FIRST_ROUND_RULES: readonly WorkflowRunDecideRule[] = [...ABOVE_MINOR_RULES, ...MINOR_RULES];

export const AFTER_REVIEW_SETTLE_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: "state.verdict != 'approve'" },
    decision: 'fix_before_merge',
    reason: NOT_APPROVED_REASON,
  },
  {
    when: { expression: 'state.round > 1' },
    decision: 'publish_as_is',
    reason: AFTER_FIX_ROUND_REASON,
  },
  ...FIRST_ROUND_RULES,
];

export const AFTER_REVIEW_SETTLE_OTHERWISE = {
  decision: 'publish_as_is',
  reason: NITS_ONLY_REASON,
};

export const SETTLE_AFTER_REVIEW_TASK = {
  taskId: 'settle-after-review',
  name: 'Decide by the rounds rule whether the findings are fixed before merging',
  goal: "Read the review's verdict, the severities of its findings and this publication's round, and decide by the rounds rule: a review that did not approve is fix_before_merge; an approving review of nits alone, or none, is publish_as_is; an approving review with a minor or worse is fix_before_merge on the slice's first publication and publish_as_is once a fix round has run, its findings carried open. A finding of kind `needs_setup` — the browser setup the review ran without — is no defect of the change and counts as none. No model is asked.",
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: REVIEW_TASK_IDS,
  // A review that did not finish returned no findings to read.
  when: reviewHas('findings'),
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    ...reviewBindings('verdict', 'verdict'),
    ...reviewBindings('findings', 'findings'),
    round: runInput('round'),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: {
      verdict: reviewValue('verdict'),
      findings: reviewValue('findings'),
      round: bind('round'),
    },
    rules: AFTER_REVIEW_SETTLE_RULES,
    otherwise: AFTER_REVIEW_SETTLE_OTHERWISE,
  },
  outputProjection: {
    decision: { path: 'decision', onMissing: 'error' as const },
    reason: { path: 'reason', onMissing: 'error' as const },
  },
};

/** The decision on the findings, as every task after it reads it; absent where the review did not finish. */
export const AFTER_REVIEW_BINDINGS = {
  afterReview: out(SETTLE_AFTER_REVIEW_TASK.taskId, 'decision'),
};
export const AFTER_REVIEW_VALUE = bind('afterReview');
