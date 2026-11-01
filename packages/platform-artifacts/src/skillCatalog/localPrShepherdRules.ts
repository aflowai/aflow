import {
  HOST_MERGE_POSTURE_REVIEWED_PUSH,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_UNLISTED_PERSISTS_AFTER_MS,
  type ShepherdMergeOutcome,
  type WorkflowRunDecideRule,
} from '@aflow/schemas';

// --- The rules ---------------------------------------------------------------

/**
 * The decision of the one rule that holds when the attempt budget is spent.
 * A pass records it in its handoff, and that record on the pull request is
 * what lets a publication verify an override by `shepherd_rule`, so no other
 * rule may decide it.
 */
export const SHEPHERD_BUDGET_SPENT = 'abandon';

const GREEN = "state.checks.data.state == 'passing'";

function greenAnd(expression: string, reason: string): WorkflowRunDecideRule {
  return { when: { allOf: [GREEN, expression] }, decision: 'leave', reason };
}

function greenWait(expression: string, reason: string): WorkflowRunDecideRule {
  return { when: { allOf: [GREEN, expression] }, decision: 'wait', reason };
}

/**
 * The rules that end a pass on a case they cannot act on — GitHub refused,
 * or could not be read on every pass for as long as
 * `SHEPHERD_UNLISTED_PERSISTS_AFTER_MS`, or the head is in a state no remedy
 * of the shepherd's answers — and that no later pass would act on either.
 * Their case is handed to the agent (`localPrShepherdHandOver.ts`), which
 * decides and acts with the skills it has. A single read that failed is no
 * such case: the next pass reads it again. Nor is a rule holding back on a
 * person's or the folder's own choice — the posture, a draft, a declined
 * merge, a review requesting changes — which stays with them.
 *
 * Each is claimed under the name of its case, so a head handed over for one
 * is still handed over for another.
 */
const HAND_OVER = new Map<WorkflowRunDecideRule, string>();

function handedOver(handOverCase: string, rule: WorkflowRunDecideRule): WorkflowRunDecideRule {
  HAND_OVER.set(rule, handOverCase);
  return rule;
}

/**
 * The case of a merge GitHub refused other than for a moved base: named so
 * by `record-merge` in the pass it is refused, and by the rule that ends every
 * later pass on the refused head, so the two are one case.
 */
export const HAND_OVER_MERGE_REFUSED = 'merge_refused' satisfies ShepherdMergeOutcome;

// Said of the case, not of this pass: the claim decides which pass hands it
// over, and the handoff says where this one did.
const HANDED_OVER_HEAD =
  ' The case is the Helmsman’s: it is handed to the Helmsman once for this head, by the first pass that ends on it, with what that pass read, decided and tried.';

const READ_AGAIN = ' Nothing is merged on this pass; the next pass reads it again.';

/**
 * Where the head is green, what the merge posture allows (D6): each condition
 * that does not hold leaves the pull request, saying which — or waits, where
 * a read it needs failed, for the next pass to read again — and only where
 * every one holds is the decision `merge`. They follow every rule that decides
 * `wait`, so a pull request with a push on its way is never merged. Each
 * condition is written `!= <expected>`, so a read that did not happen — the
 * posture is `never`, or it failed — holds it back.
 */
export const MERGE_RULES: readonly WorkflowRunDecideRule[] = [
  // Before anything that can decide `merge`: the merge claims the head once
  // for good, and GitHub refuses a draft, so a head claimed while a draft
  // would never be asked about once marked ready.
  greenAnd(
    'state.pr.data.draft != false',
    'CI passes on the head, but the pull request is a draft: no merge is asked for until it is marked ready for review.',
  ),
  greenAnd(
    "state.folder.branchPolicy.mergePosture != 'when-green'",
    "CI passes on the head. The folder's merge posture is `never`: the merge is the operator's.",
  ),
  greenAnd(
    `state.folder.branchPolicy.pushApproval != '${HOST_MERGE_POSTURE_REVIEWED_PUSH}'`,
    `CI passes on the head, and the merge posture is \`when-green\`, but the push posture runs no review, so no publication left a verdict to merge on: the merge is the operator's. A folder that merges needs the push approval \`${HOST_MERGE_POSTURE_REVIEWED_PUSH}\`.`,
  ),
  greenAnd(
    'state.handoff.data.mergeDeclinedSha == state.pr.data.headSha',
    'The operator declined to merge this head. No merge is asked for again until a push moves it.',
  ),
  handedOver(
    HAND_OVER_MERGE_REFUSED,
    greenAnd(
      'state.handoff.data.mergeRefusedSha == state.pr.data.headSha',
      `GitHub refused to merge this head. No merge is asked for again until a push moves it.${HANDED_OVER_HEAD}`,
    ),
  ),
  // No rule asks for a pinned record. The two above only spare a lease: a
  // head already asked about is held by `claim-merge`, a create under the
  // lease that fails where anything is recorded for it. A record read with no
  // pin shows nothing, and the handoff that pass posts carries nothing either,
  // so holding it back would cost a pass and see nothing more.
  greenWait(
    'state.requiredRulesStatus != 200',
    `GitHub did not return the rulesets of the base branch, so which checks it requires is unknown.${READ_AGAIN}`,
  ),
  greenWait(
    'state.requiredProtectionStatus != 200',
    `GitHub did not return the base branch's protection, so which checks it requires is unknown.${READ_AGAIN}`,
  ),
  greenAnd(
    "state.checks.data.required.state == 'none'",
    "The base branch requires no check, so it has not said what green is: the merge is the operator's. Name a required check on it for the shepherd to merge.",
  ),
  greenAnd(
    "state.checks.data.required.state != 'passed'",
    "A check the base branch requires has not passed on the head — it failed, is still running, was skipped, or has no check run on it, as a context reported only as a commit status has none. The handoff names each: the merge is the operator's.",
  ),
  greenWait(
    'state.reviewsStatus != 200',
    `GitHub did not return the pull request's reviews, so whether a person requests changes is unknown.${READ_AGAIN}`,
  ),
  handedOver(
    'reviews_past_page',
    greenAnd(
      'state.reviews.complete != true',
      `The pull request has more reviews than one page holds, so a change request past it would not be seen: nothing is merged.${HANDED_OVER_HEAD}`,
    ),
  ),
  greenAnd(
    'state.reviews.changesRequestedBy[0] != null',
    'A person’s review on the pull request requests changes, and has been neither dismissed nor followed by their approval: the merge waits on them.',
  ),
  // Read from the publication's run, never the pull request's body, which any
  // collaborator can edit.
  // A head the publication's push sent as the merge of a moved base (Plan 339
  // D3) is reviewed where the review is of the commit that merge was made
  // from: the two rules hold together only where the review is of neither.
  {
    when: {
      allOf: [
        GREEN,
        'state.publicationReview.reviewed.at != state.pr.data.headSha',
        'state.publicationMerge.baseMerge.commit != state.pr.data.headSha',
      ],
    },
    decision: 'leave',
    reason:
      "No publication's Local Code Review is on record for this head — no publication of the branch pushed it, as its commit or as the merge of a moved base, which another hand did, or the publication that pushed it ran no review of it: the merge is the operator's.",
  },
  {
    when: {
      allOf: [
        GREEN,
        'state.publicationReview.reviewed.at != state.pr.data.headSha',
        'state.publicationReview.reviewed.at != state.publicationMerge.baseMerge.branchCommit',
      ],
    },
    decision: 'leave',
    reason:
      "The publication that pushed this head as the merge of a moved base has no Local Code Review on record of the commit that merge was made from: the merge is the operator's.",
  },
  // `workflow.run.detail` reads a task that waited on a run from that run as
  // it stands, so a review retried in place counts by its final attempt.
  ...[
    "state.publication.overrideCheck != 'operator'",
    "state.publication.pushDecision != 'ask'",
  ].map((expression) => ({
    when: {
      allOf: [GREEN, "state.publicationReview.verdict != 'approve'", expression],
    },
    decision: 'leave',
    reason:
      "The Local Code Review of the publication that pushed this head did not return `approve` — read from the review run itself, its final attempt where it was retried in place: the merge is the operator's.",
  })),
  // GitHub computes whether a head merges after it is asked, and answers null
  // until it has: a merge asked for on null is a guess GitHub may refuse. The
  // read asked, so the next pass has the answer. A head that does not merge
  // is the conflict rule's, which comes before every merge rule.
  {
    when: { allOf: [GREEN, 'state.pr.data.mergeable != true'] },
    decision: 'wait',
    reason:
      'Every condition to merge holds, but GitHub has not yet said whether the head merges into its base as the base stands now: no merge is asked for on a guess. The pull request is read again next pass.',
  },
  {
    when: {
      allOf: [
        GREEN,
        "state.publication.overrideCheck == 'operator'",
        "state.publication.pushDecision == 'ask'",
        "state.publicationReview.verdict == 'comment'",
      ],
    },
    decision: 'merge',
    reason:
      'Checks passed, no person requests changes, and GitHub permits this merge: review `comment`, set aside by the operator at the push.',
  },
  {
    when: {
      allOf: [
        GREEN,
        "state.publication.overrideCheck == 'operator'",
        "state.publication.pushDecision == 'ask'",
        "state.publicationReview.verdict != 'approve'",
      ],
    },
    decision: 'merge',
    reason:
      'Checks passed, no person requests changes, and GitHub permits this merge: review set aside by the operator at the push.',
  },
  {
    when: { expression: GREEN },
    decision: 'merge',
    reason:
      "Every check the base branch requires passed on the head, the Local Code Review of the publication that pushed it approved this head, no person's review requests changes, and GitHub says the head merges into its base: the shepherd asks to merge it by squash, pinned to this head, on the operator's approval — unless a merge of this head was already asked for, which is never asked for twice.",
  },
];

/**
 * GitHub never runs a pull request's checks again when its base branch moves,
 * so a failure a remedy was recorded for can stay red over a base that has
 * since cleared it. The pin keeps the base each remedy was taken against, and
 * a remedy follows the start of the check run it answered, so a base that
 * moved after the remedy moved after that run started too. The remedy is the
 * merge round, never a re-run: GitHub re-runs a job on the commit of the event
 * that started it — a pull request's merge commit with the old base, or a
 * pushed head with none — so no re-run the pass can ask for reads the moved base.
 */
const BASE_MOVED_AFTER_REMEDY: WorkflowRunDecideRule = {
  when: {
    allOf: [
      'state.checks.data.firstFailing.id == state.handoff.data.checkRunId',
      'state.pin.dataJson.checkRunId == state.checks.data.firstFailing.id',
      'state.pin.dataJson.remedyBaseSha != null',
      "state.pin.dataJson.remedyBaseSha != ''",
      'state.base.sha != null',
      'state.base.sha != state.pin.dataJson.remedyBaseSha',
      'state.handoff.data.attemptCount < state.budget',
    ],
  },
  decision: 'fix',
  reason:
    "This check run's failure was acted on already, and the base branch has moved since: GitHub does not run a pull request's checks again when its base moves, so the failure may be one the base has since cleared. A re-run of the failed jobs would run on the old base again, so the base is merged into the branch and published, and CI runs over it.",
};

const UNLISTED = ["state.aim.decision == 'discover'", 'state.candidates.statusCode != 200'];

/** A listing that failed where no earlier failure is noted: this pass notes it, and waits. */
const UNLISTED_FIRST: WorkflowRunDecideRule = {
  when: { allOf: UNLISTED },
  decision: 'wait',
  reason:
    "GitHub did not list the repository's open pull requests, so nothing was read to act on. The next pass reads them again; only a listing GitHub goes on refusing is handed to the Helmsman.",
};

const CI_NOT_FAILED_REASON =
  'CI has not failed on the head: its checks are still running, stopped short, or not there yet.';

const CI_RUNNING: WorkflowRunDecideRule = {
  when: { expression: "state.checks.data.state == 'pending'" },
  decision: 'wait',
  reason: CI_NOT_FAILED_REASON,
};

const CI_NOT_FAILED: WorkflowRunDecideRule = {
  when: { expression: "state.checks.data.state != 'failing'" },
  decision: 'wait',
  reason: CI_NOT_FAILED_REASON,
};

const NODE_IN_FLIGHT_REASON =
  "A run serving this pull request's plan node, or a node under it, is in flight — running, or paused — whoever started it: the node's work is under way.";

/**
 * Read in order; the first that holds decides. A rule a missing read must not
 * pass is written `!= <expected>`, since a path through a read that did not
 * happen reads as null. Every way to `fix` but one runs through the last two:
 * CI failed on a check run the shepherd has not acted on, within the budget.
 * The one is {@link BASE_MOVED_AFTER_REMEDY}: a check run acted on, whose base
 * has moved since its remedy.
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
  // A pass aimed at a number reads its pull request directly and lists none.
  // The turn notes when a listing first failed (`note-unlisted`), and a pass
  // that lists them clears it, so only a listing that failed on every pass for
  // the whole bound is handed over.
  handedOver('unlisted', {
    when: {
      allOf: [
        ...UNLISTED,
        'state.turn.dataJson.unlistedAtMs != null',
        'state.turn.dataJson.unlistedAtMs <= state.unlistedBefore',
      ],
    },
    decision: 'wait',
    reason: `GitHub has not listed the repository's open pull requests on any pass for ${String(SHEPHERD_UNLISTED_PERSISTS_AFTER_MS / 60_000)} minutes or more, so nothing was read to act on — the GitHub connection's access to the repository is the likely cause. The case is the Helmsman’s: it is handed to the Helmsman once, by the first pass that ends on it, with GitHub's answer, and again only after a pass lists them.`,
  }),
  {
    when: { allOf: [...UNLISTED, 'state.turn.dataJson.unlistedAtMs != null'] },
    decision: 'wait',
    reason:
      "GitHub did not list the repository's open pull requests on this pass, nor on an earlier one since a pass last listed them, so nothing was read to act on. The next pass reads them again; should GitHub go on refusing, the case is handed to the Helmsman.",
  },
  UNLISTED_FIRST,
  {
    when: {
      allOf: ["state.aim.decision == 'discover'", 'state.candidates.data.count == 0'],
    },
    decision: 'leave',
    reason: "No open pull request Local Publish opened under the folder's prefix.",
  },
  {
    when: { allOf: ["state.aim.decision == 'aimed'", 'state.pr.statusCode == 404'] },
    decision: 'leave',
    reason: 'The repository has no pull request of the number this pass was aimed at.',
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
  // Only a 404 says the pinned comment is gone. Any other failure leaves it
  // standing unread, and the newest page — past one page of conversation —
  // does not hold a handoff rewritten in place, so it is not read instead.
  {
    when: {
      allOf: [
        'state.pin.dataJson.commentId != null',
        'state.pinned.statusCode != 200',
        'state.pinned.statusCode != 404',
      ],
    },
    decision: 'wait',
    reason:
      'GitHub did not return the handoff comment pinned for this pull request, and it is not gone, so its record may exist unread: what was acted on before, and how many attempts are spent, is unknown. Nothing is written until it reads.',
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
  // A merge pass pauses nowhere but at its merge card, which waits on the
  // operator rather than being stuck: its lease is live past the bound, so a
  // card left open is still the only card (D6).
  {
    when: {
      allOf: [
        "state.lease.dataJson.decision == 'merge'",
        "state.leaseOwner.run.status == 'paused'",
      ],
    },
    decision: 'wait',
    reason:
      'Another pass holds the lease on this branch and is paused at its merge approval, waiting on the operator: no second approval is asked for.',
  },
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
  // The branch's work as the plan holds it (Plan 322 P2). A pull request no
  // node holds reads whole and empty; a read that failed, or stopped at its
  // bounds, leaves the node's work unknown, which is not none.
  {
    when: { expression: 'state.planNode.complete != true' },
    decision: 'wait',
    reason:
      "The runs serving this pull request's plan node could not all be read — the read failed, or the plan under the node is larger than one read — so whether its work is in flight is unknown.",
  },
  // A pass started on the node serves it itself, and is never work beside
  // itself: it waits only on a run other than its own. The ids are distinct,
  // so a second run listed is always another's.
  {
    when: {
      allOf: ['state.planNode.runs[0] != null', 'state.planNode.runs[0].id != state.runId'],
    },
    decision: 'wait',
    reason: NODE_IN_FLIGHT_REASON,
  },
  {
    when: { expression: 'state.planNode.runs[1] != null' },
    decision: 'wait',
    reason: NODE_IN_FLIGHT_REASON,
  },
  // The conflict rule's own condition, read apart because that rule holds
  // the most comparisons one rule may: a head whose CI is still running may
  // yet turn red, and its fix would then act on the head beside the Helmsman,
  // so it is not handed over but read again. Past the conflict rule, every
  // rule before `CI_NOT_FAILED` holds only on a head that is green or whose
  // check runs fill more than a page, so the pass ends as it would there.
  CI_RUNNING,
  // A red head's fix is commissioned with its base merged in, conflicts and
  // all; any other head GitHub says does not merge has nothing a remedy
  // answers, and GitHub refuses its merge. A draft, a folder whose merge the
  // operator keeps, a merge the operator declined on this head, a person's
  // review requesting changes, and a publication review that did not approve
  // this head are held by their person whatever the head merges into, so the
  // rule holds only where the shepherd would merge: those fall through to
  // their own rule. Written `== <expected>`, so a read that did not happen
  // hands nothing over.
  handedOver('does_not_merge', {
    when: {
      allOf: [
        'state.pr.data.mergeable == false',
        "state.checks.data.state != 'failing'",
        'state.pr.data.draft == false',
        "state.folder.branchPolicy.mergePosture == 'when-green'",
        `state.folder.branchPolicy.pushApproval == '${HOST_MERGE_POSTURE_REVIEWED_PUSH}'`,
        'state.handoff.data.mergeDeclinedSha != state.pr.data.headSha',
        'state.reviews.complete == true',
        'state.reviews.changesRequestedBy[0] == null',
        'state.publicationReview.reviewed.at == state.pr.data.headSha',
        "state.publicationReview.verdict == 'approve'",
      ],
    },
    decision: 'leave',
    reason: `GitHub says the head does not merge into its base as the base stands now, and CI concluded on it without failing: no fix answers that, and GitHub refuses the merge.${HANDED_OVER_HEAD}`,
  }),
  ...MERGE_RULES,
  // Every later pass reads the same one page, so a wait here would never end.
  handedOver('checks_past_page', {
    when: { expression: "state.checks.data.state == 'unknown'" },
    decision: 'leave',
    reason: `GitHub holds more check runs on the head than the one page of a hundred a pass reads, and none on that page failed or is still running: whether CI failed on the head is unknown, so the shepherd neither fixes nor merges it.${HANDED_OVER_HEAD}`,
  }),
  CI_NOT_FAILED,
  BASE_MOVED_AFTER_REMEDY,
  {
    when: { expression: 'state.checks.data.firstFailing.id == state.handoff.data.checkRunId' },
    decision: 'wait',
    reason:
      'This check run’s failure was acted on already, and CI has not run again since: the fix is still to be published or checked.',
  },
  {
    when: { expression: 'state.handoff.data.attemptCount >= state.budget' },
    decision: SHEPHERD_BUDGET_SPENT,
    reason:
      'The shepherd has acted on as many failures of this pull request as its budget allows, and CI fails again. It acts on nothing here and leaves the pull request to a person, with one Action Center item for this head; a push that moves the head is read again, and handed over the same way if CI fails on it.',
  },
];

/** The rules whose case the pass hands to the agent, in the order they are read. */
export const HAND_OVER_RULES: readonly WorkflowRunDecideRule[] = SHEPHERD_RULES.filter((rule) =>
  HAND_OVER.has(rule),
);

/** The decision step ended on a rule whose case is handed to the agent, one comparison each. */
export const DECIDED_HAND_OVER: readonly string[] = HAND_OVER_RULES.map(
  (rule) => `tasks.decide.output.rule == ${String(SHEPHERD_RULES.indexOf(rule))}`,
);

/** The decision step ended on the first refusal to list the pull requests since they were last listed. */
export const DECIDED_UNLISTED_FIRST = `tasks.decide.output.rule == ${String(SHEPHERD_RULES.indexOf(UNLISTED_FIRST))}`;

/**
 * The name of the case a pass hands over, which its claim is keyed by: the
 * merge refused in this pass, or the rule the pass ended on. A name, not a
 * rule's index, so the refusal and the rule that ends later passes on the
 * refused head are one case.
 */
export const HAND_OVER_CASE_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: `state.mergeOutcome == '${HAND_OVER_MERGE_REFUSED}'` },
    decision: HAND_OVER_MERGE_REFUSED,
    reason: 'GitHub refused the merge this pass asked for.',
  },
  ...HAND_OVER_RULES.map((rule) => ({
    when: { expression: `state.rule == ${String(SHEPHERD_RULES.indexOf(rule))}` },
    decision: HAND_OVER.get(rule)!,
    reason: `The pass ended on the rule that hands its case over as \`${HAND_OVER.get(rule)!}\`.`,
  })),
];

export const HAND_OVER_CASE_OTHERWISE = {
  decision: 'unnamed',
  reason: 'The pass ended on no case it hands over.',
};

/**
 * The decision step's `rule` where the base moved after the remedy: the pass
 * merges the base in, and asks the remedy question nothing.
 */
const BASE_MOVED_RULE = String(SHEPHERD_RULES.indexOf(BASE_MOVED_AFTER_REMEDY));
export const DECIDED_BASE_MOVED = `tasks.decide.output.rule == ${BASE_MOVED_RULE}`;
export const DECIDED_OTHER_THAN_BASE_MOVED = `tasks.decide.output.rule != ${BASE_MOVED_RULE}`;

/** The commission the pass takes where the base moved after the remedy. */
export const MERGE_ROUND_AFTER_BASE_MOVED = 'merge-round-after-base-moved';

/** Whether a pass was aimed at one pull request: `aimed`, read by its number, or `discover`, listed. */
export const AIM_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.pullNumber != null' },
    decision: 'aimed',
    reason: 'The pass was aimed at one pull request: it is read by its number.',
  },
];

export const AIM_OTHERWISE = {
  decision: 'discover',
  reason:
    "The pass was aimed at none: the loop's open pull requests are listed, and the one after the pull request the last such pass tended is tended.",
};

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
    when: { expression: `state.rule == ${BASE_MOVED_RULE}` },
    decision: 'merge_round',
    reason:
      'The base branch moved after the last remedy, and a re-run would have run on the old base: the base was merged into the branch.',
  },
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

/**
 * GitHub's answer, with 405, to a merge whose base branch moved between the
 * pull request's read and the merge — another pull request merged first. The
 * wording is matched exactly: a 405 can also mean a conflict or a rule the
 * base requires, which no re-attempt clears, and wording GitHub changes falls
 * back to the ordinary refusal rather than a re-attempt that repeats forever.
 */
export const BASE_MOVED_MESSAGE = 'Base branch was modified. Review and try the merge again.';

/** The refusal kind under which the merge is attempted again and handed back, never left. */
export const MERGE_REFUSAL_BASE_MOVED = 'base_moved';

/**
 * Which kind of refusal GitHub gave the merge pinned to the head. Only one is
 * benign: the base moved, while the head — read again after the refusal — is
 * still the one pinned and its checks, the base's required ones among them,
 * passed. Anything else, a re-read that failed included, is `head_invalid`
 * and recorded against the head as before.
 */
export const MERGE_REFUSAL_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: {
      anyOf: [
        'state.merge.statusCode != 405',
        `state.merge.data.message != '${BASE_MOVED_MESSAGE}'`,
        'state.pr.statusCode != 200',
        'state.pr.data.headSha != state.pinnedHead',
        "state.checks.data.state != 'passing'",
        "state.checks.data.required.state != 'passed'",
      ],
    },
    decision: 'head_invalid',
    reason:
      'GitHub refused the merge for something other than a base that moved under an unchanged, green head.',
  },
];

export const MERGE_REFUSAL_OTHERWISE = {
  decision: MERGE_REFUSAL_BASE_MOVED,
  reason:
    'GitHub refused the merge only because the base branch moved after the pass read it; the head is still the one pinned, and its required checks passed.',
};

/**
 * What `record-merge` decides where the base moved and the re-attempt did not
 * merge either: the pass's own decision, handed back. It is no
 * `ShepherdMergeOutcome`, so the handoff records nothing against the head and
 * the claim on it is deleted, and the next pass asks to merge it again.
 */
export const MERGE_HANDED_BACK = 'merge';

/**
 * How the merge this pass asked for ended, as one of `SHEPHERD_MERGE_OUTCOMES`
 * or {@link MERGE_HANDED_BACK}. A merge task that failed binds as absent:
 * under the write approval that is the operator's denial, which fails the
 * task as a permission error. A refusal of the head-invalid kind is recorded
 * against the head; one of the base-moved kind was attempted again.
 */
export const MERGE_OUTCOME_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { expression: 'state.merge == null' },
    decision: 'merge_declined' satisfies ShepherdMergeOutcome,
    reason:
      'The merge was not made: the operator declined it, or the request could not be sent. No merge of this head is asked for again.',
  },
  {
    when: { expression: 'state.merge.statusCode == 200' },
    decision: 'merged' satisfies ShepherdMergeOutcome,
    reason: 'GitHub merged the pull request by squash, on the head the pass read.',
  },
  {
    when: { expression: `state.refusal != '${MERGE_REFUSAL_BASE_MOVED}'` },
    decision: 'merge_refused' satisfies ShepherdMergeOutcome,
    reason: `GitHub refused the merge pinned to this head. No merge of this head is asked for again.${HANDED_OVER_HEAD}`,
  },
  {
    when: { expression: 'state.mergeAgain.statusCode == 200' },
    decision: 'merged' satisfies ShepherdMergeOutcome,
    reason:
      'GitHub refused the first request because the base branch moved after the pass read it, and merged the pull request by squash on the re-attempt, on the same head.',
  },
];

export const MERGE_OUTCOME_OTHERWISE = {
  decision: MERGE_HANDED_BACK,
  reason:
    'GitHub refused the merge because the base branch moved after the pass read it — another pull request merged — and the one re-attempt was not merged either. The head is intact, still the one pinned, and its required checks passed, so nothing is recorded against it: the decision stays `merge`, and the next pass asks to merge it again.',
};

export const REMEDY_TAKEN_OTHERWISE = {
  decision: 'fix_commission',
  reason: 'The failure was commissioned as a fix.',
};
