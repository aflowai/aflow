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
 * reviewed, never what the branch holds by then. The verbs, the remote and the
 * absence of a force flag are the skill's, so no caller can turn a publish into
 * an overwrite.
 */
const PUSH_COMMAND = ['git', 'push', 'origin', { $bind: 'refspec' }];

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

const PUBLISH_LOCAL_CHANGES: SkillCatalogEntry = {
  catalogId: 'publish-local-changes',
  version: 9,
  name: 'Publish Local Changes',
  tagline:
    'Commit a patch onto a branch of a connected repository, then push it and open the pull request — asking the operator first unless the folder says otherwise.',
  description: `Fits a request to publish work that already exists as a patch — the result of a commission, or a diff the operator hands over — onto a branch of a connected repository and into a pull request. The commit lands on a branch without touching the working tree, and nothing leaves the machine until the push is cleared.

**Not for a folder whose machine block shows no publish prefix.** Pushing is a posture the operator sets when the folder is connected; without it the push is refused. Say so, ask for the folder to be reconnected allowing pushes under a branch prefix, and stop there rather than committing work that cannot be published.

**What it needs**: the connected folder; the change — for a commission's work, the \`patchRef\` its result reports, passed as \`patchRef\`, or for a diff the operator hands over, that text as \`patch\`, one or the other; a branch name under the folder's publish prefix; the commit message; a title for the pull request; the repository owner and name, which the folder's \`origin\` remote gives — read it with the folder's shell when it is not already known; and the base branch the pull request targets. A summary is optional and becomes the body of both the commit and the pull request. Ask for whatever is missing instead of inventing it.

**Never pass a commission's \`patch\` text.** It is a copy for reading, cut short on a large change, and the run's inputs are capped at ${String(RUN_INPUTS_KB)} KB together. \`patchRef\` names the whole diff at any size.

**When it asks before pushing**: the folder's push approval decides, and the machine block shows it as \`pushApproval\`. \`always\`: the run waits for the operator's approval before every push. \`never\`: it pushes without asking. \`unless-unreviewed\`: the run starts a Local Code Review of the commit it made, waits for it, and pushes without asking only when it returns \`approve\` — on any other verdict, or a review that did not finish or could not start, it waits for the operator. The review is the catalog's Local Code Review as the Store installed it in the space; an edited copy is refused, and the run asks. A folder connected without naming one is \`${HOST_PUSH_APPROVAL_DEFAULT}\`, which stays the default until a publication scans its commit for secrets before the push, and \`unless-unreviewed\` becomes the default with that scan. Either way the run needs no review started beside it.

**On an existing branch**: a fix that was commissioned from a branch (\`base: <branch>\` on the commission) is published onto that branch by naming it as \`branch\` and passing the commission's \`baseSha\` as \`baseSha\`; a branch is reused only that way, and a fresh change takes a fresh branch.

**With the result**: report the pull request link, and whether the push was approved by the operator or cleared by the folder's push approval — and, where the run reviewed its commit, the verdict. Where approval was declined, report that the branch stayed on the machine and nothing was pushed — the commit is still there to publish later. Where the push failed, git's own message says why: a branch on \`origin\` that moved on is not overwritten.`,
  tags: ['coding', 'publish', 'git', 'local', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description:
        'GitHub REST API — read the repository before the push, and open the pull request for the pushed branch.',
      requiredEndpoints: ['getRepository', 'createPullRequest'],
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
        "Take a patch to a pull request on a repository connected as a host folder: the patch is committed in a detached worktree — onto a new branch at the commit the patch was made against, or appended to the branch it was made on — the push is cleared, by the operator's approval or by the folder's push approval, and the branch is then pushed and opened as a pull request. The operator's working tree is never touched.",
      goal: "Turn a patch into a commit on a branch of a connected repository and, once the push is cleared, a pushed branch and an open pull request — with nothing leaving the machine before the operator approves, unless the folder's push approval says it need not ask.",
      mode: 'process' as const,
      outcomes: [
        {
          id: 'change-published',
          name: 'Change published',
          evaluator: {
            type: 'manual' as const,
            instruction:
              "The patch was committed onto its branch of the connected repository without changing the working tree, and either the push was cleared — by the operator's approval, or by the folder's push approval without asking — and the branch was pushed and opened as a pull request, or the operator declined and the branch stayed local.",
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
            "The change a commission made: the `patchRef` its result reports, passed on as it is. It names the whole diff whatever its size. Give this or `patch`, never both — a commission's change always goes this way.",
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
          id: 'commitMessage',
          required: true,
          // The template substitutes whole nodes and cannot concatenate, so
          // the message the commit carries arrives already composed rather
          // than being assembled from the title and the summary here.
          description:
            'The commit message: the title, and where a summary is given, a blank line and the summary after it.',
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
            'What the change does and why, for whoever reviews it. Becomes the body of the pull request. Omit it and the pull request carries no body.',
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
          goal: "Apply the patch in a detached worktree and commit it — on a new branch at the commit the patch was made against (the connected folder's last commit when none is given), or on top of the existing branch it was made on. The operator's working tree is not touched, and nothing leaves the machine.",
          type: 'operation' as const,
          operation: 'host.file.patch',
          retryability: 'unsafe' as const,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            patchRef: { kind: 'run_input' as const, path: 'patchRef' },
            patch: { kind: 'run_input' as const, path: 'patch' },
            branch: { kind: 'run_input' as const, path: 'branch' },
            baseSha: { kind: 'run_input' as const, path: 'baseSha' },
            commitMessage: { kind: 'run_input' as const, path: 'commitMessage' },
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
            },
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
          goal: 'Read, from the machine holding the connected folder, when a publication from it asks the operator before pushing.',
          type: 'operation' as const,
          operation: 'host.binding.inspect',
          dependsOn: ['commit'],
          when: {
            expression: "tasks.commit.output.state == 'applied'",
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
          goal: 'Run a Local Code Review of exactly the commit this run made, as a run of its own, and wait for it to finish with its verdict.',
          type: 'operation' as const,
          operation: 'workflow.run.start',
          dependsOn: ['read-push-approval'],
          // Only the posture that depends on a review starts one, so a verdict
          // here always belongs to a run whose approval it decides.
          when: {
            expression: `tasks.read-push-approval.output.branchPolicy.pushApproval == '${REVIEW_GATED_POSTURE}'`,
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
            range: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.range' },
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
          goal: "Operator approval before anything leaves the machine, asked when the folder asks before every push, or when it asks unless reviewed and this run's review of its commit did not approve it. Approving pushes that commit to its branch on origin and opens the pull request; declining leaves the branch on the machine.",
          type: 'human' as const,
          intent: 'approve' as const,
          failureMode: 'isolate' as const,
          dependsOn: ['read-repository', 'review-commit'],
          approves: ['commit'],
          // A review task that failed has no output to compare, so its status
          // carries the same answer as a null verdict.
          when: {
            anyOf: [
              "tasks.read-push-approval.output.branchPolicy.pushApproval == 'always'",
              "tasks.review-commit.output.verdict != 'approve'",
              "tasks.review-commit.status == 'failed'",
            ],
            onMissingRef: 'skip' as const,
          },
          // The prompt is fixed text and the verdict is not a value it can
          // carry, so each case is one line and the verdict is named where the
          // run shows it.
          pauseInstruction:
            'The change is committed on its branch in the connected folder and nothing has left the machine. Asked because of the folder\'s push approval, shown with the commit:\n- `always`: it asks before every push, and no review ran.\n- `unless-unreviewed`: this run\'s Local Code Review of the commit did not return `approve` — its verdict is on the "Review the commit" task, null where the review did not finish, and that task failed where the review could not start.\nApproving pushes exactly that commit to its branch on `origin` and then opens a pull request against the base branch. Declining leaves the branch local: nothing is pushed and no pull request is opened.',
          actionPreview: {
            op: 'host.process.exec',
            inputBindings: {
              bindingId: { kind: 'run_input' as const, path: 'bindingId' },
              branch: { kind: 'run_input' as const, path: 'branch' },
              pushApproval: {
                kind: 'task_output' as const,
                taskId: 'read-push-approval',
                path: 'branchPolicy.pushApproval',
              },
              commitSha: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.sha' },
              pushRefspec: {
                kind: 'task_output' as const,
                taskId: 'commit',
                path: 'commit.pushRefspec',
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
          goal: 'Push the commit this run made to its branch on origin through the connected folder’s shell, with the argv pinned by the skill. A remote that refuses the update fails the push with git’s own message.',
          type: 'operation' as const,
          operation: 'host.process.exec',
          dependsOn: ['approve-push'],
          // Gating does not propagate from the approval, so the side-effecting
          // task carries it. Each line is one way the push is cleared — the
          // operator approved, the folder never asks, or this run's review of
          // its commit approved it — and none of them holds after a decline,
          // or when nothing was committed.
          when: {
            anyOf: [
              "tasks.approve-push.output.decision == 'approved'",
              "tasks.read-push-approval.output.branchPolicy.pushApproval == 'never'",
              "tasks.review-commit.output.verdict == 'approve'",
            ],
            onMissingRef: 'skip' as const,
          },
          retryability: 'unsafe' as const,
          maxAttempts: 1,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            refspec: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.pushRefspec' },
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
            cwd: '.',
            timeoutMs: 600_000,
          },
        },

        {
          taskId: 'open-pr',
          name: 'Open the pull request',
          goal: 'Open a pull request from the pushed branch into the base branch through the GitHub REST API.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['push'],
          when: {
            expression: 'tasks.push.output.exitCode == 0',
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
                body: { $bind: 'summary' },
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
          description: 'The opened pull request, as a person opens it.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'prNumber',
          name: 'Pull request number',
          description: 'The number of the opened pull request on the repository.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      output: {
        primary: 'prUrl',
        guidance:
          'The run carries prUrl and prNumber once the pull request is open — reporting the link is reporting the result. Where they are absent the branch was committed and not published: say that the branch stayed on the machine, and that the commit is still there to publish later.',
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
              "A patch is committed onto a branch of a repository connected as a host folder without changing the working tree, and once the push is cleared — by the operator, or by the folder's push approval — the branch is pushed and a pull request is open.",
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
        "Run to publish a patch that already exists — a commission's, passed as its `patchRef`, or a small diff from the operator — onto a branch of a connected repository and into a pull request. The commit is local and reversible; the push waits for an approval unless the folder's push approval says it need not ask. The folder must allow pushes under a branch prefix.",
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "Seven tasks, the approval between the local half and the published half: the commit lands in a detached worktree, so a decline costs nothing. The push argv is pinned with only the commit's refspec bound — its sha onto its branch — so no force flag can be added and nothing the branch gained later is sent; the prefix is enforced where the command runs. Whether the approval is asked is the folder's posture, read with host.binding.inspect, and under unless-unreviewed the verdict of a Local Code Review this run starts over its own commit and waits on, since no review of a commit can exist before the run makes it — data the when predicates read, so the push follows the approval or its skip and never a decline. The repository is read through the space's GitHub binding before the approval; the folder arrives as a run input until folder roles land.",
  },
};

export { PUBLISH_LOCAL_CHANGES };
