import { HOST_PUSH_APPROVAL_DEFAULT, type SkillUsage } from '@aflow/schemas';
import { FIX_ROUND_BRIEF_FINDINGS } from './publishLocalChangesFixRound.js';

export const CHECK_FAILED =
  "The folder's checks failed on this run's commit: their account is above, with the end of what they printed, and the whole of it is stored with this failure. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. Commission the fix onto this branch — nothing of it has left the machine — and publish again. Where they ran out of the folder's time rather than failed, the folder's `checksTimeoutMs` is the operator's to raise on the machine.";

/**
 * The first run's own failure, which is never the checks failing — a run of
 * them that did not pass succeeds, and `checks-failed` stops on it — but the
 * step that runs them breaking before they reported. Nothing has said the
 * change is at fault, so it prescribes no fix to it.
 */
export const CHECKS_COULD_NOT_RUN =
  "The folder's checks could not be run on this run's commit: the step that runs them stopped before they reported, and its own error is above — the executor, the checkout of the commit, or the fetch of `origin`'s base. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. Nothing says the change is at fault: put right what the error names, on the machine or in the connected folder, then publish the branch as it stands.";

/**
 * The stop on a first run of the checks that did not pass for any reason but
 * tests running out of their time. What they printed may name a fault in the
 * change or one in the machine they ran on, and nothing here has told the
 * two apart, so it says which happened and leaves the remedy to that account.
 */
export const CHECKS_STOPPED =
  "The folder's checks did not pass on this run's commit, and the publication stops on that: their account is the reason above, with the end of what they printed. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. What they printed says what failed — the change, or the machine the checks ran on, such as a missing tool or a service they reach — and so what puts it right. Where they ran out of the folder's time, its `checksTimeoutMs` is the operator's to raise on the machine.";

/**
 * How a commit this skill already made is published again, by the inputs that
 * take the run's no-change path — the remedy every refusal that leaves the
 * commit sound names, so none sends the caller back to the patch, which is
 * refused on a branch the commit has already moved.
 */
export const PUBLISH_AS_IT_STANDS =
  "To publish this branch as it stands, start Publish Local Changes again with `bindingId`, `round` and `findings` as this run had them — and `owner`, `repo` and `base` where it was given them — `branch` this branch, `baseSha` the `commit.sha` this run's commit task reported, and no `patchRef`, `patch`, `mergeFrom` or `commitMessage`: nothing is committed, the branch is published at its head — even where it has moved on from that sha — and the checks, the scan, the review and the push run on it again.";

/** What the Helmsman needs once it has chosen the skill: carried as the skill's usage pitfalls. */
export const PUBLISH_PITFALLS: string[] = [
  `What it needs: the connected folder; the change — a commission's \`patchRef\` as its result reports it, or a diff the operator hands over as \`patch\`, one or the other — or neither, for a branch as it stands; a branch name under the folder's publish prefix; the commission's run id as \`commission\`, whose \`summary\` — a title line under 72 characters and a paragraph — the commit is made under, as it is for a \`patchRef\` alone, or \`commitMessage\` to say it otherwise, which a \`patch\` or a merge alone cannot go without. The repository and the base branch the pull request targets are read from the folder — its \`origin\` and the branch its HEAD names; pass \`owner\`, \`repo\` or \`base\` only to publish elsewhere, never as a guess. Ask for what is missing; never invent it.`,
  `The pull request is composed from the whole branch and rewritten on each push; pass earlier reviews' \`findings\` and the commissions' \`gaps\`, and \`title\` or \`summary\` only for a person's own words — a summary heads the body.`,
  `Never pass a commission's \`patch\` text. It is a copy for reading, cut short on a large change; \`patchRef\` names the whole diff at any size.`,
  `When it asks before pushing: the folder's push approval, \`pushApproval\` in the machine block, decides. \`always\` asks before every push; \`never\` pushes without asking. \`unless-unreviewed\`: Local Code Review reads everything the push would add, and the decision on its findings is followed — \`fix_before_merge\` neither asks nor pushes, \`publish_as_is\` pushes, listing the findings left open, but asks over a blocker or a major. The review is the catalog's as installed; an edited copy is refused, and the run asks. A folder that names no posture is \`${HOST_PUSH_APPROVAL_DEFAULT}\`, the default. Whatever the posture, the run scans every line the push would add, the headers and message of every commit it carries, and the pull request's title and summary for secrets before any of this, and a finding stops it with nothing pushed — which is what lets a review stand in for the operator. Only a range the scan cleared can go without asking: where a file was not read whole, or a line that looks like a secret ends in an \`aflow-scan: allow\` comment, no review runs and the run asks under every posture, \`never\` included. Once the run asks, the operator's answer decides: a declined push pushes nothing, whatever the posture.`,
  `The decision is the rounds rule's, made by rules with no model asked, and the slice gets one fix round: a review that does not approve is \`fix_before_merge\`; an approving one of nits alone, or none, is \`publish_as_is\`; an approving one with a minor or worse is \`fix_before_merge\` on the slice's first publication and \`publish_as_is\` once its fix round has run, the findings carried open on the pull request. Whether that round ran is \`round\`, which you pass: omit it, or 1, for the slice's first publication, and pass one more than the last publication's on each publication of a fix round.`,
  `Its checks first: the folder's \`checks\`, shown in the machine block, run in a checkout of the commit before the scan, and nothing is scanned, reviewed or pushed until they pass; the push needs their passing receipt. A folder that declares none runs none. The pull request's own checks remain the proof. Test timeouts alone rerun once; any other failure stops the run with the end of what they printed.`,
  `The decision is set aside only by an explicit act, passed as \`override\` naming whose and why, which the run verifies — the operator's word at its approval, the \`hands-off\` label or the shepherd's pinned record on the pull request; one it cannot fails the run.`,
  `On an existing branch: a fix commissioned from a branch (\`base: <branch>\`, the branch's name, whether its commit was pushed or kept local) is published onto it by naming it as \`branch\` and passing the commission's \`baseSha\` — the branch's head — as \`baseSha\`, so its patch lands as one more commit with nothing reset; a branch is reused only that way, and a fresh change takes a fresh branch. A fix to a branch \`main\` has moved past is commissioned with \`mergeFrom: origin/<base>\` as well and published with the sha the commission reported in \`merge.from\` as \`mergeFrom\`: the branch then carries one merge commit holding the fix. A commission that reported a \`merge\` and no \`patchRef\` changed nothing beyond the merge: it is published with \`mergeFrom\` and neither \`patchRef\` nor \`patch\`.`,
  `A branch as it stands: a commit already made whose push did not land is published with \`branch\`, its \`commit.sha\` as \`baseSha\` (a branch moved on from it goes at its head), and no \`patchRef\`, \`patch\`, \`mergeFrom\` or \`commitMessage\`: nothing is committed, and the head is checked, scanned, reviewed and pushed.`,
  `With the result: report the pull request link and how the push was cleared, \`pushReason\` — with, where the run reviewed its commit, the verdict and decision. A branch that already has an open pull request into the base gets no second one: the run reports that one. Where approval was declined, nothing was pushed: the commit stays on the machine. On \`afterReview\` \`fix_before_merge\` nothing was pushed and the commit stays on its branch in the folder, and the run hands the round \`fixRound\`: the \`branch\`, its \`headSha\`, \`baseMovedSince\`, the \`reviewRunId\` and the \`findings\`, with \`commissionInputs\` — \`base\` the branch's name, and \`mergeFrom: origin/<base>\` where the base moved. Commission the fix with those inputs as they stand — never \`base: origin/main\` or the earlier commission's \`baseSha\`: the branch was never pushed, so a checkout of \`origin/main\` cannot reach it and the fix comes back with no files changed, and a whole-diff patch is refused on a branch already holding this one — briefed from ${FIX_ROUND_BRIEF_FINDINGS} — then publish again with its \`patchRef\`, \`baseSha\`, \`merge.from\` where it merged, and run id, \`findings\` and the next \`round\`. The run's \`verdict\` is the review run's as it stands, a retry in place counted by its final attempt. Where the scan found what looks like a secret, the run failed with nothing pushed: report each place and rule it names — never ask for or repeat the value — and say the secret has to come out and the change go again on a fresh branch, this one holding that commit. A refused push leaves the commit on its branch: report its message and the remedy the run names. Where the push failed, git's own message says why.`,
  `Whether the run waits at the approval is the folder’s push approval, shown in the machine block. Under \`unless-unreviewed\`, the default, the run reviews everything its push would add before it gets there, so no review needs starting alongside it. A file the scan could not read or a line marked \`aflow-scan: allow\` makes it ask under every posture.`,
  `The folder’s checks, where it declares them — \`checks\` in the machine block — run on the commit before anything else, so no build or test needs running beside a publication. A failed check fails the run with the end of what it printed, and nothing has left the machine; one that failed only on tests running out of time is run once more by the publication itself first, so it needs no retry from the conversation.`,
  `A publication’s push follows its \`afterReview\`, and so do you. On \`fix_before_merge\` the fix round is yours: commission it with the run’s \`fixRound.commissionInputs\` as they stand — never \`base: origin/main\`, which cannot reach a branch kept local and returns no files — briefed from the \`fixRound.reviewRunId\` run’s findings, never one of kind \`needs_setup\`, which is setup on the machine and no defect; then publish its \`patchRef\`, \`baseSha\` and run id with \`fixRound.findings\`, fixed ones closed, and the next \`round\`. Override only on an act the run verifies.`,
  `A commission’s change is committed under the commission’s own \`summary\` when the publication passes its \`patchRef\`, with its run id as \`commission\`: pass \`commitMessage\` only to say it otherwise. A run id that is not the commission which reported that \`patchRef\` on the folder is refused before anything is committed. A diff the operator hands over as \`patch\`, or a merge alone, has no summary, and the start refuses it without \`commitMessage\`.`,
];

/** What Publish Local Changes is for — the Store's account of it; how it is run is its usage. */
export const PUBLISH_DESCRIPTION = `Fits a request to publish an existing patch — a commission's result, or a diff the operator hands over — onto a branch of a connected repository and into a pull request. The working tree is never touched, and nothing leaves the machine until the push is cleared.`;

/** When to pick Publish Local Changes, when not, what follows it, and what to know running it. */
export const PUBLISH_USAGE: SkillUsage = {
  whenToUse: [
    'Publishing a patch that already exists — a commission\'s, by its `patchRef`, or a small diff the operator hands over — onto a branch of a connected repository and into a pull request: "publish these changes", "open a PR for this", "push this branch"',
    'Publishing a fix round onto the branch its commission was made from, or a branch whose commit is already made, as it stands',
  ],
  whenNotToUse: [
    'A folder whose machine block shows no publish prefix: its push is refused — say so, ask for it to be reconnected allowing pushes under a prefix, and stop',
    'Making the change — that is Commission Change, whose `patchRef` this takes',
    'Reviewing beside it — under `unless-unreviewed` the publication reviews everything its push would add itself',
  ],
  next: [
    {
      skill: 'local-pr-shepherd',
      when: "Once the pull request is open: the shepherd tends its CI — fixing a red check through this skill — and merges a green one where the folder's merge posture is `when-green`; start the Local PR Shepherd agent, or its schedule, rather than watching CI by hand.",
    },
    {
      skill: 'commission-change',
      when: 'On `afterReview` `fix_before_merge`: commission the fix round with `fixRound.commissionInputs` as they stand, briefed from the `fixRound.reviewRunId` run’s findings less any of kind `needs_setup`, then publish its `patchRef` with the next `round`.',
    },
  ],
  pitfalls: PUBLISH_PITFALLS,
};
