import { HOST_PUSH_APPROVAL_DEFAULT } from '@aflow/schemas';

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

/** What Publish Local Changes is for, what it needs, and when it asks — the skill's own description. */
export const PUBLISH_DESCRIPTION = `Fits a request to publish an existing patch — a commission's result, or a diff the operator hands over — onto a branch of a connected repository and into a pull request. The working tree is never touched, and nothing leaves the machine until the push is cleared.

**Not for a folder whose machine block shows no publish prefix**: its push is refused. Say so, ask for it to be reconnected with one, and stop.

**What it needs**: the connected folder; the change — a commission's \`patchRef\` as its result reports it, or a diff the operator hands over as \`patch\`, one or the other — or neither, for a branch as it stands; a branch name under the folder's publish prefix; the commit message; the repository owner and name, from the folder's \`origin\` remote; and the base branch the pull request targets. Ask for what is missing; never invent it.

**The pull request is composed from the whole branch** and rewritten on each push; pass earlier reviews' \`findings\` and the commissions' \`gaps\`, and \`title\` or \`summary\` only for a person's own words — a summary heads the body.

**Never pass a commission's \`patch\` text.** It is a copy for reading, cut short on a large change; \`patchRef\` names the whole diff at any size.

**When it asks before pushing**: the folder's push approval, \`pushApproval\` in the machine block, decides. \`always\` asks before every push; \`never\` pushes without asking. \`unless-unreviewed\`: Local Code Review reads everything the push would add, and the decision on its findings is followed — \`fix_before_merge\` neither asks nor pushes, \`publish_as_is\` pushes, listing the findings left open, but asks over a blocker or a major. The review is the catalog's as installed; an edited copy is refused, and the run asks. A folder that names no posture is \`${HOST_PUSH_APPROVAL_DEFAULT}\`, the default. Whatever the posture, the run scans every line the push would add, the headers and message of every commit it carries, and the pull request's title and summary for secrets before any of this, and a finding stops it with nothing pushed — which is what lets a review stand in for the operator. Only a range the scan cleared can go without asking: where a file was not read whole, or a line that looks like a secret ends in an \`aflow-scan: allow\` comment, no review runs and the run asks under every posture, \`never\` included. Once the run asks, the operator's answer decides: a declined push pushes nothing, whatever the posture.

**The decision is the rounds rule's**, made by rules with no model asked, and the slice gets one fix round: a review that does not approve is \`fix_before_merge\`; an approving one of nits alone, or none, is \`publish_as_is\`; an approving one with a minor or worse is \`fix_before_merge\` on the slice's first publication and \`publish_as_is\` once its fix round has run, the findings carried open on the pull request. Whether that round ran is \`round\`, which you pass: omit it, or 1, for the slice's first publication, and pass one more than the last publication's on each publication of a fix round.

**Its checks first**: the folder's \`checks\`, shown in the machine block, run in a checkout of the commit before the scan, and nothing is scanned, reviewed or pushed until they pass; the push needs their passing receipt. A folder that declares none runs none. The pull request's own checks remain the proof. Test timeouts alone rerun once; any other failure stops the run with the end of what they printed.

**The decision is set aside** only by an explicit act, passed as \`override\` naming whose and why, which the run verifies — the operator's word at its approval, the \`hands-off\` label or the shepherd's pinned record on the pull request; one it cannot fails the run.

**On an existing branch**: a fix commissioned from a branch (\`base: <branch>\`) is published onto it by naming it as \`branch\` and passing the commission's \`baseSha\` as \`baseSha\`; a branch is reused only that way, and a fresh change takes a fresh branch. A fix to a branch \`main\` has moved past is commissioned with \`mergeFrom: origin/<base>\` as well and published with the sha the commission reported in \`merge.from\` as \`mergeFrom\`: the branch then carries one merge commit holding the fix. A commission that reported a \`merge\` and no \`patchRef\` changed nothing beyond the merge: it is published with \`mergeFrom\` and neither \`patchRef\` nor \`patch\`.

**A branch as it stands**: a commit already made whose push did not land is published with \`branch\`, its head as \`baseSha\`, and no \`patchRef\`, \`patch\`, \`mergeFrom\` or \`commitMessage\`: nothing is committed, and the head is checked, scanned, reviewed and pushed.

**With the result**: report the pull request link and how the push was cleared, \`pushReason\` — with, where the run reviewed its commit, the verdict and decision. A branch that already has an open pull request into the base gets no second one: the run reports that one. Where approval was declined, nothing was pushed: the commit stays on the machine. On \`afterReview\` \`fix_before_merge\` nothing was pushed: brief the fix from the \`reviewRunId\` run and publish again with \`findings\` and the next \`round\`. Where the scan found what looks like a secret, the run failed with nothing pushed: report each place and rule it names — never ask for or repeat the value — and say the secret has to come out and the change go again on a fresh branch, this one holding that commit. A refused push leaves the commit on its branch: report its message and the remedy the run names. Where the push failed, git's own message says why.`;
