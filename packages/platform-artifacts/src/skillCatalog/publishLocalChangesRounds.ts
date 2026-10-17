/**
 * What Publish Local Changes does with its two decisions (Plan 315 D22): the
 * decision after a failed check and its stop, the judgement of a review's
 * findings and the decision on a fix round, and the fix round itself — a
 * commission and the publication of its fix. The questions are in
 * `publishLocalChangesDecisions.ts`; where these tasks sit in the graph, and
 * the push gate none of them touches, are in `publishLocalChanges.ts`.
 */
import { COMMISSION_CHANGE } from './commissionChange.js';
import {
  AFTER_CHECK_QUESTION,
  AFTER_CHECK_QUESTION_NAME,
  AFTER_REVIEW_QUESTION,
  AFTER_REVIEW_QUESTION_NAME,
  FIX_CHECKS_BRIEF_LEAD,
  FIX_FINDINGS_BRIEF_LEAD,
} from './publishLocalChangesDecisions.js';

export const CHECK_FAILED =
  "The folder's checks failed on this run's commit: their account is above, with the end of what they printed, and the whole of it is stored with this failure. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. Commission the fix onto this branch — nothing of it has left the machine — and publish again. Where they ran out of the folder's time rather than failed, the folder's `checksTimeoutMs` is the operator's to raise on the machine.";

/** The commission a fix round starts, and the publication that publishes its fix: each as the Store installed it. */
const COMMISSION_SKILL = {
  catalogId: COMMISSION_CHANGE.catalogId,
  slug: COMMISSION_CHANGE.bundle.workflow.slug,
};
const PUBLISH_SKILL = {
  catalogId: 'publish-local-changes',
  slug: 'publish-local-changes',
};

export const AFTER_CHECK = `tasks.decide-after-check.output`;
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

/** What a fix round's commission returns, read from its run: no change is no fix, and fails the round. */
const FIX_COMMISSION_PROJECTION = {
  patchRef: { path: 'result.output.patchRef', onMissing: 'error' as const },
  baseSha: { path: 'result.output.baseSha', onMissing: 'error' as const },
  outcome: { path: 'outcome', onMissing: 'error' as const },
  commissionRunId: { path: 'runId', onMissing: 'error' as const },
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

export const DECIDE_AFTER_CHECK_TASK = {
  taskId: 'decide-after-check',
  name: 'Decide what follows the failed checks',
  goal: "Read the account of the folder's checks that did not pass — their summary, the failing step where they named one, the end of what they printed — and choose what follows: run them again where nothing failed but time, commission a fix where they found something wrong in the change, or stop for the operator where the machine cannot run them as declared.",
  type: 'operation' as const,
  operation: 'ai.decision.decide',
  dependsOn: ['check-commit'],
  // A run lost only to tests running out of their time is run again by rule,
  // whatever model the space has or lacks: the checks reported nothing else
  // failed, so there is nothing to decide, and a decision beside the rule
  // could only send one failure down two routes.
  when: {
    allOf: [
      'tasks.check-commit.output.passed == false',
      'tasks.check-commit.output.testTimeouts == null',
    ],
    onMissingRef: 'skip' as const,
  },
  // A decision that cannot be made — no decision model bound to the
  // space, a provider refusing — is no answer: `checks-failed` reads
  // its status and stops the run as a failed check always did.
  optional: true,
  retryability: 'safe' as const,
  maxAttempts: 2,
  inputBindings: {
    summary: { kind: 'task_output' as const, taskId: 'check-commit', path: 'summary' },
    tail: { kind: 'task_output' as const, taskId: 'check-commit', path: 'tail' },
    failingGuard: {
      kind: 'task_output' as const,
      taskId: 'check-commit',
      path: 'failingGuard',
    },
    timedOut: { kind: 'task_output' as const, taskId: 'check-commit', path: 'timedOut' },
    testTimeouts: {
      kind: 'task_output' as const,
      taskId: 'check-commit',
      path: 'testTimeouts',
    },
  },
  context: DECIDE_CONTEXT,
  inputTemplate: {
    state: {
      summary: { $bind: 'summary' },
      tail: { $bind: 'tail' },
      failingGuard: { $bind: 'failingGuard' },
      timedOut: { $bind: 'timedOut' },
      testTimeouts: { $bind: 'testTimeouts' },
    },
    questions: { [AFTER_CHECK_QUESTION_NAME]: AFTER_CHECK_QUESTION },
  },
  // `nextStep` is the route, null where the answer fell below the bar;
  // `chosen` is what it would have chosen, kept for whoever reads the run.
  outputProjection: {
    nextStep: {
      path: `answers.${AFTER_CHECK_QUESTION_NAME}.decidedValue`,
      onMissing: 'error' as const,
    },
    chosen: {
      path: `answers.${AFTER_CHECK_QUESTION_NAME}.value`,
      onMissing: 'error' as const,
    },
    decided: {
      path: `answers.${AFTER_CHECK_QUESTION_NAME}.decided`,
      onMissing: 'error' as const,
    },
    confidence: {
      path: `answers.${AFTER_CHECK_QUESTION_NAME}.confidence`,
      onMissing: 'error' as const,
    },
  },
};

export const CHECKS_FAILED_TASK = {
  taskId: 'checks-failed',
  name: 'Stop on the failed checks',
  goal: "Fail the publication with the checks' own account, where the decision after them found the machine cannot run them as declared, could not decide, or could not be made — so whoever started it is woken with what the checks printed, as a failed check always woke them.",
  failureInstruction: CHECK_FAILED,
  type: 'operation' as const,
  operation: 'workflow.run.fail',
  dependsOn: ['check-commit', 'decide-after-check'],
  when: {
    anyOf: [
      `${AFTER_CHECK}.nextStep == 'operator_install_mismatch'`,
      `${AFTER_CHECK}.decided == false`,
      "tasks.decide-after-check.status == 'failed'",
    ],
    onMissingRef: 'skip' as const,
  },
  retryability: 'safe' as const,
  maxAttempts: 1,
  inputBindings: {
    summary: { kind: 'task_output' as const, taskId: 'check-commit', path: 'summary' },
  },
  context: {
    strategy: 'scoped' as const,
    contextPolicy: 'auto-optimize' as const,
    learnings: 'none' as const,
    capabilities: {
      operations: ['workflow.run.fail'],
      integrations: [],
    },
  },
  inputTemplate: {
    reason: { $bind: 'summary' },
  },
};

export const DECIDE_AFTER_REVIEW_TASK = {
  taskId: 'decide-after-review',
  name: 'Decide whether the findings are fixed before merging',
  goal: "Read the review's findings and choose whether this branch takes a fix round before it merges, merges as it is with the findings recorded, or waits on the operator's word.",
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

export const FIX_CHECKS_TASK = {
  taskId: 'fix-checks',
  name: 'Commission the fix the checks call for',
  goal: "Start a commission on this run's commit, briefed with the checks' own account — the step that failed and the end of what they printed — and wait for its change.",
  failureInstruction:
    "The commission briefed to make the folder's checks pass returned no change, or did not finish; its run says why. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. Read the commission's run, then commission the fix onto this branch and publish again — or, where its brief was refused for its length, brief it by hand from the checks' account above.",
  type: 'operation' as const,
  operation: 'workflow.run.start',
  dependsOn: ['commit', 'check-commit', 'decide-after-check'],
  when: {
    expression: `${AFTER_CHECK}.nextStep == 'fix_commission'`,
    onMissingRef: 'skip' as const,
  },
  // A second attempt starts a second commission.
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    bindingId: { kind: 'run_input' as const, path: 'bindingId' },
    commitSha: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.sha' },
    summary: { kind: 'task_output' as const, taskId: 'check-commit', path: 'summary' },
  },
  context: RUN_START_CONTEXT,
  inputTemplate: {
    slug: COMMISSION_SKILL.slug,
    catalogId: COMMISSION_SKILL.catalogId,
    inputs: {
      bindingId: { $bind: 'bindingId' },
      task: { $concat: [FIX_CHECKS_BRIEF_LEAD, { $bind: 'summary' }] },
      base: { $bind: 'commitSha' },
    },
    wait: 'until_complete',
  },
  outputProjection: FIX_COMMISSION_PROJECTION,
};

export const FIX_FINDINGS_TASK = {
  taskId: 'fix-findings',
  name: 'Commission the fix the findings call for',
  goal: "Once this run's push has gone, start a commission on this run's commit, briefed with every finding of the review as the review reported it, and wait for its change.",
  failureInstruction:
    "The commission briefed to fix the review's findings returned no change, or did not finish; its run says why. This run's commit was pushed, and the findings are on the review. Read the commission's run, then commission the fix onto this branch and publish again — or, where its brief was refused for its length, brief it by hand from the findings.",
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
  outputProjection: FIX_COMMISSION_PROJECTION,
};

const REPUBLISH_FAILED =
  'The publication of the fix did not push: it failed, was cancelled, stopped at its own approval, or its push was declined — how it ended is named above, and that run says why. The fix is committed on the branch in the folder where that publication got so far. Read that run, put right what stopped it, and publish the branch as it stands.';

export const REPUBLISH_AFTER_CHECKS_TASK = {
  taskId: 'republish-after-checks',
  name: 'Publish the fix the checks called for',
  goal: "Publish the commission's fix onto this branch as a publication of its own — committed, checked, scanned, reviewed and pushed under the folder's push approval as any publication is — and report its pull request as this run's.",
  failureInstruction: REPUBLISH_FAILED,
  type: 'operation' as const,
  operation: 'workflow.run.start',
  // Nothing of this run was scanned, reviewed or pushed — its checks failed —
  // so the publication of the fix is the only one, and asks as any does.
  dependsOn: ['fix-checks'],
  when: {
    expression: 'tasks.fix-checks.output.patchRef != null',
    onMissingRef: 'skip' as const,
  },
  retryability: 'unsafe' as const,
  maxAttempts: 1,
  inputBindings: {
    ...REPUBLISH_PASSED_ON_BINDINGS,
    patchRef: { kind: 'task_output' as const, taskId: 'fix-checks', path: 'patchRef' },
    baseSha: { kind: 'task_output' as const, taskId: 'fix-checks', path: 'baseSha' },
    commissionRunId: {
      kind: 'task_output' as const,
      taskId: 'fix-checks',
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
          "Make the folder's checks pass\n\nThe fix commission ",
          { $bind: 'commissionRunId' },
          " made from what the folder's checks printed when they failed on ",
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
