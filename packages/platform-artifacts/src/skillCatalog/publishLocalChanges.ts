import {
  HOST_PUSH_APPROVAL_DEFAULT,
  type HostPushApproval,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  STORED_PAYLOAD_REF_PATTERN,
  type SkillCatalogEntry,
} from '@aflow/schemas';
import { REVIEW_LOCAL_CHANGES } from './reviewLocalChanges.js';

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

const PUBLISH_LOCAL_CHANGES: SkillCatalogEntry = {
  catalogId: 'publish-local-changes',
  version: 21,
  name: 'Publish Local Changes',
  tagline:
    'Commit a patch onto a branch of a connected repository, then push it and open the pull request — asking the operator first unless the folder says otherwise.',
  description: `Fits a request to publish an existing patch — a commission's result, or a diff the operator hands over — onto a branch of a connected repository and into a pull request. The commit never touches the working tree, the folder's checks run on it, it is scanned for secrets, and nothing leaves the machine until the push is cleared.

**Not for a folder whose machine block shows no publish prefix**: its push is refused. Say so, ask for the folder to be reconnected with one, and stop rather than commit what cannot be published.

**What it needs**: the connected folder; the change — for a commission's work, the \`patchRef\` its result reports, passed as \`patchRef\`, or for a diff the operator hands over, that text as \`patch\`, one or the other; a branch name under the folder's publish prefix; the commit message; a title for the pull request; the repository owner and name, from the folder's \`origin\` remote; and the base branch the pull request targets. A summary is optional and becomes the pull request's body; omitted, the pull request's body is the commit message after its first line — the commission's own account of the change. Ask for what is missing; never invent it.

**Never pass a commission's \`patch\` text.** It is a copy for reading, cut short on a large change, and the run's inputs are capped at ${String(RUN_INPUTS_KB)} KB together. \`patchRef\` names the whole diff at any size.

**When it asks before pushing**: the folder's push approval decides, and the machine block shows it as \`pushApproval\`. \`always\` asks before every push; \`never\` pushes without asking. \`unless-unreviewed\`: the run has Local Code Review read everything the push would add and pushes without asking only when it returns \`approve\` — on any other verdict, or a review that did not finish or could not start, it waits for the operator. The review is the catalog's as installed; an edited copy is refused, and the run asks. A folder that names no posture is \`${HOST_PUSH_APPROVAL_DEFAULT}\`, the default. Whatever the posture, the run scans every line the push would add, the headers and message of every commit it carries, and the pull request's title and summary for secrets before any of this, and a finding stops it with nothing pushed — which is what lets a review stand in for the operator. Only a range the scan cleared can go without asking: where a file was not read whole, or a line that looks like a secret ends in an \`aflow-scan: allow\` comment, no review runs and the run waits for the operator whatever the posture, \`never\` included, naming each and why. The comment never clears a line — whoever wrote the change could have written it; it turns a stop into a question. Once the run asks, the operator's answer decides: a declined push pushes nothing, whatever the posture.

**Its checks first**: the folder's \`checks\`, shown in the machine block, run in a checkout of the commit before the scan, and a failure stops the run with nothing scanned, reviewed or pushed; the push needs their passing receipt. A folder that declares none runs none. The pull request's own checks remain the proof.

**On an existing branch**: a fix commissioned from a branch (\`base: <branch>\`) is published onto it by naming it as \`branch\` and passing the commission's \`baseSha\` as \`baseSha\`; a branch is reused only that way, and a fresh change takes a fresh branch. A fix to a branch \`main\` has moved past is commissioned with \`mergeFrom: origin/<base>\` as well and published with the sha the commission reported in \`merge.from\` as \`mergeFrom\`: the branch then carries one merge commit holding the fix. A commission that reported a \`merge\` and no \`patchRef\` changed nothing beyond the merge: it is published with \`mergeFrom\` and neither \`patchRef\` nor \`patch\`.

**With the result**: report the pull request link, and whether the push was approved by the operator or cleared by the folder's push approval — and, where the run reviewed its commit, the verdict. A branch that already has an open pull request into the base gets no second one: the run reports that one. Where approval was declined, report that nothing was pushed and the commit stays on the machine to publish later. Where the checks failed, nothing left the machine: report the end of what they printed. Where the scan found what looks like a secret, the run failed with nothing pushed: report the files, commit headers and messages, title or summary, lines and rules it names — never ask for or repeat the value — and say the secret has to come out and the change be commissioned again onto a fresh branch, this one holding that commit — or, for one of the folder's own commits \`origin\` lacks, that the commit needs rewriting first. Where the push refused because \`origin\`'s base moved since the run measured it, either way, or \`origin\` pushes elsewhere than it fetches, nothing was pushed: report what its message names, and that the publication runs again on a fresh branch. Where the push failed, git's own message says why; a branch on \`origin\` that moved on is never overwritten.`,
  tags: ['coding', 'publish', 'git', 'local', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description:
        'GitHub REST API — read the repository before the push, then find the open pull request for the pushed branch, or open one where there is none.',
      requiredEndpoints: ['getRepository', 'listPullRequests', 'createPullRequest'],
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
            "The change a commission made: the `patchRef` its result reports, passed on as it is. It names the whole diff whatever its size. Give this or `patch`, never both — a commission's change always goes this way. Omit both only with `mergeFrom`, for a commission that reported a `merge` and no `patchRef`: the merge is then the whole change.",
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
            "The commit the patch was made against, as the commission reported it in `baseSha`. Required to append to an existing branch, and it must be that branch's head. A new branch is created at it, even where the folder's last commit is behind or ahead of it — a commission started from a remote fetched it into the folder; without it, a new branch starts at the folder's last commit.",
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
          required: true,
          // Its own input rather than the title and the summary joined here:
          // with no summary, the body it carries is the pull request's.
          description:
            "The commit message: the title, then a blank line and what the change does and why — the summary where one is given, otherwise the commission's own account of the change. Where no summary is given, the pull request's body is this message after its first line.",
          schema: { type: 'string', minLength: 1, maxLength: 20_000 },
        },
        {
          id: 'title',
          required: true,
          description: 'The title of the pull request.',
          schema: { type: 'string', minLength: 1, maxLength: 500 },
        },
        {
          id: 'summary',
          required: false,
          description:
            "What the change does and why, for whoever reviews it. Becomes the body of the pull request. Omit it and the pull request's body is the commit message after its first line.",
          schema: { type: 'string', minLength: 1, maxLength: 20_000 },
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
          goal: "Apply the patch in a detached worktree and commit it — on a new branch at the commit the patch was made against (the connected folder's last commit when none is given), or on top of the existing branch it was made on — after fetching the base branch from `origin`, so the commit reports everything a push of it would add. The operator's working tree is not touched, and nothing leaves the machine.",
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
                schema: { type: 'string', minLength: 1, maxLength: 500 },
              },
              summary: {
                kind: 'run_input' as const,
                bindAs: 'summary',
                path: 'summary',
                schema: { type: 'string', minLength: 1, maxLength: 20_000 },
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
          failureInstruction:
            "The folder's checks failed on this run's commit: their account is above, with the end of what they printed, and the whole of it is stored with this failure. Nothing was scanned, reviewed or pushed, and the commit is still on its branch in the folder. Commission the fix onto this branch — nothing of it has left the machine — and publish again. Where they ran out of time rather than failed, the folder's `checksTimeoutMs` is the operator's to raise on the machine.",
          type: 'operation' as const,
          operation: 'host.commit.check',
          dependsOn: ['commit'],
          when: {
            expression: "tasks.commit.output.state == 'applied'",
            onMissingRef: 'skip' as const,
          },
          // `clearedSha` exists only where the checks passed or none are
          // declared, so a failure fails the projection; with one attempt and
          // no output contract that fails the run here, the check's own
          // summary — which carries the tail — leading the message.
          retryability: 'safe' as const,
          maxAttempts: 1,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            sha: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.sha' },
            pushBaseSha: {
              kind: 'task_output' as const,
              taskId: 'commit',
              path: 'commit.pushBaseSha',
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['host.commit.check'],
              integrations: [],
            },
          },
          inputTemplate: {
            bindingId: { $bind: 'bindingId' },
            sha: { $bind: 'sha' },
            base: { $bind: 'pushBaseSha' },
          },
          outputProjection: {
            clearedSha: { path: 'clearedSha', onMissing: 'error' as const },
            passed: { path: 'passed', onMissing: 'error' as const },
            skipped: { path: 'skipped', onMissing: 'null' as const },
            summary: { path: 'summary', onMissing: 'error' as const },
            // Null where the folder declares no checks: the push needs none then.
            receipt: { path: 'receipt', onMissing: 'null' as const },
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
          // After the checks: a commit they failed goes no further.
          dependsOn: ['commit', 'check-commit'],
          when: {
            expression: "tasks.commit.output.state == 'applied'",
            onMissingRef: 'skip' as const,
          },
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
          dependsOn: ['commit'],
          when: {
            expression: "tasks.commit.output.state == 'applied'",
            onMissingRef: 'skip' as const,
          },
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
              depth: 'standard',
            },
            wait: 'until_complete',
          },
          // A review that failed, was cancelled or paused carries no promoted
          // output, so its verdict reads null and the approval is asked for.
          outputProjection: {
            verdict: { path: 'result.output.verdict', onMissing: 'null' as const },
            outcome: { path: 'outcome', onMissing: 'error' as const },
            reviewRunId: { path: 'runId', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['verdict', 'outcome', 'reviewRunId'],
              additionalProperties: false,
              properties: {
                verdict: {
                  type: ['string', 'null'],
                  description:
                    'What the review of this commit returned: approve, request_changes or comment; null when it did not complete.',
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
          goal: 'Push the commit this run made to its branch on origin through the connected folder’s shell, with the argv pinned by the skill — carrying the commits of `pushRange` under it that origin does not have, and no tag or submodule commit. It carries the base branch, the receipt the scan issued for `pushRange` and, where the folder declares checks, the receipt the check issued for the commit; the executor refuses a push without them, and one whose checks did not pass on exactly this commit against that base. In the same step, just before git runs, the executor confirms the push goes where `origin` fetches from, reads where `origin`’s base branch is now, and pushes only if the receipt is for the range from exactly there to the commit. Where the scan did not clear the range, or the folder’s push approval is `always`, the executor pushes only on the operator’s approval of this push in this run. A remote that refuses the update fails the push with git’s own message.',
          failureInstruction:
            "Where the message above says `origin`'s base branch is somewhere other than where the receipt's range starts, or that `origin` pushes somewhere other than where it fetches from, nothing was pushed: the push would have carried what was not scanned or reviewed, or gone where nothing was measured. The commit is still on its branch in the folder. For a base that moved, run the publication again on a fresh branch, so what the push would add is measured, scanned and reviewed against the base as it is now; for a push URL, the folder has to push where it fetches before publishing again. Where it says the push carries no scan receipt the executor issued, or one more than a day old — the executor restarted, or the approval waited that long — nothing was pushed either; run the publication again on a fresh branch, so the executor that pushes is the one that scanned. Where it says the push carries no check receipt, or one for checks the folder no longer declares, nothing was pushed: the folder's checks changed or were declared after this run checked its commit, and the publication runs again so they run as declared now. Where it says no approval of this push is on record, nothing was pushed: the operator's approval in this run is what lets a range the scan did not clear leave the machine, and any push at all from a folder whose push approval is `always`. Otherwise git's own message says why the remote refused the update.",
          type: 'operation' as const,
          operation: 'host.process.exec',
          // The scan and the check as well as the approval: under `never` over a cleared
          // range the approval is skipped, and a skip clears a dependency
          // where a failure does not.
          dependsOn: ['approve-push', 'scan-commit', 'check-commit'],
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
            check: { receipt: { $bind: 'checkReceipt' } },
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
          goal: "Ask GitHub, through the REST API, for the open pull request from the pushed branch into the base branch — a branch appended to may already have one, and GitHub refuses a second. That pull request now carries the push, and it is the run's result.",
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
          taskId: 'open-pr',
          name: 'Open the pull request',
          goal: 'Open a pull request from the pushed branch into the base branch through the GitHub REST API, where the branch has none open.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['find-pr'],
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
            title: { kind: 'run_input' as const, path: 'title' },
            summary: { kind: 'run_input' as const, path: 'summary' },
            // Read from the commit, whose message the scan read, so a body
            // taken from it has been scanned as the summary would have been.
            messageBody: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.body' },
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
                body: { $firstOf: [{ $bind: 'summary' }, { $bind: 'messageBody' }] },
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
      ],
      output: {
        primary: 'prUrl',
        guidance:
          'The run carries prUrl and prNumber once the branch has its pull request — opened by this run, or already open for a branch it appended to — and reporting the link is reporting the result. Absent, the branch was committed and not published: say it stayed on the machine to publish later — unless the run failed at the checks, whose failure names what to fix, or at the scan, where the commit holds what looks like a secret and must not be published.',
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
        "Run to publish a patch that already exists — a commission's, passed as its `patchRef`, or a small diff from the operator — onto a branch of a connected repository and into a pull request. The commit is local and reversible, and everything the push would add is scanned for secrets before it; the push waits for an approval unless the folder's push approval says it need not ask. The folder must allow pushes under a branch prefix.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "Ten tasks, the approval between local and published halves: the commit lands in a detached worktree; a decline costs nothing. host.commit.check runs the folder's checks on it: a failure fails the run. host.commit.scan reads all a push would add (from a fetched origin/<base>), commit headers, messages, PR text: a finding fails the run; an unread file or an allowed line asks, unreviewed, whatever the posture. Over a cleared range the posture, and under unless-unreviewed a Local Code Review, decide whether to ask; asked, it obeys. The push argv is pinned bar the refspec: no force, tag or submodule. The executor refuses a push without the scan's receipt for origin/<base>..commit, re-measured as git runs, or, with checks declared, the check's passed one, and lets an uncleared range (under always, any) through only on this run's approval grant. The repo is read via the space's GitHub binding first; an open PR is reported, not duplicated. The folder is a run input until folder roles land.",
  },
};

export { PUBLISH_LOCAL_CHANGES };
