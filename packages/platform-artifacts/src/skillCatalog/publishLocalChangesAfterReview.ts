import {
  NEEDS_SETUP_FINDING_KIND,
  ROUNDS_RULE,
  ROUNDS_RULE_ROUNDS,
  type RoundsRuleRound,
  type RoundsRuleTable,
  type WorkflowRunDecideRule,
} from '@aflow/schemas';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import {
  AFTER_REVIEW_MIN_CONFIDENCE,
  AFTER_REVIEW_QUESTION,
  AFTER_REVIEW_QUESTION_NAME,
} from './publishLocalChangesDecisions.js';
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
 * The decision after a review, in four steps (Plan 315 D22). `grade-findings`
 * names the severest finding. `rule-after-review` looks the case up in the
 * rounds rule's table (`ROUNDS_RULE`, `@aflow/schemas`) over the round, that
 * severity and the verdict. `decide-after-review` asks the space's decision
 * model only where no row covers the case. `settle-after-review` records the
 * decision every later task reads. The first, second and fourth ask no model,
 * so a case the table covers is decided with no model call.
 */
export const GRADE_FINDINGS_TASK_ID = 'grade-findings';
export const RULE_AFTER_REVIEW_TASK_ID = 'rule-after-review';
export const DECIDE_AFTER_REVIEW_TASK_ID = 'decide-after-review';

/** What `rule-after-review` decides where no row of the table covers the case. */
export const UNCOVERED = 'uncovered';
export const UNCOVERED_REASON =
  'No row of the rounds rule covers this round, severest finding and verdict, so the decision model is asked.';
export const MODEL_FIX_REASON =
  'No row of the rounds rule covers this review. The decision model answered `fix_before_merge` above its bar.';
export const MODEL_PUBLISH_REASON =
  'No row of the rounds rule covers this review. The decision model answered `publish_as_is` above its bar.';
export const MODEL_UNDECIDED_REASON =
  'No row of the rounds rule covers this review, and the decision model gave no answer above its bar. The branch is held for a fix round, which only an override sets aside.';

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

const at = (index: number) => `state.findings[${String(index)}]`;

/** One of `severities` at any index, a rule's worth of indices at a time, each deciding `decision`. */
function severityRules(
  severities: readonly ReviewSeverity[],
  decision: string,
  reason: string,
): WorkflowRunDecideRule[] {
  const perRule = Math.floor(RULE_COMPARISONS_MAX / severities.length);
  return Array.from({ length: Math.ceil(REVIEW_FINDINGS_MAX / perRule) }, (_, rule) => {
    const first = rule * perRule;
    const last = Math.min(first + perRule, REVIEW_FINDINGS_MAX);
    const indices = Array.from({ length: last - first }, (_, i) => first + i);
    return {
      when: {
        anyOf: indices.flatMap((index) =>
          severities.map((severity) => `${at(index)}.severity == '${severity}'`),
        ),
      },
      decision,
      reason,
    };
  });
}

/**
 * A minor at each index, unless it is the review's `needs_setup` finding
 * (Plan 320 D21): setup the operator gives once on the machine, which no fix
 * round on the branch can, so it never takes one. It always follows every
 * finding of the reviewer's, so these indices read all of theirs.
 */
function defectMinorRules(decision: string, reason: string): WorkflowRunDecideRule[] {
  return Array.from({ length: REVIEW_FINDINGS_MAX }, (_, index) => ({
    when: {
      allOf: [
        `${at(index)}.severity == 'minor'`,
        `${at(index)}.kind != '${NEEDS_SETUP_FINDING_KIND}'`,
      ],
    },
    decision,
    reason,
  }));
}

/**
 * A blocker or a major at any index, deciding `fix_before_merge` for
 * `reason`. The review rounds that run without a publication
 * (`reviewRounds.ts`) read these under a reason of their own.
 */
export function aboveMinorRules(reason: string): readonly WorkflowRunDecideRule[] {
  return severityRules(ABOVE_MINOR, 'fix_before_merge', reason);
}

/** A minor of the change's own at any index, deciding `fix_before_merge` for `reason`. */
export function minorRules(reason: string): readonly WorkflowRunDecideRule[] {
  return defectMinorRules('fix_before_merge', reason);
}

const severestReason = (severity: string) => `The severest finding is a ${severity}.`;

/** The severest finding, most severe first: the first rule that holds names it. */
export const GRADE_FINDINGS_RULES: readonly WorkflowRunDecideRule[] = [
  ...severityRules(['blocker'], 'blocker', severestReason('blocker')),
  ...severityRules(['major'], 'major', severestReason('major')),
  ...defectMinorRules('minor', severestReason('minor')),
  ...severityRules(['nit'], 'nit', severestReason('nit')),
];

export const GRADE_FINDINGS_OTHERWISE = {
  decision: 'none',
  reason: 'The review returned no finding of the change, a `needs_setup` one aside.',
};

/** Where `round` holds, as a comparison: a missing round is bound as 1, the first. */
const ROUND_COMPARISON: Record<RoundsRuleRound, string> = {
  first: 'state.round <= 1',
  later: 'state.round > 1',
};

/**
 * The table as `workflow.run.decide` rules: one rule for each case a row
 * covers, each comparing the round, the severest finding and the verdict. A
 * row covering every round compares none. The rows are disjoint, so the
 * rules' order decides nothing.
 */
export function roundsRuleDecideRules(
  table: RoundsRuleTable = ROUNDS_RULE,
): WorkflowRunDecideRule[] {
  return table.flatMap((row) => {
    const rounds: Array<RoundsRuleRound | null> =
      row.rounds.length === ROUNDS_RULE_ROUNDS.length ? [null] : row.rounds;
    return rounds.flatMap((round) =>
      row.severest.flatMap((severest) =>
        row.verdicts.map((verdict) => ({
          when: {
            allOf: [
              ...(round === null ? [] : [ROUND_COMPARISON[round]]),
              `state.severest == '${severest}'`,
              `state.verdict == '${verdict}'`,
            ],
          },
          decision: row.decision,
          reason: row.reason,
        })),
      ),
    );
  });
}

export const ROUNDS_RULE_DECIDE_RULES: readonly WorkflowRunDecideRule[] = roundsRuleDecideRules();

export const RULE_AFTER_REVIEW_OTHERWISE = { decision: UNCOVERED, reason: UNCOVERED_REASON };

/** What the final record reads after the table: the model's answer, where it cleared its bar. */
export const AFTER_REVIEW_SETTLE_RULES: readonly WorkflowRunDecideRule[] = [
  ...ROUNDS_RULE_DECIDE_RULES,
  {
    when: { expression: "state.answer == 'fix_before_merge'" },
    decision: 'fix_before_merge',
    reason: MODEL_FIX_REASON,
  },
  {
    when: { expression: "state.answer == 'publish_as_is'" },
    decision: 'publish_as_is',
    reason: MODEL_PUBLISH_REASON,
  },
];

export const AFTER_REVIEW_SETTLE_OTHERWISE = {
  decision: 'fix_before_merge',
  reason: MODEL_UNDECIDED_REASON,
};

/** The round, the severest finding and the verdict, as the table's two readers bind them. */
const ROUND_FACTS_BINDINGS = {
  ...reviewBindings('verdict', 'verdict'),
  round: runInput('round'),
  severest: out(GRADE_FINDINGS_TASK_ID, 'decision'),
};
const ROUND_FACTS_STATE = {
  verdict: reviewValue('verdict'),
  round: { $firstOf: [bind('round'), 1] },
  severest: bind('severest'),
};

const DECISION_PROJECTION = {
  decision: { path: 'decision', onMissing: 'error' as const },
  reason: { path: 'reason', onMissing: 'error' as const },
};

export const GRADE_FINDINGS_TASK = {
  taskId: GRADE_FINDINGS_TASK_ID,
  name: "Name the severest of the review's findings",
  goal: "Name the severest of the review's findings: blocker, major, minor or nit, or none where it returned none. A finding of kind `needs_setup` is setup on the machine, not a defect of the change, and counts as none. No model is asked.",
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: REVIEW_TASK_IDS,
  // A review that did not finish returned no findings to read.
  when: reviewHas('findings'),
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: reviewBindings('findings', 'findings'),
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { findings: reviewValue('findings') },
    rules: GRADE_FINDINGS_RULES,
    otherwise: GRADE_FINDINGS_OTHERWISE,
  },
  outputProjection: DECISION_PROJECTION,
};

export const RULE_AFTER_REVIEW_TASK = {
  taskId: RULE_AFTER_REVIEW_TASK_ID,
  name: 'Look the review up in the rounds rule',
  goal: "Look up this publication's round, the severest finding and the verdict in the rounds rule's table. A row covering the case decides it. A case no row covers is `uncovered`, and only then is the decision model asked. No model is asked here.",
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [...REVIEW_TASK_IDS, GRADE_FINDINGS_TASK_ID],
  when: {
    expression: `tasks.${GRADE_FINDINGS_TASK_ID}.output.decision != null`,
    onMissingRef: SKIP,
  },
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: ROUND_FACTS_BINDINGS,
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: ROUND_FACTS_STATE,
    rules: ROUNDS_RULE_DECIDE_RULES,
    otherwise: RULE_AFTER_REVIEW_OTHERWISE,
  },
  outputProjection: DECISION_PROJECTION,
};

export const DECIDE_AFTER_REVIEW_TASK = {
  taskId: DECIDE_AFTER_REVIEW_TASK_ID,
  name: 'Ask the decision model about a review the rounds rule leaves open',
  goal: "Ask the space's decision model whether the review's findings are fixed before the branch merges, for a case no row of the rounds rule covers. An answer below its bar decides nothing, and the branch is then held for a fix round.",
  type: 'operation' as const,
  operation: 'ai.decision.decide',
  dependsOn: [...REVIEW_TASK_IDS, RULE_AFTER_REVIEW_TASK_ID],
  when: {
    expression: `tasks.${RULE_AFTER_REVIEW_TASK_ID}.output.decision == '${UNCOVERED}'`,
    onMissingRef: SKIP,
  },
  // A decision that could not be made is recorded as an undecided one.
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: {
    ...reviewBindings('verdict', 'verdict'),
    ...reviewBindings('findings', 'findings'),
    round: runInput('round'),
  },
  context: ctx('ai.decision.decide'),
  // No model is named: the space's decision model answers.
  inputTemplate: {
    state: {
      verdict: reviewValue('verdict'),
      findings: reviewValue('findings'),
      round: { $firstOf: [bind('round'), 1] },
    },
    questions: {
      [AFTER_REVIEW_QUESTION_NAME]: {
        ...AFTER_REVIEW_QUESTION,
        minConfidence: AFTER_REVIEW_MIN_CONFIDENCE,
      },
    },
  },
};

export const SETTLE_AFTER_REVIEW_TASK = {
  taskId: 'settle-after-review',
  name: 'Decide by the rounds rule whether the findings are fixed before merging',
  goal: "Record the decision on the review's findings. A case the rounds rule's table covers is decided by its row, with no model asked. A case it does not cover takes the decision model's answer where it cleared its bar, and is held for a fix round where it did not.",
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: [
    ...REVIEW_TASK_IDS,
    GRADE_FINDINGS_TASK_ID,
    RULE_AFTER_REVIEW_TASK_ID,
    DECIDE_AFTER_REVIEW_TASK_ID,
  ],
  when: {
    expression: `tasks.${RULE_AFTER_REVIEW_TASK_ID}.output.decision != null`,
    onMissingRef: SKIP,
  },
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    ...ROUND_FACTS_BINDINGS,
    answer: out(DECIDE_AFTER_REVIEW_TASK_ID, `answers.${AFTER_REVIEW_QUESTION_NAME}.decidedValue`),
  },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { ...ROUND_FACTS_STATE, answer: bind('answer') },
    rules: AFTER_REVIEW_SETTLE_RULES,
    otherwise: AFTER_REVIEW_SETTLE_OTHERWISE,
  },
  outputProjection: DECISION_PROJECTION,
};

/** Every task of the decision after a review, in the order they run. */
export const AFTER_REVIEW_TASKS = [
  GRADE_FINDINGS_TASK,
  RULE_AFTER_REVIEW_TASK,
  DECIDE_AFTER_REVIEW_TASK,
  SETTLE_AFTER_REVIEW_TASK,
];

/** The decision on the findings, as every task after it reads it; absent where the review did not finish. */
export const AFTER_REVIEW_BINDINGS = {
  afterReview: out(SETTLE_AFTER_REVIEW_TASK.taskId, 'decision'),
};
export const AFTER_REVIEW_VALUE = bind('afterReview');
