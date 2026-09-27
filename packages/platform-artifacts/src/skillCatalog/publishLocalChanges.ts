import type { SkillCatalogEntry } from '@aflow/schemas';

/**
 * The push argv, pinned by the skill rather than bound as a whole. Only the
 * branch travels from the run; the verbs, the remote and the absence of a
 * force flag are the skill's, so no caller can turn a publish into an
 * overwrite.
 */
const PUSH_COMMAND = ['git', 'push', '--set-upstream', 'origin', { $bind: 'branch' }];

/** The operation's own ceiling for a unified diff. */
const PATCH_MAX_BYTES = 4_194_304;

const PUBLISH_LOCAL_CHANGES: SkillCatalogEntry = {
  catalogId: 'publish-local-changes',
  version: 2,
  name: 'Publish Local Changes',
  tagline:
    'Commit a patch onto a branch of a connected repository, then push it and open the pull request once the operator approves.',
  description: `Fits a request to publish work that already exists as a patch — the result of a commission, or a diff the operator hands over — onto a branch of a connected repository and into a pull request. The commit lands on a branch without touching the working tree, the run then waits for approval, and only after it does anything leave the machine.

**Not for a folder whose machine block shows no publish prefix.** Pushing is a posture the operator sets when the folder is connected; without it the push is refused. Say so, ask for the folder to be reconnected allowing pushes under a branch prefix, and stop there rather than committing work that cannot be published.

**What it needs**: the connected folder; the patch, which a commission's result carries; a branch name under the folder's publish prefix; the commit message; a title for the pull request; the repository owner and name, which the folder's \`origin\` remote gives — read it with the folder's shell when it is not already known; and the base branch the pull request targets. A summary is optional and becomes the body of both the commit and the pull request. Ask for whatever is missing instead of inventing it.

**Before approving**: the run waits at the approval, so the range can be read first — run Local Code Review over \`<base>..<branch>\` while this run waits, and approve or decline on what it finds.

**On an existing branch**: a fix that was commissioned from a branch (\`base: <branch>\` on the commission) is published onto that branch by naming it as \`branch\` and passing the commission's \`baseSha\` as \`baseSha\`; a branch is reused only that way, and a fresh change takes a fresh branch.

**With the result**: report the pull request link. Where approval was declined, report that the branch stayed on the machine and nothing was pushed — the commit is still there to publish later.`,
  tags: ['coding', 'publish', 'git', 'local', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description: 'GitHub REST API — open the pull request for the pushed branch.',
      requiredEndpoints: ['createPullRequest'],
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
        "Take a patch to a pull request on a repository connected as a host folder: the patch is committed in a detached worktree — onto a new branch at the folder's last commit, or appended to the branch it was made on — the operator approves, and the branch is then pushed and opened as a pull request. The operator's working tree is never touched.",
      goal: 'Turn a patch into a commit on a branch of a connected repository and, once the operator approves, a pushed branch and an open pull request — with nothing leaving the machine before the approval.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'change-published',
          name: 'Change published',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The patch was committed onto its branch of the connected repository without changing the working tree, and either the operator approved and the branch was pushed and opened as a pull request, or the operator declined and the branch stayed local.',
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
          id: 'patch',
          required: true,
          description:
            'The unified diff to publish, as a commission returns it or as the operator supplies it.',
          schema: { type: 'string', minLength: 1, maxLength: PATCH_MAX_BYTES },
        },
        {
          id: 'branch',
          required: true,
          description:
            "The branch the commit lands on — a branch under the folder's publish prefix, which the machine block shows. A new one is created at the folder's last commit; an existing one is appended to only with `baseSha`.",
          schema: { type: 'string', minLength: 1, maxLength: 200 },
        },
        {
          id: 'baseSha',
          required: false,
          description:
            "The commit the patch was made against, as the commission reported it in `baseSha`. Required to append to an existing branch, and it must be that branch's head; a patch made at the folder's last commit may omit it.",
          schema: { type: 'string', minLength: 1, maxLength: 200 },
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
            "The repository owner — the account or organisation in the folder's `origin` remote.",
          schema: { type: 'string', minLength: 1, maxLength: 200 },
        },
        {
          id: 'repo',
          required: true,
          description: "The repository name, from the folder's `origin` remote.",
          schema: { type: 'string', minLength: 1, maxLength: 200 },
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
          goal: "Apply the patch in a detached worktree and commit it — on a new branch at the connected folder's last commit, or on top of the existing branch it was made on. The operator's working tree is not touched, and nothing leaves the machine.",
          type: 'operation' as const,
          operation: 'host.file.patch',
          retryability: 'unsafe' as const,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
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
              patch: {
                kind: 'run_input' as const,
                bindAs: 'patch',
                path: 'patch',
                schema: { type: 'string', minLength: 1, maxLength: PATCH_MAX_BYTES },
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
                schema: { type: 'string', minLength: 1, maxLength: 200 },
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
                schema: { type: 'string', minLength: 1, maxLength: 200 },
              },
              repo: {
                kind: 'run_input' as const,
                bindAs: 'repo',
                path: 'repo',
                schema: { type: 'string', minLength: 1, maxLength: 200 },
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
            patch: { $bind: 'patch' },
            mode: 'clean',
            commit: {
              branch: { $bind: 'branch' },
              message: { $bind: 'commitMessage' },
              base: { $bind: 'baseSha' },
            },
          },
        },

        {
          taskId: 'approve-push',
          name: 'Approve the push',
          goal: 'Operator approval before anything leaves the machine. Approving pushes the committed branch to origin and opens the pull request; declining leaves the branch on the machine.',
          type: 'human' as const,
          intent: 'approve' as const,
          failureMode: 'isolate' as const,
          dependsOn: ['commit'],
          approves: ['commit'],
          when: {
            expression: "tasks.commit.output.state == 'applied'",
            onMissingRef: 'skip' as const,
          },
          pauseInstruction:
            'The change is committed on its branch in the connected folder and nothing has left the machine. Approving pushes that branch to `origin` and then opens a pull request against the base branch. The range can be read first — Local Code Review over `<base>..<branch>` — while this run waits. Declining leaves the branch local: nothing is pushed and no pull request is opened.',
          actionPreview: {
            op: 'host.process.exec',
            inputBindings: {
              bindingId: { kind: 'run_input' as const, path: 'bindingId' },
              branch: { kind: 'run_input' as const, path: 'branch' },
            },
          },
        },

        {
          taskId: 'push',
          name: 'Push the branch',
          goal: 'Push the committed branch to origin through the connected folder’s shell, with the argv pinned by the skill.',
          type: 'operation' as const,
          operation: 'host.process.exec',
          dependsOn: ['approve-push'],
          // Gating does not propagate from the approval, so the side-effecting
          // task carries it: a declined or skipped approval must not push.
          when: {
            expression: "tasks.approve-push.output.decision == 'approved'",
            onMissingRef: 'skip' as const,
          },
          retryability: 'unsafe' as const,
          maxAttempts: 1,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            branch: { kind: 'run_input' as const, path: 'branch' },
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
              'A patch is committed onto a branch of a repository connected as a host folder without changing the working tree, and after the operator approves, the branch is pushed and a pull request is open.',
          },
        ],
      },
      mode: 'process' as const,
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
        'Run to publish a patch that already exists — from a commission or from the operator — onto a branch of a connected repository and into a pull request. The commit is local and reversible; the push waits for an approval. The folder must allow pushes under a branch prefix.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "Four tasks with the approval between the local half and the published half: the commit lands in a detached worktree — at the folder's last commit for a new branch, at the branch's head for an append whose base is that head — so a declined approval costs nothing and leaves the operator's working tree as it was. The push argv is pinned by the skill with only the branch bound, so no caller can add a force flag; the branch prefix that decides what may be pushed is a posture on the connected folder, enforced where the command runs rather than named here. The pull request is the GitHub connector's own createPullRequest, which the operator binds once for the space. The folder arrives as a run input until folder roles land.",
  },
};

export { PUBLISH_LOCAL_CHANGES };
