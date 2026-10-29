import {
  AfterReviewOverrideSchema,
  MAX_PARENT_INPUTS_SERIALIZED_BYTES,
  PULL_REQUEST_TITLE_MAX_CHARS,
  PullRequestFindingsSchema,
  PullRequestGapsSchema,
  STORED_PAYLOAD_REF_PATTERN,
  type SkillCatalogEntry,
  toJsonSchemaSync,
} from '@aflow/schemas';
import {
  AFTER_REVIEW_BINDINGS,
  AFTER_REVIEW_VALUE,
  SETTLE_AFTER_REVIEW_TASK,
} from './publishLocalChangesAfterReview.js';
import { FIX_ROUND_TASKS, READ_REVIEW_TASK } from './publishLocalChangesFixRound.js';
import { decidePushTask } from './publishLocalChangesGate.js';
import {
  COMMISSION_RUN_ID_SCHEMA,
  COMMIT_MESSAGE_BINDINGS,
  COMMIT_MESSAGE_REQUIRED_WHEN,
  COMMIT_MESSAGE_VALUE,
  commitMessageTasks,
} from './publishLocalChangesMessage.js';
import { overrideTasks } from './publishLocalChangesOverride.js';
import {
  BASE,
  REPOSITORY,
  REPOSITORY_TASK_IDS,
  repositoryTasks,
} from './publishLocalChangesRepository.js';
import {
  CHECK_FAILED,
  CHECKS_COULD_NOT_RUN,
  CHECKS_STOPPED,
  PUBLISH_AS_IT_STANDS,
  PUBLISH_DESCRIPTION,
  PUBLISH_USAGE,
} from './publishLocalChangesProse.js';
import {
  DECIDE_REVIEW_DEPTH_TASK,
  RETRY_REVIEW_TASK_ID,
  REVIEW_DEPTH_AREAS,
  REVIEW_TASK_ID,
  REVIEW_TASKS,
  reviewBindings,
  reviewValue,
} from './publishLocalChangesReview.js';

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
 * or the gate cleared it without asking — and only the first can hold once
 * the approval ran: the approval asks exactly where the gate decided `ask`.
 * So a decline is followed whatever the posture or the decision, and nothing
 * holds when nothing was committed.
 */
const PUSH_CLEARED = {
  anyOf: [
    "tasks.approve-push.output.decision == 'approved'",
    "tasks.decide-push.output.decision == 'push'",
  ],
  onMissingRef: 'skip' as const,
};

/**
 * A branch the gate kept local opens and rewrites no pull request, whatever
 * else reads as done — read beside each pull-request task's own condition.
 */
const NOT_KEPT_LOCAL = "tasks.decide-push.output.decision != 'keep_local'";

/**
 * Where the push may follow the checks: they passed on the first run, or on
 * the second, where the first lost only tests to their time. Read by every
 * task that only runs on a commit the checks cleared.
 */
const CHECKS_CLEARED = {
  anyOf: ['tasks.check-commit.output.passed == true', 'tasks.recheck-commit.output.passed == true'],
  onMissingRef: 'skip' as const,
};

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
const OVERRIDE_SCHEMA = { ...toJsonSchemaSync(AfterReviewOverrideSchema) };

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

/** Equal to Local Code Review's `harness` schema (a test pins it), so a value this run accepts the review accepts too. */
const REVIEW_HARNESS_SCHEMA = { type: 'string', minLength: 1 };

/**
 * Which publication of the slice this is, as the caller counts them — the
 * one fact the rounds rule reads that no task of the run can: 1 for the
 * first, more once a fix round has run. Absent reads as the first.
 */
const ROUND_SCHEMA = { type: 'integer', minimum: 1, maximum: 1000, default: 1 };

const CHECK_INPUT_TEMPLATE = {
  bindingId: { $bind: 'bindingId' },
  sha: { $bind: 'sha' },
  base: { $bind: 'pushBaseSha' },
};

/** The run's whole input surface, which the entry task carries for the start to check against. */
const ENTRY_INPUT_CONTRACT = {
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
    commission: {
      kind: 'run_input' as const,
      bindAs: 'commission',
      path: 'commission',
      schema: COMMISSION_RUN_ID_SCHEMA,
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
    round: {
      kind: 'run_input' as const,
      bindAs: 'round',
      path: 'round',
      schema: ROUND_SCHEMA,
    },
    gaps: {
      kind: 'run_input' as const,
      bindAs: 'gaps',
      path: 'gaps',
      schema: GAPS_SCHEMA,
    },
    override: {
      kind: 'run_input' as const,
      bindAs: 'override',
      path: 'override',
      schema: OVERRIDE_SCHEMA,
    },
    reviewHarness: {
      kind: 'run_input' as const,
      bindAs: 'reviewHarness',
      path: 'reviewHarness',
      schema: REVIEW_HARNESS_SCHEMA,
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
};

const PUBLISH_LOCAL_CHANGES: SkillCatalogEntry = {
  catalogId: 'publish-local-changes',
  version: 49,
  name: 'Publish Local Changes',
  tagline:
    'Commit a patch onto a branch of a connected repository, then push it and open the pull request — asking the operator first unless the folder says otherwise.',
  description: PUBLISH_DESCRIPTION,
  tags: ['coding', 'publish', 'git', 'local', 'developer-tools'],
  capabilityHints: [
    {
      apiId: 'github',
      description:
        "GitHub REST API — read the repository before the push, then find the open pull request for the pushed branch and rewrite its description, or open one where there is none; where an override names the hands-off label or a shepherd rule, read that pull request's labels and the shepherd's pinned handoff comment to verify it.",
      requiredEndpoints: [
        'getRepository',
        'listPullRequests',
        'getIssueComment',
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
      usage: PUBLISH_USAGE,
      goal: "Turn a patch into a commit on a branch of a connected repository and, once the push is cleared, a pushed branch and an open pull request — with nothing leaving the machine before the operator approves, unless the folder's push approval says it need not ask.",
      mode: 'process' as const,
      outcomes: [
        {
          id: 'change-published',
          name: 'Change published',
          evaluator: {
            type: 'manual' as const,
            instruction:
              "The patch was committed onto its branch of the connected repository without changing the working tree, the folder's checks passed on it or none are declared, and everything the push would add was scanned with no secret found, and either the push was cleared — by the operator, the folder's push approval or the review — and the branch was pushed and opened as a pull request, or the operator declined or the decision was fix_before_merge and the branch stayed local.",
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
            "The commit the patch was made against, as the commission reported it in `baseSha`. Required to append to an existing branch, and it must be that branch's head. A new branch is created at it, even where the folder's last commit is behind or ahead of it — a commission started from a remote fetched it into the folder; without it, a new branch starts at the folder's last commit. As it stands: an earlier publication's `commit.sha`; the branch goes at its head, if that holds it.",
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
          id: 'commission',
          required: false,
          description:
            'The run id of the Commission Change that made the change, beside its `patchRef`. The commit carries the `summary` — a title line and one paragraph — of the commission on this folder that reported the `patchRef`, found by it with or without this id; a run id naming any other run is refused, and nothing is committed. Left out for a diff the operator hands over, which takes `commitMessage`.',
          schema: COMMISSION_RUN_ID_SCHEMA,
        },
        {
          id: 'commitMessage',
          required: false,
          // A diff handed over or a merge alone has no commission to take a
          // message from, so the start refuses it without one.
          requiredWhen: COMMIT_MESSAGE_REQUIRED_WHEN,
          description:
            "The commit message, only to say it otherwise than the commission's `summary`, which a change published by its `patchRef` is committed under: a title line under 72 characters, a blank line, then what it does and why. Required for a `patch` or a merge alone. The pull request's body carries it, and a new branch's first subject is its title. Left out for a branch as it stands.",
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
            "Words for the pull request's body, only where a person wants to say something themselves: they head the body, and the body composed from the branch follows under them whole — every commit's message, the review's findings, the decision on them and any override, the checks and the known gaps — closed by the loop's marker, which the Local PR Shepherd tends by. A summary never replaces what the publication records.",
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
          id: 'round',
          required: false,
          description:
            "Which publication of this slice this is: 1, the default, for its first; one more than the publication before it for each publication of a fix round on the same branch. The rounds rule decides the review's findings on it — on the first, an approving review with a minor or worse takes a fix round (`fix_before_merge`); after that round, the same review publishes as is, its findings carried open. Count it from the publications of this branch that ran; never guess it.",
          schema: ROUND_SCHEMA,
        },
        {
          id: 'gaps',
          required: false,
          description:
            "What the branch's commissions reported they left undone or could not verify, one item each, in their words. Omitted, the pull request says none were recorded.",
          schema: GAPS_SCHEMA,
        },
        {
          id: 'override',
          required: false,
          description:
            "Publish as is over this run's decision on its review's findings, on an explicit act the run verifies: `by` — `operator`, their word, taken at this run's approval; `hands_off_label`, the label, read on the branch's open pull request; `shepherd_rule`, the budget spent, read in the shepherd's pinned record there — and `reason`, which the pull request records. One it cannot verify fails the run. Omit it to follow the decision. Never stands in for an `always` folder or an uncleared scan.",
          schema: OVERRIDE_SCHEMA,
        },
        {
          id: 'reviewHarness',
          required: false,
          description:
            "Which coding agent runs this publication's Local Code Review, by the id the operator configured on the machine — passed to the review as its `harness`. Omit it and the review runs on its own default: the space's preferred coding agent, else the machine's default. Only a folder whose push approval is reviewed starts a review; elsewhere it is unused.",
          schema: REVIEW_HARNESS_SCHEMA,
        },
        {
          id: 'owner',
          required: false,
          description:
            "The repository owner by name alone, not a URL or `owner/repo` — only to publish somewhere other than the folder's `origin`, whose owner the run reads from the folder when this is left out.",
          schema: OWNER_SCHEMA,
        },
        {
          id: 'repo',
          required: false,
          description:
            "The repository name alone, not a URL or `owner/repo` — only to publish somewhere other than the folder's `origin`, whose name the run reads from the folder when this is left out.",
          schema: REPO_SCHEMA,
        },
        {
          id: 'base',
          required: false,
          description:
            "The branch the pull request targets, by name alone — only to target another than the repository's default branch, which the run reads from the folder (the branch `origin`'s HEAD names) when this is left out.",
          schema: { type: 'string', minLength: 1, maxLength: 200 },
        },
      ],
      tasks: [
        ...commitMessageTasks(ENTRY_INPUT_CONTRACT),
        ...repositoryTasks('message-from'),

        {
          taskId: 'commit',
          name: 'Commit the patch on its branch',
          goal: "Apply the patch in a detached worktree and commit it, under the caller's message or the commission's summary — on a new branch at the commit the patch was made against (the connected folder's last commit when none is given), or on top of the existing branch it was made on — after fetching the base branch from `origin`, so the commit reports everything a push of it would add. With no change given, commit nothing and report the branch's head as it stands. The operator's working tree is not touched, and nothing leaves the machine.",
          type: 'operation' as const,
          operation: 'host.file.patch',
          dependsOn: ['message-from', 'find-commission', 'read-commission', ...REPOSITORY_TASK_IDS],
          retryability: 'unsafe' as const,
          inputBindings: {
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            patchRef: { kind: 'run_input' as const, path: 'patchRef' },
            patch: { kind: 'run_input' as const, path: 'patch' },
            branch: { kind: 'run_input' as const, path: 'branch' },
            baseSha: { kind: 'run_input' as const, path: 'baseSha' },
            mergeFrom: { kind: 'run_input' as const, path: 'mergeFrom' },
            ...COMMIT_MESSAGE_BINDINGS,
            base: BASE,
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
              message: COMMIT_MESSAGE_VALUE,
              baseSha: { $bind: 'baseSha' },
              mergeFrom: { $bind: 'mergeFrom' },
              // The push sends every ancestor `origin` lacks, not this commit
              // alone, so the scan and the review read the range measured
              // against the base as `origin` holds it now.
              pushBase: { $bind: 'base' },
              // What the review's depth is decided from.
              pushAreas: REVIEW_DEPTH_AREAS,
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
            ...REPOSITORY,
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

        DECIDE_REVIEW_DEPTH_TASK,
        ...REVIEW_TASKS,

        SETTLE_AFTER_REVIEW_TASK,

        ...overrideTasks(CHECKS_CLEARED),

        {
          taskId: 'describe-pr',
          name: 'Compose the pull request from the branch',
          goal: "Compose the pull request's title and body from everything the push sends — the subject of the branch's first commit as the title, and as the body every commit's message oldest first, the review findings closed and left open, the folder's checks as verification, and the gaps the commissions recorded — and read that text for secrets, before anything is pushed. A title a person passed stands as it is; a summary heads the body, never replaces it. Not composed where an override was refused.",
          failureInstruction:
            "The pull request composed from the branch holds what looks like a secret, named above by where it is in the title or the body, line and rule — never by its value — and nothing was pushed: the commit is still on its branch in the folder. Where the line came from `findings` or `gaps`, or from a title or summary passed in, publish this branch as it stands without it. Where it came from the review's summary or the end of what the checks printed, that text is the review's or the checks' own: take the secret out of the code or the environment they read, rotate it if it was real, and publish again. Where it came from a commit's message — a line marked allowed, which the scan let the operator read — that commit has to be rewritten before the branch is published.",
          type: 'operation' as const,
          operation: 'host.commit.describe',
          dependsOn: [
            'commit',
            'check-commit',
            'recheck-commit',
            'scan-commit',
            REVIEW_TASK_ID,
            RETRY_REVIEW_TASK_ID,
            SETTLE_AFTER_REVIEW_TASK.taskId,
            'verify-override',
          ],
          // Skipped as well where the checks did not clear, since the check
          // of the override runs only where they did: the override it is
          // handed is one whose authority held, or one that sets nothing aside.
          when: {
            expression: "tasks.verify-override.output.decision != 'refused'",
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          maxAttempts: 1,
          // Whole outputs, each absent where its task did not run: a review
          // that failed or was never started is reported as none finishing,
          // and its findings, and the decision on them, are what the pull
          // request records of it.
          inputBindings: {
            ...AFTER_REVIEW_BINDINGS,
            bindingId: { kind: 'run_input' as const, path: 'bindingId' },
            range: { kind: 'task_output' as const, taskId: 'commit', path: 'commit.pushRange' },
            title: { kind: 'run_input' as const, path: 'title' },
            summary: { kind: 'run_input' as const, path: 'summary' },
            findings: { kind: 'run_input' as const, path: 'findings' },
            gaps: { kind: 'run_input' as const, path: 'gaps' },
            override: { kind: 'run_input' as const, path: 'override' },
            ...reviewBindings('review'),
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
            review: reviewValue('review'),
            check: { $bind: 'check' },
            recheck: { $bind: 'recheck' },
            gaps: { $bind: 'gaps' },
            afterReview: AFTER_REVIEW_VALUE,
            override: { $bind: 'override' },
          },
          outputProjection: {
            title: { path: 'title', onMissing: 'error' as const },
            body: { path: 'body', onMissing: 'error' as const },
            findings: { path: 'findings', onMissing: 'error' as const },
            // Absent where the hand-on left none out.
            findingsLeftOut: { path: 'findingsLeftOut', onMissing: 'null' as const },
            // Absent where the review did not finish, so nothing was decided.
            afterReview: { path: 'afterReview', onMissing: 'null' as const },
            // Absent where no override set a decision aside.
            afterReviewOverride: { path: 'afterReviewOverride', onMissing: 'null' as const },
            // Absent where the review returned no findings.
            severest: { path: 'severest', onMissing: 'null' as const },
          },
          promoteOutputs: [
            { kind: 'output_path' as const, path: 'afterReview', toState: 'afterReview' },
            {
              kind: 'output_path' as const,
              path: 'afterReviewOverride',
              toState: 'afterReviewOverride',
            },
            { kind: 'output_path' as const, path: 'findings', toState: 'findings' },
            { kind: 'output_path' as const, path: 'findingsLeftOut', toState: 'findingsLeftOut' },
          ],
        },

        decidePushTask(CHECKS_CLEARED),

        ...FIX_ROUND_TASKS,

        {
          taskId: 'approve-push',
          name: 'Approve the push',
          goal: "Operator approval before anything leaves the machine, asked exactly where the gate decided to ask: the folder asks before every push; the scan marked a line allowed or could not read a file, whatever the posture; or, unless reviewed, a blocker or a major is among this run's review findings, the operator's word set the decision aside, the review found nothing and did not approve, or it ended without a result and so did its one retry. Approving pushes the commit to its branch on origin and opens the pull request; declining leaves the branch on the machine, whatever the posture.",
          type: 'human' as const,
          intent: 'approve' as const,
          failureMode: 'isolate' as const,
          dependsOn: ['read-repository', 'scan-commit', 'decide-push'],
          approves: ['commit'],
          when: {
            expression: "tasks.decide-push.output.decision == 'ask'",
            onMissingRef: 'skip' as const,
          },
          // The prompt is fixed text and the verdict is not a value it can
          // carry, so each case is one line and the verdict and the decision
          // are named where the run shows them; the gate's reason is on its task.
          pauseInstruction:
            'The change is committed on its branch in the connected folder, and nothing has left the machine. The push would add every commit of `pushRange` — this commit, and any of the folder\'s own under it that `origin` does not have yet. The scan read them for secrets and found none outside the lines and files listed below, where there are any. Asked for one of these, shown with the commit:\n- `always`: the folder\'s push approval asks before every push, and no review ran.\n- `unless-unreviewed`, a blocker or a major among the findings: a decision stands in for an approving verdict only over minor findings and nits, so whatever was decided — by the rounds rule on the "Decide by the rounds rule whether the findings are fixed before merging" task, or by an override — the operator decides whether the push goes; the findings are on the "Review the commit" task.\n- `unless-unreviewed`, the decision set aside on the operator\'s word: the override and its reason are on the run as `afterReviewOverride`. Approving is that word on record; declining pushes nothing and the decision stands.\n- `unless-unreviewed`, no findings: this run\'s Local Code Review of `pushRange` did not return `approve` — its verdict is on the "Review the commit" task, or on the "Review the commit again, once" task where the review was retried, and that task failed where the review could not start.\n- `unless-unreviewed`, no result twice: the review ended without a result — its run failed, or its harness exited without writing one — so it was retried once in place, as the "Review the commit again, once" task, and the retry ended without a result as well. Nothing was decided on findings, so nothing stands in for the operator; each review\'s run says how it ended.\n- Lines marked allowed, whatever the posture: `allowed` names each by file, line and rule — a line that looks like a secret and ends in an `aflow-scan: allow` comment, which whoever wrote the change could have written as easily as the line — and no review ran. Read each of those lines before approving: approving pushes them.\n- Files, messages or texts the scan could not read whole, whatever the posture: `unscanned` names each and why — binary, a NUL byte in a line it adds, more than the scan reads of one file in one commit, a line too long to read, or a Git LFS pointer, whose content the push uploads without the scan having read it — and no review ran. Nothing unread there was checked for secrets; read it before approving.\nApproving pushes that commit to its branch on `origin`, with every commit of `pushRange` under it, and then opens a pull request against the base branch. Declining leaves the branch local whatever the folder\'s push approval says: nothing is pushed and no pull request is opened.',
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
          failureInstruction: `Nothing was pushed, and the commit is still on its branch in the folder. Where the message above says the commit no longer merges cleanly into \`origin\`'s base branch, which moved on since the scan, the remedy is the merge round it names: commission the fix from this branch with \`mergeFrom: origin/<base>\`, and publish it onto this branch with the sha the commission reports in \`merge.from\` as \`mergeFrom\`. Where it says the push scanned the range it sends and found what looks like a secret, the commits \`origin\`'s base gained are not the cause: the secret is in this branch, and is handled as a finding of the scan is. Where it says the receipt's range starts at a commit \`origin\`'s base branch no longer holds — the base was rewound — or that \`origin\` pushes somewhere other than where it fetches from, put that right — for a push URL, the folder has to push where it fetches — and publish this branch as it stands. Where it says the push carries no check receipt the executor issued — the executor restarted since the checks — one more than a day old, or one for checks the folder no longer declares, the checks have to run again on the commit: publish this branch as it stands. ${PUBLISH_AS_IT_STANDS} Never publish the commission's patch again: the branch already holds it, and a patch is appended only to the commit it was made against. Where it says no approval of this push is on record, nothing was pushed: the operator's approval in this run is what lets a range the scan did not clear leave the machine, and any push at all from a folder whose push approval is \`always\`. Otherwise git's own message says why the remote refused the update.`,
          type: 'operation' as const,
          operation: 'host.process.exec',
          // The scan and the check as well as the approval: where the gate
          // pushes without asking the approval is skipped, and a skip clears
          // a dependency where a failure does not. The pull request's text as
          // well, so text that cannot go out stops the run before the branch has.
          dependsOn: [
            'approve-push',
            'decide-push',
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
            base: BASE,
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
          dependsOn: ['push', 'decide-push'],
          when: {
            allOf: ['tasks.push.output.exitCode == 0', NOT_KEPT_LOCAL],
            onMissingRef: 'skip' as const,
          },
          retryability: 'safe' as const,
          maxAttempts: 2,
          inputBindings: {
            ...REPOSITORY,
            branch: { kind: 'run_input' as const, path: 'branch' },
            base: BASE,
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
            allOf: ['tasks.find-pr.output.prNumber != null', NOT_KEPT_LOCAL],
            onMissingRef: 'skip' as const,
          },
          // The same text sent twice leaves the same pull request.
          retryability: 'safe' as const,
          maxAttempts: 2,
          // The title only where a person passed one: a title edited on
          // GitHub since is theirs, and the slice's would overwrite it.
          inputBindings: {
            ...REPOSITORY,
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
            allOf: ['tasks.find-pr.output.prNumber == null', NOT_KEPT_LOCAL],
            onMissingRef: 'skip' as const,
          },
          retryability: 'unsafe' as const,
          maxAttempts: 2,
          inputBindings: {
            ...REPOSITORY,
            branch: { kind: 'run_input' as const, path: 'branch' },
            base: BASE,
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

        READ_REVIEW_TASK,
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
            "What the rounds rule decided about the review's findings, as the pull request records it, and what the push gate followed: fix_before_merge — nothing pushed, the branch kept local — for a verdict short of approve, or a minor or worse in round 1; publish_as_is — pushed, asking only over a blocker or a major — for nits alone, or after round 1. Null where the review did not finish. On fix_before_merge the fix round, the conversation's or the shepherd's, takes `fixRound`.",
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'afterReviewOverride',
          name: 'Decision set aside',
          description:
            'The override that turned the decision into publish_as_is, once its authority was verified: by — operator, hands_off_label or shepherd_rule — its reason, and the decision it set aside. Null where the decision stood.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'overrideCheck',
          name: 'Override check',
          description:
            "What the check of an override's authority decided: none, where no override was passed or it set nothing aside; operator, taken at the push's approval; hands_off_label or shepherd_rule, verified from what the run read; refused, where it could not be verified — the run failed with nothing pushed.",
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'overrideCheckReason',
          name: 'Why the override check decided so',
          description: 'The reason of the rule that decided, naming what the run read.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'pushDecision',
          name: 'Push gate',
          description:
            'What the push gate decided: push, without asking; ask, the operator; or keep_local, nothing pushed — the decision fix_before_merge, a refused override, or a folder that allows no push.',
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'pushReason',
          name: 'Why the push gate decided so',
          description: "The gate's reason, as the rule that decided says it.",
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
            "The run of this publication's own review, where one started — its retry's, where the first ended without a result and it was run once more: its output holds every finding whole, with its evidence and suggestion — what a fix round is briefed from, less any finding of kind `needs_setup`, which is setup on the machine and no defect a fix settles.",
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'alternatives' as const,
        },
        {
          variableId: 'verdict',
          name: 'Review verdict',
          description:
            "What this publication's review returned — approve, request_changes or comment — read from the review run as it stands once the push went or the branch stayed local, so a review retried in place counts by its final attempt. Null where the review did not complete.",
          required: false,
          sensitive: false,
          immutable: false,
        },
        {
          variableId: 'fixRound',
          name: 'Fix round',
          description:
            "On fix_before_merge, what the fix round takes: `branch`, kept on the machine; `headSha`, its head; `baseMovedSince`, whether `origin`'s base moved past it; `reviewRunId`, the run the round is briefed from, less its `needs_setup` finding, which no fix on the branch settles; `findings`, the open ones; and `commissionInputs`, the exact Commission Change inputs — `base` the branch, with `mergeFrom: origin/<base>` where the base moved. Never base it on `origin/main`: the branch is not there.",
          required: false,
          sensitive: false,
          immutable: false,
          writers: 'alternatives' as const,
        },
      ],
      output: {
        primary: 'prUrl',
        guidance:
          'prUrl and prNumber are the branch’s pull request: report the link, pushReason and verdict. On afterReview fix_before_merge nothing was pushed: start Commission Change with fixRound.commissionInputs as they stand — never base origin/main — briefed from the fixRound.reviewRunId run’s findings less needs_setup (setup, not a fix), then publish its patchRef, baseSha and run id with fixRound.findings and the next round. Absent prUrl otherwise, the run kept local or failed: its account says why.',
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
      activationHint: 'Run to publish an existing patch onto a branch and into a pull request.',
      prerequisites: [],
      priority: 50,
    },
    rationale:
      "The approval between local and published. Repo and base default to the folder's. The message is the caller's, or the commission's summary read from its run. The commit lands in a detached worktree; checks run, test timeouts alone rerun; the scan reads all a push adds, a finding fails the run. Under unless-unreviewed a Local Code Review runs; the rounds rule decides: not approve is fix_before_merge; approve is publish_as_is over nits or past round 1, else fix_before_merge. An override is verified on GitHub or at the approval, or fails the run. decide-push gates the push by rules: uncleared scan or always asks, never pushes; fix_before_merge keeps the branch local and hands fixRound its commission inputs; publish_as_is pushes, asking over a blocker, major or the operator's word. The verdict is reread from the review run. No task starts a publication. Push argv pinned bar the refspec; the executor re-measures origin/<base> and needs the check receipt; an open PR is PATCHed.",
  },
};

export { PUBLISH_LOCAL_CHANGES };
