import {
  HOST_PUSH_APPROVAL_DEFAULT,
  type HostPushApproval,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  PULL_REQUEST_TITLE_MAX_CHARS,
  PullRequestFindingsSchema,
  PullRequestGapsSchema,
  STORED_PAYLOAD_REF_PATTERN,
  type SkillCatalogEntry,
  toJsonSchemaSync,
} from '@aflow/schemas';
import {
  AFTER_REVIEW_QUESTION,
  AFTER_REVIEW_QUESTION_NAME,
} from './publishLocalChangesDecisions.js';
import { REVIEW_FINDING_SCHEMA, REVIEW_LOCAL_CHANGES } from './reviewLocalChanges.js';

/**
 * The push argv, pinned by the skill rather than bound as a whole. Only the
 * refspec travels from the run, and it is the commit's own,
 * `<sha>:refs/heads/<branch>`: the push sends the commit that was approved or
 * reviewed, never what the branch holds by then — with whatever under it
 * `origin` lacks, which is why the scan and the review read `pushRange` rather
 * than the commit alone. The verbs, the remote and the
 * absence of a force flag are the skill's, so no caller can turn a publish into
 * an overwrite. `--no-follow-tags` and `--no-recurse-submodules` override the
 * operator's `push.followTags` and `push.recurseSubmodules`, which would
 * otherwise send tags and submodule commits the scan never read; the executor
 * refuses a push without them.
 */
const PUSH_COMMAND = [
  'git',
  'push',
  '--no-follow-tags',
  '--no-recurse-submodules',
  'origin',
  { $bind: 'refspec' },
];

/**
 * When the push goes ahead. Gating does not propagate from the approval, so the side-effecting tasks
 * carry it. Each line is one way the push is cleared — the operator approved,
 * the folder never asks, or this run's review approved — and only the first
 * can hold once the approval ran: the posture is read only over a range the
 * scan cleared, where `never` does not ask, and a review runs only where
 * `approve` does not ask. So a decline is followed whatever the posture, and
 * nothing holds when nothing was committed.
 */
const PUSH_CLEARED = {
  anyOf: [
    "tasks.approve-push.output.decision == 'approved'",
    "tasks.read-push-approval.output.branchPolicy.pushApproval == 'never'",
    "tasks.review-commit.output.verdict == 'approve'",
  ],
  onMissingRef: 'skip' as const,
};

/**
 * The skill whose verdict on the commit can stand in for the operator's
 * approval — named by its catalog entry, so only that skill as the Store
 * installed it may skip the approval, never whatever holds its slug.
 */
const REVIEW_SKILL = {
  catalogId: REVIEW_LOCAL_CHANGES.catalogId,
  slug: REVIEW_LOCAL_CHANGES.bundle.workflow.slug,
};

/**
 * Where the push may follow the checks: they passed on the first run, or on
 * the second, where the first lost only tests to their time. Read by every
 * task that only runs on a commit the checks cleared.
 */
const CHECKS_CLEARED = {
  anyOf: ['tasks.check-commit.output.passed == true', 'tasks.recheck-commit.output.passed == true'],
  onMissingRef: 'skip' as const,
};

/** The one posture under which the publication reviews its commit to decide whether to ask. */
const REVIEW_GATED_POSTURE: HostPushApproval = 'unless-unreviewed';

/** The run's inputs together, and so the most a diff passed as text can be. */
const RUN_INPUTS_KB = MAX_PARENT_INPUTS_SERIALIZED_BYTES / 1024;

/**
 * A stored reference, never an inline one: an `inline:` ref carries the diff's
 * bytes in the run input, which is the thing this input exists to avoid.
 */
const PATCH_REF_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  pattern: STORED_PAYLOAD_REF_PATTERN,
  description:
    'The `patchRef` a commission reported, verbatim — a reference to the whole stored diff.',
};

const PATCH_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  description: `A diff the operator hands over, within the ${String(RUN_INPUTS_KB)} KB a run's inputs carry together. A commission's change goes as its \`patchRef\`, which names the whole diff at any size.`,
};

/** GitHub's rule for an owner: letters, digits and single hyphens between them, at most 39. */
const GITHUB_OWNER_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$';

/**
 * GitHub's rule for a repository: letters, digits, `.`, `_` and `-`, at most
 * 100. `.` and `..` are refused because they collapse `/repos/{owner}/{repo}`
 * onto another endpoint.
 */
const GITHUB_REPO_PATTERN = '^(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$';

const OWNER_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 39,
  pattern: GITHUB_OWNER_PATTERN,
  description:
    'The owner name alone — `aflowai` for github.com/aflowai/aflow — not a URL or `owner/repo`. Letters, digits and single hyphens between them, 1 to 39 characters: no dot, and no hyphen at the start, at the end or twice in a row.',
};

const REPO_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: GITHUB_REPO_PATTERN,
  description:
    'The repository name alone — `aflow` for github.com/aflowai/aflow — not a URL or `owner/repo`. Letters, digits, `.`, `_` and `-`, 1 to 100 characters, and neither `.` nor `..`.',
};

const BASE_SHA_SCHEMA = {
  type: 'string',
  minLength: 7,
  maxLength: 40,
  pattern: '^[0-9a-fA-F]{7,40}$',
  description:
    'The sha the commission reported in `baseSha`, 7 to 40 hexadecimal characters — not a branch or tag name.',
};

const MERGE_FROM_SCHEMA = {
  type: 'string',
  minLength: 7,
  maxLength: 40,
  pattern: '^[0-9a-fA-F]{7,40}$',
  description:
    'The sha the commission reported in `merge.from`, as it reported it — not a branch or tag name.',
};

const TITLE_SCHEMA = { type: 'string', minLength: 1, maxLength: PULL_REQUEST_TITLE_MAX_CHARS };

const SUMMARY_SCHEMA = { type: 'string', minLength: 1, maxLength: 20_000 };

/** Derived from the schemas `host.commit.describe` reads them with, so the two cannot drift. */
const FINDINGS_SCHEMA = { ...toJsonSchemaSync(PullRequestFindingsSchema) };
const GAPS_SCHEMA = { ...toJsonSchemaSync(PullRequestGapsSchema) };

const CHECK_FAILED =
  "The folder's checks failed on this run's commit: their account is above, with the end of what they printed, and the whole of it is stored with this failure. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. Commission the fix onto this branch — nothing of it has left the machine — and publish again. Where they ran out of the folder's time rather than failed, the folder's `checksTimeoutMs` is the operator's to raise on the machine.";

/**
 * The first run's own failure, which is never the checks failing — a run of
 * them that did not pass succeeds, and `checks-failed` stops on it — but the
 * step that runs them breaking before they reported. Nothing has said the
 * change is at fault, so it prescribes no fix to it.
 */
const CHECKS_COULD_NOT_RUN =
  "The folder's checks could not be run on this run's commit: the step that runs them stopped before they reported, and its own error is above — the executor, the checkout of the commit, or the fetch of `origin`'s base. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. Nothing says the change is at fault: put right what the error names, on the machine or in the connected folder, then publish the branch as it stands.";

/**
 * The stop on a first run of the checks that did not pass for any reason but
 * tests running out of their time. What they printed may name a fault in the
 * change or one in the machine they ran on, and nothing here has told the
 * two apart, so it says which happened and leaves the remedy to that account.
 */
const CHECKS_STOPPED =
  "The folder's checks did not pass on this run's commit, and the publication stops on that: their account is the reason above, with the end of what they printed. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. What they printed says what failed — the change, or the machine the checks ran on, such as a missing tool or a service they reach — and so what puts it right. Where they ran out of the folder's time, its `checksTimeoutMs` is the operator's to raise on the machine.";

/** Both runs of the checks take the same commit, measured against the same base. */
const CHECK_INPUT_BINDINGS = {
  bindingId: { kind: 'run_input' as const, path: 'bindingId' },
  sha: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.sha' },
  pushBaseSha: {
    kind: 'task_output' as const,
    taskId: 'commit',
    path: 'commit.pushBaseSha',
  },
};

const CHECK_CONTEXT = {
  strategy: 'scoped' as const,
  contextPolicy: 'auto-optimize' as const,
  learnings: 'none' as const,
  capabilities: {
    operations: ['host.commit.check'],
    integrations: [],
  },
};

const CHECK_INPUT_TEMPLATE = {
  bindingId: { $bind: 'bindingId' },
  sha: { $bind: 'sha' },
  base: { $bind: 'pushBaseSha' },
};

const PUBLISH_LOCAL_CHANGES: SkillCatalogEntry = {
  catalogId: 'publish-local-changes',
  version: 32,
  name: 'Publish Local Changes',
  tagline:
    'Commit a patch onto a branch of a connected repository, then push it and open the pull request — asking the operator first unless the folder says otherwise.',
  description: `Fits a request to publish an existing patch — a commission's result, or a diff the operator hands over — onto a branch of a connected repository and into a pull request. The working tree is never touched, and nothing leaves the machine until the push is cleared.

**Not for a folder whose machine block shows no publish prefix**: its push is refused. Say so, ask for it to be reconnected with one, and stop.

**What it needs**: the connected folder; the change — a commission's \`patchRef\` as its result reports it, or a diff the operator hands over as \`patch\`, one or the other — or neither, for a branch as it stands; a branch name under the folder's publish prefix; the commit message; the repository owner and name, from the folder's \`origin\` remote; and the base branch the pull request targets. Ask for what is missing; never invent it.

**The pull request is composed from the whole branch** and rewritten on each push; pass earlier reviews' \`findings\` and the commissions' \`gaps\`, and \`title\` or \`summary\` only for a person's own words.

**Never pass a commission's \`patch\` text.** It is a copy for reading, cut short on a large change; \`patchRef\` names the whole diff at any size.

**When it asks before pushing**: the folder's push approval, \`pushApproval\` in the machine block, decides. \`always\` asks before every push; \`never\` pushes without asking. \`unless-unreviewed\`: the run has Local Code Review read everything the push would add and pushes without asking only when it returns \`approve\` — otherwise, a review that did not finish or start included, it waits for the operator. The review is the catalog's as installed; an edited copy is refused, and the run asks. A folder that names no posture is \`${HOST_PUSH_APPROVAL_DEFAULT}\`, the default. Whatever the posture, the run scans every line the push would add, the headers and message of every commit it carries, and the pull request's title and summary for secrets before any of this, and a finding stops it with nothing pushed — which is what lets a review stand in for the operator. Only a range the scan cleared can go without asking: where a file was not read whole, or a line that looks like a secret ends in an \`aflow-scan: allow\` comment, no review runs and the run waits for the operator whatever the posture, \`never\` included. The comment never clears a line — whoever wrote the change could have written it; it turns a stop into a question. Once the run asks, the operator's answer decides: a declined push pushes nothing, whatever the posture.

**Its checks first**: the folder's \`checks\`, shown in the machine block, run in a checkout of the commit before the scan, and nothing is scanned, reviewed or pushed until they pass; the push needs their passing receipt. A folder that declares none runs none. The pull request's own checks remain the proof. Test timeouts alone rerun once; any other failure stops the run with the end of what they printed. A decision on review findings is recorded, never acted on. No decision clears or holds a push.

**On an existing branch**: a fix commissioned from a branch (\`base: <branch>\`) is published onto it by naming it as \`branch\` and passing the commission's \`baseSha\` as \`baseSha\`; a branch is reused only that way, and a fresh change takes a fresh branch. A fix to a branch \`main\` has moved past is commissioned with \`mergeFrom: origin/<base>\` as well and published with the sha the commission reported in \`merge.from\` as \`mergeFrom\`: the branch then carries one merge commit holding the fix. A commission that reported a \`merge\` and no \`patchRef\` changed nothing beyond the merge: it is published with \`mergeFrom\` and neither \`patchRef\` nor \`patch\`.

**A branch as it stands**: a commit already made whose push did not land is published with \`branch\`, its head as \`baseSha\`, and no \`patchRef\`, \`patch\`, \`mergeFrom\` or \`commitMessage\`: nothing is committed, and the head is checked, scanned, reviewed and pushed.

**With the result**: report the pull request link, and whether the push was approved by the operator or cleared by the folder's push approval — and, where the run reviewed its commit, the verdict. A branch that already has an open pull request into the base gets no second one: the run reports that one. Where approval was declined, report that nothing was pushed and the commit stays on the machine to publish later. Where the checks failed, nothing left the machine: report the end of what they printed. On \`afterReview\` \`fix_before_merge\`, brief the fix from the review run; publish again with \`findings\`. Where the scan found what looks like a secret, the run failed with nothing pushed: report the files, commit headers and messages, title or summary, lines and rules it names — never ask for or repeat the value — and say the secret has to come out and the change go again on a fresh branch, this one holding that commit. A refused push leaves the commit on its branch: report its message and the remedy the run names. Where the push failed, git's own message says why.`,
  tags: ['coding', 'publish', 'git', 'local', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description:
        'GitHub REST API — read the repository before the push, then find the open pull request for the pushed branch and rewrite its description, or open one where there is none.',
      requiredEndpoints: [
        'getRepository',
        'listPullRequests',
        'createPullRequest',
        'updatePullRequest',
      ],
      authKind: 'bearer',
      setupNote:
        'Bind the GitHub connector for the space (a fine-grained personal access token or a GitHub App installation token with repository and pull-request access) before the first run. Sent as Authorization: Bearer.',
    },
  ],
  bundle: {
    workflow: {
      slug: 'publish-local-changes',
      name: 'Publish Local Changes',
      description:
        "Take a patch to a pull request on a repository connected as a host folder: the patch is committed in a detached worktree — onto a new branch at the commit the patch was made against, or appended to the branch it was made on — the folder's declared checks run on it, everything the push would add is scanned for secrets, the push is cleared, by the operator's approval or by the folder's push approval, and the branch is then pushed and opened as a pull request. The operator's working tree is never touched.",
      goal: "Turn a patch into a commit on a branch of a connected repository and, once the push is cleared, a pushed branch and an open pull request — with nothing leaving the machine before the operator approves, unless the folder's push approval says it need not ask.",
      mode: 'process' as const,
      outcomes: [
        {
          id: 'change-published',
          name: 'Change published',
          evaluator: {
            type: 'manual' as const,
            instruction:
              "The patch was committed onto its branch of the connected repository without changing the working tree, the folder's checks passed on it or none are declared, and everything the push would add was scanned with no secret found, and either the push was cleared — by the operator's approval, or by the folder's push approval without asking — and the branch was pushed and opened as a pull request, or the operator declined and the branch stayed local.",
          },
        },
      ],
      runInputs: [
        {
          id: 'bindingId',
          required: true,
          description: 'The connected folder holding the repository to publish to.',
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
        {
          id: 'patchRef',
          required: false,
          description:
            "The change a commission made: the `patchRef` its result reports, passed on as it is. It names the whole diff whatever its size. Give this or `patch`, never both — a commission's change always goes this way. Omit both with `mergeFrom`, for a commission that reported a `merge` and no `patchRef`: the merge is then the whole change. Omit both, `mergeFrom` and `commitMessage` to publish `branch` as it stands, at the head `baseSha` names.",
          schema: PATCH_REF_SCHEMA,
        },
        {
          id: 'patch',
          required: false,
          description: `A unified diff the operator hands over, as text. It travels in the run's inputs, which are capped at ${String(RUN_INPUTS_KB)} KB together, so it must stay small — and it is never a commission's \`patch\`, which is a copy for reading and cut short on a large change. Give this or \`patchRef\`, never both.`,
          schema: PATCH_SCHEMA,
        },
        {
          id: 'branch',
          required: true,
          description:
            "The branch the commit lands on — a branch under the folder's publish prefix, which the machine block shows. A new one is created at `baseSha`, or at the folder's last commit without one; an existing one is appended to only with `baseSha`.",
          schema: { type: 'string', minLength: 1, maxLength: 200 },
        },
        {
          id: 'baseSha',
          required: false,
          description:
            "The commit the patch was made against, as the commission reported it in `baseSha`. Required to append to an existing branch, and it must be that branch's head. A new branch is created at it, even where the folder's last commit is behind or ahead of it — a commission started from a remote fetched it into the folder; without it, a new branch starts at the folder's last commit. For a branch published as it stands, the head to publish — the commit an earlier publication reported in `commit.sha`.",
          schema: BASE_SHA_SCHEMA,
        },
        {
          id: 'mergeFrom',
          required: false,
          description:
            "The commit the commission merged into its checkout, as it reported it in `merge.from` — only for a fix commissioned with `mergeFrom`, appended to the branch it was made on. The branch's head merges it as the commission did, and the commit is that merge with the patch folded in. Omit it when the commission reported no `merge`.",
          schema: MERGE_FROM_SCHEMA,
        },
        {
          id: 'commitMessage',
          // Absent only for a branch published as it stands, whose head
          // carries its own; the commit refuses any other change without one.
          required: false,
          description:
            "The commit message, required with every change: a subject line saying what this round changes, then a blank line and what it does and why — the commission's own account of the change. The pull request's body carries it beside every other commit's on the branch, and the subject of a new branch's first commit is the pull request's title. Left out for a branch published as it stands, whose head keeps its own.",
          schema: { type: 'string', minLength: 1, maxLength: 20_000 },
        },
        {
          id: 'title',
          required: false,
          description:
            "A title for the pull request, only where a person wants to say it themselves. Omitted, the title is the slice's: the subject of the branch's first commit.",
          schema: TITLE_SCHEMA,
        },
        {
          id: 'summary',
          required: false,
          description:
            "A body for the pull request, only where a person wants to say it themselves: it stands as the whole body, and nothing is composed beside it. Omitted, the body is composed from the branch — every commit's message, the review's findings, the checks and the known gaps.",
          schema: SUMMARY_SCHEMA,
        },
        {
          id: 'findings',
          required: false,
          description:
            "The findings of the review rounds before this publication — each Local Code Review whose findings a commission on this branch was briefed to fix — as the review named them, each marked `closed` where a commit fixed it or `open` where it was left: what this run's pull request records of the rounds before it. Where this run's own review finishes, its findings replace these in what the run hands on. Omit it where no review ran before.",
          schema: FINDINGS_SCHEMA,
        },
        {
          id: 'gaps',
          required: false,
          description:
            "What the branch's commissions reported they left undone or could not verify, one item each, in their words. Omitted, the pull request says none were recorded.",
          schema: GAPS_SCHEMA,
        },
        {
          id: 'owner',
          required: true,
          description:
            "The repository owner — the account or organisation in the folder's `origin` remote — by name alone, not a URL or `owner/repo`.",
          schema: OWNER_SCHEMA,
        },
        {
          id: 'repo',
          required: true,
          description:
            "The repository name alone, from the folder's `origin` remote — not a URL or `owner/repo`.",
          schema: REPO_SCHEMA,
        },
        {
          id: 'base',
          required: true,
          description: 'The branch the pull request targets.',
          schema: { type: 'string', minLength: 1, maxLength: 200, default: 'main' },
        },
      ],
      tasks: [
        {
          taskId: 'commit',
          name: 'Commit the patch on its branch',
          goal: "Apply the patch in a detached worktree and commit it — on a new branch at the commit the patch was made against (the connected folder's last commit when none is given), or on top of the existing branch it was made on — after fetching the base branch from `origin`, so the commit reports everything a push of it would add. With no change given, commit nothing and report the branch's head as it stands. The operator's working tree is not touched, and nothing leaves the machine.",
          type: 'operation' as const,
          operation: 'host.file.patch',
          retryability: 'unsafe' as const,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            patchRef: { kind: 'run_input' as const, path: 'patchRef' },
            patch: { kind: 'run_input' as const, path: 'patch' },
            branch: { kind: 'run_input' as const, path: 'branch' },
            baseSha: { kind: 'run_input' as const, path: 'baseSha' },
            mergeFrom: { kind: 'run_input' as const, path: 'mergeFrom' },
            commitMessage: { kind: 'run_input' as const, path: 'commitMessage' },
            base: { kind: 'run_input' as const, path: 'base' },
          },
          // Every run input is declared here, including the ones only the
          // later tasks read: start-time validation checks the caller's inputs
          // against the ENTRY task's surface, and a slot missing from it is
          // refused rather than passed on.
          inputContract: {
            bindings: {
              bindingId: {
                kind: 'run_input' as const,
                bindAs: 'bindingId',
                path: 'bindingId',
                schema: { type: 'string', minLength: 1, maxLength: 128 },
              },
              patchRef: {
                kind: 'run_input' as const,
                bindAs: 'patchRef',
                path: 'patchRef',
                schema: PATCH_REF_SCHEMA,
              },
              patch: {
                kind: 'run_input' as const,
                bindAs: 'patch',
                path: 'patch',
                schema: PATCH_SCHEMA,
              },
              branch: {
                kind: 'run_input' as const,
                bindAs: 'branch',
                path: 'branch',
                schema: { type: 'string', minLength: 1, maxLength: 200 },
              },
              baseSha: {
                kind: 'run_input' as const,
                bindAs: 'baseSha',
                path: 'baseSha',
                schema: BASE_SHA_SCHEMA,
              },
              mergeFrom: {
                kind: 'run_input' as const,
                bindAs: 'mergeFrom',
                path: 'mergeFrom',
                schema: MERGE_FROM_SCHEMA,
              },
              commitMessage: {
                kind: 'run_input' as const,
                bindAs: 'commitMessage',
                path: 'commitMessage',
                schema: { type: 'string', minLength: 1, maxLength: 20_000 },
              },
              title: {
                kind: 'run_input' as const,
                bindAs: 'title',
                path: 'title',
                schema: TITLE_SCHEMA,
              },
              summary: {
                kind: 'run_input' as const,
                bindAs: 'summary',
                path: 'summary',
                schema: SUMMARY_SCHEMA,
              },
              findings: {
                kind: 'run_input' as const,
                bindAs: 'findings',
                path: 'findings',
                schema: FINDINGS_SCHEMA,
              },
              gaps: {
                kind: 'run_input' as const,
                bindAs: 'gaps',
                path: 'gaps',
                schema: GAPS_SCHEMA,
              },
              owner: {
                kind: 'run_input' as const,
                bindAs: 'owner',
                path: 'owner',
                schema: OWNER_SCHEMA,
              },
              repo: {
                kind: 'run_input' as const,
                bindAs: 'repo',
                path: 'repo',
                schema: REPO_SCHEMA,
              },
              base: {
                kind: 'run_input' as const,
                bindAs: 'base',
                path: 'base',
                schema: { type: 'string', minLength: 1, maxLength: 200 },
              },
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['host.file.patch'],
              integrations: [],
            },
          },
          inputTemplate: {
            bindingId: { $bind: 'bindingId' },
            patchRef: { $bind: 'patchRef' },
            patch: { $bind: 'patch' },
            mode: 'clean',
            commit: {
              branch: { $bind: 'branch' },
              message: { $bind: 'commitMessage' },
              baseSha: { $bind: 'baseSha' },
              mergeFrom: { $bind: 'mergeFrom' },
              // The push sends every ancestor `origin` lacks, not this commit
              // alone, so the scan and the review read the range measured
              // against the base as `origin` holds it now.
              pushBase: { $bind: 'base' },
            },
          },
        },

        {
          taskId: 'check-commit',
          name: "Run the folder's checks on the commit",
          goal: "Run the checks the connected folder declares — the operator's own command, from the repository root — in a detached checkout of this run's commit, measured against where `origin`'s base branch stands, before anything is scanned, reviewed or pushed. A folder that declares none runs none, and the result says so.",
          failureInstruction: CHECKS_COULD_NOT_RUN,
          type: 'operation' as const,
          operation: 'host.commit.check',
          dependsOn: ['commit'],
          when: {
            expression: "tasks.commit.output.state == 'applied'",
            onMissingRef: 'skip' as const,
          },
          // A run that did not pass succeeds with `passed: false` and its
          // account: `recheck-commit` runs the checks again where only tests
          // ran out of their time, and `checks-failed` stops the run on
          // anything else. Nothing after the checks runs unless they cleared.
          retryability: 'safe' as const,
          maxAttempts: 1,
          inputBindings: CHECK_INPUT_BINDINGS,
          context: CHECK_CONTEXT,
          inputTemplate: CHECK_INPUT_TEMPLATE,
          outputProjection: {
            passed: { path: 'passed', onMissing: 'error' as const },
            skipped: { path: 'skipped', onMissing: 'null' as const },
            testTimeouts: { path: 'testTimeouts', onMissing: 'null' as const },
            summary: { path: 'summary', onMissing: 'error' as const },
            tail: { path: 'tail', onMissing: 'null' as const },
            // Null where the folder declares no checks: the push needs none then.
            receipt: { path: 'receipt', onMissing: 'null' as const },
          },
        },

        {
          taskId: 'checks-failed',
          name: 'Stop on the failed checks',
          goal: "Fail the publication with the checks' own account where their first run did not pass for any reason but tests running out of their time, so whoever started it is woken with what they printed.",
          failureInstruction: CHECKS_STOPPED,
          type: 'operation' as const,
          operation: 'workflow.run.fail',
          dependsOn: ['check-commit'],
          when: {
            allOf: [
              'tasks.check-commit.output.passed == false',
              'tasks.check-commit.output.testTimeouts == null',
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
        },

        {
          taskId: 'recheck-commit',
          name: "Run the folder's checks again, after tests ran out of time",
          goal: "Run the folder's checks once more on this run's commit, where nothing failed on their first run but tests running out of their time — `testTimeouts` names them — which a machine under load does to a passing commit. This run's result is the one the push carries; a failure here fails the publication.",
          failureInstruction: `${CHECK_FAILED} They were run a second time because tests ran out of their time on the first, and this second run failed as well.`,
          type: 'operation' as const,
          operation: 'host.commit.check',
          dependsOn: ['commit', 'check-commit'],
          // `testTimeouts` is present only where nothing else failed.
          when: {
            expression: 'tasks.check-commit.output.testTimeouts != null',
            onMissingRef: 'skip' as const,
          },
          // Its own task rather than a second attempt of the first, which a
          // failed projection does not get: one more run, recorded as one.
          retryability: 'safe' as const,
          maxAttempts: 1,
          inputBindings: CHECK_INPUT_BINDINGS,
          context: CHECK_CONTEXT,
          inputTemplate: CHECK_INPUT_TEMPLATE,
          outputProjection: {
            clearedSha: { path: 'clearedSha', onMissing: 'error' as const },
            passed: { path: 'passed', onMissing: 'error' as const },
            summary: { path: 'summary', onMissing: 'error' as const },
            tail: { path: 'tail', onMissing: 'null' as const },
            receipt: { path: 'receipt', onMissing: 'error' as const },
          },
        },

        {
          taskId: 'scan-commit',
          name: 'Scan the commit for secrets',
          goal: "Read every line the push would add — this run's commit and every commit under it that `origin`'s base branch does not hold — the headers and message of each of those commits, and the pull request's title and summary for what looks like a secret: a private key, a cloud or service token, a random-looking value under a secret-looking name. Before anything leaves the machine.",
          failureInstruction:
            "What the push would carry holds what looks like a secret, named above by file, line and rule — or by `<sha> (headers)` or `<sha> (message)` for a commit's headers or message, `pull request title` or `pull request summary` for those — never by its value. The branch stayed on the machine and nothing was pushed. Take the secret out and rotate it if it was real. Where it is in this run's change or its commit's headers or message, commission the change again and publish it on a fresh branch: this branch still holds the commit with the secret, and anything appended to it would push that commit too. Where it is only in the title or the summary, publish again on a fresh branch without it. Where it is in a commit of the folder's own that `origin` does not have yet, or in that commit's headers or message, that commit has to be rewritten before anything built on it is pushed.",
          type: 'operation' as const,
          operation: 'host.commit.scan',
          // After the checks, and their second run where there is one: a
          // commit they failed goes no further.
          dependsOn: ['commit', 'check-commit', 'recheck-commit'],
          when: CHECKS_CLEARED,
          // `unflaggedRange` exists only when no rule matched, so a finding
          // fails the projection; with one attempt and no output contract that
          // fails the run here instead of parking it on a resolution that
          // could clear it. A range with unscanned files or allowed lines
          // projects, and its `clean` sends the run to the approval.
          retryability: 'safe' as const,
          maxAttempts: 1,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            range: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.pushRange' },
            title: { kind: 'run_input' as const, path: 'title' },
            summary: { kind: 'run_input' as const, path: 'summary' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['host.commit.scan'],
              integrations: [],
            },
          },
          inputTemplate: {
            bindingId: { $bind: 'bindingId' },
            range: { $bind: 'range' },
            // The pull request carries these out with the push; an absent
            // summary drops its key rather than scanning an empty text.
            texts: {
              'pull request title': { $bind: 'title' },
              'pull request summary': { $bind: 'summary' },
            },
          },
          outputProjection: {
            unflaggedRange: { path: 'unflaggedRange', onMissing: 'error' as const },
            clean: { path: 'clean', onMissing: 'error' as const },
            unscanned: { path: 'unscanned', onMissing: 'error' as const },
            allowed: { path: 'allowed', onMissing: 'error' as const },
            summary: { path: 'summary', onMissing: 'error' as const },
            receipt: { path: 'receipt', onMissing: 'error' as const },
          },
        },

        {
          taskId: 'read-repository',
          name: "Check the space's GitHub credential can see the repository",
          goal: "Read `owner`/`repo` through the space's GitHub connection before anything is pushed.",
          failureInstruction:
            "The GitHub credential bound to this space cannot see `owner`/`repo` — GitHub answers 404 for a private repository the token has no access to — and that credential's repository access is the thing to check. Nothing has been pushed, and the commit is still on its branch.",
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['commit', 'check-commit', 'recheck-commit'],
          when: CHECKS_CLEARED,
          // One attempt and no output contract: a repository the credential
          // cannot see fails the run here, rather than parking it on a
          // resolution nobody can supply.
          retryability: 'safe' as const,
          maxAttempts: 1,
          inputBindings: {
            owner: { kind: 'run_input' as const, path: 'owner' },
            repo: { kind: 'run_input' as const, path: 'repo' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['api.http.call'],
              integrations: [],
            },
          },
          inputTemplate: {
            apiId: 'github',
            endpointId: 'getRepository',
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
            },
            response: { format: 'json' },
          },
          outputProjection: {
            repository: { path: 'data.full_name', onMissing: 'error' as const },
          },
        },

        {
          taskId: 'read-push-approval',
          name: "Read the folder's push approval",
          goal: 'Read, from the machine holding the connected folder, when a publication from it asks the operator before pushing — for a commit the scan cleared, the only kind the posture decides for.',
          type: 'operation' as const,
          operation: 'host.binding.inspect',
          dependsOn: ['commit', 'scan-commit'],
          // A range the scan did not clear asks whatever the posture, so the
          // posture is read only where it decides — and is absent wherever the
          // approval asks for any other reason. That is what lets the push read
          // `never` as a clearance in a single comparison without it ever
          // clearing a push the operator declined.
          when: {
            expression: 'tasks.scan-commit.output.clean == true',
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['host.binding.inspect'],
              integrations: [],
            },
          },
          inputTemplate: {
            bindingId: { $bind: 'bindingId' },
          },
        },

        {
          taskId: 'review-commit',
          name: 'Review the commit',
          goal: "Run a Local Code Review of everything the push would add — this run's commit and every commit under it that `origin`'s base branch does not hold — as a run of its own, and wait for it to finish with its verdict.",
          type: 'operation' as const,
          operation: 'workflow.run.start',
          // After the scan as well: a commit carrying a secret is never handed
          // to a coding agent, whose provider would read it.
          dependsOn: ['read-push-approval', 'scan-commit'],
          // Only the posture that depends on a review starts one, so a verdict
          // here always belongs to a run whose approval it decides — and only
          // over a range the scan cleared, since an unread file or a line
          // marked allowed may hold what the coding agent's provider must not
          // see, and the approval is asked for such a range whatever a review
          // says.
          when: {
            allOf: [
              `tasks.read-push-approval.output.branchPolicy.pushApproval == '${REVIEW_GATED_POSTURE}'`,
              'tasks.scan-commit.output.clean == true',
            ],
            onMissingRef: 'skip' as const,
          },
          // A review that could not run is no verdict, not a failed
          // publication: the approval reads its status and asks.
          optional: true,
          // A second attempt starts a second review.
          retryability: 'unsafe' as const,
          maxAttempts: 1,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            range: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.pushRange' },
            // The range's tip, where the review's checkout stands. The folder's
            // own HEAD is where the commission started — the range's base — since
            // the commit lands on a branch nothing has checked out.
            at: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.sha' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['workflow.run.start'],
              integrations: [],
            },
          },
          inputTemplate: {
            slug: REVIEW_SKILL.slug,
            catalogId: REVIEW_SKILL.catalogId,
            inputs: {
              bindingId: { $bind: 'bindingId' },
              range: { $bind: 'range' },
              at: { $bind: 'at' },
              depth: 'standard',
            },
            wait: 'until_complete',
          },
          // A review that failed, was cancelled or paused carries no promoted
          // output, so its verdict reads null and the approval is asked for.
          outputProjection: {
            verdict: { path: 'result.output.verdict', onMissing: 'null' as const },
            reviewSummary: { path: 'result.output.reviewSummary', onMissing: 'null' as const },
            findings: { path: 'result.output.findings', onMissing: 'null' as const },
            outcome: { path: 'outcome', onMissing: 'error' as const },
            reviewRunId: { path: 'runId', onMissing: 'error' as const },
          },
          // The review run holds every finding whole, which is what a fix
          // round is briefed from; the run names it so whoever starts one can read it.
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'reviewRunId', toState: 'reviewRunId' },
          ],
          outputContract: {
            schema: {
              type: 'object',
              required: ['verdict', 'reviewSummary', 'findings', 'outcome', 'reviewRunId'],
              additionalProperties: false,
              properties: {
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
                reviewRunId: { type: 'string', minLength: 1 },
              },
            },
          },
        },

        {
          taskId: 'decide-after-review',
          name: 'Decide whether the findings are fixed before merging',
          goal: "Read the review's findings and choose whether this branch takes a fix round before it merges or merges as it is, for the pull request to record. An answer too unsure to stand is recorded as undecided.",
          type: 'operation' as const,
          operation: 'ai.decision.decide',
          dependsOn: ['review-commit'],
          // A review with no findings, or one that did not finish, has none to weigh.
          when: {
            expression: 'tasks.review-commit.output.findings[0] != null',
            onMissingRef: 'skip' as const,
          },
          // Only `describe-pr` reads the answer, to record it; a decision that
          // could not be made is recorded as undecided, and the run goes on.
          optional: true,
          retryability: 'safe' as const,
          maxAttempts: 2,
          inputBindings: {
            verdict: { kind: 'task_output' as const, taskId: 'review-commit', path: 'verdict' },
            findings: { kind: 'task_output' as const, taskId: 'review-commit', path: 'findings' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['ai.decision.decide'],
              integrations: [],
            },
          },
          inputTemplate: {
            state: {
              verdict: { $bind: 'verdict' },
              findings: { $bind: 'findings' },
            },
            questions: { [AFTER_REVIEW_QUESTION_NAME]: AFTER_REVIEW_QUESTION },
          },
          // No model is named: the space's decision model answers. The 0.80 bar
          // was measured on Jev alone (Plan 316 §7), and holds for another
          // decider only once that decider is measured on the same cases
          // (`yarn decisions:measure-loop`); the bar moves only on such a measurement.
          // `afterReview` is the answer that cleared the bar, null where none
          // did; `chosen` is what it would have chosen, and with `confidence`
          // null where the model declined the question — a refusal is an
          // answer, never decided, not a failed step.
          outputProjection: {
            afterReview: {
              path: `answers.${AFTER_REVIEW_QUESTION_NAME}.decidedValue`,
              onMissing: 'error' as const,
            },
            chosen: {
              path: `answers.${AFTER_REVIEW_QUESTION_NAME}.value`,
              onMissing: 'null' as const,
            },
            decided: {
              path: `answers.${AFTER_REVIEW_QUESTION_NAME}.decided`,
              onMissing: 'error' as const,
            },
            confidence: {
              path: `answers.${AFTER_REVIEW_QUESTION_NAME}.confidence`,
              onMissing: 'null' as const,
            },
          },
        },

        {
          taskId: 'describe-pr',
          name: 'Compose the pull request from the branch',
          goal: "Compose the pull request's title and body from everything the push sends — the subject of the branch's first commit as the title, and as the body every commit's message oldest first, the review findings closed and left open, the folder's checks as verification, and the gaps the commissions recorded — and read that text for secrets, before anything is pushed. A title or summary a person passed stands as it is.",
          failureInstruction:
            "The pull request composed from the branch holds what looks like a secret, named above by where it is in the title or the body, line and rule — never by its value — and nothing was pushed: the commit is still on its branch in the folder. Where the line came from `findings` or `gaps`, or from a title or summary passed in, publish this branch as it stands without it. Where it came from the review's summary or the end of what the checks printed, that text is the review's or the checks' own: take the secret out of the code or the environment they read, rotate it if it was real, and publish again. Where it came from a commit's message — a line marked allowed, which the scan let the operator read — that commit has to be rewritten before the branch is published.",
          type: 'operation' as const,
          operation: 'host.commit.describe',
          dependsOn: [
            'commit',
            'check-commit',
            'recheck-commit',
            'scan-commit',
            'review-commit',
            'decide-after-review',
          ],
          when: CHECKS_CLEARED,
          retryability: 'safe' as const,
          maxAttempts: 1,
          // Whole outputs, each absent where its task did not run: a review
          // that failed or was never started is reported as none finishing,
          // and its findings, and the decision on them, are what the pull
          // request records of it.
          inputBindings: {
            afterReview: {
              kind: 'task_output' as const,
              taskId: 'decide-after-review',
              path: 'afterReview',
            },
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            range: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.pushRange' },
            title: { kind: 'run_input' as const, path: 'title' },
            summary: { kind: 'run_input' as const, path: 'summary' },
            findings: { kind: 'run_input' as const, path: 'findings' },
            gaps: { kind: 'run_input' as const, path: 'gaps' },
            review: { kind: 'task_output' as const, taskId: 'review-commit' },
            check: { kind: 'task_output' as const, taskId: 'check-commit' },
            recheck: { kind: 'task_output' as const, taskId: 'recheck-commit' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['host.commit.describe'],
              integrations: [],
            },
          },
          inputTemplate: {
            bindingId: { $bind: 'bindingId' },
            range: { $bind: 'range' },
            title: { $bind: 'title' },
            summary: { $bind: 'summary' },
            findings: { $bind: 'findings' },
            review: { $bind: 'review' },
            check: { $bind: 'check' },
            recheck: { $bind: 'recheck' },
            gaps: { $bind: 'gaps' },
            afterReview: { $bind: 'afterReview' },
          },
          outputProjection: {
            title: { path: 'title', onMissing: 'error' as const },
            body: { path: 'body', onMissing: 'error' as const },
            findings: { path: 'findings', onMissing: 'error' as const },
            // Absent where the hand-on left none out.
            findingsLeftOut: { path: 'findingsLeftOut', onMissing: 'null' as const },
            // Absent where the review returned no findings, so none was decided.
            afterReview: { path: 'afterReview', onMissing: 'null' as const },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'afterReview', toState: 'afterReview' },
            { kind: 'output_path' as const, path: 'findings', toState: 'findings' },
            { kind: 'output_path' as const, path: 'findingsLeftOut', toState: 'findingsLeftOut' },
          ],
        },

        {
          taskId: 'approve-push',
          name: 'Approve the push',
          goal: "Operator approval before anything leaves the machine, asked when the folder asks before every push, when it asks unless reviewed and this run's review did not approve what the push would add, and — whatever the posture — when the scan marked a line allowed or could not read a file. Approving pushes the commit to its branch on origin and opens the pull request; declining leaves the branch on the machine, whatever the posture.",
          type: 'human' as const,
          intent: 'approve' as const,
          failureMode: 'isolate' as const,
          dependsOn: ['read-repository', 'scan-commit', 'review-commit'],
          approves: ['commit'],
          // A review task that failed has no output to compare, so its status
          // carries the same answer as a null verdict. A scan that marked a
          // line allowed or could not read every file asks whatever the
          // posture.
          when: {
            anyOf: [
              "tasks.read-push-approval.output.branchPolicy.pushApproval == 'always'",
              "tasks.review-commit.output.verdict != 'approve'",
              "tasks.review-commit.status == 'failed'",
              'tasks.scan-commit.output.clean == false',
            ],
            onMissingRef: 'skip' as const,
          },
          // The prompt is fixed text and the verdict is not a value it can
          // carry, so each case is one line and the verdict is named where the
          // run shows it.
          pauseInstruction:
            "The change is committed on its branch in the connected folder, and nothing has left the machine. The push would add every commit of `pushRange` — this commit, and any of the folder's own under it that `origin` does not have yet. The scan read them for secrets and found none outside the lines and files listed below, where there are any. Asked for one of these, shown with the commit:\n- `always`: the folder's push approval asks before every push, and no review ran.\n- `unless-unreviewed`: this run's Local Code Review of `pushRange` did not return `approve` — its verdict is on the \"Review the commit\" task, null where the review did not finish, and that task failed where the review could not start.\n- Lines marked allowed, whatever the posture: `allowed` names each by file, line and rule — a line that looks like a secret and ends in an `aflow-scan: allow` comment, which whoever wrote the change could have written as easily as the line — and no review ran. Read each of those lines before approving: approving pushes them.\n- Files, messages or texts the scan could not read whole, whatever the posture: `unscanned` names each and why — binary, a NUL byte in a line it adds, more than the scan reads of one file in one commit, a line too long to read, or a Git LFS pointer, whose content the push uploads without the scan having read it — and no review ran. Nothing unread there was checked for secrets; read it before approving.\nApproving pushes that commit to its branch on `origin`, with every commit of `pushRange` under it, and then opens a pull request against the base branch. Declining leaves the branch local whatever the folder's push approval says: nothing is pushed and no pull request is opened.",
          // Every binding reads a task that succeeded whenever this asks: an
          // unresolved one refuses the approval itself, so nothing binds the
          // posture, which is not read over a range the scan did not clear.
          actionPreview: {
            op: 'host.process.exec',
            inputBindings: {
              bindingId: { kind: 'run_input' as const, path: 'bindingId' },
              branch: { kind: 'run_input' as const, path: 'branch' },
              unscanned: { kind: 'task_output' as const, taskId: 'scan-commit', path: 'unscanned' },
              allowed: { kind: 'task_output' as const, taskId: 'scan-commit', path: 'allowed' },
              scanSummary: {
                kind: 'task_output' as const,
                taskId: 'scan-commit',
                path: 'summary',
              },
              commitSha: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.sha' },
              // `bindingId`, `refspec` and `receipt` are the push call: the
              // operator's approval mints a grant for exactly that push, and
              // the executor sends a range the scan did not clear, or any range
              // from an `always` folder, only on it.
              receipt: { kind: 'task_output' as const, taskId: 'scan-commit', path: 'receipt' },
              refspec: {
                kind: 'task_output' as const,
                taskId: 'commit',
                path: 'commit.pushRefspec',
              },
              pushRange: {
                kind: 'task_output' as const,
                taskId: 'commit',
                path: 'commit.pushRange',
              },
              commitBranch: {
                kind: 'task_output' as const,
                taskId: 'commit',
                path: 'commit.branch',
              },
              commitMessage: {
                kind: 'task_output' as const,
                taskId: 'commit',
                path: 'commit.message',
              },
              filesChanged: {
                kind: 'task_output' as const,
                taskId: 'commit',
                path: 'filesChanged',
              },
            },
          },
        },

        {
          taskId: 'push',
          name: 'Push the commit',
          goal: 'Push the commit this run made to its branch on origin through the connected folder’s shell, with the argv pinned by the skill — carrying the commits of `pushRange` under it that origin does not have, and no tag or submodule commit. It carries the base branch, the receipt the scan issued for `pushRange` and, where the folder declares checks, the receipt the check issued for the commit; the executor refuses a push without them, and one whose checks did not pass on exactly this commit against that base. In the same step, just before git runs, the executor confirms the push goes where `origin` fetches from and reads where `origin`’s base branch is now; where that is not where the receipt’s range starts, or the executor restarted since the scan, it scans the range from there to the commit itself and pushes on that scan. Where the scan did not clear the range, or the folder’s push approval is `always`, the executor pushes only on the operator’s approval of this push in this run. A remote that refuses the update fails the push with git’s own message.',
          failureInstruction:
            "Nothing was pushed, and the commit is still on its branch in the folder. Where the message above says the commit no longer merges cleanly into `origin`'s base branch, which moved on since the scan, the remedy is the merge round it names: commission the fix from this branch with `mergeFrom: origin/<base>`, and publish it onto this branch with the sha the commission reports in `merge.from` as `mergeFrom`. Where it says the push scanned the range it sends and found what looks like a secret, the commits `origin`'s base gained are not the cause: the secret is in this branch, and is handled as a finding of the scan is. Where it says the receipt's range starts at a commit `origin`'s base branch no longer holds — the base was rewound — or that `origin` pushes somewhere other than where it fetches from, put that right — for a push URL, the folder has to push where it fetches — and publish this branch as it stands: `branch` and `baseSha` its head, with no patch, `mergeFrom` or `commitMessage`. Where it says the push carries no check receipt the executor issued, one more than a day old, or one for checks the folder no longer declares, the checks have to run again on the commit: publish this branch as it stands. Where it says no approval of this push is on record, nothing was pushed: the operator's approval in this run is what lets a range the scan did not clear leave the machine, and any push at all from a folder whose push approval is `always`. Otherwise git's own message says why the remote refused the update.",
          type: 'operation' as const,
          operation: 'host.process.exec',
          // The scan and the check as well as the approval: under `never` over a cleared
          // range the approval is skipped, and a skip clears a dependency
          // where a failure does not. The pull request's text as well, so
          // text that cannot go out stops the run before the branch has.
          dependsOn: [
            'approve-push',
            'scan-commit',
            'check-commit',
            'recheck-commit',
            'describe-pr',
          ],
          when: PUSH_CLEARED,
          retryability: 'unsafe' as const,
          maxAttempts: 1,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            refspec: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.pushRefspec' },
            base: { kind: 'run_input' as const, path: 'base' },
            receipt: { kind: 'task_output' as const, taskId: 'scan-commit', path: 'receipt' },
            checkReceipt: {
              kind: 'task_output' as const,
              taskId: 'check-commit',
              path: 'receipt',
            },
            // Absent where the first run passed and no second one ran.
            recheckReceipt: {
              kind: 'task_output' as const,
              taskId: 'recheck-commit',
              path: 'receipt',
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['host.process.exec'],
              integrations: [],
            },
          },
          inputTemplate: {
            bindingId: { $bind: 'bindingId' },
            command: PUSH_COMMAND,
            pushBase: { $bind: 'base' },
            scan: { receipt: { $bind: 'receipt' } },
            check: {
              receipt: { $firstOf: [{ $bind: 'recheckReceipt' }, { $bind: 'checkReceipt' }] },
            },
            cwd: '.',
            timeoutMs: 600_000,
          },
        },

        // Before `open-pr`, and the order matters: a run's state takes each
        // task's promoted outputs in this order, so the null an empty list
        // promotes here is overwritten by the pull request opened after it.
        {
          taskId: 'find-pr',
          name: 'Find the open pull request for the branch',
          goal: "Ask GitHub, through the REST API, for the open pull request from the pushed branch into the base branch — a branch appended to may already have one, and GitHub refuses a second. That pull request now carries the push, its description is rewritten to match, and it is the run's result.",
          failureInstruction:
            "The push went through — the commit is on its branch on `origin` — but GitHub could not be asked whether the branch already has an open pull request, so none was opened. Find the branch's pull request on GitHub, or open one for it there.",
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['push'],
          when: {
            expression: 'tasks.push.output.exitCode == 0',
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          maxAttempts: 2,
          inputBindings: {
            owner: { kind: 'run_input' as const, path: 'owner' },
            repo: { kind: 'run_input' as const, path: 'repo' },
            branch: { kind: 'run_input' as const, path: 'branch' },
            base: { kind: 'run_input' as const, path: 'base' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['api.http.call'],
              integrations: [],
            },
          },
          inputTemplate: {
            apiId: 'github',
            endpointId: 'listPullRequests',
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
              // GitHub filters on the head only in its `owner:branch` form.
              head: { $concat: [{ $bind: 'owner' }, ':', { $bind: 'branch' }] },
              // A pull request from the branch into another base is not this
              // publication's, and reporting it would open none into `base`.
              base: { $bind: 'base' },
              state: 'open',
            },
            response: { format: 'json' },
          },
          outputProjection: {
            prNumber: { path: 'data[0].number', onMissing: 'null' as const },
            prUrl: { path: 'data[0].html_url', onMissing: 'null' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['prNumber', 'prUrl'],
              additionalProperties: false,
              properties: {
                prNumber: {
                  type: ['number', 'null'],
                  description:
                    "The branch's open pull request into the base; null when it has none.",
                },
                prUrl: { type: ['string', 'null'] },
              },
            },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'prUrl', toState: 'prUrl' },
            { kind: 'output_path' as const, path: 'prNumber', toState: 'prNumber' },
          ],
        },

        {
          taskId: 'update-pr',
          name: "Rewrite the pull request's description",
          goal: "Rewrite the body of the branch's open pull request through the GitHub REST API — and its title, where one was passed — to the text composed from the branch as it now stands, so an appended push does not leave an earlier publication's description on it.",
          failureInstruction:
            "The push went through and the branch's pull request carries it, but GitHub did not take its new description, so it still describes the branch as an earlier publication left it. Rewrite it on GitHub, or publish this branch as it stands to compose it again.",
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['find-pr', 'describe-pr'],
          when: {
            expression: 'tasks.find-pr.output.prNumber != null',
            onMissingRef: 'skip' as const,
          },
          // The same text sent twice leaves the same pull request.
          retryability: 'safe' as const,
          maxAttempts: 2,
          // The title only where a person passed one: a title edited on
          // GitHub since is theirs, and the slice's would overwrite it.
          inputBindings: {
            owner: { kind: 'run_input' as const, path: 'owner' },
            repo: { kind: 'run_input' as const, path: 'repo' },
            prNumber: { kind: 'task_output' as const, taskId: 'find-pr', path: 'prNumber' },
            title: { kind: 'run_input' as const, path: 'title' },
            body: { kind: 'task_output' as const, taskId: 'describe-pr', path: 'body' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['api.http.call'],
              integrations: [],
            },
          },
          inputTemplate: {
            apiId: 'github',
            endpointId: 'updatePullRequest',
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
              pull_number: { $bind: 'prNumber' },
              body: {
                title: { $bind: 'title' },
                body: { $bind: 'body' },
              },
            },
            response: { format: 'json' },
          },
          outputProjection: {
            prNumber: { path: 'data.number', onMissing: 'error' as const },
          },
        },

        {
          taskId: 'open-pr',
          name: 'Open the pull request',
          goal: 'Open a pull request from the pushed branch into the base branch through the GitHub REST API, where the branch has none open, with the title and body composed from the branch.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['find-pr', 'describe-pr'],
          when: {
            expression: 'tasks.find-pr.output.prNumber == null',
            onMissingRef: 'skip' as const,
          },
          retryability: 'unsafe' as const,
          maxAttempts: 2,
          inputBindings: {
            owner: { kind: 'run_input' as const, path: 'owner' },
            repo: { kind: 'run_input' as const, path: 'repo' },
            branch: { kind: 'run_input' as const, path: 'branch' },
            base: { kind: 'run_input' as const, path: 'base' },
            title: { kind: 'task_output' as const, taskId: 'describe-pr', path: 'title' },
            body: { kind: 'task_output' as const, taskId: 'describe-pr', path: 'body' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['api.http.call'],
              integrations: [],
            },
          },
          inputTemplate: {
            apiId: 'github',
            endpointId: 'createPullRequest',
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
              body: {
                title: { $bind: 'title' },
                head: { $bind: 'branch' },
                base: { $bind: 'base' },
                body: { $bind: 'body' },
                draft: false,
              },
            },
            response: { format: 'json' },
          },
          outputProjection: {
            prNumber: { path: 'data.number', onMissing: 'error' as const },
            prUrl: { path: 'data.html_url', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['prNumber', 'prUrl'],
              additionalProperties: false,
              properties: {
                prNumber: { type: 'number' },
                prUrl: { type: 'string', minLength: 1 },
              },
            },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'prUrl', toState: 'prUrl' },
            { kind: 'output_path' as const, path: 'prNumber', toState: 'prNumber' },
          ],
        },
      ],
      stateVariables: [
        {
          variableId: 'prUrl',
          name: 'Pull request link',
          description:
            "The branch's pull request — the one this run opened, or the one already open for the branch — as a person opens it.",
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'alternatives' as const,
        },
        {
          variableId: 'prNumber',
          name: 'Pull request number',
          description: "The number of the branch's pull request on the repository.",
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'alternatives' as const,
        },
        {
          variableId: 'afterReview',
          name: 'After the review',
          description:
            "What the run decided about its review's findings, as the pull request records it: fix_before_merge, publish_as_is, or undecided where no answer cleared the bar or none could be made. Null where the review returned no findings, so none was decided. Nothing in the run acts on it: on fix_before_merge the fix round is the conversation's, or the shepherd's.",
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'findings',
          name: 'Findings',
          description:
            "The open findings of the latest review — this run's own review's where it finished, replacing the earlier rounds'; otherwise the open ones it was given — bounded to fit a later publication's inputs. That publication takes them as its `findings`, with each its fix closed marked closed, for its pull request to record. A fix round is briefed from the review run's own findings, never from these.",
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'findingsLeftOut',
          name: 'Findings left out',
          description:
            'How many open findings `findings` left out to stay within its bound, the least severe of them; null where it left none out. The review run keeps every one.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'reviewRunId',
          name: 'Review run',
          description:
            "The run of this publication's own review, where one started: its output holds every finding whole, with its evidence and suggestion — what a fix round is briefed from.",
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'prUrl',
        guidance:
          "The run carries prUrl and prNumber once the branch has its pull request — opened, or already open — and reporting the link is the result. afterReview records its decision on the review's findings: on fix_before_merge, brief the fix from the reviewRunId run and publish again with findings. Absent prUrl, the branch stayed on the machine to publish later — unless the run failed at the checks, whose account says what failed, or at the scan, where the commit holds what looks like a secret.",
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'publish-local-changes',
      name: 'Publish Local Changes',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'change-published',
            description:
              "A patch is committed onto a branch of a repository connected as a host folder without changing the working tree and passes the folder's checks, and once the push is cleared — by the operator, or by the folder's push approval — the branch is pushed and a pull request is open.",
          },
        ],
      },
      mode: 'process' as const,
      // A run holds its slot for as long as its approval waits, and one
      // publication has no bearing on another, so none queues behind a pause.
      concurrency: {
        maxParallelTasksPerRun: 4,
        maxConcurrentRuns: 'unlimited' as const,
        failureMode: 'isolate' as const,
        perUserSerial: false,
      },
    },
    activation: {
      triggerPatterns: [
        'publish these changes',
        'open a pr for this',
        'push this branch',
        'commit and push this',
        'turn this patch into a pull request',
      ],
      activationHint:
        "Run to publish a patch that already exists — a commission's, passed as its `patchRef`, or a small diff from the operator — onto a branch of a connected repository and into a pull request, or a branch whose commit is already made, as it stands. The commit is local and reversible, and everything the push would add is scanned for secrets before it; the push waits for an approval unless the folder's push approval says it need not ask. The folder must allow pushes under a branch prefix.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "Fifteen tasks, the approval between local and published halves. The commit lands in a detached worktree; host.commit.check runs the folder's checks. A check lost to test timeouts alone reruns; any other failure is workflow.run.fail with the checks' summary — no decision is asked there until its measurement has labelled cases. host.commit.scan reads all a push adds: a finding fails the run, an unread file or allowed line asks. Over a cleared range the posture, and under unless-unreviewed a Local Code Review, decide whether to ask. Over its findings ai.decision.decide answers fix_before_merge or publish_as_is, which describe-pr records, undecided below the bar; no task acts on it, and no task starts a publication. No decision gates the push. The push argv is pinned bar the refspec; the executor re-measures origin/<base>, needs a passed check receipt, and sends an uncleared range only on this run's grant. host.commit.describe composes the PR before the push; an open PR is PATCHed.",
  },
};

export { PUBLISH_LOCAL_CHANGES };
