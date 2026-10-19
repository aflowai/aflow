import type { WorkflowRunDecideRule } from '@aflow/schemas';
import type { SKIP } from './localPrShepherdWiring.js';

/**
 * Publish Local Changes' push gate, as ordered rules over what the run read
 * (Plan 315 D22): the first that holds decides whether the push goes without
 * asking (`push`), waits for the operator (`ask`), or stays on the machine
 * (`keep_local`). It runs once the pull request's text is composed, since the
 * decision on the review's findings is recorded there — an override included.
 *
 * An override the run refused, or a record naming an authority it did not
 * verify, keeps the branch local before anything else is read. Then the scan
 * and the posture, so no decision ever stands in for a range the scan did not
 * clear or for a folder that asks before every push.
 * Past them, under `unless-unreviewed`, the decision on the findings stands
 * in for the verdict: a review that finished is followed by what was decided
 * on its findings — `publish_as_is`, asking no model, where it found nothing
 * or nits alone. The decision stands in for an approving verdict only up to
 * the severities it covers: over a blocker or a major the operator is asked
 * whatever was decided, an override's `publish_as_is` included. Over no
 * findings at all it stands in for nothing: a review that found nothing and
 * did not approve could not judge the range, so the operator is asked. An override pushes only on
 * an authority the run verified (`publishLocalChangesOverride.ts`), and the
 * operator's word only through the operator's own approval. A path through a
 * read that did not happen reads as null, which is why every rule that clears
 * a push compares equal to what clears it.
 */
export const PUSH_GATE_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: "state.overrideCheck == 'refused'" },
    decision: 'keep_local',
    reason:
      "The override names an authority the run could not verify: nothing is pushed, the decision on the review's findings stands, and the run stops on the refusal.",
  },
  {
    when: { allOf: ['state.overrideBy != null', 'state.overrideBy != state.overrideCheck'] },
    decision: 'keep_local',
    reason:
      "The pull request's record sets the decision aside on an authority the run did not verify, so nothing is pushed.",
  },
  {
    when: { expression: 'state.scanClean != true' },
    decision: 'ask',
    reason:
      'The scan did not clear everything the push would add — a file it could not read whole, or a line marked allowed — so the operator reads it before anything leaves, whatever the posture.',
  },
  {
    when: { expression: "state.posture == 'always'" },
    decision: 'ask',
    reason: "The folder's push approval is `always`: it asks before every push.",
  },
  {
    when: { expression: "state.posture == 'never'" },
    decision: 'push',
    reason: "The folder's push approval is `never`, over a range the scan cleared.",
  },
  {
    when: { expression: 'state.posture == null' },
    decision: 'keep_local',
    reason:
      'The folder declares no publish prefix, so no push from it is allowed: the branch stays on the machine.',
  },
  {
    when: { expression: "state.afterReview == 'fix_before_merge'" },
    decision: 'keep_local',
    reason:
      "The decision on the review's findings is `fix_before_merge`: nothing is pushed, and the branch stays on the machine for the fix round, briefed from the review run.",
  },
  {
    when: { expression: "state.overrideBy == 'operator'" },
    decision: 'ask',
    reason:
      "The decision was set aside on the operator's word, which the run takes only from the operator: their approval of this push is that word on record, and a decline pushes nothing.",
  },
  {
    when: { anyOf: ["state.severest == 'blocker'", "state.severest == 'major'"] },
    decision: 'ask',
    reason:
      'The review found a blocker or a major: a decision on its findings stands in for an approving verdict only over minor findings and nits, so the operator decides whether the push goes.',
  },
  {
    when: {
      allOf: [
        "state.afterReview == 'publish_as_is'",
        'state.severest == null',
        "state.verdict != 'approve'",
      ],
    },
    decision: 'ask',
    reason:
      'The review found nothing and did not approve: it could not judge the range, so the operator decides whether the push goes.',
  },
  {
    when: { expression: "state.afterReview == 'publish_as_is'" },
    decision: 'push',
    reason:
      "The decision on the review's findings is `publish_as_is`, over findings no more severe than minor: it stands in for an approving verdict, and the pull request lists the findings it leaves open.",
  },
  {
    when: { expression: "state.afterReview == 'undecided'" },
    decision: 'ask',
    reason:
      "No answer on the review's findings cleared the decision's bar: the operator decides whether the push goes.",
  },
];

export const PUSH_GATE_OTHERWISE = {
  decision: 'ask',
  reason:
    'The review did not finish, or could not start, so nothing was decided on its findings and nothing stands in for the operator.',
};

/**
 * The gate as the publication's task: after the composition, which records
 * the decision on the findings and any override of it — that record is what
 * is followed — and after the check of the override, which it reads beside
 * the record. `checksCleared` is the publication's own guard.
 */
export function decidePushTask(checksCleared: { anyOf: string[]; onMissingRef: typeof SKIP }) {
  return {
    taskId: 'decide-push',
    name: 'Decide whether the push asks',
    goal: "Decide, by rules over what the run read, whether the push goes without asking, waits for the operator, or stays on the machine: an uncleared scan or an `always` folder asks; a `never` folder pushes; under `unless-unreviewed` an override the run could not verify keeps the branch local, and otherwise the decision on the review's findings — `fix_before_merge` keeps the branch local, `publish_as_is` pushes over findings no more severe than minor and asks over a blocker or a major, or where the operator's word set the decision aside, `undecided` asks; where the review found nothing, `publish_as_is` pushes only on an approving verdict; and a review that did not finish asks.",
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [
      'read-repository',
      'scan-commit',
      'read-push-approval',
      'review-commit',
      'verify-override',
      'describe-pr',
    ],
    when: checksCleared,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      scanClean: { kind: 'task_output' as const, taskId: 'scan-commit', path: 'clean' },
      posture: {
        kind: 'task_output' as const,
        taskId: 'read-push-approval',
        path: 'branchPolicy.pushApproval',
      },
      verdict: { kind: 'task_output' as const, taskId: 'review-commit', path: 'verdict' },
      afterReview: {
        kind: 'task_output' as const,
        taskId: 'describe-pr',
        path: 'afterReview',
      },
      overrideBy: {
        kind: 'task_output' as const,
        taskId: 'describe-pr',
        path: 'afterReviewOverride.by',
      },
      severest: { kind: 'task_output' as const, taskId: 'describe-pr', path: 'severest' },
      overrideCheck: {
        kind: 'task_output' as const,
        taskId: 'verify-override',
        path: 'decision',
      },
    },
    context: {
      strategy: 'scoped' as const,
      contextPolicy: 'auto-optimize' as const,
      learnings: 'none' as const,
      capabilities: {
        operations: ['workflow.run.decide'],
        integrations: [],
      },
    },
    inputTemplate: {
      state: {
        scanClean: { $bind: 'scanClean' },
        posture: { $bind: 'posture' },
        verdict: { $bind: 'verdict' },
        afterReview: { $bind: 'afterReview' },
        overrideBy: { $bind: 'overrideBy' },
        severest: { $bind: 'severest' },
        overrideCheck: { $bind: 'overrideCheck' },
      },
      rules: PUSH_GATE_RULES,
      otherwise: PUSH_GATE_OTHERWISE,
    },
    outputProjection: {
      decision: { path: 'decision', onMissing: 'error' as const },
      reason: { path: 'reason', onMissing: 'error' as const },
    },
    promoteOutputs: [
      { kind: 'output_path' as const, path: 'decision', toState: 'pushDecision' },
      { kind: 'output_path' as const, path: 'reason', toState: 'pushReason' },
    ],
  };
}
