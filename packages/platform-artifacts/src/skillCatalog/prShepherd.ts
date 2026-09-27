import type { SkillCatalogEntry } from '@aflow/schemas';

const REHYDRATE_PROMPT = `Read a pull request's LIVE state and prior learnings, then decide how to tend it toward merge or abandonment. This skill starts cold each invocation — there is no warm in-graph state from a prior pass — so rehydrate everything you need from the PR itself.

Inputs (in your task context):
- \`prNumber\` — the pull request to tend.
- \`owner\`, \`repo\` — the repository the PR lives in (resolved from the campaign's repo coordinate; path params for the GitHub read tools).

Tools (GitHub READ endpoints, granted to you):
- \`getPullRequest\` — the PR's state, head SHA, head branch (\`head.ref\`), mergeability, and body.
- \`listCheckRuns\` — the CI check-runs for the PR's head SHA.
- \`listPullRequestReviews\` — submitted formal reviews (approved / changes-requested).
- \`listReviewComments\` — inline review comments (anchored to diff lines).
- \`listIssueComments\` — the PR's conversation comments: the durable handoff comment (carrying \`attemptCount\`) and any approval posted as a comment rather than a formal review. Distinct from \`listReviewComments\`.

Steps:

1. **Read prior learnings.** Earlier runs of this skill (and the open-PR skill, via the PR's handoff comment) recorded repo facts and prior attempt outcomes. The handoff comment on the PR carries \`attemptCount\` and the last outcome — read it with \`listIssueComments\` to recover the cross-invocation retry budget. Skill learnings are injected into your context.
2. **Read the live PR state.** Fetch the PR, its check-runs, its reviews, its review comments, and its issue comments. Determine the CI state (passing / failing / pending), whether reviewers requested changes or approved — a formal review (\`listPullRequestReviews\`), or, when the reviewer is the same account that opened the PR, an approval posted as an issue comment — and the PR's head branch (\`head.ref\`) — the branch a fix is pushed to.
3. **Decide the action:**
   - CI **failing** OR a reviewer requested changes → \`fix\`. Write \`fixInstructions\` — a complete, standalone brief the coding harness will run against the EXISTING PR branch, incorporating the concrete failing checks and review comments so the harness knows exactly what to repair. Do not include credentials, remotes, or branch names — those are fixed by the repo designation.
   - CI **passing** AND approved → \`merge\`.
   - The retry budget (\`attemptCount\` from the handoff) is exhausted → \`abandon\`, with a \`reason\` explaining WHY it could not be made to pass (the dead end worth recording).
   - CI **pending** (checks still running) → \`wait\`.

Output:
{
  action: "fix" | "merge" | "abandon" | "wait",
  ciState: "passing" | "failing" | "pending",
  branch: string,               // the PR's head branch (head.ref) — where a fix is pushed
  attemptCount: integer,        // the budget read off the handoff (0 if none yet)
  fixInstructions?: string,     // present when action is "fix": the standalone harness brief
  reason: string                // why this action — for the operator and the learning ledger
}`;

const COMPOSE_HANDOFF_PROMPT = `Assemble the updated PR handoff block for this shepherding pass — the durable continuity record the NEXT invocation reads on rehydrate. Runs every pass regardless of the action taken.

Inputs (in your task context): the PR number, the branch, the rehydrate decision (action, ciState, attemptCount, reason), and the fix/merge/abandon outcome when present.

Produce a one-paragraph run summary and the updated handoff Markdown block. Begin the block (\`handoffBody\`) with the literal HTML comment marker \`<!-- phoenix-agent:handoff -->\` on its own line, then sections for the original request, the branch, the INCREMENTED \`attemptCount\`, the \`status\`, and the \`lastOutcome\` of this pass.

Do NOT author learnings — review and learning happen OUTSIDE this skill (a separate reviewer skill and the driver). This skill's job is to tend the PR and keep the handoff current.

Output:
{
  runSummary: string,      // one-paragraph summary of what happened this pass
  handoffBody: string      // the updated Markdown handoff block to post on the PR
}`;

const GITHUB_READ_INTEGRATION = {
  // capabilityId is the integration id. The STATIC readiness paths require this id
  // verbatim — install-time `deriveRequiredCapabilities` and run-start
  // `checkWorkflowCapabilityPreflight` both key on `grant.capabilityId` — and only
  // `github` ("a github connection is bound") is satisfiable by the operator's
  // designated connection. The SPECIFIC connection is resolved at dispatch from the
  // run's pinned connection via the `binding: { kind: 'connection' }` deferral; a
  // run with no pinned connection withholds the read tools (fail closed).
  capabilityId: 'github',
  binding: { kind: 'connection' as const },
  sourceKind: 'api' as const,
  integrationId: 'github',
  toolNames: [
    { toolName: 'getPullRequest' },
    { toolName: 'listCheckRuns' },
    { toolName: 'listPullRequestReviews' },
    { toolName: 'listReviewComments' },
    { toolName: 'listIssueComments' },
  ],
  allTools: false,
};

const PR_SHEPHERD: SkillCatalogEntry = {
  catalogId: 'pr-shepherd',
  version: 2,
  name: 'PR Shepherd',
  tagline:
    'Tend an open pull request toward merge or abandonment: read CI + reviews, fix, and merge.',
  description: `Triggered coding skill: given an open pull request, read its live CI and review state and tend it toward merge — or abandon it when it cannot be made to pass. One invocation runs describe → rehydrate → (fix → push) / (merge with HITL approval) / abandon → record learnings + update the PR handoff, and is re-triggerable (manual / scheduled / event-later) with no graph change.

**Campaign-per-repo**: the target repository is the campaign's engagement target — the operator-created repo designation (named by its \`repo\` coordinate, e.g. \`owner/repo\`) is the campaign config, fixed once and reused for every PR tended on that repo. The PR number is the per-run input; describe resolves the coordinate to owner/repo so the GitHub tasks need no hardcoded coordinates.

**Cold-start by design**: the skill holds no warm state between invocations. \`rehydrate\` reads the PR's live state via GitHub READ endpoints and the durable handoff comment (the original request, branch, and the cross-invocation \`attemptCount\` retry budget) the open-PR skill wrote.

**Approval-gated merge**: a human approves the merge before any merge happens; the full PR is visible to the reviewer. A fix is implemented by a managed coding harness against the EXISTING PR branch (the PR's commits are preserved and the push fast-forwards).

**Handoff continuity**: the updated handoff block (with the incremented \`attemptCount\` and last outcome) is re-posted onto the PR so the next invocation can continue. This skill tends the PR and stops — review and learning happen outside it; prior campaign learnings (authored externally) are still injected into rehydrate so it improves at tending this repo's PRs over time.

**Prerequisites**: a GitHub connector binding (a fine-grained PAT or GitHub App token with repo/PR/checks access) and an operator-created repo designation for the target repository, both configured after bundle install. The repo designation becomes the campaign config on the first run.`,
  tags: ['coding', 'github', 'pull-requests', 'ci', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description:
        'GitHub REST API — read the PR, its CI check-runs, reviews, and review comments; merge or close it; and post the updated handoff comment.',
      requiredEndpoints: [
        'getPullRequest',
        'listCheckRuns',
        'listPullRequestReviews',
        'listReviewComments',
        'mergePullRequest',
        'closePullRequest',
        'createIssueComment',
      ],
      authKind: 'bearer',
      setupNote:
        'Use the GitHub connection ensured when you designate the repo (a fine-grained personal access token or a GitHub App installation token with repository, pull-request, and checks access). The read/merge/comment calls resolve through that connection — no separate binding to name. Sent as Authorization: Bearer.',
    },
    {
      apiId: 'github',
      description:
        'An operator-created repo designation fixing the remote, default branch, allowed push-branch patterns, git credential, and named check profiles for the target repository. It is the campaign config (the engagement target) — fixed once and reused for every PR.',
      authKind: 'bearer',
      setupNote:
        'Create the repo designation (named by its owner/repo coordinate) for the target repository before the first run; it becomes the campaign config. It owns the remote and git credential; the skill checks out the EXISTING PR branch and pushes fixes to it (a fast-forward). The branch must match the designation’s allowed push-branch patterns and is never the default branch.',
    },
  ],
  bundle: {
    workflow: {
      slug: 'pr-shepherd',
      name: 'PR Shepherd',
      description:
        'Tend an open pull request toward merge or abandonment: describe → rehydrate (read CI + reviews + handoff) → fix (code.agent.run → push) / merge (HITL) / abandon → record learnings + update handoff. Re-triggerable per invocation.',
      goal: 'Given an open pull request, read its live CI and review state and tend it toward a human-approved merge — fixing CI/review failures via a coding harness on the existing PR branch within a persisted retry budget, or abandoning with a recorded reason — while carrying structured learnings the next run reads back.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'pr-tended',
          name: 'Pull request tended',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The PR was advanced toward merge: a CI/review failure was fixed and pushed to the PR branch, OR a human-approved merge landed, OR the PR was explicitly abandoned with a recorded reason — and the handoff comment was updated with the incremented attemptCount and last outcome.',
          },
        },
      ],
      runInputs: [
        {
          id: 'prNumber',
          required: true,
          description: 'The pull request to tend (its number on the bound repository).',
        },
      ],
      tasks: [
        {
          taskId: 'describe',
          name: 'Describe repo',
          goal: 'Resolve the campaign’s repo coordinate to its public parts (owner, repo, default branch) so the GitHub read/merge/comment tasks have the owner/repo they need — without hardcoding them or touching the git credential.',
          type: 'operation' as const,
          operation: 'code.repo.describe',
          retryability: 'safe' as const,
          inputBindings: {
            repo: { kind: 'campaign_input' as const, path: 'repo' },
          },
          // The entry task's contract is the skill's callable input surface: a run
          // input absent from it is refused at start, whatever runInputs declares.
          // Slots later tasks read are declared here for that reason.
          inputContract: {
            bindings: {
              prNumber: {
                kind: 'run_input' as const,
                bindAs: 'prNumber',
                path: 'prNumber',
                schema: { type: 'integer', minimum: 1 },
              },
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['code.repo.describe'],
              integrations: [],
            },
          },
        },

        {
          taskId: 'rehydrate',
          name: 'Rehydrate PR state',
          goal: REHYDRATE_PROMPT,
          type: 'agent' as const,
          dependsOn: ['describe'],
          inputBindings: {
            prNumber: { kind: 'run_input' as const, path: 'prNumber' },
            owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
            repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'active' as const,
            capabilities: {
              operations: ['api.http.call'],
              integrations: [GITHUB_READ_INTEGRATION],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['action', 'ciState', 'branch', 'attemptCount', 'reason'],
              additionalProperties: false,
              properties: {
                action: { type: 'string', enum: ['fix', 'merge', 'abandon', 'wait'] },
                ciState: { type: 'string', enum: ['passing', 'failing', 'pending'] },
                branch: { type: 'string', minLength: 1, maxLength: 200 },
                attemptCount: { type: 'integer', minimum: 0 },
                fixInstructions: { type: 'string', minLength: 1, maxLength: 8000 },
                reason: { type: 'string', minLength: 1, maxLength: 4000 },
              },
            },
          },
        },

        {
          taskId: 'implement-fix',
          name: 'Implement the fix',
          goal: 'Run the coding harness over a fresh checkout of the EXISTING PR branch, executing the rehydrate step’s fix instructions (the CI failures / review comments). Returns a binary-safe patch bundle (patchRef) carrying the new commit, which the push step fast-forwards onto the PR branch.',
          type: 'operation' as const,
          operation: 'code.agent.run',
          dependsOn: ['rehydrate'],
          // Gating does NOT propagate — each side-effecting task carries its own `when`,
          // or a non-fix decision still runs the harness.
          when: {
            expression: "tasks.rehydrate.output.action == 'fix'",
            onMissingRef: 'skip' as const,
          },
          // `safe`: a failed run left no observable external state — code.agent.run
          // produces a patch with no push authority (the separate, gated push op is
          // the side-effecting step), so a failed fix is `re_execute`-able in place
          // rather than a dead-end contract-violation pause.
          retryability: 'safe' as const,
          maxAttempts: 2,
          inputBindings: {
            repo: { kind: 'campaign_input' as const, path: 'repo' },
            branch: { kind: 'task_output' as const, taskId: 'rehydrate', path: 'branch' },
            instructions: {
              kind: 'task_output' as const,
              taskId: 'rehydrate',
              path: 'fixInstructions',
            },
            checkProfile: { kind: 'run_input' as const, path: 'checkProfile' },
          },
          inputTemplate: {
            repo: { $bind: 'repo' },
            branch: { $bind: 'branch' },
            task: { instructions: { $bind: 'instructions' } },
            backendProvider: 'zai',
            checkProfile: { $bind: 'checkProfile' },
          },
          // Accept a usable diff (succeeded) OR a clean no-op (no_change — the fix was
          // already present, nothing to commit). A genuine failure — a thrown backend
          // error (FAILED step) or an empty diff with a non-zero exit / timeout (an
          // output `failed` this contract rejects) — fires the re_execute bridge. The
          // push gates on `status == 'succeeded'`, so no_change cleanly skips the push.
          outputContract: {
            schema: {
              type: 'object',
              required: ['status'],
              additionalProperties: true,
              properties: {
                status: { enum: ['succeeded', 'no_change'] },
              },
            },
          },
        },

        {
          taskId: 'push',
          name: 'Push the fix',
          goal: 'Push the implement-fix step’s patch bundle to the existing PR branch verbatim (remoteSha === headSha) — a fast-forward that adds the fix commit to the PR.',
          type: 'operation' as const,
          operation: 'code.repo.push',
          dependsOn: ['implement-fix'],
          // Push only when the fix produced a patch; on no_change (nothing to commit)
          // this deterministically skips.
          when: {
            allOf: [
              "tasks.rehydrate.output.action == 'fix'",
              "tasks.implement-fix.output.status == 'succeeded'",
            ],
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          inputBindings: {
            repo: { kind: 'campaign_input' as const, path: 'repo' },
            branch: { kind: 'task_output' as const, taskId: 'rehydrate', path: 'branch' },
            patchRef: { kind: 'task_output' as const, taskId: 'implement-fix', path: 'patchRef' },
          },
          inputTemplate: {
            repo: { $bind: 'repo' },
            branch: { $bind: 'branch' },
            patchRef: { $bind: 'patchRef' },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['pushed', 'remoteSha'],
              additionalProperties: true,
              properties: {
                pushed: { type: 'boolean' },
                remoteSha: { type: 'string', minLength: 1 },
              },
            },
          },
        },

        {
          taskId: 'merge-approve',
          name: 'Approve the merge',
          goal: 'Final operator approval before the pull request is merged. The full PR (diff, CI state, reviews) is visible to the reviewer. Approving merges the PR; rejecting leaves it open for a later pass.',
          type: 'human' as const,
          intent: 'approve' as const,
          failureMode: 'isolate' as const,
          dependsOn: ['rehydrate'],
          approves: ['rehydrate'],
          when: {
            expression: "tasks.rehydrate.output.action == 'merge'",
            onMissingRef: 'skip' as const,
          },
          pauseInstruction:
            'CI is passing and the PR is approved. Review the pull request below and approve to merge it, or reject to leave it open for a later pass.',
          actionPreview: {
            op: 'api.http.call',
            inputBindings: {
              prNumber: { kind: 'run_input' as const, path: 'prNumber' },
              owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
              repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
            },
          },
        },

        {
          taskId: 'merge',
          name: 'Merge pull request',
          goal: 'Merge the approved pull request into the default branch via the GitHub REST API.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['merge-approve'],
          // Gated on the approval decision (gating does NOT propagate): a rejected or
          // skipped approval must not merge.
          when: {
            expression: "tasks.merge-approve.output.decision == 'approved'",
            onMissingRef: 'skip' as const,
          },
          retryability: 'unsafe' as const,
          maxAttempts: 2,
          inputBindings: {
            owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
            repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
            prNumber: { kind: 'run_input' as const, path: 'prNumber' },
            githubConnection: { kind: 'connection_binding' as const },
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
            endpointId: 'mergePullRequest',
            bindingId: { $bind: 'githubConnection' },
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
              pull_number: { $bind: 'prNumber' },
              body: {
                merge_method: 'squash',
              },
            },
            response: { format: 'json' },
          },
          outputProjection: {
            merged: { path: 'data.merged', onMissing: 'error' as const },
            mergeSha: { path: 'data.sha', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['merged', 'mergeSha'],
              additionalProperties: false,
              properties: {
                merged: { type: 'boolean' },
                mergeSha: { type: 'string', minLength: 1 },
              },
            },
          },
        },

        {
          taskId: 'abandon',
          name: 'Abandon pull request',
          goal: 'Close the pull request without merging when the retry budget is exhausted or it cannot be made to pass. The why-it-failed reason is recorded by the learning tasks so the ledger captures dead ends, not only successes.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['rehydrate'],
          when: {
            expression: "tasks.rehydrate.output.action == 'abandon'",
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          inputBindings: {
            owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
            repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
            prNumber: { kind: 'run_input' as const, path: 'prNumber' },
            githubConnection: { kind: 'connection_binding' as const },
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
            endpointId: 'closePullRequest',
            bindingId: { $bind: 'githubConnection' },
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
              pull_number: { $bind: 'prNumber' },
              body: {
                state: 'closed',
              },
            },
            response: { format: 'json' },
          },
        },

        // Runs every pass (ungated): the handoff is kept current regardless of the
        // fix/merge/abandon outcome. This skill tends the PR and STOPS — review and
        // learning happen outside it (Plan 221).
        {
          taskId: 'compose-handoff',
          name: 'Compose Handoff',
          goal: COMPOSE_HANDOFF_PROMPT,
          type: 'agent' as const,
          dependsOn: ['rehydrate'],
          inputBindings: {
            prNumber: { kind: 'run_input' as const, path: 'prNumber' },
            branch: { kind: 'task_output' as const, taskId: 'rehydrate', path: 'branch' },
            action: { kind: 'task_output' as const, taskId: 'rehydrate', path: 'action' },
            ciState: { kind: 'task_output' as const, taskId: 'rehydrate', path: 'ciState' },
            attemptCount: {
              kind: 'task_output' as const,
              taskId: 'rehydrate',
              path: 'attemptCount',
            },
            reason: { kind: 'task_output' as const, taskId: 'rehydrate', path: 'reason' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: [],
              integrations: [],
            },
          },
          // `additionalProperties: false` with only handoff fields structurally
          // forbids the agent from authoring learnings here.
          outputContract: {
            schema: {
              type: 'object',
              required: ['runSummary', 'handoffBody'],
              additionalProperties: false,
              properties: {
                runSummary: { type: 'string', maxLength: 2000 },
                handoffBody: { type: 'string', minLength: 1, maxLength: 8000 },
              },
            },
          },
        },

        {
          taskId: 'update-handoff',
          name: 'Update handoff comment',
          goal: 'Re-post the updated handoff block as a comment on the PR (the original request, branch, INCREMENTED attemptCount, status, last outcome) — the continuity record the next invocation reads on rehydrate.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['rehydrate', 'compose-handoff'],
          retryability: 'safe' as const,
          inputBindings: {
            owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
            repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
            prNumber: { kind: 'run_input' as const, path: 'prNumber' },
            handoffBody: {
              kind: 'task_output' as const,
              taskId: 'compose-handoff',
              path: 'handoffBody',
            },
            githubConnection: { kind: 'connection_binding' as const },
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
            endpointId: 'createIssueComment',
            bindingId: { $bind: 'githubConnection' },
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
              issue_number: { $bind: 'prNumber' },
              body: {
                body: { $bind: 'handoffBody' },
              },
            },
            response: { format: 'json' },
          },
        },
      ],
      // No run-scoped state variables: cross-invocation continuity lives on the PR
      // (the handoff comment), not in run state. Per-task outputs carry within a run.
      stateVariables: [],
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'pr-shepherd',
      name: 'PR Shepherd',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'pr-tended',
            description:
              'An open pull request is read for live CI + review state and tended one pass toward merge — a fix pushed to the PR branch, a human-approved merge, or an explicit abandonment with a recorded reason — with the handoff comment updated for the next invocation.',
          },
        ],
      },
      campaign: {
        fields: {
          repo: {
            schema: { type: 'string', minLength: 1 },
            // The repo coordinate IS the campaign identity — a different repo is a
            // different campaign (one per repo), and the engagement target is fixed
            // for the campaign's life (immutable). Mirrors Kaggle's competitionSlug.
            identity: true,
            label: 'Repo',
            description: 'Repo coordinate (owner/repo) of the engagement target.',
          },
        },
      },
      mode: 'process' as const,
    },
    activation: {
      triggerPatterns: [
        'tend this pr',
        'shepherd this pull request',
        'fix the ci on this pr',
        'get this pr merged',
        'resolve the review comments and merge',
        'check on pull request',
      ],
      activationHint:
        'Run to tend an open pull request toward merge: rehydrate its live CI + review state and the handoff comment, fix CI/review failures with a coding harness on the existing PR branch, and merge on a human approval — or abandon with a recorded reason. The target repo (its coordinate) is the campaign config; the PR number is the per-run input. Re-triggerable per invocation (manual / scheduled / event-later).',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'Plan 178 Skill B — the triggered PR-shepherd coding skill, on campaigns. The repo coordinate (repo) is the campaign config (the engagement target); the PR number is the per-run input. describe (code.repo.describe) is the root, resolving the coordinate to owner/repo/defaultBranch so no GitHub coordinate is hardcoded → rehydrate reads the PR’s live CI + review state and head branch via GitHub READ tools and the handoff comment (recovering the attemptCount budget) → it decides fix / merge / abandon / wait. implement-fix (code.agent.run, opTaskOnly) on the EXISTING PR branch + push (code.repo.push) fast-forward the fix; both gate on action == fix. merge-approve is an HITL gate over mergePullRequest; abandon closes the PR on action == abandon. compose-handoff runs every pass and update-handoff re-posts the incremented handoff; review and learning happen OUTSIDE this skill (Plan 221). Every side-effecting task carries its own `when` — gating does not propagate.',
  },
};

export { PR_SHEPHERD };
