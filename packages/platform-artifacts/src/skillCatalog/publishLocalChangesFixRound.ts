import type { WorkflowRunDecideRule } from '@aflow/schemas';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';

/**
 * What a publication that decided `fix_before_merge` hands the round after it
 * (Plan 315 D22): the branch kept on the machine, its head, whether `origin`'s
 * base moved past it, the review run the round is briefed from, the findings
 * it carries, and the exact Commission Change inputs the round takes. The
 * branch was never pushed, so a commission started from `origin/main` cannot
 * reach it and returns an empty change; `base` the branch's name is the only
 * start that holds the publication's commit, and `mergeFrom: origin/<base>`
 * brings in what the base gained since.
 *
 * Two tasks, one for each answer to whether the base moved, so each carries
 * the commission's inputs as they are to be passed — `mergeFrom` present only
 * where it is wanted — and exactly one of them writes `fixRound`.
 */

export const FIX_ROUND_MERGE_REASON =
  "`origin`'s base moved past the branch since it was cut or last merged it: the fix round starts at the branch and merges the base in first, `mergeFrom` naming it, so the fix is published onto the branch as one merge commit.";
export const FIX_ROUND_ON_BRANCH_REASON =
  "`origin`'s base holds nothing the branch lacks: the fix round starts at the branch, and its patch appends to the publication's commit.";

const FIX_ROUND_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.baseMovedSince == true' },
    decision: 'merge_base',
    reason: FIX_ROUND_MERGE_REASON,
  },
];

/** The base `origin` holds, as Commission Change's `mergeFrom` names it. */
const ORIGIN_BASE = { $concat: ['origin/', bind('base')] };

function fixRoundTask(baseMoved: boolean) {
  return {
    taskId: baseMoved ? 'hand-fix-round-merging' : 'hand-fix-round',
    name: baseMoved
      ? 'Hand the fix round its branch, merging the moved base'
      : 'Hand the fix round its branch',
    goal: `Where the decision on the review's findings is \`fix_before_merge\` and the branch stayed on the machine, record what the fix round needs: the branch, its head, whether \`origin\`'s base moved past it, the review run and the findings — and the Commission Change inputs it starts from, \`base\` the branch's name${baseMoved ? ' and `mergeFrom` the base on `origin`, which moved' : ''}.`,
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: ['commit', 'review-commit', 'describe-pr', 'decide-push'],
    when: {
      allOf: [
        "tasks.describe-pr.output.afterReview == 'fix_before_merge'",
        "tasks.decide-push.output.decision == 'keep_local'",
        `tasks.commit.output.commit.baseMoved == ${String(baseMoved)}`,
      ],
      onMissingRef: SKIP,
    },
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      branch: out('commit', 'commit.branch'),
      headSha: out('commit', 'commit.sha'),
      baseMoved: out('commit', 'commit.baseMoved'),
      reviewRunId: out('review-commit', 'reviewRunId'),
      findings: out('describe-pr', 'findings'),
      ...(baseMoved ? { base: runInput('base') } : {}),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      state: {
        branch: bind('branch'),
        headSha: bind('headSha'),
        baseMovedSince: bind('baseMoved'),
        reviewRunId: bind('reviewRunId'),
        findings: bind('findings'),
        commissionInputs: baseMoved
          ? { base: bind('branch'), mergeFrom: ORIGIN_BASE }
          : { base: bind('branch') },
      },
      rules: FIX_ROUND_RULES,
      otherwise: { decision: 'on_branch', reason: FIX_ROUND_ON_BRANCH_REASON },
    },
    outputProjection: {
      decision: { path: 'decision', onMissing: 'error' as const },
      reason: { path: 'reason', onMissing: 'error' as const },
      fixRound: { fromInput: 'state' },
    },
    promoteOutputs: [{ kind: 'output_path' as const, path: 'fixRound', toState: 'fixRound' }],
  };
}

export const FIX_ROUND_TASKS = [fixRoundTask(false), fixRoundTask(true)];

/**
 * The review's verdict as its run holds it now, not as the run first ended:
 * a review retried in place keeps its run and its id, and its result is
 * rebuilt from the attempt that last ran, so a retry that approved reads as
 * a first pass that did. Read after the push, or after the gate kept the
 * branch local — the operator's answer to an approval is where such a retry
 * lands — and never on a decline, which pushes nothing for it to describe.
 */
export const READ_REVIEW_TASK = {
  taskId: 'read-review',
  name: "Read the review's verdict from its run",
  goal: "Read the verdict of this publication's Local Code Review from the review run as it stands — its final attempt, where a failed review was retried in place — for the run to record.",
  type: 'operation' as const,
  operation: 'workflow.run.detail',
  dependsOn: ['review-commit', 'push'],
  when: { expression: 'tasks.review-commit.output.reviewRunId != null', onMissingRef: SKIP },
  // The verdict on record, never the push's: nothing waits on it here.
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: { reviewRunId: out('review-commit', 'reviewRunId') },
  context: ctx('workflow.run.detail'),
  inputTemplate: { runId: bind('reviewRunId'), compact: true },
  // Only a completed review promoted a verdict: one failed, cancelled or
  // still running reads as null.
  outputProjection: {
    verdict: { path: 'result.output.verdict', onMissing: 'null' as const },
    reviewStatus: { path: 'run.status', onMissing: 'error' as const },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'verdict', toState: 'verdict' }],
};
