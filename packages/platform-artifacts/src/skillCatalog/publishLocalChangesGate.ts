import type { WorkflowRunDecideRule } from '@aflow/schemas';

/**
 * Publish Local Changes' push gate, as ordered rules over what the run read
 * (Plan 315 D22): the first that holds decides whether the push goes without
 * asking (`push`), waits for the operator (`ask`), or stays on the machine
 * (`keep_local`). It runs once the pull request's text is composed, since the
 * decision on the review's findings is recorded there — an override included.
 *
 * The scan and the posture come first, so no decision ever stands in for a
 * range the scan did not clear or for a folder that asks before every push.
 * Past them, under `unless-unreviewed`, the decision on the findings stands
 * in for the verdict: a review with findings is followed by what was decided
 * on them, and only a review with none is followed by its verdict alone. A
 * path through a read that did not happen reads as null, which is why every
 * rule that clears a push compares equal to what clears it.
 */
export const PUSH_GATE_RULES: readonly WorkflowRunDecideRule[] = [
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
    when: { expression: "state.afterReview == 'publish_as_is'" },
    decision: 'push',
    reason:
      "The decision on the review's findings is `publish_as_is`: it stands in for an approving verdict, and the pull request lists the findings it leaves open.",
  },
  {
    when: { expression: "state.afterReview == 'undecided'" },
    decision: 'ask',
    reason:
      "No answer on the review's findings cleared the decision's bar: the operator decides whether the push goes.",
  },
  {
    when: { expression: "state.verdict == 'approve'" },
    decision: 'push',
    reason: 'The review approved everything the push would add and found nothing.',
  },
];

export const PUSH_GATE_OTHERWISE = {
  decision: 'ask',
  reason:
    'The review returned no findings to decide on and did not approve — or did not finish, or could not start — so nothing stands in for the operator.',
};
