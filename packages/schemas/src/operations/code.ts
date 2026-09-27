/**
 * Code step operation schemas.
 *
 * A managed coding harness (Claude Code / OpenCode) runs over a real git
 * checkout as one black-box step. The harness (claude | opencode) is decoupled
 * from the model backend (zai | anthropic | openai). The op produces a durable,
 * binary-safe patch artifact (a git bundle carrying the authoritative commit);
 * it is granted no push/PR/merge authority of its own.
 */
import { z } from 'zod';
import { PayloadRefSchema } from '../runtime/payloadRef.js';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

// ============================================================================
// Shared sub-schemas (one harness lifecycle drives both produce and review)
// ============================================================================

/** Optional budget caps for one harness run — shared by run and review. */
export const CodeBudgetSchema = z
  .object({
    maxTurns: z.number().int().positive().describe('Maximum harness turns.'),
    maxWallClockSeconds: z
      .number()
      .int()
      .positive()
      .describe('Maximum wall-clock seconds for the harness run.'),
  })
  .partial();

/** One structured review finding — maps 1:1 to an inline PR review comment. */
export const CodeReviewIssueSchema = z.object({
  path: z.string().describe('Repo-relative path the issue is about.'),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      '1-based line in the head version, when the issue is line-specific (inline comment).',
    ),
  severity: z
    .enum(['blocker', 'major', 'minor', 'nit'])
    .describe('blocker/major typically drive request_changes; minor/nit are advisory.'),
  body: z.string().describe('The comment text for this issue.'),
});

/**
 * The verdict the review harness writes to its verdict file — the lane's contract
 * WITH the harness (the standing review prompt instructs exactly this shape). The
 * executor reads the file and validates it against this schema before surfacing.
 */
export const CodeReviewVerdictSchema = z.object({
  verdict: z
    .enum(['approve', 'request_changes'])
    .describe('The reviewer’s overall call — drives the loop branch (request_changes → fix).'),
  reviewBody: z
    .string()
    .describe('Overall assessment (markdown) — becomes the PR review body when posted.'),
  issues: z
    .array(CodeReviewIssueSchema)
    .optional()
    .describe('Structured findings; empty/absent is valid for a clean approve.'),
});
export type CodeReviewVerdict = z.infer<typeof CodeReviewVerdictSchema>;

/** Model usage + cost + turn count for one harness run — shared by run and review. */
export const CodeHarnessUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().describe('Input tokens consumed.'),
  outputTokens: z.number().int().nonnegative().describe('Output tokens produced.'),
  usd: z.number().nonnegative().describe('Estimated spend in USD.'),
  turns: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Harness agentic turns (assistant↔tool round-trips). The primary signal of how hard ' +
        'the harness worked — a small change taking many turns means it struggled or looped.',
    ),
});

// ============================================================================
// Input
// ============================================================================

export const CodeAgentRunInputSchema = z.object({
  repo: z
    .string()
    .describe(
      'Repo coordinate (owner/repo, or host/owner/repo) of an operator-created repo designation in ' +
        'this space. The designation fixes the remote, default branch, allowed push-branch patterns, ' +
        'git credential, egress host(s), and named check profiles. The agent picks branch + task, ' +
        'never the authority boundary.',
    ),
  branch: z
    .string()
    .describe(
      'Working branch for the checkout. Must match the designation’s allowed push-branch patterns; never the default branch.',
    ),
  task: z
    .object({
      instructions: z
        .string()
        .describe(
          'What the harness should do, in natural language (from user input / memory / an issue).',
        ),
      contextRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Optional references to supporting context (memory paths, payload refs, issue ids).',
        ),
    })
    .describe('The coding task handed to the harness.'),
  harness: z
    .enum(['claude', 'opencode'])
    .default('claude')
    .describe('Coding harness CLI to drive headless. Independent of the model backend.'),
  backendProvider: z
    .enum(['zai', 'anthropic', 'openai'])
    .describe(
      'Model backend the task selects. The executor resolves the credential by owner from the job ' +
        'context — the agent picks the provider, never the secret.',
    ),
  budget: CodeBudgetSchema.optional().describe(
    'Optional budget caps. Exhaustion with no diff yields status === "failed" (timedOut === true); with a usable partial diff it still yields "succeeded".',
  ),
  checkProfile: z
    .string()
    .optional()
    .describe(
      'A named check profile id declared on the repo designation (operator-authored). NOT arbitrary shell ' +
        'and NOT a list of commands — model-proposed commands are deferred behind an operator-reviewed manifest.',
    ),
});
export type CodeAgentRunInput = z.infer<typeof CodeAgentRunInputSchema>;

// ============================================================================
// Output
// ============================================================================

export const CodeAgentRunOutputSchema = z
  .object({
    status: z
      .enum(['succeeded', 'no_change', 'failed'])
      .describe(
        'succeeded: a usable diff was produced (carries patchRef + headSha + diffStat) — REGARDLESS of exit ' +
          'code, timeout, OR developer-check outcome. Typecheck/format/lint failures are recorded in `checks` ' +
          'and reflected in `prDraft`; they NEVER discard the work — the diff always lands (a ' +
          'failing-checks diff opens as a DRAFT). no_change: the harness STOPPED CLEANLY (exit 0, no timeout) ' +
          'with the tree unchanged — the desired state already existed (carries summary, no patchRef/errorRef), ' +
          'NOT a failure. failed: NO usable work — a crash, an infra error, an empty diff with a non-zero ' +
          'exit/timeout, OR a SAFETY-gate failure (secret scan, authority, branch policy, bundle integrity — ' +
          'these stay terminal, never advisory; carries errorRef). Field presence is conditional on status.',
      ),
    branch: z.string().describe('The branch the checkout/commit targets (echoes the input).'),
    timedOut: z.boolean().describe('True if the harness hit its wall-clock budget.'),
    exitCode: z
      .number()
      .int()
      .optional()
      .describe(
        'Harness process exit code, when the harness launched (absent on a pre-launch infra error).',
      ),
    headSha: z
      .string()
      .optional()
      .describe(
        'Present on succeeded. Authoritative SHA of the local commit the op created; preserved verbatim by the push op.',
      ),
    patchRef: PayloadRefSchema.optional().describe(
      'Present on succeeded. Binary-safe git bundle carrying the authoritative commit — the durable handoff the push op replays verbatim.',
    ),
    diffStat: z
      .object({
        files: z.number().int().nonnegative().describe('Number of files changed.'),
        insertions: z.number().int().nonnegative().describe('Lines inserted.'),
        deletions: z.number().int().nonnegative().describe('Lines deleted.'),
      })
      .optional()
      .describe(
        'Present on succeeded (and no_change, where files is 0). Aggregate diff statistics.',
      ),
    changedFiles: z
      .array(
        z.object({
          path: z.string().describe('Repo-relative path of the changed file.'),
          status: z.string().describe('Change status (e.g. added, modified, deleted, renamed).'),
        }),
      )
      .optional()
      .describe(
        'Present on succeeded. Bounded list of changed files; a large change is truncated with a count.',
      ),
    summary: z.string().optional().describe('Bounded final message from the harness.'),
    eventsRef: PayloadRefSchema.optional().describe(
      'Full coarse-event stream (capped, sensitive) — stored by ref, not inline.',
    ),
    transcriptRef: PayloadRefSchema.optional().describe(
      'Optional full harness transcript, stored by ref.',
    ),
    errorRef: PayloadRefSchema.optional().describe(
      'Present on failed — the re_execute failure context (and any partial patchRef may accompany it).',
    ),
    usage: CodeHarnessUsageSchema.optional().describe(
      'Model usage, cost, and turn count for the run, when the harness launched.',
    ),
    checks: z
      .object({
        profileName: z.string().describe('The check profile that ran.'),
        conclusion: z
          .enum(['passed', 'failed'])
          .describe(
            'Developer-check result. failed → the diff STILL landed (not a discard); it is just not review-ready. The whole `checks` object is absent when no profile ran OR the check phase faulted before recording a result — so an absent `checks` does NOT imply the checks passed; read `prDraft`.',
          ),
        failedCommand: z
          .string()
          .optional()
          .describe('The first command that failed, when conclusion is failed.'),
        ranCommands: z
          .array(z.string())
          .describe('The check commands that ran, in order (secret-scrubbed).'),
        outputRef: PayloadRefSchema.optional().describe(
          'Bounded check output (the failing command tail), stored by ref when non-trivial.',
        ),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Wall-clock the checks took.'),
      })
      .optional()
      .describe(
        'Developer-quality check result — ADVISORY metadata, NEVER a reason to discard a diff. A failed ' +
          'conclusion means the patch landed but is not review-ready (the skill opens a DRAFT). Safety-gate ' +
          'failures (secret scan, authority, branch policy, bundle integrity) are NOT recorded here — they ' +
          'are terminal (status: failed, no patchRef).',
      ),
    prDraft: z
      .boolean()
      .optional()
      .describe(
        "Present on succeeded. The value to bind directly to GitHub's PR `draft` field. TRUE (open a " +
          'draft) when developer checks FAILED (checks.conclusion === "failed") OR could not be verified (the ' +
          'check phase faulted — `checks` absent) — the diff landed but is not review-ready. FALSE (normal PR) ' +
          'when the checks passed or no profile ran.',
      ),
  })
  .superRefine((out, ctx) => {
    if (out.status === 'succeeded') {
      for (const field of ['patchRef', 'headSha', 'diffStat', 'prDraft'] as const) {
        if (out[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `status "succeeded" requires ${field}`,
          });
        }
      }
    } else if (out.status === 'failed' && out.errorRef === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorRef'],
        message: 'status "failed" requires errorRef',
      });
    }
    // no_change carries no patchRef and no errorRef — nothing was produced and
    // nothing failed; the summary explains why the tree was unchanged.
  });
export type CodeAgentRunOutput = z.infer<typeof CodeAgentRunOutputSchema>;

// ============================================================================
// code.repo.push — gated, verbatim push of a patch bundle
// ============================================================================

export const CodeRepoPushInputSchema = z.object({
  repo: z
    .string()
    .describe(
      'Repo coordinate (owner/repo, or host/owner/repo) of an operator-created repo designation in ' +
        'this space. The designation fixes the remote, default branch, allowed push-branch patterns, ' +
        'and git credential. The push targets this designation’s remote; the agent never supplies the ' +
        'authority boundary.',
    ),
  branch: z
    .string()
    .describe(
      'Branch to push. Must match the designation’s allowed push-branch patterns and is never the default branch.',
    ),
  patchRef: PayloadRefSchema.describe(
    'The binary-safe git bundle a prior code.agent.run produced (its patchRef), carrying the ' +
      'authoritative commit. The push replays this commit VERBATIM — no re-commit — so remoteSha === headSha.',
  ),
});
export type CodeRepoPushInput = z.infer<typeof CodeRepoPushInputSchema>;

export const CodeRepoPushOutputSchema = z.object({
  pushed: z.boolean().describe('True when the carried commit was pushed to the remote branch.'),
  branch: z.string().describe('The branch the commit was pushed to (echoes the input).'),
  remoteSha: z
    .string()
    .describe(
      'The SHA of the branch on the remote after the push. Equals the bundle’s headSha — the commit is replayed verbatim, never re-committed.',
    ),
});
export type CodeRepoPushOutput = z.infer<typeof CodeRepoPushOutputSchema>;

// ============================================================================
// code.repo.describe — resolve a repo designation's public coordinates
// ============================================================================

export const CodeRepoDescribeInputSchema = z.object({
  repo: z
    .string()
    .describe(
      'Repo coordinate (owner/repo, or host/owner/repo) of an operator-created repo designation to ' +
        'describe. Only its public coordinates are returned — never the git credential.',
    ),
});
export type CodeRepoDescribeInput = z.infer<typeof CodeRepoDescribeInputSchema>;

export const CodeRepoDescribeOutputSchema = z.object({
  owner: z.string().describe('Repository owner (org or user), parsed from the repo coordinate.'),
  repo: z
    .string()
    .describe('Repository name (without the .git suffix), parsed from the repo coordinate.'),
  defaultBranch: z.string().describe('The designation’s default branch.'),
  remoteUrl: z
    .string()
    .describe(
      'The designation’s https remote URL (derived from the coordinate). Never carries embedded credentials.',
    ),
});
export type CodeRepoDescribeOutput = z.infer<typeof CodeRepoDescribeOutputSchema>;

// ============================================================================
// code.agent.review — read-only deep review over a real checkout
// ============================================================================

export const CodeAgentReviewInputSchema = z.object({
  repo: z
    .string()
    .describe(
      'Repo coordinate (owner/repo, or host/owner/repo) of an operator-created repo designation in ' +
        'this space. The designation fixes the remote, default branch, git credential, and egress ' +
        'host(s). The reviewer clones read-only — it never pushes, edits, or opens a PR.',
    ),
  branch: z
    .string()
    .describe('The head/feature branch to review (the PR head). Checked out read-only.'),
  baseBranch: z
    .string()
    .optional()
    .describe(
      'Branch to diff the head against for the change set. Defaults to the binding’s default branch.',
    ),
  review: z
    .object({
      instructions: z
        .string()
        .describe(
          'What to review for, and the request the change is meant to satisfy — so the verdict can ' +
            'judge "matches the request", not merely "compiles".',
        ),
      lens: z
        .string()
        .optional()
        .describe(
          'Optional focus label (e.g. correctness, security, performance). The driver picks per ' +
            'change — a README needs no security lens; token-conscious by construction.',
        ),
      contextRefs: z
        .array(z.string())
        .optional()
        .describe(
          'Optional references to supporting context (memory paths, payload refs, issue ids).',
        ),
    })
    .describe('The review brief handed to the harness.'),
  depth: z
    .enum(['standard', 'deep'])
    .default('standard')
    .describe(
      'standard: static review with full repo context. deep: also run the designation’s check profile ' +
        '(tests/lint) for evidence before judging.',
    ),
  checkProfile: z
    .string()
    .optional()
    .describe(
      'A named check profile id declared on the repo designation, run when depth=deep. NOT arbitrary ' +
        'shell and NOT a list of commands.',
    ),
  harness: z
    .enum(['claude', 'opencode'])
    .default('claude')
    .describe('Coding harness CLI to drive headless. Independent of the model backend.'),
  backendProvider: z
    .enum(['zai', 'anthropic', 'openai'])
    .describe(
      'Model backend the task selects. The executor resolves the credential by owner from the job ' +
        'context — the agent picks the provider, never the secret.',
    ),
  budget: CodeBudgetSchema.optional().describe(
    'Optional budget caps. Exhaustion with no usable verdict yields status === "failed".',
  ),
});
export type CodeAgentReviewInput = z.infer<typeof CodeAgentReviewInputSchema>;

export const CodeAgentReviewOutputSchema = z
  .object({
    status: z
      .enum(['succeeded', 'failed'])
      .describe(
        'succeeded: the harness produced a structured verdict (carries verdict + reviewBody). failed: ' +
          'crash, infra error, or budget exhausted with no verdict (carries errorRef). A ' +
          'request_changes verdict is NOT a failure.',
      ),
    branch: z.string().describe('The head branch reviewed (echoes the input).'),
    verdict: z
      .enum(['approve', 'request_changes'])
      .optional()
      .describe(
        'Present on succeeded. The reviewer’s overall call — drives the loop branch (request_changes → fix).',
      ),
    reviewBody: z
      .string()
      .optional()
      .describe(
        'Present on succeeded. The overall review narrative (markdown) — becomes the PR review body ' +
          'when posted via the github mesh.',
      ),
    issues: z
      .array(CodeReviewIssueSchema)
      .optional()
      .describe(
        'Present on succeeded. Structured findings — each maps to an inline PR review comment.',
      ),
    summary: z.string().optional().describe('Bounded final message from the harness.'),
    timedOut: z.boolean().describe('True if the harness hit its wall-clock budget.'),
    exitCode: z
      .number()
      .int()
      .optional()
      .describe('Harness process exit code, when the harness launched.'),
    eventsRef: PayloadRefSchema.optional().describe(
      'Full coarse-event stream (capped, sensitive) — stored by ref, not inline.',
    ),
    transcriptRef: PayloadRefSchema.optional().describe(
      'Optional full harness transcript, stored by ref.',
    ),
    errorRef: PayloadRefSchema.optional().describe('Present on failed — the failure context.'),
    usage: CodeHarnessUsageSchema.optional().describe(
      'Model usage, cost, and turn count for the run, when the harness launched.',
    ),
  })
  .superRefine((out, ctx) => {
    if (out.status === 'succeeded') {
      for (const field of ['verdict', 'reviewBody'] as const) {
        if (out[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `status "succeeded" requires ${field}`,
          });
        }
      }
    } else if (out.errorRef === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorRef'],
        message: 'status "failed" requires errorRef',
      });
    }
  });
export type CodeAgentReviewOutput = z.infer<typeof CodeAgentReviewOutputSchema>;

// ============================================================================

export const CodeOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'code',
    group: 'agent',
    verb: 'run',
    name: 'Run Coding Agent',
    actionLabel: 'Running coding agent…',
    semanticDescription:
      'Run a managed coding harness (Claude Code or OpenCode) over a real git checkout as one black-box step. ' +
      'The harness reads, edits, and tests the repo in its own multi-minute loop; Phoenix never decomposes that loop into steps. ' +
      'The op clones the repo designation’s remote on a working branch, runs the harness headless on the selected model backend, ' +
      'creates the authoritative local commit, and returns a binary-safe git bundle (patchRef) plus a bounded diff/usage summary. ' +
      'It has no push/PR/merge authority — a separate, gated push op replays the bundle verbatim.',
    tags: ['code', 'coding-agent', 'harness', 'git'],
    idempotency: 'non_idempotent',
    mutates: true,
    opTaskOnly: true,
    usage: {
      oneLine:
        'Run a coding harness over a git checkout as one black-box step; returns a patch bundle + diffstat + usage.',
      whenToUse: [
        'Implementing a code change described in natural language against an operator-bound repo (the skill’s implement task).',
        'Producing a reviewable diff (patchRef) to hand to a separate, gated push/PR op.',
      ],
      whenNotToUse: [
        'Calling external APIs (open PR, poll CI, post review comments, merge) — those run via api.http.call as first-class steps.',
        'Running untrusted data-processing scripts — use compute.sandbox.exec (network-isolated, read-only).',
        'Ad-hoc selection from an agent’s tool surface — this op is opTaskOnly and must be an explicit workflow operation task.',
      ],
      pitfalls: [
        'Self-review or CI check failures are NOT this op’s failure — status stays "succeeded" with a usable diff; failures loop back via re_execute on the implement task.',
        'An empty diff (the desired state already exists) is status "no_change", NOT a failure — a clean terminal outcome with no patchRef. A consuming workflow should treat it as "nothing to do" (skip the push/PR), not retry it as an error.',
        'branch must match the designation’s allowed push-branch patterns and is never the default branch.',
        'checkProfile resolves only to a named profile declared on the repo designation — it is not arbitrary shell and not a list of commands.',
        'The credential is resolved by owner from the job context; the agent picks backendProvider, never the secret.',
      ],
      minimalExampleInput: {
        repo: 'munchist/duality',
        branch: 'phoenix/fix-typo',
        task: { instructions: 'Fix the typo in the README title.' },
        backendProvider: 'anthropic' as const,
      },
    },
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    inputZod: CodeAgentRunInputSchema,
    outputZod: CodeAgentRunOutputSchema,
  },
  {
    stepType: 'code',
    group: 'agent',
    verb: 'review',
    name: 'Review Code',
    actionLabel: 'Reviewing code…',
    semanticDescription:
      'Run a managed coding harness (Claude Code or OpenCode) over a real git checkout to REVIEW a branch read-only — ' +
      'the deep counterpart to glancing at a diff via the API. It clones the repo designation’s remote at the head branch, ' +
      'diffs against the base, explores the repo with full context (and runs the designation’s named check profile when depth=deep), ' +
      'and returns a STRUCTURED VERDICT (approve | request_changes) plus inline issues and a review body. ' +
      'It has NO push/edit/PR authority and produces NO patch; posting the verdict to the PR runs via the GitHub API as a separate step.',
    tags: ['code', 'review', 'harness', 'git'],
    idempotency: 'non_idempotent',
    mutates: false,
    opTaskOnly: true,
    usage: {
      oneLine:
        'Review a branch deep over a real checkout; returns a structured verdict (approve | request_changes) + inline issues. No patch, no push.',
      whenToUse: [
        'Adversarially reviewing a feature branch with full repo context — running tests, tracing callers — beyond what a diff-only API review can see (the skill’s review task).',
        'Producing a machine-readable verdict that drives an implement↔review loop (request_changes → fix).',
      ],
      whenNotToUse: [
        'A trivial diff-only glance (README / config / rename) — the driver can read the diff via the GitHub API; this op pays for a clone.',
        'Posting the verdict to the PR (review comments, approve / request changes) — that runs via api.http.call (createReview); the lane has no GitHub authority.',
        'Making the change — that is code.agent.run (the producer). This op never edits or pushes.',
        'Ad-hoc selection from an agent’s tool surface — this op is opTaskOnly and must be an explicit workflow operation task.',
      ],
      pitfalls: [
        'A request_changes verdict is NOT this op’s failure — status stays "succeeded"; the verdict drives the loop branch.',
        'The reviewer is read-only — it produces no patchRef and has no push/edit/PR authority of its own.',
        'depth=deep runs only the designation’s named check profile — not arbitrary shell and not a list of commands.',
        'The credential is resolved by owner from the job context; the agent picks backendProvider, never the secret.',
      ],
      minimalExampleInput: {
        repo: 'munchist/duality',
        branch: 'agent/add-health-endpoint',
        review: {
          instructions:
            'Review this change for correctness and that it satisfies: add a /health endpoint returning 200.',
        },
        backendProvider: 'anthropic' as const,
      },
    },
    accessMode: 'read',
    inputZod: CodeAgentReviewInputSchema,
    outputZod: CodeAgentReviewOutputSchema,
  },
  {
    stepType: 'code',
    group: 'repo',
    verb: 'push',
    name: 'Push Patch Bundle',
    actionLabel: 'Pushing patch bundle…',
    semanticDescription:
      'Push the patch bundle a prior code.agent.run produced (its patchRef) to the repo designation’s remote. ' +
      'The op clones the designation’s remote FRESH, applies the bundle, and pushes the carried commit VERBATIM — ' +
      'it does NOT re-commit — so the remote SHA equals the bundle’s authoritative headSha (signature/SHA preserved, no divergence). ' +
      'It runs no harness (trusted git only), targets a branch matching the designation’s allowed push-branch patterns (never the default branch), ' +
      'and is the gated write-back half of the coding lane.',
    tags: ['code', 'git', 'push', 'patch-bundle'],
    idempotency: 'non_idempotent',
    mutates: true,
    opTaskOnly: true,
    usage: {
      oneLine:
        'Push a code.agent.run patch bundle verbatim to the designation’s remote branch; remoteSha === headSha.',
      whenToUse: [
        'Writing back a reviewed patchRef from a prior code.agent.run to the operator-bound repo (the skill’s push task).',
        'After self-review/approval, to land the carried commit on a feature branch without re-committing.',
      ],
      whenNotToUse: [
        'Opening a PR, merging, or posting review comments — those run via api.http.call as first-class steps.',
        'Producing the patch in the first place — that is code.agent.run, which emits the patchRef this op consumes.',
        'Ad-hoc selection from an agent’s tool surface — this op is opTaskOnly and must be an explicit workflow operation task.',
      ],
      pitfalls: [
        'branch must match the designation’s allowed push-branch patterns and is never the default branch.',
        'The op pushes the carried commit VERBATIM — it never re-commits, so the remote SHA must equal the bundle’s headSha.',
        'The git credential is resolved by owner from the designation; the agent never supplies the secret.',
      ],
      minimalExampleInput: {
        repo: 'munchist/duality',
        branch: 'phoenix/fix-typo',
        patchRef: 'inline:patch-bundle-ref',
      },
    },
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    inputZod: CodeRepoPushInputSchema,
    outputZod: CodeRepoPushOutputSchema,
  },
  {
    stepType: 'code',
    group: 'repo',
    verb: 'describe',
    name: 'Describe Repo',
    actionLabel: 'Resolving repo coordinates…',
    semanticDescription:
      'Resolve a repo designation to its public coordinates — owner, repo, default branch, and https remote URL — ' +
      'so a workflow can derive the owner/repo a GitHub API task needs without hardcoding them. ' +
      'A pure DB read + coordinate parse: no git, no clone, no harness, no network side effect, and it NEVER returns the ' +
      'git credential. Safe and idempotent for an agent to call.',
    tags: ['code', 'git', 'repo', 'read'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine:
        'Resolve a repo coordinate to { owner, repo, defaultBranch, remoteUrl } — no credential, no side effects.',
      whenToUse: [
        'Deriving owner/repo from a repo coordinate to feed a GitHub API task (open PR, poll CI, post comments).',
        'Reading the designation’s default branch before targeting a feature branch in a coding run.',
      ],
      whenNotToUse: [
        'Running the coding harness or producing a patch — that is code.agent.run.',
        'Pushing a patch bundle — that is code.repo.push.',
      ],
      pitfalls: [
        'Returns only PUBLIC coordinates — the git credential is never resolved or returned by this op.',
        'A designation that is not in the "ready" status is rejected (archived / provisioning / error cannot be described).',
      ],
      minimalExampleInput: {
        repo: 'munchist/duality',
      },
    },
    accessMode: 'read',
    inputZod: CodeRepoDescribeInputSchema,
    outputZod: CodeRepoDescribeOutputSchema,
  },
];
