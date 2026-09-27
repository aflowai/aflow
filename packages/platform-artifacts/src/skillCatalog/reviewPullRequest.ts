import type { SkillCatalogEntry } from '@aflow/schemas';

/** Post the review verdict as a formal PR review. The verdict gates which literal */
/** `event` runs (deterministic branch), so no inline transform is needed. */
function postReviewTask(args: {
  taskId: string;
  name: string;
  verdict: 'approve' | 'request_changes';
  event: 'APPROVE' | 'REQUEST_CHANGES';
}) {
  return {
    taskId: args.taskId,
    name: args.name,
    goal: `Post the review verdict to the pull request as a formal ${args.event} review (body = the review). The verdict lands in the repo system — the durable, human-visible record the fix cycle reads.`,
    type: 'operation' as const,
    operation: 'api.http.call',
    dependsOn: ['review', 'describe'],
    // Gated on the verdict (gating does NOT propagate): exactly one of the two
    // post tasks runs; the other deterministically skips.
    when: {
      expression: `tasks.review.output.verdict == '${args.verdict}'`,
      onMissingRef: 'skip' as const,
    },
    retryability: 'safe' as const,
    inputBindings: {
      owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
      repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
      prNumber: { kind: 'run_input' as const, path: 'prNumber' },
      reviewBody: { kind: 'task_output' as const, taskId: 'review', path: 'reviewBody' },
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
      endpointId: 'createReview',
      bindingId: { $bind: 'githubConnection' },
      params: {
        owner: { $bind: 'owner' },
        repo: { $bind: 'repo' },
        pull_number: { $bind: 'prNumber' },
        body: {
          event: args.event,
          body: { $bind: 'reviewBody' },
        },
      },
      response: { format: 'json' },
    },
  };
}

const REVIEW_PULL_REQUEST: SkillCatalogEntry = {
  catalogId: 'review-pull-request',
  version: 2,
  name: 'Review Pull Request',
  tagline: 'Deep-review an open pull request over a real checkout and post the verdict.',
  description: `Triggered review skill: given an open pull request, run a coding harness over a real checkout of its head branch and return a structured adversarial verdict — posted on the PR as a formal review (APPROVE / REQUEST_CHANGES), or as a regular PR comment when the reviewing identity can't submit a formal review (e.g. its own PR). One invocation runs describe → resolve-pr → review → post, and is re-triggerable per pass (the review→fix loop runs it again after each fix).

**Deep, not diff-only**: the review runs over a real clone (\`code.agent.review\`), so it sees the whole repo — it can trace callers and, at \`depth: deep\`, run the project's checks — beyond what a diff-only API review can judge. The lane has no GitHub authority, so it produces the verdict; a separate mesh step posts it.

**One half of the implement ↔ review loop**: this skill REVIEWS; the implement skill (the coding harness) FIXES. The driver alternates them toward passing. This skill never edits code, never merges, never pushes — its only write is the PR review. PR-shepherd (merge-tending) is a different, separate skill.

**Calibrated, token-conscious**: the driver picks the \`lens\` (breadth — a README needs no security review) and the \`depth\` (standard read vs run-the-checks) per the change, and bounds how many review→fix cycles to run.

**Campaign-per-repo**: the target repository is the campaign's engagement target — the operator-created repo designation (named by its \`repo\` coordinate, e.g. \`owner/repo\`) is the campaign config. The PR number, lens, and depth are the per-run inputs.

**Prerequisites**: a GitHub connector binding (read + PR-review write) and an operator-created repo designation for the target repository, both configured after bundle install.`,
  tags: ['coding', 'github', 'pull-requests', 'review', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description:
        'GitHub REST API — read the PR (head/base branch + title) and post the structured verdict as a formal PR review (APPROVE / REQUEST_CHANGES).',
      requiredEndpoints: ['getPullRequest', 'createReview'],
      authKind: 'bearer',
      setupNote:
        'Use the GitHub connection ensured when you designate the repo (a fine-grained personal access token or a GitHub App installation token with repository + pull-request read AND pull-request-review write access). The PR read + review-post calls resolve through that connection — no separate binding to name. Sent as Authorization: Bearer.',
    },
    {
      apiId: 'github',
      description:
        'An operator-created repo designation fixing the target repository. It is the campaign config (the engagement target) — the reviewer clones it read-only to review the head branch.',
      authKind: 'bearer',
      setupNote:
        'Create the repo designation (named by its owner/repo coordinate) for the target repository before the first run; it becomes the campaign config. The reviewer clones read-only — it never pushes or edits.',
    },
  ],
  bundle: {
    workflow: {
      slug: 'review-pull-request',
      name: 'Review Pull Request',
      description:
        'Deep-review an open pull request through a scoped lens at a chosen depth: describe → resolve-pr (head/base/intent) → review (run the harness read-only over the head branch → verdict) → post the verdict as a formal PR review. Re-triggerable per review→fix cycle.',
      goal: 'Given an open pull request, return a structured adversarial verdict through the requested lens at the requested depth — request_changes on any blocker/major issue, else approve — and post it as a formal PR review for the fixer (the implement skill) to act on.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'pr-reviewed',
          name: 'Pull request reviewed',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'The PR head branch was reviewed over a real checkout through the requested lens at the requested depth, a verdict (approve / request_changes) with any issues was produced, and it was posted as a formal PR review.',
          },
        },
      ],
      runInputs: [
        {
          id: 'prNumber',
          required: true,
          description: 'The pull request to review (its number on the bound repository).',
        },
        {
          id: 'lens',
          required: false,
          description:
            'The review scope (default "correctness"): e.g. correctness, security, performance, style. The driver picks it per the change.',
        },
        {
          id: 'depth',
          required: false,
          description:
            'Review depth: "standard" (read with full repo context, default) or "deep" (also run the project\'s checks/tests).',
        },
      ],
      tasks: [
        {
          taskId: 'describe',
          name: 'Describe repo',
          goal: 'Resolve the campaign’s repo coordinate to its public parts (owner, repo) so the GitHub tasks have the owner/repo they need — without hardcoding them or touching the git credential.',
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
              lens: {
                kind: 'run_input' as const,
                bindAs: 'lens',
                path: 'lens',
                schema: { type: 'string', minLength: 1, maxLength: 200 },
              },
              depth: {
                kind: 'run_input' as const,
                bindAs: 'depth',
                path: 'depth',
                schema: { type: 'string', enum: ['standard', 'deep'] },
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
          taskId: 'resolve-pr',
          name: 'Resolve the pull request',
          goal: 'Fetch the open pull request to resolve its head branch (what the reviewer checks out), its base branch (what the change is diffed against), and its title (the change’s intent) — without hardcoding any of them.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['describe'],
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
            endpointId: 'getPullRequest',
            bindingId: { $bind: 'githubConnection' },
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
              pull_number: { $bind: 'prNumber' },
            },
            response: { format: 'json' },
          },
          outputProjection: {
            branch: { path: 'data.head.ref', onMissing: 'error' as const },
            base: { path: 'data.base.ref', onMissing: 'error' as const },
            intent: { path: 'data.title', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['branch', 'base', 'intent'],
              additionalProperties: false,
              properties: {
                branch: { type: 'string', minLength: 1 },
                base: { type: 'string', minLength: 1 },
                intent: { type: 'string', minLength: 1 },
              },
            },
          },
        },

        {
          taskId: 'review',
          name: 'Review the change',
          goal: 'Run the coding harness over a real checkout of the PR’s head branch and return a structured verdict (approve / request_changes) with issues and a postable review body — read-only: no edits, no commit, no push.',
          type: 'operation' as const,
          operation: 'code.agent.review',
          dependsOn: ['resolve-pr'],
          retryability: 'safe' as const,
          inputBindings: {
            repo: { kind: 'campaign_input' as const, path: 'repo' },
            branch: { kind: 'task_output' as const, taskId: 'resolve-pr', path: 'branch' },
            baseBranch: { kind: 'task_output' as const, taskId: 'resolve-pr', path: 'base' },
            intent: { kind: 'task_output' as const, taskId: 'resolve-pr', path: 'intent' },
            lens: { kind: 'run_input' as const, path: 'lens' },
            depth: { kind: 'run_input' as const, path: 'depth' },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'none' as const,
            capabilities: {
              operations: ['code.agent.review'],
              integrations: [],
            },
          },
          inputTemplate: {
            repo: { $bind: 'repo' },
            branch: { $bind: 'branch' },
            baseBranch: { $bind: 'baseBranch' },
            review: {
              instructions: { $bind: 'intent' },
              lens: { $bind: 'lens' },
            },
            depth: { $bind: 'depth' },
            backendProvider: 'zai',
          },
          // The verdict is the loop signal and reviewBody is the human-readable
          // outcome — promote BOTH so the driver branches AND the operator/Helmsman
          // see what was found on the run result, without drilling into task outputs.
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'verdict', toState: 'verdict' },
            { kind: 'output_path' as const, path: 'reviewBody', toState: 'reviewSummary' },
          ],
        },

        postReviewTask({
          taskId: 'post-approve',
          name: 'Approve the pull request',
          verdict: 'approve',
          event: 'APPROVE',
        }),
        postReviewTask({
          taskId: 'post-request-changes',
          name: 'Request changes on the pull request',
          verdict: 'request_changes',
          event: 'REQUEST_CHANGES',
        }),

        {
          taskId: 'comment-fallback',
          name: 'Post the review as a PR comment',
          goal: 'Fallback: when the formal review could not be submitted, post the review body as a regular PR comment so the review is still visible on the PR. The driver reads the verdict from the run output, so the loop signal is unaffected either way.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['review', 'post-approve', 'post-request-changes'],
          // Fires ONLY when the formal review that ran returned a non-2xx. api.http.call
          // surfaces a 4xx as a SUCCEEDED step (the error rides in the response body),
          // so the formal post can silently not-land — most often a 422 from GitHub
          // refusing a formal APPROVE/REQUEST_CHANGES on a PR the same identity opened.
          // anyOf short-circuits on the first TRUE before the missing-ref check, so the
          // one post task that deterministically skipped (the other verdict) is a non-issue.
          when: {
            anyOf: [
              'tasks.post-approve.output.statusCode >= 400',
              'tasks.post-request-changes.output.statusCode >= 400',
            ],
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          inputBindings: {
            owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
            repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
            prNumber: { kind: 'run_input' as const, path: 'prNumber' },
            reviewBody: { kind: 'task_output' as const, taskId: 'review', path: 'reviewBody' },
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
                body: { $bind: 'reviewBody' },
              },
            },
            response: { format: 'json' },
          },
        },
      ],
      stateVariables: [
        {
          variableId: 'verdict',
          name: 'Review verdict',
          description: 'The reviewer’s call: approve | request_changes.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'reviewSummary',
          name: 'Review summary',
          description: 'The reviewer’s narrative — what was found and what to change.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      // The deliverable is the verdict (the loop signal) + the summary (what was
      // found) — surface both so the driver branches AND the operator reads the
      // outcome without re-querying. The review is posted on the PR: a formal review
      // where the identity can submit one, else a PR comment (the fallback task).
      output: {
        primary: 'verdict',
        guidance:
          'The output carries the review verdict (approve | request_changes) and reviewSummary (what was found — report this to the operator). The review is also posted on the PR: a formal review where the reviewing identity can submit one, or a regular PR comment when it cannot (e.g. the same identity opened the PR). On request_changes, drive a fix — re-run open-pr-from-request in fix mode with the review feedback, then re-review. On approve, the change is ready.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'review-pull-request',
      name: 'Review Pull Request',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'pr-reviewed',
            description:
              'An open pull request is reviewed over a real checkout through the requested lens at the requested depth, a structured verdict (approve / request_changes with any issues) is produced, and it is posted on the PR (a formal review, or a comment when a formal review is not possible).',
          },
        ],
      },
      campaign: {
        fields: {
          repo: {
            schema: { type: 'string', minLength: 1 },
            // The repo coordinate IS the campaign identity — a different repo is a
            // different campaign (one per repo). Mirrors pr-shepherd + open-pr.
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
        'review this pr',
        'review this pull request',
        'adversarial review of the pr',
        'critique this pull request',
        'security review of the pr',
        'check this pr for bugs',
      ],
      activationHint:
        'Run to deep-review an open pull request over a real checkout through a scoped lens (correctness / security / performance / style) at a chosen depth, and post the verdict as a formal PR review. The reviewing half of the implement ↔ review loop — the implement skill fixes; this skill never edits, merges, or pushes. The target repo (its coordinate) is the campaign config; the PR number + lens + depth are the per-run inputs.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'Plan 221 P4 — the reviewing half of the implement ↔ review bounded loop, on campaigns, now deep (clone-based). The repo coordinate (repo) is the campaign config; the PR number + lens + depth are the per-run inputs the driver calibrates per change. describe (code.repo.describe) resolves owner/repo → resolve-pr (api.http.call getPullRequest) resolves the head/base branch + title (intent) → review (code.agent.review) runs the harness read-only over a real checkout of the head branch and returns a structured verdict → the verdict deterministically gates post-approve / post-request-changes (api.http.call createReview), posting a formal PR review as the reviewer→fixer interface. The lane has no GitHub authority, so the harness produces the verdict and the mesh posts it. The fixer is the implement skill (the coding harness), NOT this skill and NOT pr-shepherd. Helmsman is one driver of the loop, not a coupling.',
  },
};

export { REVIEW_PULL_REQUEST };
