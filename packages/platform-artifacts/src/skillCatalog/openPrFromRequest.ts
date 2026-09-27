import type { SkillCatalogEntry } from '@aflow/schemas';

const DISCOVER_PROMPT = `Frame a coding task for the harness, decide the MODE, and propose the working branch and PR title. Work from the request and any prior learnings from earlier runs; the deep repo work — reading files, or a plan/doc the request points at — happens inside the harness during \`implement\`. When the request points at a repo path (a plan doc, a file), pass that path through in your \`instructions\` so the harness reads it there.

You operate in one of two modes, decided by whether a pull request was supplied:

**CREATE mode** (no \`prNumber\`): the request is a NEW bounded engineering change. Frame it, propose a FRESH working branch named \`agent/<slug>\` (kebab-case, derived from the request) and a PR title. The branch MUST start with \`agent/\` — the repo's allowed push-branch patterns require that prefix, and a branch outside the pattern is rejected before any work. Never the default branch. Set \`mode: "create"\`.

**FIX mode** (\`prNumber\` present): the request is REVIEW FEEDBACK to address on an EXISTING open pull request. The existing PR branch is supplied as \`branch\` — echo it VERBATIM as your \`branch\` (the fix commits land on the open PR; do NOT propose a new branch). Frame the harness instructions to resolve the review's issues. Set \`mode: "fix"\`. Provide a short \`title\` describing the fix (required, but unused — no new PR is opened in fix mode).

**Deliverable** — the \`deliverable\` input (\`code\` by default, or \`design\`) — is an ORTHOGONAL axis that shapes WHAT the harness produces, independent of create/fix:
- \`code\`: the harness makes the code change (the default; everything above describes this).
- \`design\`: the harness writes a DESIGN DOC and makes NO code change — a markdown plan under the repo's plans location (e.g. \`docs/plans/<area>/<name>.md\`) covering the goal, the approach, alternatives + tradeoffs, and a phased plan. The doc IS the change: it is committed, pushed, and opened as a PR for review exactly like code. In create mode, name the branch \`agent/design-<slug>\` and the title \`Design: <subject>\`; frame \`instructions\` to produce ONLY the doc (what to cover and where it lives), never code. A design run is for thinking a change through BEFORE implementing it — the resulting doc is the input a later \`code\` run implements against.

Inputs (in your task context): \`request\` (the change to design or make, or the review feedback to address in fix mode); \`deliverable\` (\`design\` | \`code\`, default \`code\`); optionally \`prNumber\` + \`branch\` (present only in fix mode); and any prior learnings (weave repo facts — flaky modules, build ordering, conventions — into the brief).

Write the harness \`instructions\` as a complete, standalone brief the coding harness executes (it sees ONLY this string, not your reasoning): the concrete change to make, where, and how to know it is correct (which checks/tests pass).

The harness makes ONLY the change in the working tree — the code change, or the design doc when \`deliverable\` is \`design\`. It does NOT commit, push, or open a pull request — the platform does all three as SEPARATE steps after it finishes (it commits + bundles the change, pushes the branch, and opens the PR). So do NOT instruct the harness to commit, \`git push\`, run \`gh\`, or open a PR — it has no git credential and instructing it to do so makes it loop on an impossible step. Instruct only the change + how to verify it. No credentials, remotes, or the default branch — the repo designation fixes those.

Output:
{
  mode: "create" | "fix",
  summary: string,        // one-line framing for the operator's plan review
  branch: string,         // a fresh working branch (create) / the existing PR branch echoed (fix)
  title: string,          // the PR title (create) / a fix summary (fix)
  instructions: string    // the self-contained brief handed verbatim to the coding harness
}`;

const COMPOSE_HANDOFF_PROMPT = `Assemble the PR handoff block for this run — the durable A→B join a reviewer / PR-shepherd skill reads on rehydrate. This runs only on the approved create-path, where a PR exists to post it to.

Inputs (in your task context): the original request, the framed request summary, the harness instructions, the working branch, the implement outcome (status, diff stat), and the review-readiness signal (\`prDraft\`, and \`checks\` = { profileName, conclusion, failedCommand }) when present.

Produce a one-paragraph run summary and the handoff Markdown block. Begin the block (\`handoffBody\`) with the literal HTML comment marker \`<!-- phoenix-agent:handoff -->\` on its own line, then sections for the original request, the plan summary, the branch, and the status. **Review-readiness:** if \`prDraft\` is true the PR was opened as a DRAFT — say so plainly, then explain why from the signal: when \`checks\` is present, name the failing check (its \`profileName\` + \`failedCommand\`) so the reviewer / next fix pass works from the concrete failure, not just later CI; when \`checks\` is ABSENT, say the checks could not be verified this run — do NOT invent a check name. If \`prDraft\` is false, note it is ready for review — here \`checks\` being absent just means no check profile was configured, so do NOT say checks failed or could not be verified.

Do NOT author learnings — review and learning happen OUTSIDE this skill (a separate reviewer skill and the driver). This skill's job is to open the PR and leave a clean handoff.

Output:
{
  runSummary: string,      // one-paragraph summary of what happened this run
  handoffBody: string      // the Markdown handoff block to post on the PR
}`;

const OPEN_PR_FROM_REQUEST: SkillCatalogEntry = {
  catalogId: 'open-pr-from-request',
  version: 1,
  name: 'Open PR from Request',
  tagline:
    'Take a bounded engineering request to an approved plan, then a design doc or a real code change, and an open pull request.',
  description: `Coding skill: turn a bounded engineering request into an open pull request on an operator-bound repository — and revise that PR when given review feedback. One invocation runs discover → describe → plan-approve (HITL) → implement (coding harness) → push → open-PR → write-handoff, and completes the moment the PR is open — no held-open CI wait.

**Two modes** (the implement half of the implement ↔ review loop): in CREATE mode (no \`prNumber\`) the request is a new change and a fresh PR is opened; in FIX mode (\`prNumber\` + the existing \`branch\` supplied) the request is review feedback and the harness revises the open PR's branch — no new PR. The create-only tasks (open-PR + handoff) deterministically skip in fix mode via \`allOf\` gates on the approval AND \`discover\`'s decided mode.

**Two deliverables** (orthogonal to the mode): \`code\` (default) makes the code change; \`design\` makes the harness write a design/plan doc (markdown, no code) — opened as a PR to think a change through BEFORE implementing it. Same discover → approve → implement → push → open-PR flow; only \`discover\`'s brief differs, since a design doc is just a working-tree change.

**Campaign-per-repo**: the target repository is the campaign's engagement target — the operator-created repo designation (named by its \`repo\` coordinate, e.g. \`owner/repo\`) is the campaign config, fixed once and reused for every run against that repo. The designation owns the remote, default branch, allowed push-branch patterns, git credential, and named check profiles; the skill never supplies the authority boundary. The bounded engineering request is the per-run input; the working branch + PR title are proposed by discover.

**Approval-gated**: the operator approves the plan before any code is written. The implement step runs a managed coding harness over a fresh checkout. A real diff ALWAYS lands (Plan 232) — failing developer checks only open the PR as a draft, never a re_execute; only a failed CODING outcome (no diff / a crash) is the contract violation that re_execute retries.

**Handoff for review**: the opened PR carries a handoff block (the original request, the plan, the branch, the status) so a separate reviewer / PR-shepherd skill can pick it up. This skill produces the PR and stops — review and learning happen outside it; prior campaign learnings are still injected into planning, so it improves at this repo over time.

**Prerequisites**: a GitHub connector binding (a fine-grained PAT or GitHub App token with repo/PR access) and an operator-created repo designation for the target repository, both configured after bundle install. The repo designation becomes the campaign config on the first run.`,
  tags: ['coding', 'github', 'pull-requests', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description: 'GitHub REST API — open the pull request and post the handoff comment onto it.',
      requiredEndpoints: ['createPullRequest', 'createIssueComment'],
      authKind: 'bearer',
      setupNote:
        'Use the GitHub connection ensured when you designate the repo (a fine-grained personal access token or a GitHub App installation token with repository + pull-request access). The PR calls resolve through that connection — no separate binding to name. Sent as Authorization: Bearer.',
    },
    {
      apiId: 'github',
      description:
        'An operator-created repo designation fixing the remote, default branch, allowed push-branch patterns, git credential, and named check profiles for the target repository. It is the campaign config (the engagement target) — fixed once and reused for every run.',
      authKind: 'bearer',
      setupNote:
        'Create the repo designation (named by its owner/repo coordinate) for the target repository before the first run; it becomes the campaign config. It owns the remote and git credential; discover proposes the working branch and PR title. The branch must match the designation’s allowed push-branch patterns and is never the default branch.',
    },
  ],
  bundle: {
    workflow: {
      slug: 'open-pr-from-request',
      name: 'Open PR from Request',
      description:
        'Take a bounded engineering request to an open pull request — as a DESIGN DOC (deliverable=design: a markdown plan, no code) or a CODE CHANGE (default). It grounds itself by exploring the bound repo ITSELF — you do not pre-read files or pre-frame the change. Flow: discover → describe → plan (HITL approval) → implement (a coding harness writes the doc or the code) → push → open-PR → handoff. Prerequisite: a repo designated under Integrations → Repositories. Terminal at open-PR.',
      goal: 'Take a bounded engineering request to an operator-approved plan, a real code change implemented by a coding harness, a pushed branch, and an open pull request carrying a handoff block. Review and learning happen outside this skill.',
      mode: 'process' as const,
      outcomes: [
        {
          id: 'pr-opened',
          name: 'Pull request opened',
          evaluator: {
            type: 'manual' as const,
            instruction:
              'A pull request was opened on the bound repository for the implemented change (open-pr produced a prNumber + prUrl), OR the run terminated cleanly at a rejected plan (no PR opened — the rejection is the recorded outcome).',
          },
        },
      ],
      runInputs: [
        {
          id: 'request',
          required: true,
          description:
            'The bounded engineering request (an issue body, a free-text ask, or a spec) — or, in fix mode, the review feedback to address on the existing PR.',
        },
        {
          id: 'prNumber',
          required: false,
          description:
            'Fix mode: the open PR to revise. When present, the run revises the existing PR branch (no new PR is opened).',
        },
        {
          id: 'branch',
          required: false,
          description:
            'Fix mode: the existing PR branch the harness revises (supplied with prNumber).',
        },
        {
          id: 'deliverable',
          required: false,
          description:
            '`design` | `code` (default `code`). `design` makes the harness write a design/plan doc and no code; `code` makes the code change. Orthogonal to create/fix.',
        },
      ],
      tasks: [
        {
          taskId: 'discover',
          name: 'Discover',
          goal: DISCOVER_PROMPT,
          type: 'agent' as const,
          inputBindings: {
            request: { kind: 'run_input' as const, path: 'request' },
            // Fix mode (present only when the driver supplies them): the open PR +
            // its existing branch. Their presence flips discover to mode: 'fix'.
            prNumber: { kind: 'run_input' as const, path: 'prNumber' },
            branch: { kind: 'run_input' as const, path: 'branch' },
            // Deliverable axis: 'design' frames a doc brief, 'code' (default) frames code.
            deliverable: { kind: 'run_input' as const, path: 'deliverable' },
          },
          // Declare the run inputs at the task level so `firstTaskInputContract`
          // derives — the bootstrap harness then requires `request` up front instead
          // of failing the root task with a binding-resolution error (Plan 221 P1).
          // prNumber/branch are optional (fix mode only), so the bootstrap requires
          // only `request`.
          inputContract: {
            bindings: {
              request: {
                kind: 'run_input' as const,
                bindAs: 'request',
                path: 'request',
                schema: { type: 'string', minLength: 1, maxLength: 8000 },
              },
              prNumber: {
                kind: 'run_input' as const,
                bindAs: 'prNumber',
                path: 'prNumber',
                schema: { type: 'integer', minimum: 1 },
              },
              branch: {
                kind: 'run_input' as const,
                bindAs: 'branch',
                path: 'branch',
                schema: { type: 'string', minLength: 1, maxLength: 200 },
              },
              deliverable: {
                kind: 'run_input' as const,
                bindAs: 'deliverable',
                path: 'deliverable',
                schema: { type: 'string', enum: ['design', 'code'] },
              },
            },
          },
          context: {
            strategy: 'scoped' as const,
            contextPolicy: 'auto-optimize' as const,
            learnings: 'active' as const,
            capabilities: {
              operations: ['memory.store.get'],
              integrations: [],
            },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['mode', 'summary', 'branch', 'title', 'instructions'],
              additionalProperties: false,
              properties: {
                // The branch — create-only PR tasks gate on `mode == 'create'`.
                mode: { type: 'string', enum: ['create', 'fix'] },
                summary: { type: 'string', maxLength: 2000 },
                branch: { type: 'string', minLength: 1, maxLength: 200 },
                title: { type: 'string', minLength: 1, maxLength: 200 },
                instructions: { type: 'string', minLength: 1, maxLength: 8000 },
              },
            },
          },
        },

        {
          taskId: 'describe',
          name: 'Describe repo',
          goal: 'Resolve the campaign’s repo coordinate to its public parts (owner, repo, default branch) so the GitHub PR task has the owner/repo it needs — without hardcoding them or touching the git credential.',
          type: 'operation' as const,
          operation: 'code.repo.describe',
          dependsOn: ['discover'],
          retryability: 'safe' as const,
          inputBindings: {
            repo: { kind: 'campaign_input' as const, path: 'repo' },
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
          taskId: 'plan-approve',
          name: 'Approve the plan',
          goal: 'Operator approves the framed plan before any code is written. Approving runs the coding harness against the bound repo on the working branch; rejecting abandons the run cleanly (no PR is opened).',
          type: 'human' as const,
          intent: 'approve' as const,
          failureMode: 'isolate' as const,
          dependsOn: ['discover'],
          approves: ['discover'],
          pauseInstruction:
            'Review the framed plan below (the summary and the harness instructions). Approve to run the coding harness and open a PR, or reject to abandon this run.',
          actionPreview: {
            op: 'code.agent.run',
            inputBindings: {
              repo: { kind: 'campaign_input' as const, path: 'repo' },
              branch: { kind: 'task_output' as const, taskId: 'discover', path: 'branch' },
              instructions: {
                kind: 'task_output' as const,
                taskId: 'discover',
                path: 'instructions',
              },
            },
          },
        },

        {
          taskId: 'implement',
          name: 'Implement',
          goal: 'Run the coding harness over a fresh checkout of the bound repo on the working branch, executing the discovered instructions. Returns a binary-safe patch bundle (patchRef) carrying the authoritative commit.',
          type: 'operation' as const,
          operation: 'code.agent.run',
          dependsOn: ['plan-approve'],
          // Gating does NOT propagate from the approval — each side-effecting task must
          // carry its own `when`, or a rejected plan still runs the harness/push/PR.
          when: {
            expression: "tasks.plan-approve.output.decision == 'approved'",
            onMissingRef: 'skip' as const,
          },
          // `safe`: a failed run left no observable external state — code.agent.run
          // produces a patch with no push authority (the separate, gated push op is
          // the side-effecting step), so a failed implement is `re_execute`-able in
          // place rather than a dead-end contract-violation pause.
          retryability: 'safe' as const,
          maxAttempts: 2,
          inputBindings: {
            repo: { kind: 'campaign_input' as const, path: 'repo' },
            branch: { kind: 'task_output' as const, taskId: 'discover', path: 'branch' },
            instructions: {
              kind: 'task_output' as const,
              taskId: 'discover',
              path: 'instructions',
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
          // Accept a usable diff (succeeded) OR a clean no-op (no_change — the
          // desired state already exists, nothing to commit). A genuine failure —
          // a thrown backend error (FAILED step) or an empty diff with a non-zero
          // exit / timeout (an output `failed` this contract rejects) — fires the
          // §2.6 ↔ re_execute bridge; it never flows through as a phantom success.
          // The patch-consuming tasks (push, open-pr, handoff) gate on
          // `status == 'succeeded'`, so no_change cleanly skips them.
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
          name: 'Push patch bundle',
          goal: 'Push the implement step’s patch bundle to the bound repo’s remote on the working branch, verbatim (remoteSha === headSha).',
          type: 'operation' as const,
          operation: 'code.repo.push',
          dependsOn: ['implement'],
          // There is a patch to push only when implement produced one. On no_change
          // (nothing to commit) this deterministically skips, and so do the PR tasks.
          when: {
            allOf: [
              "tasks.plan-approve.output.decision == 'approved'",
              "tasks.implement.output.status == 'succeeded'",
            ],
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          inputBindings: {
            repo: { kind: 'campaign_input' as const, path: 'repo' },
            branch: { kind: 'task_output' as const, taskId: 'discover', path: 'branch' },
            patchRef: { kind: 'task_output' as const, taskId: 'implement', path: 'patchRef' },
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
          taskId: 'open-pr',
          name: 'Open pull request',
          goal: 'Open a pull request from the working branch into the repo’s default branch via the GitHub REST API.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['push', 'describe'],
          // Create-only: open a new PR only when approved AND in create mode. In fix
          // mode the PR already exists, so this is skipped (the fix just pushes to the
          // existing branch). `allOf` — deterministic compound branching.
          when: {
            allOf: [
              "tasks.plan-approve.output.decision == 'approved'",
              "tasks.discover.output.mode == 'create'",
              "tasks.implement.output.status == 'succeeded'",
            ],
            onMissingRef: 'skip' as const,
          },
          retryability: 'unsafe' as const,
          maxAttempts: 2,
          inputBindings: {
            owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
            repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
            defaultBranch: {
              kind: 'task_output' as const,
              taskId: 'describe',
              path: 'defaultBranch',
            },
            title: { kind: 'task_output' as const, taskId: 'discover', path: 'title' },
            branch: { kind: 'task_output' as const, taskId: 'discover', path: 'branch' },
            // Plan 232: open a DRAFT PR when the implement task's developer checks
            // failed (the diff landed but is not review-ready) — never present a
            // failing-checks change as a normal, ready PR.
            prDraft: { kind: 'task_output' as const, taskId: 'implement', path: 'prDraft' },
            // Pins the GitHub call to the connection the campaign's repo resolves
            // through (run-start). No static binding grant — an unpinned github task
            // would scope-resolve an arbitrary account (Plan 222 P3).
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
            endpointId: 'createPullRequest',
            bindingId: { $bind: 'githubConnection' },
            params: {
              owner: { $bind: 'owner' },
              repo: { $bind: 'repo' },
              body: {
                title: { $bind: 'title' },
                head: { $bind: 'branch' },
                base: { $bind: 'defaultBranch' },
                draft: { $bind: 'prDraft' },
              },
            },
            response: { format: 'json' },
          },
          outputProjection: {
            prNumber: { path: 'data.number', onMissing: 'error' as const },
            prUrl: { path: 'data.html_url', onMissing: 'error' as const },
            prTitle: { path: 'data.title', onMissing: 'error' as const },
          },
          outputContract: {
            schema: {
              type: 'object',
              required: ['prNumber', 'prUrl', 'prTitle'],
              additionalProperties: false,
              properties: {
                prNumber: { type: 'number' },
                prUrl: { type: 'string', minLength: 1 },
                prTitle: { type: 'string', minLength: 1 },
              },
            },
          },
          // Promoted so the run result carries the opened PR straight to the caller —
          // the UI output box AND the workflow.run.start/resume tool result — instead
          // of the driver having to query task outputs to recover the PR number.
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'prNumber', toState: 'prNumber' },
            { kind: 'output_path' as const, path: 'prUrl', toState: 'prUrl' },
            { kind: 'output_path' as const, path: 'prTitle', toState: 'prTitle' },
          ],
        },

        // Create-only: the handoff is the new PR's continuity record, so it's
        // composed only when a new PR is being opened (approved AND create mode).
        // In fix mode the PR already exists and the review comments are the
        // continuity. This skill produces the PR + handoff and STOPS — review and
        // learning happen outside it (Plan 221).
        {
          taskId: 'compose-handoff',
          name: 'Compose Handoff',
          goal: COMPOSE_HANDOFF_PROMPT,
          type: 'agent' as const,
          dependsOn: ['implement'],
          when: {
            allOf: [
              "tasks.plan-approve.output.decision == 'approved'",
              "tasks.discover.output.mode == 'create'",
              "tasks.implement.output.status == 'succeeded'",
            ],
            onMissingRef: 'skip' as const,
          },
          inputBindings: {
            request: { kind: 'run_input' as const, path: 'request' },
            branch: { kind: 'task_output' as const, taskId: 'discover', path: 'branch' },
            summary: { kind: 'task_output' as const, taskId: 'discover', path: 'summary' },
            instructions: {
              kind: 'task_output' as const,
              taskId: 'discover',
              path: 'instructions',
            },
            implementStatus: { kind: 'task_output' as const, taskId: 'implement', path: 'status' },
            diffStat: { kind: 'task_output' as const, taskId: 'implement', path: 'diffStat' },
            // Plan 232: the PR opens as a draft when developer checks failed — the
            // handoff must say so + name the failing checks, so the reviewer / next fix
            // pass works from concrete output, not just later CI.
            prDraft: { kind: 'task_output' as const, taskId: 'implement', path: 'prDraft' },
            checks: { kind: 'task_output' as const, taskId: 'implement', path: 'checks' },
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
          taskId: 'write-handoff',
          name: 'Write handoff comment',
          goal: 'Post the handoff block as a comment on the opened pull request (original request, plan summary, branch, status) — the durable A→B join a reviewer / PR-shepherd skill reads on rehydrate.',
          type: 'operation' as const,
          operation: 'api.http.call',
          dependsOn: ['open-pr', 'compose-handoff', 'describe'],
          // Create-only: the handoff comment lands on the NEWLY opened PR. In fix
          // mode there is no new PR (and compose-handoff is skipped), so this is too.
          when: {
            allOf: [
              "tasks.plan-approve.output.decision == 'approved'",
              "tasks.discover.output.mode == 'create'",
              "tasks.implement.output.status == 'succeeded'",
            ],
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          inputBindings: {
            owner: { kind: 'task_output' as const, taskId: 'describe', path: 'owner' },
            repo: { kind: 'task_output' as const, taskId: 'describe', path: 'repo' },
            prNumber: { kind: 'task_output' as const, taskId: 'open-pr', path: 'prNumber' },
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
      stateVariables: [
        {
          variableId: 'prNumber',
          name: 'Pull request number',
          description: 'Number of the pull request opened for this run’s change.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'prUrl',
          name: 'Pull request URL',
          description: 'HTML URL of the opened pull request.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'prTitle',
          name: 'Pull request title',
          description: 'Title of the pull request opened for this run’s change.',
          required: false,
          sensitive: false,
          immutable: false,
        },
      ],
      // The deliverable IS the opened PR — surface it as the run's primary output
      // so the caller can act (e.g. review it) without re-querying. In fix mode no
      // new PR is opened, so these stay unset and the result carries no PR block.
      output: {
        primary: 'prNumber',
        guidance:
          'On a create-mode run the output carries the opened pull request: prNumber, prUrl, and prTitle. To review it, start review-pull-request with prNumber as the PR number. The PR also carries a handoff comment with the original request and plan.',
      },
      iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    },
    manifest: {
      skillId: 'open-pr-from-request',
      name: 'Open PR from Request',
      goal: {
        type: 'objective' as const,
        criteria: [
          {
            id: 'pr-opened',
            description:
              'A request is taken through an approved plan, a harness-implemented change, a pushed branch, and an open pull request carrying a handoff block — or it terminates cleanly at a rejected plan (no PR opened).',
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
        'open a pr',
        'open a pull request',
        'implement this change',
        'fix this issue and open a pr',
        'make this change in the repo',
        'turn this request into a pr',
        'design a feature',
        'write a design doc',
        'plan a change before building it',
        'produce a design plan or rfc',
      ],
      activationHint:
        'Take a bounded engineering request to an open PR — a DESIGN DOC (deliverable=design: a markdown plan, no code, to think a change through first) or a CODE CHANGE (default). It explores the bound repo ITSELF to ground the work — no need to pre-read files. discover → approve → implement → push → open-PR. Prerequisite: a designated repo (Integrations → Repositories). Terminal at open-PR; the PR carries a handoff a PR-shepherd skill can tend.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      'Plan 178 Skill A + Plan 221 — the implement half of the implement ↔ review loop, on campaigns. The repo coordinate (repo) is the campaign config; the request is the per-run input. discover frames the request and decides mode (create|fix from an optional prNumber) → describe (code.repo.describe) resolves owner/repo → HITL plan-approve → implement (code.agent.run, opTaskOnly) whose contract requires a succeeded diff so a failed outcome re_executes → push (code.repo.push) replays the bundle verbatim. open-PR + compose/write-handoff are create-only via `allOf` [approved, mode==create], so fix mode revises the existing PR branch and the review comments are the continuity. Review and learning happen OUTSIDE this skill (Plan 221).',
  },
};

export { OPEN_PR_FROM_REQUEST };
