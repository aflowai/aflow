import { SHEPHERD_HANDS_OFF_LABEL, type WorkflowRunDecideRule } from '@aflow/schemas';

// --- The rules ---------------------------------------------------------------

/**
 * Read in order; the first that holds decides. A rule a missing read must not
 * pass is written `!= <expected>`, since a path through a read that did not
 * happen reads as null. Every way to `fix` runs through the last two: CI
 * failed on a check run the shepherd has not acted on, within the budget.
 */
export const SHEPHERD_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.folder.branchPolicy.branchPrefix == null' },
    decision: 'leave',
    reason:
      'The folder allows no pushes, so no pull request from it is the shepherd’s to fix. Reconnect it with a publish prefix.',
  },
  {
    when: { expression: 'state.folder.origin == null' },
    decision: 'leave',
    reason:
      "The folder's `origin` is not a repository on GitHub, so there is no pull request to read.",
  },
  {
    when: { expression: 'state.candidates.statusCode != 200' },
    decision: 'wait',
    reason:
      "GitHub did not list the repository's open pull requests, so nothing was read to act on. The GitHub connection's access to the repository is the thing to check.",
  },
  {
    when: { expression: 'state.candidates.data.count == 0' },
    decision: 'leave',
    reason:
      "No open pull request Local Publish opened under the folder's prefix — or none of the number this pass was aimed at.",
  },
  {
    when: { expression: 'state.pr.statusCode != 200' },
    decision: 'wait',
    reason: 'GitHub did not return the pull request, so nothing was read to act on.',
  },
  {
    when: {
      anyOf: ['state.pr.data.ours != true', "state.pr.data.state != 'open'"],
    },
    decision: 'leave',
    reason: "The pull request is not an open one Local Publish opened under the folder's prefix.",
  },
  {
    when: { expression: 'state.pr.data.handsOff == true' },
    decision: 'wait',
    reason: `The pull request is labelled \`${SHEPHERD_HANDS_OFF_LABEL}\`: a person is working on it, and the shepherd writes nothing on it until the label goes.`,
  },
  // A pin read that finds none answers `found: false`; only one that failed
  // leaves nothing. Deciding that as a first pass would drop the acted-on
  // guard and restart the attempt count over a record that may exist.
  {
    when: { expression: 'state.pin == null' },
    decision: 'wait',
    reason:
      "The pin naming this pull request's handoff could not be read from the space's memory, so its record may exist unread: what was acted on before, and how many attempts are spent, is unknown. Nothing is written until it reads.",
  },
  {
    when: {
      anyOf: ['state.checks.statusCode != 200', 'state.handoff.statusCode != 200'],
    },
    decision: 'wait',
    reason:
      "GitHub did not return the head's check runs or the pull request's comments, so what CI says, or what was done before, is unknown.",
  },
  // A lease is live while its run is: running or paused, and taken within the
  // stated bound. One whose run ended, or that is older, is stale, and this
  // pass takes it over (`lease-takeover`).
  ...(['running', 'paused'] as const).map((status) => ({
    when: {
      allOf: [
        'state.lease.dataJson.runId != null',
        `state.leaseOwner.run.status == '${status}'`,
        'state.lease.dataJson.takenAtMs >= state.staleBefore',
      ],
    },
    decision: 'wait',
    reason:
      'Another pass holds the lease on this branch, and its run is still going: its fix is still being made or published.',
  })),
  {
    when: { expression: 'state.publications.runs[0] != null' },
    decision: 'wait',
    reason:
      'A publication of this branch is in flight — running, or paused at its approval — whoever started it.',
  },
  {
    when: { expression: 'state.commissions.runs[0] != null' },
    decision: 'wait',
    reason: 'A commission based on this branch is in flight, whoever started it.',
  },
  {
    when: { expression: "state.checks.data.state == 'passing'" },
    decision: 'leave',
    reason: 'CI passes on the head. The merge is the operator’s.',
  },
  {
    when: { expression: "state.checks.data.state != 'failing'" },
    decision: 'wait',
    reason:
      'CI has not failed on the head: its checks are still running, stopped short, or not there yet.',
  },
  {
    when: { expression: 'state.checks.data.firstFailing.id == state.handoff.data.checkRunId' },
    decision: 'wait',
    reason:
      'This check run’s failure was acted on already, and CI has not run again since: the fix is still to be published or checked.',
  },
  {
    when: { expression: 'state.handoff.data.attemptCount >= state.budget' },
    decision: 'abandon',
    reason:
      'The shepherd has acted on as many failures of this pull request as its budget allows, and CI fails again. It leaves the pull request to a person.',
  },
];

export const SHEPHERD_OTHERWISE = {
  decision: 'fix',
  reason: 'CI failed on a check run the shepherd has not acted on: the failure is commissioned.',
};

/**
 * Which remedy the routes took, as a label the record keeps — the routes of
 * `classify-failure`, read as rules over its answer: a confident answer takes
 * its remedy, and anything else the fix commission. Recorded so the next
 * round is briefed with what this one did; a test holds the two to the same
 * answers.
 */
export const REMEDY_TAKEN_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.answer == null' },
    decision: 'none',
    reason: 'The remedy question could not be asked, so no remedy ran.',
  },
  ...(
    [
      ['flaky_or_timeout', 'rerun_failed_jobs', 'The failed jobs were run again.'],
      ['dependency_advisory', 'dependency_bump', 'The flagged dependency was bumped.'],
      ['base_conflict', 'merge_round', 'The base was merged into the branch.'],
      ['ci_outage', 'wait_on_ci', 'CI itself was down; nothing in the repository was changed.'],
    ] as const
  ).map(([option, decision, reason]) => ({
    when: { allOf: ['state.answer.decided == true', `state.answer.value == '${option}'`] },
    decision,
    reason,
  })),
];

export const REMEDY_TAKEN_OTHERWISE = {
  decision: 'fix_commission',
  reason: 'The failure was commissioned as a fix.',
};
