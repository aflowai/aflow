import type { HostPushApproval, WorkflowRunDecideRule } from '@aflow/schemas';
import { bind, ctx, out, runInput, SKIP } from './localPrShepherdWiring.js';
import {
  BRIEF_MAX_TURNS,
  REVIEW_FINDING_SCHEMA,
  REVIEW_LOCAL_CHANGES,
} from './reviewLocalChanges.js';

/**
 * Publish Local Changes' review of what its push adds (Plan 315 D22): how
 * deep it reads, decided by rules from the commit's shape, and the review
 * itself — retried once, as a task of its own, where it ended without a
 * result. Every task after it reads the review that counts: the retry's,
 * where it ran, and the first one's otherwise.
 */

export const REVIEW_TASK_ID = 'review-commit';
export const RETRY_REVIEW_TASK_ID = 'retry-review';
export const REVIEW_DEPTH_TASK_ID = 'decide-review-depth';

/**
 * The skill whose verdict on the commit, or the decision on whose findings,
 * can stand in for the operator's approval — named by its catalog entry, so
 * only that skill as the Store installed it may skip the approval, never
 * whatever holds its slug.
 */
const REVIEW_SKILL = {
  catalogId: REVIEW_LOCAL_CHANGES.catalogId,
  slug: REVIEW_LOCAL_CHANGES.bundle.workflow.slug,
};

/** The one posture under which the publication reviews its commit to decide whether to ask. */
const REVIEW_GATED_POSTURE: HostPushApproval = 'unless-unreviewed';

/**
 * Only the posture that depends on a review starts one, so a verdict always
 * belongs to a run whose approval it decides — and only over a range the
 * scan cleared, since an unread file or a line marked allowed may hold what
 * the coding agent's provider must not see, and the approval is asked for
 * such a range whatever a review says.
 */
const REVIEW_RUNS = [
  `tasks.read-push-approval.output.branchPolicy.pushApproval == '${REVIEW_GATED_POSTURE}'`,
  'tasks.scan-commit.output.clean == true',
];

// --- How deep the review reads -----------------------------------------------

/**
 * The areas the commit task counts what the push changes within. `deep`
 * covers the contracts every service reads, the orchestrator, the executor
 * that runs on the operator's machine, and the database's migrations;
 * `light` is documentation and tests.
 */
export const REVIEW_DEPTH_AREAS = {
  deep: [
    'packages/schemas/**',
    'apps/aflow-orchestrator/**',
    'apps/aflow-executor-host/**',
    'packages/database/src/migrations/**',
    'packages/database/src/tenant/migrations/**',
  ],
  light: ['docs/**', '**/*.md', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'],
};

/** Fewer changed lines than this, added and removed together, is a small change. */
export const SMALL_CHANGE_LINES = 30;

export const UNMEASURED_REASON =
  'The commit task did not report what the push changes, so the review reads at `standard`, the depth it read at before its shape was measured.';
export const DEEP_REASON =
  "The push changes a file under the schemas, the orchestrator, the host executor or a database migration: the review reads at `deep`, running the project's own checks over what it touches.";
export const DOCS_TESTS_REASON =
  'The push changes documentation and tests alone: the review reads at `brief`.';
export const SMALL_CHANGE_REASON = `The push changes fewer than ${String(SMALL_CHANGE_LINES)} lines, none of them under the schemas, the orchestrator, the host executor or a database migration: the review reads at \`brief\`.`;
export const STANDARD_REASON = `The push changes code outside the sensitive paths, in ${String(SMALL_CHANGE_LINES)} lines or more: the review reads at \`standard\`.`;

/**
 * The depth, by the commit's shape. Deep is read first, so it takes
 * precedence over brief: a one-line change to a schema, a migration, the
 * orchestrator or the host executor is read deep, because a small change there
 * reaches every service or the operator's machine, and the size of a diff says
 * nothing about the size of what it can break. That ordering is the choice to
 * argue with. A shape the commit did not report reads `standard`, never
 * `brief`: an unmeasured change is not a small one.
 *
 * The turn budget travels as the rule's value. `brief` takes
 * `BRIEF_MAX_TURNS`, the budget Local Code Review sizes a brief review by;
 * `standard` and `deep` take none, as Local Code Review has them — its
 * `maxTurns` admits no more than the brief budget, and those depths read the
 * range through, bounded by the review's own timeout.
 */
export const REVIEW_DEPTH_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.changes == null' },
    decision: 'standard',
    reason: UNMEASURED_REASON,
  },
  {
    when: { expression: 'state.changes.areas.deep.files > 0' },
    decision: 'deep',
    reason: DEEP_REASON,
  },
  {
    when: { expression: 'state.changes.areas.light.files == state.changes.files' },
    decision: 'brief',
    reason: DOCS_TESTS_REASON,
    value: BRIEF_MAX_TURNS,
  },
  {
    when: { expression: `state.changes.lines < ${String(SMALL_CHANGE_LINES)}` },
    decision: 'brief',
    reason: SMALL_CHANGE_REASON,
    value: BRIEF_MAX_TURNS,
  },
];

export const REVIEW_DEPTH_OTHERWISE = { decision: 'standard', reason: STANDARD_REASON };

export const DECIDE_REVIEW_DEPTH_TASK = {
  taskId: REVIEW_DEPTH_TASK_ID,
  name: 'Decide how deep the review reads',
  goal: "Decide, by rules over what the commit task counted of the push's changes, the depth the review reads at and the turns it is given: `deep` where any file is under the schemas, the orchestrator, the host executor or a database migration, however small the change; `brief` where only documentation and tests change, or fewer than 30 lines; `standard` otherwise. No model is asked.",
  type: 'operation' as const,
  operation: 'workflow.run.decide',
  dependsOn: ['commit', 'read-push-approval', 'scan-commit'],
  when: { allOf: REVIEW_RUNS, onMissingRef: SKIP },
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: { changes: out('commit', 'commit.pushChanges') },
  context: ctx('workflow.run.decide'),
  inputTemplate: {
    state: { changes: bind('changes') },
    rules: REVIEW_DEPTH_RULES,
    otherwise: REVIEW_DEPTH_OTHERWISE,
  },
  // Unprojected: `value`, the turn budget, is absent where the depth takes
  // none, so the review's `maxTurns` is dropped rather than handed a null.
};

// --- The review, and its one retry -------------------------------------------

const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reviewSummary', 'findings', 'outcome', 'reviewRunId', 'reviewed'],
  additionalProperties: false,
  properties: {
    reviewed: {
      type: 'object',
      required: ['from', 'at'],
      properties: {
        from: { type: 'string', minLength: 1 },
        at: { type: 'string', minLength: 1 },
      },
      description:
        'What the review was started on: `from..at`, where `at` is the commit this run pushes — the sha `verdict` is for.',
    },
    verdict: {
      type: ['string', 'null'],
      description:
        'What the review of this commit returned: approve, request_changes or comment; null when it did not complete.',
    },
    reviewSummary: {
      type: ['string', 'null'],
      description:
        "The review's own account — every finding by severity and `file:line`, and the checks it ran — which the pull request carries; null when it did not complete.",
    },
    findings: {
      type: ['array', 'null'],
      items: REVIEW_FINDING_SCHEMA,
      description:
        'Every finding as the review returned it — severity, file, line, claim, evidence, suggestion — which the decision after the review weighs and the pull request records; null when the review did not complete.',
    },
    outcome: {
      type: 'string',
      description:
        'How the review run ended: completed, failed or cancelled — or paused, when it stopped for something only an operator can supply and was cancelled.',
    },
    reviewRunId: { type: 'string', format: 'uuid' },
  },
};

function reviewTask(retry: boolean) {
  return {
    taskId: retry ? RETRY_REVIEW_TASK_ID : REVIEW_TASK_ID,
    name: retry ? 'Review the commit again, once' : 'Review the commit',
    goal: retry
      ? 'Where the review ended without a result — its run failed, or its harness exited without writing one — run the same Local Code Review once more, as a run of its own with the same inputs, and wait for it to finish with its verdict. Only a second review without a result leaves the push to the operator.'
      : "Run a Local Code Review of everything the push would add — this run's commit and every commit under it that `origin`'s base branch does not hold — as a run of its own, at the depth decided from the commit's shape, and wait for it to finish with its verdict.",
    type: 'operation' as const,
    operation: 'workflow.run.start',
    // After the scan as well: a commit carrying a secret is never handed to
    // a coding agent, whose provider would read it.
    dependsOn: retry
      ? [REVIEW_TASK_ID, REVIEW_DEPTH_TASK_ID]
      : ['read-push-approval', 'scan-commit', REVIEW_DEPTH_TASK_ID],
    // A run cancelled by a person is their answer, not a missing result.
    when: retry
      ? {
          allOf: [
            `tasks.${REVIEW_TASK_ID}.output.verdict == null`,
            `tasks.${REVIEW_TASK_ID}.output.outcome != 'cancelled'`,
          ],
          onMissingRef: SKIP,
        }
      : { allOf: REVIEW_RUNS, onMissingRef: SKIP },
    // A review that could not run is no verdict, not a failed publication:
    // the approval reads its status and asks.
    optional: true,
    // A second attempt starts a second review, and the one retry is its own
    // task so the run shows it happened.
    retryability: 'unsafe' as const,
    maxAttempts: 1,
    inputBindings: {
      bindingId: runInput('bindingId'),
      // `pushRange`'s two ends: the review builds the range from them, so it
      // reads exactly what the scan read. The tip is where its checkout
      // stands — not the folder's own HEAD, which is where the commission
      // started, since the commit lands on a branch nothing has checked out.
      from: out('commit', 'commit.pushBaseSha'),
      at: out('commit', 'commit.sha'),
      reviewHarness: runInput('reviewHarness'),
      depth: out(REVIEW_DEPTH_TASK_ID, 'decision'),
      maxTurns: out(REVIEW_DEPTH_TASK_ID, 'value'),
    },
    context: ctx('workflow.run.start'),
    inputTemplate: {
      slug: REVIEW_SKILL.slug,
      catalogId: REVIEW_SKILL.catalogId,
      inputs: {
        bindingId: bind('bindingId'),
        from: bind('from'),
        at: bind('at'),
        depth: bind('depth'),
        // Unset, each key is dropped: no turn budget, and the review's own default harness.
        maxTurns: bind('maxTurns'),
        harness: bind('reviewHarness'),
      },
      wait: 'until_complete',
    },
    // A review that failed, was cancelled or paused carries no promoted
    // output, so its verdict reads null.
    outputProjection: {
      verdict: { path: 'result.output.verdict', onMissing: 'null' as const },
      reviewSummary: { path: 'result.output.reviewSummary', onMissing: 'null' as const },
      findings: { path: 'result.output.findings', onMissing: 'null' as const },
      outcome: { path: 'outcome', onMissing: 'error' as const },
      reviewRunId: { path: 'runId', onMissing: 'error' as const },
      // The Local PR Shepherd trusts a verdict only for the head it reads
      // (Plan 321 D6): `reviewed.at` is the commit this push carries.
      reviewed: { fromInput: 'inputs' },
    },
    // The review run holds every finding whole, which is what a fix round is
    // briefed from; the run names it so whoever starts one can read it.
    promoteOutputs: [{ kind: 'output_path' as const, path: 'reviewRunId', toState: 'reviewRunId' }],
    outputContract: { schema: REVIEW_OUTPUT_SCHEMA },
  };
}

export const REVIEW_TASKS = [reviewTask(false), reviewTask(true)];

/** Both review tasks, for a task that reads the review that counts to wait on. */
export const REVIEW_TASK_IDS = [REVIEW_TASK_ID, RETRY_REVIEW_TASK_ID];

const retried = (name: string) => `retried${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/**
 * One output of the review that counts, as a pair of bindings — the first
 * review's under `name`, the retry's beside it — that `reviewValue(name)`
 * reads in a template. `path` absent binds the whole output.
 */
export function reviewBindings(name: string, path?: string) {
  return { [name]: out(REVIEW_TASK_ID, path), [retried(name)]: out(RETRY_REVIEW_TASK_ID, path) };
}

/**
 * The retry's value where it ran, the first review's otherwise. A retry runs
 * only where the first returned no verdict, so its value — null included —
 * is the one that counts.
 */
export function reviewValue(name: string) {
  return { $firstOf: [bind(retried(name)), bind(name)] };
}

/** Holds where the review that counts has `path` — the first review's, or the retry's. */
export function reviewHas(path: string) {
  return {
    anyOf: [
      `tasks.${REVIEW_TASK_ID}.output.${path} != null`,
      `tasks.${RETRY_REVIEW_TASK_ID}.output.${path} != null`,
    ],
    onMissingRef: SKIP,
  };
}
