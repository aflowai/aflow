/**
 * What Publish Local Changes does with its decision on a review's findings
 * (Plan 315 D22): the decision, and the fix round it can start — a commission
 * and the publication of its fix. The question is in
 * `publishLocalChangesDecisions.ts`; where these tasks sit in the graph, and
 * the push gate none of them touches, are in `publishLocalChanges.ts`.
 */
import { COMMISSION_CHANGE } from './commissionChange.js';
import {
  AFTER_REVIEW_QUESTION,
  AFTER_REVIEW_QUESTION_NAME,
  FIX_FINDINGS_BRIEF_LEAD,
} from './publishLocalChangesDecisions.js';

/** The commission a fix round starts, and the publication that publishes its fix: each as the Store installed it. */
const COMMISSION_SKILL = {
  catalogId: COMMISSION_CHANGE.catalogId,
  slug: COMMISSION_CHANGE.bundle.workflow.slug,
};
const PUBLISH_SKILL = {
  catalogId: 'publish-local-changes',
  slug: 'publish-local-changes',
};

const AFTER_REVIEW = `tasks.decide-after-review.output`;

/** This run's push went: its exit code is there only where it ran. */
const PUSH_WENT = 'tasks.push.output.exitCode == 0';

/** A run started by a task, waited on, from the skill the Store installed. */
const RUN_START_CONTEXT = {
  strategy: 'scoped' as const,
  contextPolicy: 'auto-optimize' as const,
  learnings: 'none' as const,
  capabilities: {
    operations: ['workflow.run.start'],
    integrations: [],
  },
};

const DECIDE_CONTEXT = {
  strategy: 'scoped' as const,
  contextPolicy: 'auto-optimize' as const,
  learnings: 'none' as const,
  capabilities: {
    operations: ['ai.decision.decide'],
    integrations: [],
  },
};

/**
 * What the publication of a fix ends with, promoted as this run's pull request.
 * Its pull request is in its output only where it completed and pushed: one
 * that failed, was cancelled, stopped at its approval or was declined carries
 * none, which fails this task — never a null promoted over the pull request
 * this run opened — and the failure names how that run ended.
 */
const REPUBLISH_PROJECTION = {
  prUrl: { path: 'result.output.prUrl', onMissing: 'error' as const },
  // A number, not merely present: a null the run promoted is no pull request.
  prNumber: {
    path: 'result.output.prNumber',
    parse: ['number' as const],
    onMissing: 'error' as const,
  },
  outcome: { path: 'outcome', onMissing: 'error' as const },
  republishRunId: { path: 'runId', onMissing: 'error' as const },
};

const REPUBLISH_PROMOTES = [
  { kind: 'output_path' as const, path: 'prUrl', toState: 'prUrl' },
  { kind: 'output_path' as const, path: 'prNumber', toState: 'prNumber' },
];

/** What a publication of a fix carries on from this one besides the fix itself. */
const REPUBLISH_PASSED_ON_BINDINGS = {
  bindingId: { kind: 'run_input' as const, path: 'bindingId' },
  branch: { kind: 'run_input' as const, path: 'branch' },
  owner: { kind: 'run_input' as const, path: 'owner' },
  repo: { kind: 'run_input' as const, path: 'repo' },
  base: { kind: 'run_input' as const, path: 'base' },
  findings: { kind: 'run_input' as const, path: 'findings' },
  gaps: { kind: 'run_input' as const, path: 'gaps' },
  commitSha: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.sha' },
};

const REPUBLISH_PASSED_ON_INPUTS = {
  bindingId: { $bind: 'bindingId' },
  branch: { $bind: 'branch' },
  owner: { $bind: 'owner' },
  repo: { $bind: 'repo' },
  base: { $bind: 'base' },
  findings: { $bind: 'findings' },
  gaps: { $bind: 'gaps' },
};

export const DECIDE_AFTER_REVIEW_TASK = {
  taskId: 'decide-after-review',
  name: 'Decide whether the findings are fixed before merging',
  goal: "Read the review's findings and choose whether this branch takes a fix round before it merges or merges as it is with the findings recorded. An answer too unsure to act on is neither, and leaves the findings to whoever reads them.",
  type: 'operation' as const,
  operation: 'ai.decision.decide',
  dependsOn: ['review-commit'],
  // A review with no findings, or one that did not finish, has none to weigh.
  when: {
    expression: 'tasks.review-commit.output.findings[0] != null',
    onMissingRef: 'skip' as const,
  },
  // No decision is no fix round: the run goes on as a review's findings
  // always left it, through the approval, to whoever reads them.
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: {
    verdict: { kind: 'task_output' as const, taskId: 'review-commit', path: 'verdict' },
    findings: { kind: 'task_output' as const, taskId: 'review-commit', path: 'findings' },
  },
  context: DECIDE_CONTEXT,
  inputTemplate: {
    state: {
      verdict: { $bind: 'verdict' },
      findings: { $bind: 'findings' },
    },
    questions: { [AFTER_REVIEW_QUESTION_NAME]: AFTER_REVIEW_QUESTION },
  },
  // `afterReview` is the route, null where the answer fell below the bar;
  // `chosen` is what it would have chosen.
  outputProjection: {
    afterReview: {
      path: `answers.${AFTER_REVIEW_QUESTION_NAME}.decidedValue`,
      onMissing: 'error' as const,
    },
    chosen: {
      path: `answers.${AFTER_REVIEW_QUESTION_NAME}.value`,
      onMissing: 'error' as const,
    },
    decided: {
      path: `answers.${AFTER_REVIEW_QUESTION_NAME}.decided`,
      onMissing: 'error' as const,
    },
    confidence: {
      path: `answers.${AFTER_REVIEW_QUESTION_NAME}.confidence`,
      onMissing: 'error' as const,
    },
  },
  promoteOutputs: [{ kind: 'output_path' as const, path: 'afterReview', toState: 'afterReview' }],
};

export const FIX_FINDINGS_TASK = {
  taskId: 'fix-findings',
  name: 'Commission the fix the findings call for',
  goal: "Once this run's push has gone, start a commission on this run's commit, briefed with every finding of the review as the review reported it, and wait for its change. A commission that changed nothing found nothing to fix, and ends the round with this run's pull request as it stands.",
  failureInstruction:
    "The commission briefed to fix the review's findings did not finish; its run says why. This run's commit was pushed and its pull request stands, and the findings are on the review. Read the commission's run, then commission the fix onto this branch and publish again — or, where its brief was refused for its length, brief it by hand from the findings.",
  type: 'operation' as const,
  operation: 'workflow.run.start',
  // After the approval and the push: no commission runs while the operator
  // has yet to answer, and none on a push that was declined or never went.
  dependsOn: ['commit', 'review-commit', 'decide-after-review', 'approve-push', 'push'],
  when: {
    allOf: [`${AFTER_REVIEW}.afterReview == 'fix_before_merge'`, PUSH_WENT],
    onMissingRef: 'skip' as const,
  },
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: { kind: 'run_input' as const, path: 'bindingId' },
    commitSha: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.sha' },
    reviewSummary: {
      kind: 'task_output' as const,
      taskId: 'review-commit',
      path: 'reviewSummary',
    },
  },
  context: RUN_START_CONTEXT,
  inputTemplate: {
    slug: COMMISSION_SKILL.slug,
    catalogId: COMMISSION_SKILL.catalogId,
    inputs: {
      bindingId: { $bind: 'bindingId' },
      task: { $concat: [FIX_FINDINGS_BRIEF_LEAD, { $bind: 'reviewSummary' }] },
      base: { $bind: 'commitSha' },
    },
    wait: 'until_complete',
  },
  // `patchRef` is absent where the commission changed nothing — a round with
  // nothing to publish, which `republish-after-findings` skips. `baseSha` is
  // in every completed commission's output, so its absence is a commission
  // that did not finish, and fails this task.
  outputProjection: {
    patchRef: { path: 'result.output.patchRef', onMissing: 'null' as const },
    baseSha: { path: 'result.output.baseSha', onMissing: 'error' as const },
    outcome: { path: 'outcome', onMissing: 'error' as const },
    commissionRunId: { path: 'runId', onMissing: 'error' as const },
  },
};

const REPUBLISH_FAILED =
  'The publication of the fix did not push: it failed, was cancelled, stopped at its own approval, or its push was declined — how it ended is named above, and that run says why. The fix is committed on the branch in the folder where that publication got so far. Read that run, put right what stopped it, and publish the branch as it stands.';

export const REPUBLISH_AFTER_FINDINGS_TASK = {
  taskId: 'republish-after-findings',
  name: 'Publish the fix the findings called for',
  goal: "Publish the commission's fix onto this branch as a publication of its own, once this run's push has gone — never beside it, and never where it did not go — and report its pull request as this run's.",
  failureInstruction: REPUBLISH_FAILED,
  type: 'operation' as const,
  operation: 'workflow.run.start',
  // Its own gate on the push, beside the commission's: the fix is appended
  // to this commit, so it may leave the machine only where this commit did.
  // A decline — skipped as the harness records it, or recorded as an
  // answer — leaves the push unrun, and this with it, whatever the posture.
  dependsOn: ['fix-findings', 'approve-push', 'push'],
  when: {
    allOf: ['tasks.fix-findings.output.patchRef != null', PUSH_WENT],
    onMissingRef: 'skip' as const,
  },
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    ...REPUBLISH_PASSED_ON_BINDINGS,
    patchRef: { kind: 'task_output' as const, taskId: 'fix-findings', path: 'patchRef' },
    baseSha: { kind: 'task_output' as const, taskId: 'fix-findings', path: 'baseSha' },
    commissionRunId: {
      kind: 'task_output' as const,
      taskId: 'fix-findings',
      path: 'commissionRunId',
    },
  },
  context: RUN_START_CONTEXT,
  inputTemplate: {
    slug: PUBLISH_SKILL.slug,
    catalogId: PUBLISH_SKILL.catalogId,
    inputs: {
      ...REPUBLISH_PASSED_ON_INPUTS,
      patchRef: { $bind: 'patchRef' },
      baseSha: { $bind: 'baseSha' },
      commitMessage: {
        $concat: [
          "Fix the review's findings\n\nThe fix commission ",
          { $bind: 'commissionRunId' },
          ' made for the findings of the review of ',
          { $bind: 'commitSha' },
          '.',
        ],
      },
    },
    wait: 'until_complete',
  },
  outputProjection: REPUBLISH_PROJECTION,
  promoteOutputs: REPUBLISH_PROMOTES,
};
