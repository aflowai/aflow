/**
 * Contract (Plan 321 §6, as far as it holds without a node): one pass of the
 * Local PR Shepherd decides from what it read and acts only on `fix`. The
 * graph is driven the way the harness drives it — ready tasks run, false
 * guards skip, a failed optional task satisfies its dependents and binds as
 * absent, a failed required one stops what depends on it — and the rules are
 * decided by the rule step itself. Only GitHub's, the machine's and the
 * decision model's answers are scripted.
 */
import { describe, expect, it } from 'vitest';
import {
  computeReadyTasksWithWhen,
  decideByRules,
  materializeSkillTasks,
  projectTaskOutput,
  readOutputPath,
  validateSkillPlanSeparation,
} from '@aflow/cybernetic-runtime';
import {
  AgentDefinitionSchema,
  FlowScheduleCreateInputSchema,
  FlowScheduleGetInputSchema,
  isScheduleRenewalDue,
  MAX_FIRINGS_CAP,
  SCHEDULE_RENEWAL_WINDOW,
  scheduleFiringsLeft,
  SHEPHERD_SCHEDULE_CRON_DEFAULT,
  SKILL_STARTER_SCHEDULE_VARIABLE,
  validateCronExpression,
  WORKFLOW_TASKS_MAX,
  type CheckRunsSummary,
  CheckRunsSummarySchema,
  decodeRequiredChecks,
  encodeRequiredChecks,
  HostHarnessRunInputSchema,
  JobLogExcerptSchema,
  LOCAL_PUBLISH_PULL_REQUEST_MARKER,
  type LoopPullRequest,
  LoopPullRequestSchema,
  LoopPullRequestsSchema,
  MemoryDeleteInputSchema,
  MemoryGetInputSchema,
  MemoryPutInputSchema,
  parseShepherdHandoff,
  type PullRequestReviews,
  PullRequestReviewsSchema,
  RequiredCheckNamesSchema,
  SHEPHERD_HAND_OVER_TARGET,
  SHEPHERD_LEASE_STALE_AFTER_MS,
  SHEPHERD_UNLISTED_PERSISTS_AFTER_MS,
  type ShepherdHandoffRead,
  ShepherdHandoffReadSchema,
  skillStarterAgentDefinition,
  substituteTemplateBinds,
  validateAgentDefinition,
  type WorkflowTask,
  WorkflowRunDecideInputSchema,
  WorkflowRunListInputSchema,
  WorkflowRunStartInputSchema,
} from '@aflow/schemas';
import { CYBERNETIC_AGENTS } from '../cyberneticAgents.js';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { COMMISSION_CHANGE } from './commissionChange.js';
import { LOCAL_PR_SHEPHERD } from './localPrShepherd.js';
import {
  MERGE_ASKED,
  PUBLICATION_COMMIT_TASK,
  PUBLICATION_PUSH_TASK,
  PUBLICATION_PUSHED_SHA_PATH,
} from './localPrShepherdMerge.js';
import {
  BASE_MOVED_MESSAGE,
  DECIDED_HAND_OVER,
  HAND_OVER_CASE_OTHERWISE,
  HAND_OVER_CASE_RULES,
  HAND_OVER_RULES,
  MERGE_REFUSAL_OTHERWISE,
  MERGE_REFUSAL_RULES,
  MERGE_ROUND_AFTER_BASE_MOVED,
  MERGE_RULES,
  SHEPHERD_RULES,
} from './localPrShepherdRules.js';
import { REMEDY_QUESTION, REMEDY_ROUTES, type Remedy } from './localPrShepherdDecisions.js';
import { BASE_MOVED_BRIEF, BUMP_BRIEF, FIX_BRIEF, MERGE_BRIEF } from './localPrShepherdRemedies.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';
import { skillGuidance } from '../__tests__/skillGuidance.js';

const wf = LOCAL_PR_SHEPHERD.bundle.workflow;
const tasks = materializeSkillTasks(wf.tasks as unknown as WorkflowTask[]);
const taskById = new Map(tasks.map((task) => [task.taskId, task]));

const HEAD = 'c'.repeat(40);
const MERGED_FROM = 'e'.repeat(40);
const FAILING_CHECK = '555';
const BRANCH = 'aflow/fix-flaky-test';

const PULL_REQUEST_URL = 'https://github.com/aflowai/aflow/pull/94';
const PLAN_NODE = '9e000000-0000-4000-8000-000000000322';

const PULL_REQUEST: LoopPullRequest = {
  number: 94,
  url: PULL_REQUEST_URL,
  state: 'open',
  title: 'Planted failing test',
  body: 'A test that fails.',
  headRef: BRANCH,
  headSha: HEAD,
  baseRef: 'main',
  ours: true,
  handsOff: false,
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  commentPages: 3,
};

/**
 * What GitHub sends beside a body, as the API executor keeps it: about 1.3 KB
 * on every answer, which a rule never reads.
 */
const GITHUB_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers':
    'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-SSO, X-GitHub-Request-Id, Deprecation, Sunset',
  'cache-control': 'private, max-age=60, s-maxage=60',
  'content-security-policy': "default-src 'none'",
  'content-type': 'application/json; charset=utf-8',
  date: 'Sun, 25 Oct 2026 09:00:00 GMT',
  etag: 'W/"3f8a8f3c0f5b6f7a4a1f9b2d7c1e0a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f"',
  'github-authentication-token-expiration': '2026-11-24 09:00:00 UTC',
  'referrer-policy': 'origin-when-cross-origin, strict-origin-when-cross-origin',
  server: 'github.com',
  'strict-transport-security': 'max-age=31536000; includeSubdomains; preload',
  vary: 'Accept, Authorization, Cookie, X-GitHub-OTP,Accept-Encoding, Accept, X-Requested-With',
  'x-accepted-oauth-scopes': 'repo',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'deny',
  'x-github-api-version-selected': '2022-11-28',
  'x-github-media-type': 'github.v3; format=json',
  'x-github-request-id': 'C0DE:1F2E3D:4C5B6A:7980A1:671B5E10',
  'x-oauth-scopes': 'repo, workflow',
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4987',
  'x-ratelimit-reset': '1792918800',
  'x-ratelimit-resource': 'core',
  'x-ratelimit-used': '13',
  'x-xss-protection': '0',
};

/** The pass's own run, and the time it is dispatched at. */
const RUN_ID = 'shepherd-run-2';
const NOW = Date.UTC(2026, 9, 18, 9, 0, 0);
const LOOP_LOGIN = 'aflow-app[bot]';

const FAILING: CheckRunsSummary = {
  state: 'failing',
  total: 3,
  failing: [{ id: FAILING_CHECK, name: 'Test', conclusion: 'failure', runId: 37460214524 }],
  firstFailing: { id: FAILING_CHECK, name: 'Test', conclusion: 'failure', runId: 37460214524 },
};

const NO_HANDOFF: ShepherdHandoffRead = {
  found: false,
  attemptCount: 0,
  nextAttemptCount: 1,
  trust: 'verified',
};
const UNDECIDED: ShepherdHandoffRead = { ...NO_HANDOFF, trust: 'undecided' };

const PUBLICATION_RUN = '00000000-0000-4000-8000-000000000321';
const MERGE_COMMIT = 'f'.repeat(40);
const NO_REVIEWS: PullRequestReviews = {
  changesRequestedBy: [],
  approvedBy: [],
  count: 0,
  complete: true,
};
const GREEN: CheckRunsSummary = { state: 'passing', total: 2, failing: [] };
const OWN_LEASE_HASH = 'own-lease-hash';
const HAND_OVER_SCHEDULE = '0f000000-0000-4000-8000-0000000000a1';

/** The patch each commission stores: the fix's as a first pass has it, every other its own. */
function patchOf(taskId: string): string {
  return taskId === 'fix' ? 'gs://bucket/patch-1' : `gs://bucket/${taskId}.patch`;
}

function presetOf(input: Record<string, unknown>): string {
  return String((input['response'] as { transformPresetId?: string }).transformPresetId);
}

interface Scenario {
  inputs?: Record<string, unknown>;
  listStatus?: number;
  /**
   * The repository has more than 100 open pull requests, and the loop's is
   * among the least recently updated: the first page of the list holds only
   * others', none of them the loop's.
   */
  buried?: boolean;
  pullRequest?: Partial<LoopPullRequest>;
  checks?: CheckRunsSummary;
  handoff?: ShepherdHandoffRead;
  /** A lease on the branch: its run's status (`gone` where it cannot be read) and its age. */
  lease?: {
    owner: 'running' | 'paused' | 'completed' | 'failed' | 'gone';
    ageMs: number;
    decision?: 'fix' | 'merge';
  };
  /** Another pass took the lease between this one's read and its write. */
  leaseTaken?: boolean;
  /** The handoff comment an earlier pass pinned: read by its id. `gone` where it was deleted. */
  pinned?: 'found' | 'gone';
  /** The pin's read itself failed — the store threw or answered an error — whether or not a pin is there. */
  pinRead?: 'fails';
  /** The pinned comment, there and the loop's, could not be read: GitHub answered this status, or the call failed outright. */
  pinnedRead?: number | 'fails';
  /** The pull request the pin was kept for, and the one its comment sits on. */
  pinFor?: number;
  pinnedCommentOn?: number;
  /** Another run took this pass's lease over while its work ran. */
  leaseTakenOver?: boolean;
  publicationInFlight?: boolean;
  commissionInFlight?: boolean;
  /**
   * The pull request's plan node, read through the run ledger: no node holds
   * it (the default), one does with nothing in flight, one does with a run in
   * flight, one does whose only run in flight is this pass's own, one does
   * with this pass's run and another's (listed first, or second), the plan under it passed one read's bounds, or the
   * read failed.
   */
  planNode?:
    | 'none'
    | 'idle'
    | 'in-flight'
    | 'own-run'
    | 'own-and-in-flight'
    | 'in-flight-and-own'
    | 'incomplete'
    | 'fails';
  remedy?: { value: Remedy | null; decided: boolean } | 'unavailable';
  failingJobs?: number;
  /**
   * What the commission returned: a patch, only the merge, no change at all —
   * its checkout already held the base, and it changed nothing — or nothing,
   * failing.
   */
  commission?: 'patch' | 'merge-only' | 'unchanged' | 'failed';
  /** The folder's merge posture, and its push approval: `when-green` merges only beside `unless-unreviewed`. */
  mergePosture?: 'never' | 'when-green';
  pushApproval?: 'always' | 'never' | 'unless-unreviewed';
  /** The base branch's required checks: from its rulesets, and from its classic protection. */
  required?: { rules?: string[]; protection?: string[]; rulesStatus?: number };
  /** How each check run on the head concluded, by name, where a required check is judged on it. */
  checkConclusions?: Record<string, string>;
  reviews?: PullRequestReviews;
  /** The one finished publication of the branch: the verdict its review returned, for the commit it reviewed and pushed. */
  publication?:
    | {
        verdict: string | null;
        at: string;
        retriedInPlace?: boolean;
        pushDecision?: string;
        overrideCheck?: string;
      }
    | 'none';
  /** The branch's finished publications, newest first, where there are several; over `publication`. */
  publications?: PublicationRecord[];
  /** Where the base branch stands now; `unread` where its read failed. */
  baseSha?: string;
  /**
   * How GitHub, or the operator, answers the merge: `refused` is GitHub's 409
   * on a head that moved, `base-moved` its 405 on a base that moved, and
   * `not-mergeable` its 405 on a pull request that does not merge.
   */
  merge?: 'merged' | 'refused' | 'declined' | 'base-moved' | 'not-mergeable';
  /** How GitHub answers the merge sent again after a base-moved refusal. */
  mergeAgain?: 'merged' | 'base-moved';
  /** The pull request as read again after a refused merge: its head, or the status GitHub answered. */
  reread?: { headSha?: string; status?: number };
  /**
   * The space's memory of merge outcomes, by path, shared by passes that
   * overlap: what one pass records under the lease, the next one reads.
   */
  mergeOutcomes?: Map<string, Record<string, unknown>>;
  /** The claim on the head fails though nothing is recorded — the store refused it. */
  claimFails?: true;
  /** The outcome's write after the merge fails, leaving the claim as the record. */
  outcomeWriteFails?: true;
  /** The attempt state the pin kept beside the comment's id, as the pin write stored it: text. */
  pinState?: { attemptCount: string; checkRunId: string; remedyBaseSha?: string };
  /** The pull request the last pass aimed at none tended; `fails` where its read failed. */
  turn?: number | 'fails';
  /** How long ago the turn notes GitHub first refused to list the pull requests, where it notes it. */
  unlistedForMs?: number;
  /**
   * The space's memory of heads handed to a person, by path, shared by passes
   * that overlap or follow one another.
   */
  abandonClaims?: Map<string, Record<string, unknown>>;
  /** What this pass's claim read saw, where another pass wrote between its read and its write. */
  claimsAsRead?: Map<string, Record<string, unknown>>;
  /** The claim's write lands, but its task does not report success. */
  claimUnreported?: true;
  /** The pass a head's claim names, as `workflow.run.detail` reads it; `gone` where it cannot be read. */
  abandonOwner?:
    | { status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'; answered?: boolean }
    | 'gone';
  /** The schedule that started the pass, as agent.schedule.get reads it; `unread` where the read fails. */
  schedule?: { firingCount: number; status?: 'active' | 'paused' } | 'unread';
  /** The renewal is refused, however due the schedule is. */
  renewalFails?: true;
  /**
   * The space's memory of cases handed to the Helmsman, by path, shared by
   * passes that overlap or follow one another.
   */
  handOvers?: Map<string, Record<string, unknown>>;
  /** The schedule that would start the Helmsman's conversation is refused. */
  handOverFails?: true;
  /** How many of the loop's open pull requests the list holds; one where unnamed. */
  listed?: number;
}

/** One publication of the branch: its run, its review's verdict and the commit it reviewed, and the commit its push sent, if it pushed. */
interface PublicationRecord {
  pushDecision?: string;
  overrideCheck?: string;
  id: string;
  verdict: string | null;
  reviewed: string;
  pushed: string | null;
  /** Its review failed and was retried in place: the read carries the review run's final attempt. */
  retriedInPlace?: boolean;
}

function publicationsOf(s: Scenario): PublicationRecord[] {
  if (s.publications !== undefined) return s.publications;
  const publication = s.publication ?? { verdict: 'approve', at: HEAD };
  return publication === 'none'
    ? []
    : [
        {
          id: PUBLICATION_RUN,
          pushDecision: publication.pushDecision ?? 'ask',
          ...(publication.overrideCheck === undefined
            ? {}
            : { overrideCheck: publication.overrideCheck }),
          verdict: publication.verdict,
          reviewed: publication.at,
          pushed: publication.at,
          ...(publication.retriedInPlace === true ? { retriedInPlace: true } : {}),
        },
      ];
}

/** What a publication's tasks recorded, as the ledger keeps them: only a task that succeeded has a record. */
function publicationTaskOutputs(publication: PublicationRecord): Record<string, unknown> {
  return {
    commit: { commit: { sha: publication.pushed ?? publication.reviewed } },
    ...(publication.pushed !== null ? { push: { exitCode: 0 } } : {}),
  };
}

/** A stored claim's content hash, as the store answers it: one per content. */
function hashOf(content: Record<string, unknown>): string {
  return `hash:${JSON.stringify(content)}`;
}

interface Pass {
  ran: string[];
  inputs: Map<string, Record<string, unknown>>;
  outputs: Map<string, Record<string, unknown>>;
  statuses: Map<string, string>;
  decision: string | undefined;
  handoff: ReturnType<typeof parseShepherdHandoff> | undefined;
}

function bound(
  task: WorkflowTask,
  outputs: ReadonlyMap<string, Record<string, unknown>>,
  runInputs: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(task.inputBindings ?? {})) {
    let value: unknown;
    if (binding.kind === 'run_input') value = runInputs[binding.path];
    if (binding.kind === 'run_id') value = RUN_ID;
    if (binding.kind === 'clock') {
      const at = NOW + (binding.offsetMs ?? 0);
      value = binding.format === 'iso' ? new Date(at).toISOString() : at;
    }
    if (binding.kind === 'task_output') {
      const output = outputs.get(binding.taskId);
      value =
        output === undefined
          ? undefined
          : binding.path
            ? readOutputPath(output, binding.path)
            : output;
    }
    if (value !== undefined) values[name] = value;
  }
  return values;
}

type Answer = { ok: true; output: Record<string, unknown> } | { ok: false };

function answer(taskId: string, input: Record<string, unknown>, s: Scenario): Answer {
  const ok = (output: Record<string, unknown>): Answer => ({ ok: true, output });
  const github = (data: unknown, statusCode = 200) =>
    ok({ statusCode, headers: GITHUB_HEADERS, data, durationMs: 212, sizeBytes: 4096 });
  switch (taskId) {
    case 'read-folder':
      return ok({
        id: 'hb_aflow',
        origin: { owner: 'aflowai', repo: 'aflow' },
        branchPolicy: {
          branchPrefix: 'aflow/',
          pushApproval: s.pushApproval ?? 'unless-unreviewed',
          mergePosture: s.mergePosture ?? 'never',
          checksTimeoutMs: 1_800_000,
        },
        sandbox: 'open',
        maxConcurrentHarnessRuns: 2,
        keepAwake: 'on-ac',
      });
    case 'list-prs': {
      // A refused call shapes nothing: its body is GitHub's error, as it wrote it.
      if (s.listStatus !== undefined) return github({ message: 'Bad credentials' }, s.listStatus);
      const pr = { ...PULL_REQUEST, ...s.pullRequest };
      if (s.buried) return github(LoopPullRequestsSchema.parse({ pullRequests: [], count: 0 }));
      const others = Array.from({ length: (s.listed ?? 1) - 1 }, (_, i) => ({
        number: pr.number + 1 + i,
        title: `Another change of the loop's, number ${String(i + 1)}`,
        headRef: `aflow/another-change-${String(i + 1)}`,
        headSha: String(i % 10).repeat(40),
        baseRef: 'main',
        updatedAt: '2026-10-18T07:00:00Z',
        handsOff: false,
      }));
      return github(
        LoopPullRequestsSchema.parse({
          pullRequests: [
            {
              number: pr.number,
              title: pr.title,
              headRef: pr.headRef,
              headSha: pr.headSha,
              baseRef: pr.baseRef,
              updatedAt: '2026-10-18T08:00:00Z',
              handsOff: pr.handsOff,
            },
            ...others,
          ],
          count: 1 + others.length,
        }),
      );
    }
    case 'read-pr': {
      // GitHub answers the number asked for, wherever it sits among the open ones.
      const pr = LoopPullRequestSchema.parse({ ...PULL_REQUEST, ...s.pullRequest });
      const asked = (input['params'] as { pull_number?: unknown }).pull_number;
      return String(asked) === String(pr.number)
        ? github(pr)
        : github({ message: 'Not Found' }, 404);
    }
    case 'read-pr-checks': {
      // Given the base branch's required checks, the read judges each on the
      // head, as the executor's `loop_checks` does.
      const preset = presetOf(input);
      const colon = preset.indexOf(':');
      const summary = s.checks ?? FAILING;
      if (colon === -1) return github(CheckRunsSummarySchema.parse(summary));
      const required = decodeRequiredChecks(preset.slice(colon + 1));
      const conclusions = s.checkConclusions ?? {};
      const unmet = required.flatMap((name) => {
        const conclusion = conclusions[name] ?? 'no check run';
        return conclusion === 'success' ? [] : [{ name, conclusion }];
      });
      return github(
        CheckRunsSummarySchema.parse({
          ...summary,
          required: {
            state: required.length === 0 ? 'none' : unmet.length === 0 ? 'passed' : 'unmet',
            required,
            unmet,
            ...(unmet.length > 0
              ? { summary: unmet.map((u) => `\`${u.name}\` (${u.conclusion})`).join(', ') }
              : {}),
          },
        }),
      );
    }
    case 'read-required-rules': {
      if (s.required?.rulesStatus !== undefined) {
        return github({ message: 'Server Error' }, s.required.rulesStatus);
      }
      const names = s.required?.rules ?? ['Test'];
      return github(
        RequiredCheckNamesSchema.parse({ names, encoded: encodeRequiredChecks(names) }),
      );
    }
    case 'read-required-protection': {
      const preset = presetOf(input);
      const fromRules = decodeRequiredChecks(preset.slice(preset.indexOf(':') + 1));
      const names = [...new Set([...fromRules, ...(s.required?.protection ?? [])])].sort();
      return github(
        RequiredCheckNamesSchema.parse({ names, encoded: encodeRequiredChecks(names) }),
      );
    }
    case 'read-pr-reviews':
      return github(PullRequestReviewsSchema.parse(s.reviews ?? NO_REVIEWS));
    case 'read-publication': {
      // As the ledger selects: newest first, only runs that succeeded in every
      // named task with the value recorded where one is named.
      const query = WorkflowRunListInputSchema.parse(input);
      const selected = publicationsOf(s).filter((publication) => {
        const recorded = publicationTaskOutputs(publication);
        return (query.succeeded ?? []).every(
          (task) =>
            recorded[task.taskId] !== undefined &&
            (task.output === undefined ||
              readOutputPath(recorded[task.taskId], task.output.path) === task.output.equals),
        );
      });
      return ok({
        runs: selected.slice(0, query.limit).map((publication) => ({
          id: publication.id,
          status: 'completed',
          startedAt: '2026-10-18T07:00:00Z',
          own: false,
        })),
        hasMore: selected.length > query.limit,
      });
    }
    case 'read-publication-review': {
      const publication = publicationsOf(s).find((p) => p.id === input['runId']);
      if (publication === undefined) return { ok: false };
      return ok({
        result: {
          output: Object.fromEntries(
            [
              ['verify-override', publication.overrideCheck],
              ['decide-push', publication.pushDecision],
            ].map(([taskId, decision]) => {
              const task = PUBLISH_LOCAL_CHANGES.bundle.workflow.tasks.find(
                (task) => task.taskId === taskId,
              )!;
              const promotion = task.promoteOutputs?.find(
                (rule) => rule.kind === 'output_path' && rule.path === 'decision',
              );
              expect(promotion).toBeDefined();
              return [promotion!.toState, decision];
            }),
          ),
        },
        run: { runId: publication.id, status: 'completed' },
        tasks: [],
        activeWaiters: [],
        // As `workflow.run.detail` reads a task that waited on a run: where
        // the review failed and its retry in place completed, from the
        // review run's final attempt, marked `fromRun`.
        taskOutput: {
          taskId: 'review-commit',
          output: {
            verdict: publication.verdict,
            reviewSummary: 'Read.',
            findings: [],
            outcome: 'completed',
            reviewRunId: 'review-run',
            reviewed: { bindingId: 'hb_aflow', from: 'b'.repeat(40), at: publication.reviewed },
          },
          ...(publication.retriedInPlace === true
            ? { fromRun: { runId: 'review-run', status: 'completed' } }
            : {}),
        },
      });
    }
    case 'merge': {
      const merge = s.merge ?? 'merged';
      // A declined approval fails the task as a permission error, so it binds as absent.
      if (merge === 'declined') return { ok: false };
      if (merge === 'refused') {
        return github(
          { message: 'Head branch was modified. Review and try the merge again.' },
          409,
        );
      }
      if (merge === 'base-moved') return github({ message: BASE_MOVED_MESSAGE }, 405);
      if (merge === 'not-mergeable') {
        return github({ message: 'Pull Request is not mergeable' }, 405);
      }
      return github({
        sha: MERGE_COMMIT,
        merged: true,
        message: 'Pull Request successfully merged',
      });
    }
    case 'reread-pr-after-refusal': {
      if (s.reread?.status !== undefined) {
        return github({ message: 'Server Error' }, s.reread.status);
      }
      return github(
        LoopPullRequestSchema.parse({
          ...PULL_REQUEST,
          ...s.pullRequest,
          ...(s.reread?.headSha !== undefined ? { headSha: s.reread.headSha } : {}),
          mergeable: null,
          mergeableState: 'unknown',
        }),
      );
    }
    case 'merge-again':
      return (s.mergeAgain ?? 'merged') === 'merged'
        ? github({ sha: MERGE_COMMIT, merged: true, message: 'Pull Request successfully merged' })
        : github({ message: BASE_MOVED_MESSAGE }, 405);
    case 'judge-merge-refusal':
    case 'record-merge':
      return ok({ ...decideByRules(WorkflowRunDecideInputSchema.parse(input)) });
    case 'claim-merge': {
      // A create: it fails where anything is recorded at the path.
      const put = MemoryPutInputSchema.parse(input);
      expect(put.writeMode).toBe('create');
      if (s.claimFails === true || s.mergeOutcomes?.has(put.path) === true) return { ok: false };
      const claim = put.content.inlineJson as Record<string, unknown>;
      s.mergeOutcomes?.set(put.path, claim);
      return ok({ id: 'doc-3', path: put.path, version: 1, contentHash: hashOf(claim) });
    }
    case 'release-merge-claim': {
      // The delete holds only while the claim is as this pass wrote it.
      const del = MemoryDeleteInputSchema.parse(input);
      const path = String(del.target.path);
      const there = s.mergeOutcomes?.get(path);
      if (there !== undefined && del.expectedHash !== hashOf(there)) return { ok: false };
      s.mergeOutcomes?.delete(path);
      return ok({ id: 'doc-3', path, deleted: true, entryType: 'document' });
    }
    case 'remember-merge-outcome': {
      const put = MemoryPutInputSchema.parse(input);
      if (s.outcomeWriteFails === true) return { ok: false };
      s.mergeOutcomes?.set(put.path, put.content.inlineJson as Record<string, unknown>);
      return ok({ id: 'doc-3', path: put.path, version: 2 });
    }
    case 'read-handoff-pin': {
      // The read asks to be told a missing pin apart from a failed read: one
      // that is not there answers found: false. A pin is kept per pull
      // request, so another pull request's is not there.
      const read = MemoryGetInputSchema.parse(input);
      if (s.pinRead === 'fails') return { ok: false };
      return s.pinned === undefined ||
        !String(read.target.path).endsWith(`/pulls/${String(s.pinFor ?? 94)}.json`)
        ? read.ifMissing === 'absent'
          ? ok({ found: false })
          : { ok: false }
        : ok({
            stat: { path: 'pin' },
            dataJson: { commentId: 9, author: LOOP_LOGIN, ...s.pinState },
          });
    }
    case 'read-pr-handoff-pinned': {
      // Deleted, the comment answers 404 with GitHub's error, which shapes no record.
      if (s.pinned === 'gone') return github({ message: 'Not Found' }, 404);
      if (s.pinnedRead === 'fails') return { ok: false };
      if (s.pinnedRead !== undefined) return github({ message: 'Server Error' }, s.pinnedRead);
      const [, author, number] = presetOf(input).split(':');
      // The preset takes a record only from the pinned author, on this pull request.
      const on = s.pinnedCommentOn ?? s.pinFor ?? 94;
      return github(
        ShepherdHandoffReadSchema.parse(
          author === LOOP_LOGIN && number === String(on) ? (s.handoff ?? NO_HANDOFF) : NO_HANDOFF,
        ),
      );
    }
    case 'read-pr-handoff': {
      // As the executor's `loop_handoff` does: with no handoff on the page,
      // the state a pin kept stands.
      const [, author, , attempts, checkRunId] = presetOf(input).split(':');
      const kept: ShepherdHandoffRead | undefined =
        attempts === undefined
          ? undefined
          : {
              found: false,
              attemptCount: Number(attempts),
              nextAttemptCount: Number(attempts) + 1,
              ...(checkRunId ? { checkRunId } : {}),
              trust: 'verified',
            };
      return github(
        ShepherdHandoffReadSchema.parse(
          author === '' ? UNDECIDED : (s.handoff ?? kept ?? NO_HANDOFF),
        ),
      );
    }
    case 'read-turn': {
      MemoryGetInputSchema.parse(input);
      if (s.turn === 'fails') return { ok: false };
      const turn = {
        pullNumber: s.turn,
        ...(s.unlistedForMs !== undefined ? { unlistedAtMs: NOW - s.unlistedForMs } : {}),
      };
      return ok(
        s.turn === undefined && s.unlistedForMs === undefined
          ? { found: false }
          : { stat: { path: 'turn', contentHash: hashOf(turn) }, dataJson: turn },
      );
    }
    case 'claim-hand-over': {
      // A create: refused where the case is recorded already.
      const put = MemoryPutInputSchema.parse(input);
      expect(put.writeMode).toBe('create');
      if (s.handOvers?.has(put.path) === true) return { ok: false };
      s.handOvers?.set(put.path, put.content.inlineJson as Record<string, unknown>);
      return ok({ id: 'doc-6', path: put.path, version: 1 });
    }
    case 'hand-over-to-agent': {
      const schedule = FlowScheduleCreateInputSchema.parse(input);
      if (s.handOverFails === true) return { ok: false };
      return ok({
        scheduleId: HAND_OVER_SCHEDULE,
        name: schedule.name,
        kind: 'one_shot',
        status: 'active',
        maxFirings: 1,
        nextFireAt: schedule.scheduledAt,
        createdAt: new Date(NOW).toISOString(),
      });
    }
    case 'remember-turn':
    case 'note-unlisted':
      MemoryPutInputSchema.parse(input);
      return ok({ id: 'doc-4', path: input['path'], version: 1 });
    case 'read-abandon-claim': {
      const read = MemoryGetInputSchema.parse(input);
      const claim = (s.claimsAsRead ?? s.abandonClaims)?.get(String(read.target.path));
      return ok(
        claim === undefined
          ? { found: false }
          : { stat: { path: read.target.path, contentHash: hashOf(claim) }, dataJson: claim },
      );
    }
    case 'read-abandon-owner': {
      const owner = s.abandonOwner ?? { status: 'paused' };
      if (owner === 'gone') return { ok: false };
      return ok({
        run: { runId: input['runId'], status: owner.status },
        tasks: [],
        activeWaiters: [],
        ...(owner.answered === true
          ? { taskOutput: { taskId: 'hand-over', output: { note: 'Mine now.' } } }
          : {}),
      });
    }
    case 'judge-abandon-claim':
      return ok({ ...decideByRules(WorkflowRunDecideInputSchema.parse(input)) });
    case 'claim-abandon':
    case 'claim-abandon-takeover': {
      // A create fails where anything is there; an overwrite, where the claim
      // is no longer exactly as it was read.
      const put = MemoryPutInputSchema.parse(input);
      const there = s.abandonClaims?.get(put.path);
      if (put.writeMode === 'create') {
        expect(put.expectedHash).toBeUndefined();
        if (there !== undefined) return { ok: false };
      } else {
        expect(put.writeMode).toBe('overwrite');
        if (there === undefined || put.expectedHash !== hashOf(there)) return { ok: false };
      }
      s.abandonClaims?.set(put.path, put.content.inlineJson as Record<string, unknown>);
      // The write landed, and the task never reported it: it crashed, timed out or was cancelled.
      if (s.claimUnreported === true) return { ok: false };
      return ok({ id: 'doc-5', path: put.path, version: 1 });
    }
    case 'hand-over':
      // The run pauses here until a person answers; the item is the pause.
      return ok({ note: '' });
    case 'read-in-flight-lease':
      return s.lease === undefined
        ? { ok: false }
        : ok({
            stat: { path: input['target'], contentHash: 'stale-lease-hash' },
            dataJson: {
              runId: 'shepherd-run-1',
              takenAtMs: NOW - s.lease.ageMs,
              pullNumber: 94,
              headSha: HEAD,
              checkRunId: '554',
              decision: s.lease.decision ?? 'fix',
            },
          });
    case 'read-lease-owner':
      return s.lease?.owner === 'gone' || s.lease === undefined
        ? { ok: false }
        : ok({ run: { runId: 'shepherd-run-1', status: s.lease.owner } });
    case 'remember-handoff':
      MemoryPutInputSchema.parse(input);
      return ok({ id: 'doc-2', path: input['path'], version: 1 });
    case 'read-in-flight-publications':
    case 'read-in-flight-commissions': {
      WorkflowRunListInputSchema.parse(input);
      const inFlight =
        taskId === 'read-in-flight-publications' ? s.publicationInFlight : s.commissionInFlight;
      return ok({
        runs: inFlight
          ? [{ id: 'other-run', status: 'paused', startedAt: '2026-10-18T07:00:00Z', own: false }]
          : [],
        hasMore: false,
      });
    }
    case 'read-in-flight-node': {
      const query = WorkflowRunListInputSchema.parse(input);
      const node = s.planNode ?? 'none';
      if (node === 'fails') return { ok: false };
      // A node holds the pull request only by its URL, as Local Publish linked it.
      const held = node !== 'none' && query.servingNodeOfPullRequest === PULL_REQUEST_URL;
      // The read lists every run serving the node, this pass's own among them.
      const other = {
        id: 'node-run',
        status: 'running',
        startedAt: '2026-10-18T07:30:00Z',
        own: false,
      };
      const self = { id: RUN_ID, status: 'running', startedAt: '2026-10-18T07:20:00Z', own: true };
      const listed = {
        none: [],
        idle: [],
        'in-flight': [other],
        'own-run': [self],
        'own-and-in-flight': [self, other],
        'in-flight-and-own': [other, self],
        incomplete: [],
      }[node];
      return ok({
        runs: held ? listed : [],
        hasMore: false,
        planNodeIds: held ? [PLAN_NODE] : [],
        complete: node !== 'incomplete',
      });
    }
    case 'read-schedule': {
      const { scheduleId } = FlowScheduleGetInputSchema.parse(input);
      if (s.schedule === undefined || s.schedule === 'unread') return { ok: false };
      const facts = {
        kind: 'cron' as const,
        status: s.schedule.status ?? 'active',
        maxFirings: MAX_FIRINGS_CAP,
        firingCount: s.schedule.firingCount,
        expiresAt: null,
      };
      return ok({
        id: scheduleId,
        ...facts,
        firingsLeft: scheduleFiringsLeft(facts),
        renewalDue: isScheduleRenewalDue(facts),
      });
    }
    case 'renew-schedule': {
      const { renews } = FlowScheduleCreateInputSchema.parse(input);
      if (s.renewalFails) return { ok: false };
      return ok({ scheduleId: `successor-of-${String(renews)}`, kind: 'cron', status: 'active' });
    }
    case 'read-firing':
    case 'judge-remedy-change':
    case 'name-hand-over-case':
    case 'aim':
    case 'decide':
    case 'record-remedy':
      return ok({ ...decideByRules(WorkflowRunDecideInputSchema.parse(input)) });
    case 'lease':
    case 'lease-takeover':
      MemoryPutInputSchema.parse(input);
      return s.leaseTaken
        ? { ok: false }
        : ok({ id: 'doc-1', path: input['path'], version: 1, contentHash: OWN_LEASE_HASH });
    case 'read-failure':
      return github({
        jobs: Array.from({ length: s.failingJobs ?? 1 }, (_, i) => ({
          id: 112257622723 + i,
          name: i === 0 ? 'Test' : 'Dependency audit',
          conclusion: 'failure',
          failedSteps: ['Run tests'],
        })),
        count: s.failingJobs ?? 1,
      });
    case 'read-failure-log-1':
    case 'read-failure-log-2':
    case 'read-failure-log-3':
      return github(
        JobLogExcerptSchema.parse({
          excerpt: 'FAIL src/clock.test.ts > ticks\nAssertionError: expected 2 to be 1',
          lines: 2,
          totalLines: 5955,
          bytes: 70,
          truncated: true,
        }),
      );
    case 'classify-failure': {
      const remedy = s.remedy ?? { value: 'code_defect', decided: true };
      if (remedy === 'unavailable') return { ok: false };
      return ok({
        answers: {
          remedy: {
            type: 'choice',
            value: remedy.value,
            decidedValue: remedy.decided ? remedy.value : null,
            decided: remedy.decided,
            confidence: remedy.decided ? 0.93 : 0.41,
            probabilities: {},
          },
        },
      });
    }
    case 'rerun-jobs':
      return github({}, 201);
    case 'read-base':
      if (s.baseSha === 'unread') return { ok: false };
      return github({
        name: 'main',
        commit: { sha: s.baseSha ?? MERGED_FROM, commit: { message: 'Merge main' } },
        protected: true,
      });
    case 'fix':
    case 'bump-dependency':
    case 'merge-round':
    case MERGE_ROUND_AFTER_BASE_MOVED: {
      HostHarnessRunInputSchema.parse(input);
      const commission = s.commission ?? 'patch';
      if (commission === 'failed') return { ok: false };
      // The commission merges `origin/<base>` as it stands now.
      const baseNow = s.baseSha === undefined || s.baseSha === 'unread' ? MERGED_FROM : s.baseSha;
      return ok({
        runId: 'hp_1',
        harness: { id: 'claude', selectedBy: 'default' },
        continued: false,
        baseSha: HEAD,
        ...(commission === 'unchanged' ? {} : { merge: { from: baseNow, conflicts: [] } }),
        ...(commission === 'patch' ? { patchRef: patchOf(taskId), filesChanged: 1 } : {}),
        filesChanged: commission === 'patch' ? 1 : 0,
        result: { commitMessage: 'Fix the clock test\n\nIt read the wall clock.', gaps: [] },
        patchTruncated: false,
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        truncated: false,
        applies: 'clean',
        headMoved: false,
        blockedDomains: [],
      });
    }
    case 'publish':
      WorkflowRunStartInputSchema.parse(input);
      return ok({ runId: 'pub-run-1', outcome: 'completed', waiterId: 'w-1' });
    case 'release':
      MemoryDeleteInputSchema.parse(input);
      // The delete holds only while the lease is as this pass wrote it.
      return input['expectedHash'] !== (s.leaseTakenOver ? 'new-holder-hash' : OWN_LEASE_HASH)
        ? { ok: false }
        : ok({ id: 'doc-1', path: (input['target'] as { path: string }).path, deleted: true });
    case 'handoff':
    case 'handoff-edit':
      // GitHub answers a post or an edit with the comment, its author with it.
      return github({ id: 9, user: { login: LOOP_LOGIN } }, taskId === 'handoff' ? 201 : 200);
    default:
      throw new Error(`no answer scripted for ${taskId}`);
  }
}

function pass(s: Scenario = {}): Pass {
  const runInputs = { bindingId: 'hb_aflow', ...s.inputs };
  const completed = new Set<string>();
  const skipped = new Set<string>();
  const failedOptional = new Set<string>();
  const statuses = new Map<string, string>();
  const outputs = new Map<string, Record<string, unknown>>();
  const inputs = new Map<string, Record<string, unknown>>();
  const ran: string[] = [];

  for (let round = 0; round <= tasks.length; round += 1) {
    const ready = computeReadyTasksWithWhen(
      tasks,
      completed,
      skipped,
      { statuses, outputs },
      failedOptional,
    );
    expect(ready.errors).toEqual([]);
    for (const { task } of ready.skipped) {
      skipped.add(task.taskId);
      statuses.set(task.taskId, 'skipped');
    }
    const fresh = ready.ready.filter((task) => !ran.includes(task.taskId));
    if (fresh.length === 0 && ready.skipped.length === 0) break;
    for (const task of fresh) {
      ran.push(task.taskId);
      const input = substituteTemplateBinds(
        task.inputTemplate ?? {},
        bound(task, outputs, runInputs),
        new Set(Object.keys(task.inputBindings ?? {})),
      );
      inputs.set(task.taskId, input);
      const result = answer(task.taskId, input, s);
      if (!result.ok) {
        statuses.set(task.taskId, 'failed');
        if (task.optional === true) failedOptional.add(task.taskId);
        continue;
      }
      let output = result.output;
      if (task.outputProjection !== undefined) {
        const projected = projectTaskOutput(task.outputProjection, output, input);
        // A projection that does not resolve fails its task, as the harness does.
        if (!projected.ok) {
          statuses.set(task.taskId, 'failed');
          if (task.optional === true) failedOptional.add(task.taskId);
          continue;
        }
        output = projected.value;
      }
      outputs.set(task.taskId, output);
      completed.add(task.taskId);
      statuses.set(task.taskId, 'succeeded');
    }
  }

  const written = inputs.get('handoff') ?? inputs.get('handoff-edit');
  const body = (written?.['params'] as { body?: { body?: string } } | undefined)?.body?.body;
  return {
    ran,
    inputs,
    outputs,
    statuses,
    decision: outputs.get('decide')?.['decision'] as string | undefined,
    handoff: body === undefined ? undefined : parseShepherdHandoff(body),
  };
}

/** The record a pass left, read back the way the next pass's read gives it. */
function readBack(previous: Pass): ShepherdHandoffRead {
  const record = previous.handoff;
  if (record === undefined || record === null) throw new Error('the pass left no handoff');
  return {
    found: true,
    commentId: 9,
    ...record,
    nextAttemptCount: record.attemptCount + 1,
    trust: 'verified',
  };
}

const COMMISSIONS = ['fix', 'bump-dependency', 'merge-round', MERGE_ROUND_AFTER_BASE_MOVED];
const ACTIONS = ['lease', 'lease-takeover', 'rerun-jobs', ...COMMISSIONS, 'publish'];

describe('Local PR Shepherd — it fixes what CI failed', () => {
  const first = pass();

  it('decides fix on a red check it has not acted on, and commissions it on the branch with its base merged in', () => {
    expect(first.decision).toBe('fix');
    expect(first.ran).toEqual(
      expect.arrayContaining(['lease', 'read-failure', 'classify-failure', 'fix']),
    );
    const fix = first.inputs.get('fix')!;
    expect(fix['base']).toBe(BRANCH);
    expect(fix['mergeFrom']).toBe('origin/main');
    // The brief is data: the pull request, the failing checks and jobs, the log's end.
    const briefed = fix['inputs'] as Record<string, unknown>;
    expect(briefed['pullRequest']).toMatchObject({ number: 94, title: 'Planted failing test' });
    expect(briefed['failingChecks']).toEqual(FAILING.failing);
    expect((briefed['logs'] as unknown[])[0]).toMatchObject({ truncated: true });
  });

  it("has every commission run the repository's guards before it returns, and fix what fails there", () => {
    expect(first.inputs.get('fix')!['task']).toBe(FIX_BRIEF);
    for (const brief of [FIX_BRIEF, BUMP_BRIEF, MERGE_BRIEF]) {
      expect(brief).toContain('`node --import tsx scripts/large-files/cli.ts check`');
      expect(brief).toContain(
        '`node --conditions=ts-source --import tsx scripts/context-budget/cli.ts check`',
      );
      expect(brief).toContain('Fix what fails before you return');
    }
  });

  it('publishes the commission through Local Publish, appended onto the branch, and waits for it', () => {
    const start = WorkflowRunStartInputSchema.parse(first.inputs.get('publish'));
    expect(start.slug).toBe(PUBLISH_LOCAL_CHANGES.bundle.workflow.slug);
    expect(start.catalogId).toBe(PUBLISH_LOCAL_CHANGES.catalogId);
    expect(start.wait).toBe('until_complete');
    expect(start.inputs).toEqual({
      bindingId: 'hb_aflow',
      patchRef: 'gs://bucket/patch-1',
      branch: BRANCH,
      baseSha: HEAD,
      mergeFrom: MERGED_FROM,
      commitMessage: 'Fix the clock test\n\nIt read the wall clock.',
      gaps: [],
      owner: 'aflowai',
      repo: 'aflow',
      base: 'main',
      round: 2,
    });
  });

  it('publishes every commission as round 2, a fix round on the pull request it tends', () => {
    const remedies = [
      pass(),
      pass({ remedy: { value: 'base_conflict', decided: true }, commission: 'merge-only' }),
    ];
    for (const remedied of remedies) {
      expect(remedied.ran).toContain('publish');
      const start = WorkflowRunStartInputSchema.parse(remedied.inputs.get('publish'));
      expect(start.inputs['round']).toBe(2);
    }
    const round = PUBLISH_LOCAL_CHANGES.bundle.workflow.runInputs.find(
      (input) => input.id === 'round',
    );
    expect(round?.schema).toMatchObject({ type: 'integer', minimum: 1 });
  });

  it('releases the lease it took and records the attempt in the handoff', () => {
    expect(first.ran.indexOf('release')).toBeGreaterThan(first.ran.indexOf('publish'));
    expect((first.inputs.get('release')!['target'] as { path: string }).path).toBe(
      first.outputs.get('lease')!['path'],
    );
    expect(first.ran).toContain('handoff');
    expect(first.handoff).toEqual({
      attemptCount: 1,
      checkRunId: FAILING_CHECK,
      headSha: HEAD,
      decision: 'fix',
      classification: 'code_defect',
      remedy: 'fix_commission',
      publicationRunId: 'pub-run-1',
    });
  });

  it('publishes a merge round with no patch as the merge alone', () => {
    const merged = pass({
      remedy: { value: 'base_conflict', decided: true },
      commission: 'merge-only',
    });
    expect(merged.ran).toContain('merge-round');
    const start = merged.inputs.get('publish')!['inputs'] as Record<string, unknown>;
    expect(start['patchRef']).toBeUndefined();
    expect(start['mergeFrom']).toBe(MERGED_FROM);
  });
});

describe('Local PR Shepherd — it publishes whichever remedy ran', () => {
  const BUMP = { remedy: { value: 'dependency_advisory', decided: true } } as const;

  it("publishes the dependency bump's patch on a pass whose remedy is the bump", () => {
    const bumped = pass(BUMP);
    expect(bumped.outputs.get('record-remedy')?.['decision']).toBe('dependency_bump');
    expect(bumped.ran).toEqual(expect.arrayContaining(['bump-dependency', 'publish']));
    expect(bumped.ran).not.toContain('fix');
    // A bump the boundary keeps from the registry fails, naming the host, rather
    // than returning an unchanged tree as done.
    expect(bumped.inputs.get('bump-dependency')!['requiredHosts']).toEqual([
      'registry.yarnpkg.com',
      'registry.npmjs.org',
    ]);
    expect(bumped.inputs.get('bump-dependency')!['task']).toBe(BUMP_BRIEF);
    expect(pass().inputs.get('fix')).not.toHaveProperty('requiredHosts');
    const start = WorkflowRunStartInputSchema.parse(bumped.inputs.get('publish'));
    expect(start.inputs).toMatchObject({
      patchRef: 'gs://bucket/bump-dependency.patch',
      mergeFrom: MERGED_FROM,
      baseSha: HEAD,
      branch: BRANCH,
    });
    expect(bumped.handoff).toMatchObject({
      decision: 'fix',
      remedy: 'dependency_bump',
      publicationRunId: 'pub-run-1',
    });
  });

  it('decides wait, saying why, where the remedy ran and left nothing to publish', () => {
    const unchanged = pass({ ...BUMP, commission: 'unchanged' });
    expect(unchanged.statuses.get('bump-dependency')).toBe('succeeded');
    expect(unchanged.statuses.get('publish')).toBe('skipped');
    const judged = unchanged.outputs.get('judge-remedy-change');
    expect(judged).toMatchObject({ decision: 'wait' });
    expect(String(judged?.['reason'])).toContain('left nothing to publish');
    expect(unchanged.handoff).toMatchObject({ decision: 'wait', remedy: 'dependency_bump' });
    expect(unchanged.handoff?.publicationRunId).toBeUndefined();
    const body = String(
      (unchanged.inputs.get('handoff')!['params'] as { body: { body: string } }).body.body,
    );
    expect(body).toContain('this pass: `wait`');
    expect(body).toContain(String(judged?.['reason']));
  });

  it('decides wait, saying why, where the remedy commission failed — a bump kept from the registry', () => {
    const failed = pass({ ...BUMP, commission: 'failed' });
    expect(failed.statuses.get('bump-dependency')).toBe('failed');
    expect(failed.statuses.get('publish')).toBe('skipped');
    const judged = failed.outputs.get('judge-remedy-change');
    expect(judged).toMatchObject({ decision: 'wait' });
    expect(String(judged?.['reason'])).toContain('commission failed');
    expect(failed.handoff).toMatchObject({ decision: 'wait', remedy: 'dependency_bump' });
  });

  it('judges nothing where no commission ran', () => {
    const rerun = pass({ remedy: { value: 'flaky_or_timeout', decided: true } });
    expect(rerun.statuses.get('judge-remedy-change')).toBe('skipped');
    expect(rerun.handoff).toMatchObject({ decision: 'fix', remedy: 'rerun_failed_jobs' });
  });

  it('records the publication in the handoff for every remedy it publishes', () => {
    const published = [
      pass(),
      pass(BUMP),
      pass({ remedy: { value: 'base_conflict', decided: true }, commission: 'merge-only' }),
      pass({ remedy: { value: 'code_defect', decided: false } }),
    ];
    for (const remedied of published) {
      expect(remedied.ran).toContain('publish');
      expect(remedied.handoff).toMatchObject({ decision: 'fix', publicationRunId: 'pub-run-1' });
    }
    expect(published.map((remedied) => remedied.handoff?.remedy)).toEqual([
      'fix_commission',
      'dependency_bump',
      'merge_round',
      'fix_commission',
    ]);
  });
});

describe('Local PR Shepherd — once per failure', () => {
  it('waits on a second pass over the same check run, and its handoff still shows one attempt', () => {
    const second = pass({ pinned: 'found', handoff: readBack(pass()) });
    expect(second.decision).toBe('wait');
    for (const action of ACTIONS) expect(second.ran).not.toContain(action);
    expect(second.ran).toContain('handoff-edit');
    expect(second.handoff).toMatchObject({
      attemptCount: 1,
      checkRunId: FAILING_CHECK,
      decision: 'wait',
      publicationRunId: 'pub-run-1',
    });
  });

  it('acts on a new check run of the same pull request, counting it', () => {
    const rerun: CheckRunsSummary = {
      ...FAILING,
      failing: [{ ...FAILING.firstFailing!, id: '556' }],
      firstFailing: { ...FAILING.firstFailing!, id: '556' },
    };
    const next = pass({ pinned: 'found', handoff: readBack(pass()), checks: rerun });
    expect(next.decision).toBe('fix');
    expect(next.handoff).toMatchObject({ attemptCount: 2, checkRunId: '556' });
  });
});

describe('Local PR Shepherd — a failure acted on is acted on again once the base moves past its remedy', () => {
  const AUDIT_CHECK = '901';
  const AUDIT_RUN = 37460219901;
  const AUDIT_FAILING: CheckRunsSummary = {
    state: 'failing',
    total: 12,
    failing: [
      { id: AUDIT_CHECK, name: 'Dependency audit', conclusion: 'failure', runId: AUDIT_RUN },
    ],
    firstFailing: {
      id: AUDIT_CHECK,
      name: 'Dependency audit',
      conclusion: 'failure',
      runId: AUDIT_RUN,
    },
  };
  const BASE_WITH_AUDIT_FIX = '1'.repeat(40);
  const REMEDIED: ShepherdHandoffRead = {
    found: true,
    trust: 'verified',
    commentId: 9,
    attemptCount: 1,
    nextAttemptCount: 2,
    checkRunId: AUDIT_CHECK,
    headSha: HEAD,
    decision: 'fix',
    classification: 'dependency_advisory',
    remedy: 'dependency_bump',
    publicationRunId: 'pub-run-1',
  };
  const REMEDY_PIN = { attemptCount: '1', checkRunId: AUDIT_CHECK, remedyBaseSha: MERGED_FROM };

  function afterRemedy(s: Scenario = {}): Pass {
    return pass({
      checks: AUDIT_FAILING,
      pinned: 'found',
      handoff: REMEDIED,
      pinState: REMEDY_PIN,
      baseSha: BASE_WITH_AUDIT_FIX,
      ...s,
    });
  }

  function pinned(p: Pass): Record<string, unknown> {
    return MemoryPutInputSchema.parse(p.inputs.get('remember-handoff')).content
      .inlineJson as Record<string, unknown>;
  }

  it('merges the moved base into the branch and publishes it where the base moved after the remedy, rather than waiting', () => {
    const merged = afterRemedy({ commission: 'merge-only' });
    expect(merged.decision).toBe('fix');
    expect(merged.ran).toEqual(expect.arrayContaining([MERGE_ROUND_AFTER_BASE_MOVED, 'publish']));
    const commissioned = merged.inputs.get(MERGE_ROUND_AFTER_BASE_MOVED)!;
    expect(commissioned['task']).toBe(BASE_MOVED_BRIEF);
    expect(commissioned['base']).toBe(BRANCH);
    expect(commissioned['mergeFrom']).toBe('origin/main');
    const start = WorkflowRunStartInputSchema.parse(merged.inputs.get('publish'));
    expect(start.inputs['mergeFrom']).toBe(BASE_WITH_AUDIT_FIX);
    expect(start.inputs['patchRef']).toBeUndefined();
    expect(merged.handoff).toMatchObject({
      attemptCount: 2,
      checkRunId: AUDIT_CHECK,
      decision: 'fix',
      remedy: 'merge_round',
      publicationRunId: 'pub-run-1',
    });
    expect(pinned(merged)).toMatchObject({
      checkRunId: AUDIT_CHECK,
      remedyBaseSha: BASE_WITH_AUDIT_FIX,
    });
  });

  it('spends no re-run on a base that moved: a re-run runs on the old base', () => {
    const merged = afterRemedy();
    for (const unasked of ['classify-failure', 'rerun-jobs']) {
      expect(merged.ran).not.toContain(unasked);
    }
    expect(
      tasks
        .filter(
          (task) =>
            (task.inputTemplate as { endpointId?: string } | undefined)?.endpointId ===
            'reRunFailedJobs',
        )
        .map((task) => task.taskId),
    ).toEqual(['rerun-jobs']);
  });

  it('waits where the base stands where the remedy was taken', () => {
    const waited = afterRemedy({ baseSha: MERGED_FROM });
    expect(waited.decision).toBe('wait');
    for (const action of ACTIONS) expect(waited.ran).not.toContain(action);
    expect(pinned(waited)['remedyBaseSha']).toBe(MERGED_FROM);
  });

  it('waits where no base is on record for the remedy, or the base could not be read', () => {
    const unrecorded = afterRemedy({ pinState: { attemptCount: '1', checkRunId: AUDIT_CHECK } });
    expect(unrecorded.decision).toBe('wait');
    const emptied = afterRemedy({ pinState: { ...REMEDY_PIN, remedyBaseSha: '' } });
    expect(emptied.decision).toBe('wait');
    const unread = afterRemedy({ baseSha: 'unread' });
    expect(unread.statuses.get('read-base')).toBe('failed');
    expect(unread.decision).toBe('wait');
  });

  it('waits where the base moved but the budget is spent on this pull request', () => {
    const spent = afterRemedy({
      handoff: { ...REMEDIED, attemptCount: 3, nextAttemptCount: 4 },
    });
    expect(spent.decision).toBe('wait');
    expect(spent.ran).not.toContain(MERGE_ROUND_AFTER_BASE_MOVED);
  });

  it('records the base each remedy was taken against, and a pass that does not act keeps it', () => {
    const first = pass({ baseSha: MERGED_FROM });
    expect(pinned(first)['remedyBaseSha']).toBe(MERGED_FROM);
    const running = afterRemedy({ checks: { state: 'pending', total: 12, failing: [] } });
    expect(running.decision).toBe('wait');
    expect(running.statuses.get('read-base')).toBe('skipped');
    expect(pinned(running)['remedyBaseSha']).toBe(MERGED_FROM);
  });
});

describe('Local PR Shepherd — earlier rounds brief the next', () => {
  it('briefs the fix and the classifier with the first round’s remedy and classification, from a record the pinned read found', () => {
    const firstRound = pass({ remedy: { value: 'flaky_or_timeout', decided: true } });
    expect(firstRound.handoff).toMatchObject({ remedy: 'rerun_failed_jobs' });
    const rerun: CheckRunsSummary = {
      ...FAILING,
      failing: [{ ...FAILING.firstFailing!, id: '556' }],
      firstFailing: { ...FAILING.firstFailing!, id: '556' },
    };
    const second = pass({ pinned: 'found', handoff: readBack(firstRound), checks: rerun });
    expect(second.statuses.get('read-pr-handoff-pinned')).toBe('succeeded');
    expect(second.statuses.get('read-pr-handoff')).toBe('skipped');
    const earlier = {
      attemptCount: 1,
      remedy: 'rerun_failed_jobs',
      classification: 'flaky_or_timeout',
    };
    expect(
      (second.inputs.get('fix')!['inputs'] as Record<string, unknown>)['earlierRounds'],
    ).toMatchObject(earlier);
    expect(
      (second.inputs.get('classify-failure')!['state'] as Record<string, unknown>)['earlierRounds'],
    ).toMatchObject(earlier);
    // The record keeps what this round did, for the round after.
    expect(second.handoff).toMatchObject({
      attemptCount: 2,
      remedy: 'fix_commission',
      classification: 'code_defect',
    });
  });
});

describe('Local PR Shepherd — never two at once', () => {
  it.each(['running', 'paused'] as const)(
    'waits where a live lease holds the branch — its run %s, taken within the bound',
    (owner) => {
      const held = pass({ lease: { owner, ageMs: 60_000 } });
      expect(held.decision).toBe('wait');
      for (const action of ACTIONS) expect(held.ran).not.toContain(action);
    },
  );

  it.each([
    ['its run ended', { owner: 'completed', ageMs: 60_000 }],
    ['its run failed', { owner: 'failed', ageMs: 60_000 }],
    ['its run cannot be read', { owner: 'gone', ageMs: 60_000 }],
    ['it is older than the bound', { owner: 'running', ageMs: SHEPHERD_LEASE_STALE_AFTER_MS + 1 }],
  ] as const)('takes over a stale lease — %s — and acts', (_why, lease) => {
    const resumed = pass({ lease });
    expect(resumed.decision).toBe('fix');
    expect(resumed.ran).not.toContain('lease');
    const takeover = MemoryPutInputSchema.parse(resumed.inputs.get('lease-takeover'));
    // Overwrites exactly the lease it read, so a second pass taking it over fails.
    expect(takeover).toMatchObject({ writeMode: 'overwrite', expectedHash: 'stale-lease-hash' });
    expect(takeover.content.inlineJson).toMatchObject({ runId: RUN_ID, takenAtMs: NOW });
    expect(resumed.ran).toEqual(expect.arrayContaining(['fix', 'publish', 'release']));
    // Deletes the lease only as this pass wrote it: the hash its own write answered.
    expect(resumed.inputs.get('release')).toEqual({
      target: { path: takeover.path },
      expectedHash: OWN_LEASE_HASH,
    });
  });

  // Plan 321 P2's exit: two firings overlapping on one pull request produce
  // one fix. Both read the same turn and the same red check; the first to
  // write the branch's lease commissions, and the other, whichever way it
  // meets the lease, commissions nothing.
  it('makes one fix of two firings overlapping on one pull request', () => {
    const first = pass({ turn: 93 });
    const raced = pass({ turn: 93, leaseTaken: true });
    const later = pass({ turn: 93, lease: { owner: 'running', ageMs: 30_000 } });
    for (const firing of [first, raced, later]) {
      expect(firing.inputs.get('read-pr')).toMatchObject({ params: { pull_number: 94 } });
    }
    const fixes = [first, raced, later].filter((firing) =>
      COMMISSIONS.some((task) => firing.ran.includes(task)),
    );
    expect(fixes).toEqual([first]);
    expect(first.ran).toEqual(expect.arrayContaining(['lease', 'fix', 'publish', 'release']));
    expect(raced.statuses.get('lease')).toBe('failed');
    expect(later.decision).toBe('wait');
    for (const firing of [raced, later]) expect(firing.ran).not.toContain('publish');
  });

  it('records the run that holds a lease and when it was taken', () => {
    const lease = MemoryPutInputSchema.parse(pass().inputs.get('lease'));
    expect(lease.writeMode).toBe('create');
    expect(lease.content.inlineJson).toMatchObject({ runId: RUN_ID, takenAtMs: NOW });
  });

  it.each([
    ['created', {}],
    ['taken over', { lease: { owner: 'completed', ageMs: 60_000 } as const }],
  ])(
    'takes the lease only once: a pass whose lease was %s first commissions, publishes and releases nothing',
    (_how, scenario) => {
      const lost = pass({ ...scenario, leaseTaken: true });
      expect(lost.decision).toBe('fix');
      for (const task of [
        ...COMMISSIONS,
        'rerun-jobs',
        'publish',
        'release',
        'handoff',
        'handoff-edit',
      ]) {
        expect(lost.ran).not.toContain(task);
      }
    },
  );

  it('does not delete a lease another run took over: the release holds only the hash its own write answered', () => {
    const overtaken = pass({ leaseTakenOver: true });
    expect(MemoryDeleteInputSchema.parse(overtaken.inputs.get('release'))).toMatchObject({
      expectedHash: OWN_LEASE_HASH,
    });
    // The new holder's lease stands: the delete fails its hash check, and only it.
    expect(overtaken.statuses.get('release')).toBe('failed');
    expect(overtaken.ran).toContain('handoff');
  });

  it('releases the lease whichever way the leased work ended', () => {
    for (const s of [{ commission: 'failed' as const }, { remedy: 'unavailable' as const }]) {
      const ended = pass(s);
      expect(ended.ran).not.toContain('publish');
      expect(ended.ran).toContain('release');
      expect(ended.ran).toContain('handoff');
    }
  });
});

describe('Local PR Shepherd — the handoff is the loop’s own, wherever it sits', () => {
  const preset = (input: Record<string, unknown> | undefined) =>
    (input?.['response'] as { transformPresetId?: string } | undefined)?.transformPresetId;

  it('trusts a record only from the author pinned with it, on the pull request it tends — and asks no one who it is', () => {
    const pinned = pass({ pinned: 'found', handoff: readBack(pass()) });
    // GitHub App installation tokens are refused `GET /user`; nothing reads it.
    expect([...pinned.inputs.values()].map((input) => input['endpointId'])).not.toContain(
      'getAuthenticatedUser',
    );
    expect(preset(pinned.inputs.get('read-pr-handoff-pinned'))).toBe(
      `loop_handoff:${LOOP_LOGIN}:94`,
    );
    expect(pinned.outputs.get('read-pr-handoff-pinned')).toMatchObject({
      data: { found: true, trust: 'verified' },
    });
    expect(pinned.decision).toBe('wait');
  });

  it('with no pinned author, trusts no record and decides as on a pull request with none — never a wait', () => {
    // A record on the page, but no login it could be told apart by.
    const unpinned = pass({ handoff: readBack(pass()) });
    expect(preset(unpinned.inputs.get('read-pr-handoff'))).toBe('loop_handoff::94');
    expect(unpinned.outputs.get('read-pr-handoff')).toMatchObject({
      data: { found: false, trust: 'undecided' },
    });
    expect(unpinned.decision).toBe('fix');
    expect(unpinned.handoff).toMatchObject({ attemptCount: 1 });
  });

  it('does not take a record the pinned comment holds for another pull request', () => {
    const elsewhere = pass({ pinned: 'found', pinnedCommentOn: 95, handoff: readBack(pass()) });
    expect(elsewhere.outputs.get('read-pr-handoff-pinned')).toMatchObject({
      data: { found: false },
    });
    expect(elsewhere.decision).toBe('fix');
  });

  it('pins the handoff it posts for its pull request, with the author GitHub answered it was written as', () => {
    const first = pass();
    expect(first.ran).toContain('handoff');
    expect(MemoryPutInputSchema.parse(first.inputs.get('remember-handoff'))).toMatchObject({
      path: '/shepherd/aflowai/aflow/pulls/94.json',
      content: { inlineJson: { commentId: 9, author: LOOP_LOGIN } },
    });
  });

  it('keeps a pin per pull request: a second pull request on the branch neither reads nor rewrites the first’s handoff', () => {
    // The first pull request's handoff is pinned; the second has none of its own.
    const second = pass({
      pinned: 'found',
      pinFor: 94,
      handoff: readBack(pass()),
      pullRequest: { number: 95 },
    });
    expect(second.inputs.get('read-handoff-pin')).toMatchObject({
      target: { path: '/shepherd/aflowai/aflow/pulls/95.json' },
    });
    expect(second.statuses.get('read-pr-handoff-pinned')).toBe('skipped');
    expect(second.ran).not.toContain('handoff-edit');
    expect(second.ran).toContain('handoff');
    expect(second.inputs.get('handoff')).toMatchObject({ params: { issue_number: 95 } });
    expect(second.inputs.get('remember-handoff')).toMatchObject({
      path: '/shepherd/aflowai/aflow/pulls/95.json',
    });
  });

  it('pins a handoff found by the newest-page read and rewritten, so the next pass reads it by its id', () => {
    // The pinned comment is gone; the newest page holds the pinned author's handoff.
    const found = pass({ pinned: 'gone', handoff: readBack(pass()) });
    expect(found.statuses.get('read-pr-handoff')).toBe('succeeded');
    expect(found.ran).toContain('handoff-edit');
    expect(MemoryPutInputSchema.parse(found.inputs.get('remember-handoff'))).toMatchObject({
      path: '/shepherd/aflowai/aflow/pulls/94.json',
      content: { inlineJson: { commentId: 9, author: LOOP_LOGIN } },
    });
    const next = pass({ pinned: 'found', handoff: readBack(found) });
    expect(next.statuses.get('read-pr-handoff')).toBe('skipped');
    expect(next.decision).toBe('wait');
  });

  // A handoff posted early in a conversation that ran past 100 comments sits
  // on no page but the first; read by its id, it is found where it is.
  it('finds a pinned handoff however many comments came after it, and pages through nothing', () => {
    const later = pass({ pinned: 'found', handoff: readBack(pass()) });
    expect(later.inputs.get('read-pr-handoff-pinned')).toMatchObject({
      endpointId: 'getIssueComment',
      params: { comment_id: 9 },
    });
    expect(later.statuses.get('read-pr-handoff')).toBe('skipped');
    expect(later.decision).toBe('wait');
    expect(later.ran).toContain('handoff-edit');
    expect(later.ran).not.toContain('handoff');
    expect(later.handoff).toMatchObject({ attemptCount: 1, checkRunId: FAILING_CHECK });
  });

  it('reads the newest page of the conversation where none is pinned, or the pinned one is gone', () => {
    for (const s of [{}, { pinned: 'gone' as const }]) {
      const read = pass(s);
      expect(read.inputs.get('read-pr-handoff')).toMatchObject({
        endpointId: 'listIssueComments',
        params: { per_page: 100, page: PULL_REQUEST.commentPages },
      });
    }
  });
});

describe('Local PR Shepherd — a pin that could not be read is not no pin', () => {
  const unreadReason = SHEPHERD_RULES.find(
    (rule) => 'expression' in rule.when && rule.when.expression === 'state.pin == null',
  )!.reason;
  const WRITES = ['handoff', 'handoff-edit', 'remember-handoff'];

  it.each([
    ['a pin and a record of this very check run behind it', { pinned: 'found' as const }],
    ['no pin there at all', {}],
  ])(
    'waits, saying the record may exist unread, where the pin read fails — %s — and acts on and writes nothing',
    (_case, scenario) => {
      const unread = pass({ ...scenario, pinRead: 'fails', handoff: readBack(pass()) });
      expect(unread.statuses.get('read-handoff-pin')).toBe('failed');
      expect(unread.decision).toBe('wait');
      expect(unread.outputs.get('decide')?.['reason']).toBe(unreadReason);
      for (const action of ACTIONS) expect(unread.ran).not.toContain(action);
      // A handoff posted or pinned here would replace the record it could not read.
      expect(unread.statuses.get('read-pr-handoff')).toBe('skipped');
      for (const write of WRITES) expect(unread.ran).not.toContain(write);
    },
  );

  it('waits where the budget is spent and the pin read fails — the count is not restarted', () => {
    const spent = { ...readBack(pass()), attemptCount: 3, checkRunId: '554' };
    const unread = pass({ pinned: 'found', pinRead: 'fails', handoff: spent });
    expect(unread.decision).toBe('wait');
    expect(unread.outputs.get('decide')?.['reason']).toBe(unreadReason);
  });

  it('decides as a first pass only where the read succeeded and found no pin', () => {
    const first = pass();
    expect(first.inputs.get('read-handoff-pin')).toMatchObject({ ifMissing: 'absent' });
    expect(first.statuses.get('read-handoff-pin')).toBe('succeeded');
    expect(first.outputs.get('read-handoff-pin')).toEqual({ found: false });
    expect(first.decision).toBe('fix');
    expect(first.handoff).toMatchObject({ attemptCount: 1 });
    expect(first.ran).toContain('remember-handoff');
  });
});

describe('Local PR Shepherd — only a deleted pinned comment sends the pass to the newest page', () => {
  const unreadReason = SHEPHERD_RULES.find(
    (rule) => 'allOf' in rule.when && rule.when.allOf.includes('state.pinned.statusCode != 404'),
  )!.reason;
  const WRITES = ['handoff', 'handoff-edit', 'remember-handoff'];
  // The record this very check run was acted on under: decided as a first
  // pass, it would be acted on again with a fresh budget.
  const handled = () => readBack(pass());

  it('reads the newest page where the pinned comment answers 404, and decides from the record it finds there', () => {
    const gone = pass({ pinned: 'gone', handoff: handled() });
    expect(gone.outputs.get('read-pr-handoff-pinned')).toMatchObject({ statusCode: 404 });
    expect(gone.statuses.get('read-pr-handoff')).toBe('succeeded');
    expect(gone.decision).toBe('wait');
    expect(gone.outputs.get('decide')?.['reason']).toMatch(/acted on already/);
    expect(gone.ran).toContain('handoff-edit');
    expect(gone.ran).not.toContain('handoff');
  });

  it.each([
    ['GitHub answers 500', 500],
    ['GitHub answers 502', 502],
    ['the rate limit is spent (403)', 403],
    ['GitHub answers 429', 429],
    ['the call fails outright', 'fails' as const],
  ])(
    'waits, saying the record may exist unread, where the pinned read fails other than 404 — %s — and never falls back to the newest page',
    (_case, pinnedRead) => {
      const unread = pass({ pinned: 'found', pinnedRead, handoff: handled() });
      expect(unread.statuses.get('read-pr-handoff')).toBe('skipped');
      expect(unread.ran).not.toContain('read-pr-handoff');
      expect(unread.decision).toBe('wait');
      expect(unread.outputs.get('decide')?.['reason']).toBe(unreadReason);
      for (const action of ACTIONS) expect(unread.ran).not.toContain(action);
      // A handoff posted or pinned here would replace the record it could not read.
      for (const write of WRITES) expect(unread.ran).not.toContain(write);
    },
  );

  // A deleted handoff comment with none left on the newest page is not a
  // first pass: the pin kept the state the comment recorded, so the budget
  // and the guard on the check run already acted on survive the deletion.
  it('does not decide as a first pass where the pinned handoff was deleted and the newest page holds none', () => {
    const acted = pass({
      pinned: 'gone',
      pinState: { attemptCount: '1', checkRunId: FAILING_CHECK },
    });
    expect(presetOf(acted.inputs.get('read-pr-handoff')!)).toBe(
      `loop_handoff:${LOOP_LOGIN}:94:1:${FAILING_CHECK}`,
    );
    expect(acted.decision).toBe('wait');
    expect(acted.outputs.get('decide')?.['reason']).toMatch(/acted on already/);
    for (const action of ACTIONS) expect(acted.ran).not.toContain(action);
    // The record is posted again as it stood, and pinned with the same state.
    expect(acted.handoff).toMatchObject({ attemptCount: 1, checkRunId: FAILING_CHECK });
    expect(
      MemoryPutInputSchema.parse(acted.inputs.get('remember-handoff')).content.inlineJson,
    ).toMatchObject({ attemptCount: '1', checkRunId: FAILING_CHECK });

    const spent = pass({ pinned: 'gone', pinState: { attemptCount: '3', checkRunId: '554' } });
    expect(spent.decision).toBe('abandon');
    expect(spent.handoff).toMatchObject({ attemptCount: 3, decision: 'abandon' });

    // A new check run under a kept count is the next round, not the first.
    const next = pass({ pinned: 'gone', pinState: { attemptCount: '1', checkRunId: '554' } });
    expect(next.decision).toBe('fix');
    expect(next.handoff).toMatchObject({ attemptCount: 2 });
  });

  it('pins the attempt state each handoff records beside the comment it names', () => {
    const first = pass();
    expect(
      MemoryPutInputSchema.parse(first.inputs.get('remember-handoff')).content.inlineJson,
    ).toEqual({
      commentId: 9,
      author: LOOP_LOGIN,
      attemptCount: '1',
      checkRunId: FAILING_CHECK,
      remedyBaseSha: MERGED_FROM,
    });
    // Where the pinned comment is there, the newest page is not read, and so
    // the kept state is not what the record is read from.
    const pinned = pass({
      pinned: 'found',
      pinState: { attemptCount: '0', checkRunId: '' },
      handoff: readBack(first),
    });
    expect(pinned.statuses.get('read-pr-handoff')).toBe('skipped');
    expect(pinned.decision).toBe('wait');
  });

  it('does not restart a spent budget where the pinned read fails other than 404', () => {
    const spent = { ...handled(), attemptCount: 3, checkRunId: '554' };
    const unread = pass({ pinned: 'found', pinnedRead: 503, handoff: spent });
    expect(unread.decision).toBe('wait');
    expect(unread.outputs.get('decide')?.['reason']).toBe(unreadReason);
  });
});

describe('Local PR Shepherd — it yields to people', () => {
  it.each([
    ['a publication of the branch paused at its approval', { publicationInFlight: true }],
    ['a commission based on the branch running', { commissionInFlight: true }],
    ['the hands-off label', { pullRequest: { handsOff: true } }],
  ] as const)('waits on %s, and acts on nothing', (_case, scenario) => {
    const yielded = pass(scenario);
    expect(yielded.decision).toBe('wait');
    for (const action of ACTIONS) expect(yielded.ran).not.toContain(action);
  });

  it('writes nothing on a pull request labelled hands-off', () => {
    const labelled = pass({ pullRequest: { handsOff: true } });
    expect(labelled.ran).not.toContain('handoff');
    expect(labelled.ran).not.toContain('handoff-edit');
  });

  it('reads the in-flight runs of the branch, whoever started them', () => {
    const read = pass();
    expect(
      WorkflowRunListInputSchema.parse(read.inputs.get('read-in-flight-publications')),
    ).toEqual({
      slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
      input: { field: 'branch', equals: BRANCH },
      status: ['running', 'paused'],
      limit: 25,
    });
    expect(read.inputs.get('read-in-flight-commissions')).toMatchObject({
      slug: COMMISSION_CHANGE.bundle.workflow.slug,
      input: { field: 'base', equals: BRANCH },
    });
  });
});

describe('Local PR Shepherd — the branch’s work is read from its plan node (Plan 322 P2)', () => {
  it('reads the runs serving the pull request’s plan node by its URL, through the run ledger', () => {
    const read = pass();
    expect(read.ran).toContain('read-in-flight-node');
    expect(WorkflowRunListInputSchema.parse(read.inputs.get('read-in-flight-node'))).toEqual({
      servingNodeOfPullRequest: PULL_REQUEST_URL,
      status: ['running', 'paused'],
      limit: 25,
    });
    // The node is read, never written, and no pull-request comment carries what is in flight.
    const task = taskById.get('read-in-flight-node');
    expect(task?.operation).toBe('workflow.run.list');
    expect(JSON.stringify(task?.inputTemplate)).not.toMatch(/IssueComment|github/);
  });

  it('reaches the plan through no plan.* operation: a run may serve a node, never rewrite it (322 D3)', () => {
    expect(validateSkillPlanSeparation(tasks)).toBeNull();
    expect(tasks.filter((task) => String(task.operation).startsWith('plan.'))).toEqual([]);
  });

  it('decides from the node read: the rule waits while a run serves the node, whoever started it', () => {
    const decide = taskById.get('decide');
    // What the rules read of it, and nothing else the read returned.
    expect(decide?.inputBindings).toMatchObject({
      planNode_complete: { kind: 'task_output', taskId: 'read-in-flight-node', path: 'complete' },
      planNode_runs_0_: { kind: 'task_output', taskId: 'read-in-flight-node', path: 'runs[0]' },
      planNode_runs_1_: { kind: 'task_output', taskId: 'read-in-flight-node', path: 'runs[1]' },
    });
    // Ordered before the read it decides on, as every binding is.
    expect(decide?.dependsOn).toContain('read-in-flight-node');
  });

  it.each([
    ['a run serving the pull request’s plan node, though none is on the branch', 'in-flight'],
    ['another run serving the node, listed after this pass’s own', 'own-and-in-flight'],
    ['another run serving the node, listed before this pass’s own', 'in-flight-and-own'],
    ['a node whose plan is larger than one read, so its work is unknown', 'incomplete'],
    ['a node read that failed, so its work is unknown', 'fails'],
  ] as const)('waits on %s, and acts on nothing', (_case, planNode) => {
    const yielded = pass({ planNode });
    expect(yielded.decision).toBe('wait');
    for (const action of ACTIONS) expect(yielded.ran).not.toContain(action);
  });

  it('says why it waited: the node’s work is under way', () => {
    const yielded = pass({ planNode: 'in-flight' });
    expect(yielded.outputs.get('decide')?.['reason']).toMatch(/plan node.*in flight/);
  });

  it('holds back a merge as it holds back a fix while the node’s work is in flight', () => {
    const merging = {
      mergePosture: 'when-green',
      checks: GREEN,
      checkConclusions: { Test: 'success' },
    } as const;
    expect(pass(merging).decision).toBe('merge');
    const held = pass({ ...merging, planNode: 'in-flight' });
    expect(held.decision).toBe('wait');
    expect(held.ran).not.toContain('merge');
  });

  it.each([
    ['no node holds the pull request', 'none'],
    ['its node has nothing in flight', 'idle'],
  ] as const)('acts as before where %s', (_case, planNode) => {
    expect(pass({ planNode }).decision).toBe('fix');
  });

  it('does not wait on its own run: a pass serving the node, the only run on it, acts', () => {
    const decide = taskById.get('decide');
    expect(decide?.inputBindings?.['runId']).toEqual({ kind: 'run_id' });
    const acted = pass({ planNode: 'own-run' });
    expect(acted.decision).toBe('fix');
    expect(acted.outputs.get('decide')?.['reason']).not.toMatch(/plan node/);
    expect(acted.ran).toContain('fix');
  });
});

describe('Local PR Shepherd — it approves nothing', () => {
  it('has no approval of its own, and calls nothing that closes or reviews', () => {
    // Its one human task hands a spent pull request to a person: it collects
    // a note, approves no task's output, and previews no action to let through.
    const human = tasks.filter((task) => task.type === 'human');
    expect(human.map((task) => task.taskId)).toEqual(['hand-over']);
    expect(human[0]).toMatchObject({ intent: 'collect' });
    expect(human[0]?.approves).toBeUndefined();
    expect(human[0]?.actionPreview).toBeUndefined();
    const endpoints = tasks.map(
      (task) => (task.inputTemplate as { endpointId?: unknown } | undefined)?.endpointId,
    );
    for (const forbidden of ['closePullRequest', 'createReview']) {
      expect(endpoints).not.toContain(forbidden);
    }
    expect(tasks.map((task) => task.operation)).not.toContain('host.process.exec');
  });

  it('merges only in its `merge` task, only on a `merge` decision, and decides `merge` only under `when-green`', () => {
    const merging = tasks.filter(
      (task) =>
        (task.inputTemplate as { endpointId?: unknown } | undefined)?.endpointId ===
        'mergePullRequest',
    );
    expect(merging.map((task) => task.taskId)).toEqual(['merge', 'merge-again']);
    const claimed = [
      "tasks.decide.output.decision == 'merge'",
      "tasks.claim-merge.status == 'succeeded'",
    ];
    // On a merge decision, and only where this pass claimed the head under
    // the lease — nothing being recorded for it.
    expect(merging[0]!.when).toMatchObject({ allOf: claimed });
    // The second only where the first was refused because the base alone moved.
    expect(merging[1]!.when).toMatchObject({
      allOf: [...claimed, "tasks.judge-merge-refusal.output.decision == 'base_moved'"],
    });
    for (const task of merging) {
      // Squash, pinned to the head read; never retried into a second approval.
      expect(task.inputTemplate).toMatchObject({
        params: { body: { merge_method: 'squash', sha: { $bind: 'headSha' } } },
      });
      expect(task.maxAttempts).toBe(1);
    }

    const merges = SHEPHERD_RULES.filter((rule) => rule.decision === 'merge');
    expect(merges).toHaveLength(3);
    const first = SHEPHERD_RULES.findIndex((rule) =>
      JSON.stringify(rule.when).includes('mergePosture'),
    );
    expect(SHEPHERD_RULES[first]).toMatchObject({ decision: 'leave' });
    for (const merge of merges) expect(SHEPHERD_RULES.indexOf(merge)).toBeGreaterThan(first);
    // Every wait that can hold on a green head — hands-off, a live lease, a
    // publication or commission in flight, a read that failed — is read first.
    // The waits after them hold only where CI is not passing — but a read a
    // merge needs that GitHub did not answer, read again next pass, and a
    // head GitHub has not yet said merges, the last rule before the merge.
    const mergeIndex = SHEPHERD_RULES.indexOf(merges[0]!);
    expect(SHEPHERD_RULES[mergeIndex - 1]).toMatchObject({
      decision: 'wait',
      when: { allOf: expect.arrayContaining(['state.pr.data.mergeable != true']) },
    });
    const failedRead = /state\.(requiredRulesStatus|requiredProtectionStatus|reviewsStatus) != 200/;
    for (const [index, rule] of SHEPHERD_RULES.entries()) {
      if (rule.decision !== 'wait' || index < first || index === mergeIndex - 1) continue;
      if (failedRead.test(JSON.stringify(rule.when))) continue;
      expect(JSON.stringify(rule.when)).toMatch(
        /state\.checks\.data\.(state != 'failing'|firstFailing)/,
      );
    }
  });

  it('pushes only by starting Local Publish, as the Store installed it', () => {
    const starts = tasks.filter((task) => task.operation === 'workflow.run.start');
    expect(starts.map((task) => task.taskId)).toEqual(['publish']);
    expect(starts[0]!.inputTemplate).toMatchObject({ catalogId: PUBLISH_LOCAL_CHANGES.catalogId });
  });

  it('lets no decision model gate the publication: the remedy question only routes the remedies', () => {
    const classify = taskById.get('classify-failure')!;
    expect(classify.inputTemplate).not.toHaveProperty('model');
    expect(classify.routes?.flatMap((route) => route.enable).sort()).toEqual(
      ['bump-dependency', 'fix', 'merge-round', 'rerun-jobs'].sort(),
    );
    const publishGuard = JSON.stringify(taskById.get('publish')!.when);
    expect(publishGuard).not.toContain('classify-failure');
    // The rules are a model-free step.
    expect(taskById.get('decide')!.operation).toBe('workflow.run.decide');
  });
});

/** The record a pass left after fixing a red check on an earlier head: pinned, so trusted. */
const EARLIER_ROUND: ShepherdHandoffRead = {
  found: true,
  trust: 'verified',
  commentId: 9,
  attemptCount: 1,
  nextAttemptCount: 2,
  checkRunId: '554',
  headSha: 'd'.repeat(40),
  decision: 'fix',
  publicationRunId: 'pub-run-1',
};

/** A green pull request of a `when-green` folder that every condition says to merge. */
function green(s: Scenario = {}): Pass {
  return pass({
    mergePosture: 'when-green',
    checks: GREEN,
    checkConclusions: { Test: 'success', Lint: 'success' },
    pinned: 'found',
    handoff: EARLIER_ROUND,
    ...s,
  });
}

const MERGE_READS = [
  'read-required-rules',
  'read-required-protection',
  'read-pr-reviews',
  'read-publication',
  'read-publication-review',
];

describe('Local PR Shepherd — it merges what the posture allows', () => {
  it('under when-green, merges a green, approved pull request by squash, pinned to the head it read, under the lease', () => {
    const merged = green();
    expect(merged.decision).toBe('merge');
    expect(merged.ran).toEqual(expect.arrayContaining([...MERGE_READS, 'lease', 'merge']));
    expect(merged.inputs.get('merge')).toMatchObject({
      apiId: 'github',
      endpointId: 'mergePullRequest',
      params: { pull_number: 94, body: { merge_method: 'squash', sha: HEAD } },
    });
    expect(merged.ran.indexOf('merge')).toBeGreaterThan(merged.ran.indexOf('lease'));
    // A merge is no fix: nothing is commissioned or published, and no failure is counted.
    for (const task of [
      'read-failure',
      'classify-failure',
      'rerun-jobs',
      ...COMMISSIONS,
      'publish',
    ]) {
      expect(merged.ran).not.toContain(task);
    }
    expect(merged.ran.indexOf('release')).toBeGreaterThan(merged.ran.indexOf('record-merge'));
    expect(merged.handoff).toMatchObject({
      decision: 'merge',
      attemptCount: 1,
      headSha: HEAD,
      mergeCommitSha: MERGE_COMMIT,
    });
    expect(merged.handoff?.mergeDeclinedSha).toBeUndefined();
  });

  it('asks no merge of a draft and claims no head, then merges the same head once it is marked ready', () => {
    const store = new Map<string, Record<string, unknown>>();
    const draft = green({ pullRequest: { draft: true }, mergeOutcomes: store });
    expect(draft.decision).toBe('leave');
    expect(draft.outputs.get('decide')?.['reason']).toMatch(/is a draft/);
    for (const task of ['lease', 'lease-takeover', 'claim-merge', 'merge']) {
      expect(draft.statuses.get(task)).not.toBe('succeeded');
    }
    expect(store.size).toBe(0);
    // The draft rule is read before every rule that can decide `merge`.
    const draftRule = SHEPHERD_RULES.findIndex((rule) =>
      JSON.stringify(rule.when).includes('state.pr.data.draft'),
    );
    const mergeRule = SHEPHERD_RULES.findIndex((rule) => rule.decision === 'merge');
    expect(draftRule).toBeGreaterThanOrEqual(0);
    expect(draftRule).toBeLessThan(mergeRule);

    const ready = green({ mergeOutcomes: store });
    expect(ready.decision).toBe('merge');
    expect(ready.statuses.get('claim-merge')).toBe('succeeded');
    expect(ready.statuses.get('merge')).toBe('succeeded');
  });

  it('reads the required checks from the rulesets and the classic protection together, and judges each on the head', () => {
    const merged = green({ required: { rules: ['Test'], protection: ['Lint'] } });
    expect(presetOf(merged.inputs.get('read-required-protection')!)).toBe(
      'loop_required_protection:Test',
    );
    expect(presetOf(merged.inputs.get('read-pr-checks')!)).toBe('loop_checks:Lint,Test');
    expect(merged.decision).toBe('merge');
    // A check only the protection requires holds the merge back as well.
    const held = green({
      required: { rules: ['Test'], protection: ['Lint'] },
      checkConclusions: { Test: 'success' },
    });
    expect(held.decision).toBe('leave');
  });

  it('records the lease as a merge, which a pass paused at its merge card holds past the bound', () => {
    const merged = green();
    expect(MemoryPutInputSchema.parse(merged.inputs.get('lease')).content.inlineJson).toMatchObject(
      {
        decision: 'merge',
        headSha: HEAD,
      },
    );
    const card = green({
      lease: { owner: 'paused', ageMs: SHEPHERD_LEASE_STALE_AFTER_MS * 2, decision: 'merge' },
    });
    expect(card.decision).toBe('wait');
    expect(card.ran).not.toContain('merge');
    expect(card.ran).not.toContain('lease-takeover');
    // A fix pass's lease past the bound is stale, as before.
    const stale = green({
      lease: { owner: 'paused', ageMs: SHEPHERD_LEASE_STALE_AFTER_MS + 1, decision: 'fix' },
    });
    expect(stale.decision).toBe('merge');
    expect(stale.ran).toContain('lease-takeover');
  });

  it('under never, leaves the same green, approved pull request to the operator, reading nothing it would merge on', () => {
    const left = green({ mergePosture: 'never' });
    expect(left.decision).toBe('leave');
    expect(left.outputs.get('decide')?.['reason']).toMatch(/merge posture is `never`/);
    for (const task of [...MERGE_READS, 'lease', 'merge']) {
      expect(left.statuses.get(task)).not.toBe('succeeded');
    }
    // The checks are read with no required set, as before the posture existed.
    expect(presetOf(left.inputs.get('read-pr-checks')!)).toBe('loop_checks');
  });

  it('leaves it where the push posture runs no review, so no verdict exists', () => {
    const left = green({ pushApproval: 'never' });
    expect(left.decision).toBe('leave');
    expect(left.outputs.get('decide')?.['reason']).toMatch(/runs no review/);
    expect(left.ran).not.toContain('merge');
  });

  // The first planted refusal: a red check on the head is never merged — the
  // shepherd fixes it, or waits on the fix it already made.
  it('refuses to merge a head with a red check, and raises no merge approval', () => {
    const red = green({ checks: FAILING, checkConclusions: { Test: 'failure', Lint: 'success' } });
    expect(red.decision).toBe('fix');
    expect(red.ran).not.toContain('merge');
    const acted = green({
      checks: FAILING,
      checkConclusions: { Test: 'failure' },
      handoff: { ...EARLIER_ROUND, checkRunId: FAILING_CHECK },
    });
    expect(acted.decision).toBe('wait');
    expect(acted.ran).not.toContain('merge');
  });

  it.each([
    ['skipped', { Test: 'skipped', Lint: 'success' }],
    ['reported only as a commit status, with no check run', { Lint: 'success' }],
  ])('leaves a head whose required check was %s, naming it in the handoff', (_how, conclusions) => {
    const left = green({ checkConclusions: conclusions });
    expect(left.decision).toBe('leave');
    expect(left.ran).not.toContain('merge');
    expect(left.ran).not.toContain('lease');
    const body = String(
      (left.inputs.get('handoff-edit')!['params'] as { body: { body: string } }).body.body,
    );
    expect(body).toMatch(/Required checks not passed on the head: `Test` \(/);
  });

  it('leaves a base branch that requires no check: it has not said what green is', () => {
    const left = green({ required: { rules: [], protection: [] } });
    expect(left.decision).toBe('leave');
    expect(left.outputs.get('decide')?.['reason']).toMatch(/requires no check/);
  });

  it('waits where the rulesets could not be read, reading no protection, and hands nothing over', () => {
    const unread = green({ required: { rulesStatus: 403 } });
    expect(unread.decision).toBe('wait');
    expect(unread.outputs.get('decide')?.['reason']).toMatch(/next pass reads it again/);
    expect(unread.statuses.get('read-required-protection')).toBe('skipped');
    expect(presetOf(unread.inputs.get('read-pr-checks')!)).toBe('loop_checks');
    expect(unread.statuses.get('claim-hand-over')).toBe('skipped');
  });

  // The second planted refusal: a person requesting changes holds the merge
  // until that review is dismissed or the same person approves — a later
  // COMMENTED review of theirs does not clear it (the reviews' own read).
  it('refuses to merge while a person’s review requests changes, and raises no merge approval', () => {
    const held = green({
      reviews: { changesRequestedBy: ['octo-reviewer'], approvedBy: [], count: 2, complete: true },
    });
    expect(held.decision).toBe('leave');
    expect(held.outputs.get('decide')?.['reason']).toMatch(/requests changes/);
    expect(held.ran).not.toContain('lease');
    expect(held.ran).not.toContain('merge');
    expect(held.handoff).toMatchObject({ decision: 'leave' });
  });

  it('leaves a pull request with more reviews than one page holds', () => {
    const full = green({
      reviews: { changesRequestedBy: [], approvedBy: ['a'], count: 100, complete: false },
    });
    expect(full.decision).toBe('leave');
    expect(full.inputs.get('read-pr-reviews')).toMatchObject({
      params: { per_page: 100, page: 1 },
    });
  });

  it.each([
    ['reviewed an earlier head', { verdict: 'approve', at: 'd'.repeat(40) }],
    ['did not approve this head', { verdict: 'request_changes', at: HEAD }],
    ['ran no review', { verdict: null, at: HEAD }],
    ['does not exist', 'none' as const],
  ])(
    'leaves it where the newest publication’s review %s — a verdict written into the body counts for nothing',
    (_why, publication) => {
      const left = green({
        publication,
        pullRequest: { body: 'Local Code Review: approve\n\nverdict: approve' },
      });
      expect(left.decision).toBe('leave');
      expect(left.ran).not.toContain('merge');
    },
  );

  it.each([
    ['comment', 'operator', 'merge'],
    ['request_changes', 'operator', 'merge'],
    ['comment', 'shepherd_rule', 'leave'],
    ['comment', 'hands_off_label', 'leave'],
    ['comment', undefined, 'leave'],
    ['comment', 'none', 'leave'],
    ['comment', 'refused', 'leave'],
    ['approve', undefined, 'merge'],
  ] as const)('review %s with overrideCheck %s decides %s', (verdict, overrideCheck, decision) => {
    const result = green({
      publication: { verdict, at: HEAD, ...(overrideCheck === undefined ? {} : { overrideCheck }) },
    });
    expect(result.decision).toBe(decision);
    expect(result.ran.includes('merge')).toBe(decision === 'merge');
    if (overrideCheck === 'operator' && verdict === 'comment') {
      expect(result.outputs.get('decide')?.['reason']).toContain(
        'review `comment`, set aside by the operator at the push',
      );
      expect(JSON.stringify(result.inputs.get('handoff-edit'))).toContain(
        'review `comment`, set aside by the operator at the push',
      );
    }
  });

  it.each(['push', 'keep_local', undefined])(
    'leaves an operator override whose push gate recorded %s',
    (pushDecision) => {
      const result = green({
        publications: [
          {
            id: PUBLICATION_RUN,
            verdict: 'comment',
            reviewed: HEAD,
            pushed: HEAD,
            overrideCheck: 'operator',
            ...(pushDecision === undefined ? {} : { pushDecision }),
          },
        ],
      });
      expect(result.decision).toBe('leave');
      expect(result.ran).not.toContain('merge');
    },
  );

  it.each([
    { mergePosture: 'never' as const },
    { reviews: { changesRequestedBy: ['octo'], approvedBy: [], count: 1, complete: true } },
    { pullRequest: { mergeable: false } },
    { checkConclusions: { Test: 'failure', Lint: 'success' } },
  ])('keeps the other merge conditions under an operator override: %j', (scenario) => {
    const result = green({
      ...scenario,
      publication: { verdict: 'comment', at: HEAD, overrideCheck: 'operator' },
    });
    expect(result.ran).not.toContain('merge');
  });

  it('reads the operator override only from the publication that pushed the head', () => {
    const result = green({
      publications: [
        {
          id: 'newer-unpushed',
          verdict: 'comment',
          reviewed: HEAD,
          pushed: null,
          overrideCheck: 'operator',
        },
        { id: PUBLICATION_RUN, verdict: 'comment', reviewed: HEAD, pushed: HEAD },
      ],
    });
    expect(result.decision).toBe('leave');
    expect(result.ran).not.toContain('merge');
  });

  it('merges on the approve of a review retried in place, as on a first pass that approved', () => {
    const merged = green({ publication: { verdict: 'approve', at: HEAD, retriedInPlace: true } });
    expect(merged.decision).toBe('merge');
    // The one read of the verdict is the publication's review task through
    // `workflow.run.detail`, which reads it by the review run's final attempt.
    expect(merged.inputs.get('read-publication-review')).toMatchObject({
      taskOutput: 'review-commit',
    });
    const verdictRule = MERGE_RULES.find((rule) =>
      JSON.stringify(rule.when).includes('publicationReview.verdict'),
    );
    expect(verdictRule?.reason).toContain('its final attempt where it was retried in place');
  });

  it('reads the verdict from the finished publication of the branch that pushed the head, never from the pull request', () => {
    const merged = green();
    expect(WorkflowRunListInputSchema.parse(merged.inputs.get('read-publication'))).toMatchObject({
      slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
      input: { field: 'branch', equals: BRANCH },
      succeeded: [
        { taskId: PUBLICATION_PUSH_TASK },
        {
          taskId: PUBLICATION_COMMIT_TASK,
          output: { path: PUBLICATION_PUSHED_SHA_PATH, equals: HEAD },
        },
      ],
      status: ['completed', 'failed', 'cancelled'],
      limit: 1,
    });
    expect(merged.inputs.get('read-publication-review')).toEqual({
      runId: PUBLICATION_RUN,
      compact: true,
      taskOutput: 'review-commit',
    });
  });

  it('decides from the fields its rules read: no headers, no body, no run envelope', () => {
    const merged = green();
    const state = merged.inputs.get('decide')?.['state'] as Record<string, unknown>;
    expect(JSON.stringify(state)).not.toMatch(/x-ratelimit|durationMs|Planted failing test/);
    expect(state['pr']).toEqual({
      statusCode: 200,
      data: {
        ours: true,
        state: 'open',
        handsOff: false,
        draft: false,
        headSha: HEAD,
        mergeable: true,
      },
    });
    expect(state['reviews']).toEqual({ complete: true, changesRequestedBy: [] });
    expect(state['publicationReview']).toEqual({ verdict: 'approve', reviewed: { at: HEAD } });
    for (const name of ['requiredRules', 'requiredProtection', 'reviews']) {
      expect(state[`${name}Status`]).toBe(200);
    }
    expect(merged.decision).toBe('merge');
  });

  it('names the tasks of Local Publish that push a commit, and the output naming the commit pushed', () => {
    const published = new Map(
      PUBLISH_LOCAL_CHANGES.bundle.workflow.tasks.map((task) => [task.taskId, task]),
    );
    const push = published.get(PUBLICATION_PUSH_TASK);
    expect(push?.inputBindings).toMatchObject({
      refspec: { kind: 'task_output', taskId: PUBLICATION_COMMIT_TASK, path: 'commit.pushRefspec' },
    });
    const bindings = PUBLISH_LOCAL_CHANGES.bundle.workflow.tasks.flatMap((task) =>
      Object.values((task.inputBindings ?? {}) as Record<string, unknown>),
    );
    expect(bindings).toContainEqual({
      kind: 'task_output',
      taskId: PUBLICATION_COMMIT_TASK,
      path: PUBLICATION_PUSHED_SHA_PATH,
    });
  });

  describe('a head pushed by an older publication than the newest', () => {
    const PUSHED_HEAD = 'da3e7cb1-0000-4000-8000-000000000185';
    const unpushed = [3, 2, 1].map((n) => ({
      id: `da3e7cb${String(n + 1)}-0000-4000-8000-000000000185`,
      verdict: 'request_changes',
      reviewed: String(n).repeat(40),
      pushed: null,
    }));
    const pushedHead = { id: PUSHED_HEAD, verdict: 'approve', reviewed: HEAD, pushed: HEAD };

    it('merges a green head on the review of the publication that pushed it, past newer ones that pushed nothing', () => {
      const merged = green({ publications: [...unpushed, pushedHead] });
      expect(merged.decision).toBe('merge');
      expect(merged.inputs.get('read-publication-review')).toMatchObject({ runId: PUSHED_HEAD });
      expect(merged.ran).toContain('merge');
    });

    it('leaves it, no review on record, only where no publication pushed the head', () => {
      const left = green({
        publications: [...unpushed, { ...pushedHead, pushed: null }],
      });
      expect(left.decision).toBe('leave');
      expect(left.statuses.get('read-publication-review')).toBe('skipped');
      expect(left.outputs.get('decide')?.['reason']).toMatch(
        /no publication of the branch pushed it/,
      );
    });
  });

  it('records a declined merge against the head, asks no more on that head, and asks again after a push', () => {
    const declined = green({ merge: 'declined' });
    expect(declined.statuses.get('merge')).toBe('failed');
    expect(declined.ran).toEqual(
      expect.arrayContaining(['record-merge', 'release', 'handoff-edit']),
    );
    expect(declined.handoff).toMatchObject({ decision: 'merge', mergeDeclinedSha: HEAD });
    expect(declined.handoff?.mergeCommitSha).toBeUndefined();

    const again = green({ handoff: readBack(declined) });
    expect(again.decision).toBe('leave');
    expect(again.outputs.get('decide')?.['reason']).toMatch(/declined to merge this head/);
    expect(again.ran).not.toContain('merge');
    // The record is carried forward while the head stands.
    expect(again.handoff).toMatchObject({ mergeDeclinedSha: HEAD });

    const pushed = 'a'.repeat(40);
    const moved = green({
      handoff: readBack(declined),
      pullRequest: { headSha: pushed },
      publication: { verdict: 'approve', at: pushed },
    });
    expect(moved.decision).toBe('merge');
    expect(moved.inputs.get('merge')).toMatchObject({ params: { body: { sha: pushed } } });
  });

  it('records a merge GitHub refused against the head, with its answer, and asks no more on that head', () => {
    const refused = green({ merge: 'refused' });
    expect(refused.handoff).toMatchObject({ mergeRefusedSha: HEAD });
    expect(refused.handoff?.mergeCommitSha).toBeUndefined();
    const body = String(
      (refused.inputs.get('handoff-edit')!['params'] as { body: { body: string } }).body.body,
    );
    expect(body).toMatch(/GitHub answered 409: Head branch was modified/);
    // A head-invalid refusal is attempted once, and judged so.
    expect(refused.outputs.get('judge-merge-refusal')?.['decision']).toBe('head_invalid');
    expect(refused.statuses.get('merge-again')).toBe('skipped');
    const again = green({ handoff: readBack(refused) });
    expect(again.decision).toBe('leave');
    expect(again.outputs.get('decide')?.['reason']).toMatch(/GitHub refused to merge this head/);
    expect(again.ran).not.toContain('merge');
  });
});

describe('Local PR Shepherd — a merge refused only because the base moved is benign', () => {
  const path = `/shepherd/aflowai/aflow/pulls/94/merges/${HEAD}.json`;

  it('reads the pull request again and merges the same head on the re-attempt', () => {
    const store = new Map<string, Record<string, unknown>>();
    const raced = green({ merge: 'base-moved', mergeOutcomes: store });
    expect(raced.decision).toBe('merge');
    expect(raced.ran.indexOf('reread-pr-after-refusal')).toBeGreaterThan(
      raced.ran.indexOf('merge'),
    );
    expect(raced.outputs.get('judge-merge-refusal')?.['decision']).toBe('base_moved');
    expect(raced.ran.indexOf('merge-again')).toBeGreaterThan(
      raced.ran.indexOf('reread-pr-after-refusal'),
    );
    // The same request, pinned to the same head: the approval already granted covers it.
    expect(raced.inputs.get('merge-again')).toEqual(raced.inputs.get('merge'));
    expect(raced.outputs.get('record-merge')?.['decision']).toBe('merged');
    expect(raced.handoff).toMatchObject({ decision: 'merge', mergeCommitSha: MERGE_COMMIT });
    expect(raced.handoff?.mergeRefusedSha).toBeUndefined();
    expect(store.get(path)).toMatchObject({ outcome: 'merged', mergeCommit: MERGE_COMMIT });
    expect(raced.ran.indexOf('release')).toBeGreaterThan(raced.ran.indexOf('merge-again'));
  });

  it('hands back merge, not leave, where the re-attempt is refused again, and the next pass merges', () => {
    const store = new Map<string, Record<string, unknown>>();
    const raced = green({ merge: 'base-moved', mergeAgain: 'base-moved', mergeOutcomes: store });
    expect(raced.decision).toBe('merge');
    expect(raced.ran).toContain('merge-again');
    const record = raced.outputs.get('record-merge');
    expect(record?.['decision']).toBe('merge');
    expect(String(record?.['reason'])).toMatch(/head is intact/);
    expect(String(record?.['reason'])).toMatch(/base branch moved/);
    // Nothing recorded against the head: no refusal in the handoff, and the claim is gone.
    expect(raced.handoff).toMatchObject({ decision: 'merge' });
    expect(raced.handoff?.mergeRefusedSha).toBeUndefined();
    expect(raced.handoff?.mergeDeclinedSha).toBeUndefined();
    expect(raced.handoff?.mergeCommitSha).toBeUndefined();
    expect(raced.statuses.get('remember-merge-outcome')).toBe('skipped');
    expect(raced.statuses.get('release-merge-claim')).toBe('succeeded');
    expect(store.has(path)).toBe(false);
    expect(raced.ran.indexOf('release')).toBeGreaterThan(raced.ran.indexOf('release-merge-claim'));
    const body = String(
      (raced.inputs.get('handoff-edit')!['params'] as { body: { body: string } }).body.body,
    );
    expect(body).toMatch(/GitHub answered 405: Base branch was modified/);
    expect(body).toMatch(/Attempted again, GitHub answered 405: Base branch was modified/);

    const next = green({ handoff: readBack(raced), mergeOutcomes: store });
    expect(next.decision).toBe('merge');
    expect(next.statuses.get('claim-merge')).toBe('succeeded');
    expect(next.ran).toContain('merge');
    expect(next.handoff).toMatchObject({ mergeCommitSha: MERGE_COMMIT });
  });

  it.each([
    ['the head moved since the pass read it', { headSha: 'a'.repeat(40) }],
    ['the pull request could not be read again', { status: 502 }],
  ])('records a base-moved refusal against the head, as before, where %s', (_why, reread) => {
    const store = new Map<string, Record<string, unknown>>();
    const refused = green({ merge: 'base-moved', reread, mergeOutcomes: store });
    expect(refused.outputs.get('judge-merge-refusal')?.['decision']).toBe('head_invalid');
    expect(refused.statuses.get('merge-again')).toBe('skipped');
    expect(refused.handoff).toMatchObject({ mergeRefusedSha: HEAD });
    expect(store.get(path)).toMatchObject({ outcome: 'merge_refused' });
    expect(green({ handoff: readBack(refused) }).decision).toBe('leave');
  });

  it('records any other 405 against the head, as before, and leaves it on the next pass', () => {
    const refused = green({ merge: 'not-mergeable' });
    expect(refused.ran).toContain('reread-pr-after-refusal');
    expect(refused.outputs.get('judge-merge-refusal')?.['decision']).toBe('head_invalid');
    expect(refused.statuses.get('merge-again')).toBe('skipped');
    expect(refused.handoff).toMatchObject({ mergeRefusedSha: HEAD });
    const again = green({ handoff: readBack(refused) });
    expect(again.decision).toBe('leave');
    expect(again.ran).not.toContain('merge');
  });

  it('judges a base-moved refusal benign only under a head still pinned and green', () => {
    const benign = {
      merge: { statusCode: 405, data: { message: BASE_MOVED_MESSAGE } },
      pr: { statusCode: 200, data: { headSha: HEAD } },
      pinnedHead: HEAD,
      checks: { statusCode: 200, data: { state: 'passing', required: { state: 'passed' } } },
    };
    const judge = (state: Record<string, unknown>) =>
      decideByRules(
        WorkflowRunDecideInputSchema.parse({
          state,
          rules: MERGE_REFUSAL_RULES,
          otherwise: MERGE_REFUSAL_OTHERWISE,
        }),
      ).decision;
    expect(judge(benign)).toBe('base_moved');
    for (const unlike of [
      { checks: { statusCode: 200, data: { state: 'failing', required: { state: 'passed' } } } },
      { checks: { statusCode: 200, data: { state: 'passing', required: { state: 'unmet' } } } },
      { checks: undefined },
      { pr: { statusCode: 200, data: { headSha: 'a'.repeat(40) } } },
      { merge: { statusCode: 409, data: { message: BASE_MOVED_MESSAGE } } },
    ]) {
      expect(judge({ ...benign, ...unlike })).toBe('head_invalid');
    }
  });
});

describe('Local PR Shepherd — the merge claims its head under the lease before it asks, so a head is asked about once', () => {
  const path = `/shepherd/aflowai/aflow/pulls/94/merges/${HEAD}.json`;

  it('claims the head under the lease before asking, and records the outcome over the claim before the release', () => {
    const store = new Map<string, Record<string, unknown>>();
    const declined = green({ merge: 'declined', mergeOutcomes: store });
    expect(declined.ran.indexOf('claim-merge')).toBeGreaterThan(declined.ran.indexOf('lease'));
    expect(declined.ran.indexOf('merge')).toBeGreaterThan(declined.ran.indexOf('claim-merge'));
    expect(declined.inputs.get('claim-merge')).toMatchObject({
      path,
      writeMode: 'create',
      content: { inlineJson: { headSha: HEAD, outcome: MERGE_ASKED } },
    });
    expect(declined.ran.indexOf('remember-merge-outcome')).toBeGreaterThan(
      declined.ran.indexOf('record-merge'),
    );
    expect(declined.ran.indexOf('release')).toBeGreaterThan(
      declined.ran.indexOf('remember-merge-outcome'),
    );
    expect(store.get(path)).toMatchObject({ headSha: HEAD, outcome: 'merge_declined' });
  });

  // The review's case: the person declined, or GitHub refused, and the
  // outcome's own record could not be written. The claim written before the
  // ask stands in its place, so the next pass — reaching `merge` by its rules
  // on a handoff that may not show the outcome — still asks nothing.
  it.each([
    ['declined by the person', 'declined'],
    ['refused', 'refused'],
  ] as const)(
    'does not ask again for a head whose merge was %s though the outcome could not be recorded',
    (_how, merge) => {
      const store = new Map<string, Record<string, unknown>>();
      const first = green({ merge, mergeOutcomes: store, outcomeWriteFails: true });
      expect(first.ran).toContain('merge');
      expect(first.statuses.get('remember-merge-outcome')).toBe('failed');
      expect(first.ran).toContain('release');
      expect(store.get(path)).toMatchObject({ headSha: HEAD, outcome: MERGE_ASKED });

      const second = green({ mergeOutcomes: store });
      expect(second.decision).toBe('merge');
      expect(second.statuses.get('claim-merge')).toBe('failed');
      expect(second.ran).not.toContain('merge');
      expect(second.statuses.get('merge')).toBe('skipped');
    },
  );

  // The overlap: the second pass read the handoff before the first rewrote
  // it, so its own record shows no outcome and its rules decide `merge`.
  // Only what the first recorded under the lease stands between it and a
  // second approval for the same head.
  it.each([
    ['declined by the person', 'declined', 'merge_declined'],
    ['refused', 'refused', 'merge_refused'],
    ['merged', 'merged', 'merged'],
  ] as const)(
    'does not ask again for a head an overlapping pass already %s, though its own handoff is stale',
    (_how, merge, outcome) => {
      const store = new Map<string, Record<string, unknown>>();
      const first = green({ merge, mergeOutcomes: store });
      expect(first.ran).toContain('merge');

      const second = green({ mergeOutcomes: store });
      expect(second.decision).toBe('merge');
      expect(second.statuses.get('claim-merge')).toBe('failed');
      expect(second.ran).not.toContain('merge');
      expect(second.statuses.get('merge')).toBe('skipped');
      expect(second.statuses.get('record-merge')).toBe('skipped');
      expect(second.statuses.get('remember-merge-outcome')).toBe('skipped');
      // The first pass's outcome stands as it was recorded; nothing overwrote it.
      expect(store.get(path)).toMatchObject({ outcome });
      expect(second.ran).toContain('release');
      expect(second.handoff?.mergeCommitSha).toBeUndefined();
    },
  );

  it('asks for a new head, whose outcome nothing has recorded', () => {
    const store = new Map<string, Record<string, unknown>>();
    green({ merge: 'declined', mergeOutcomes: store });
    const pushed = 'a'.repeat(40);
    const moved = green({
      mergeOutcomes: store,
      pullRequest: { headSha: pushed },
      publication: { verdict: 'approve', at: pushed },
    });
    expect(moved.ran).toContain('merge');
    expect(moved.inputs.get('merge')).toMatchObject({ params: { body: { sha: pushed } } });
  });

  it('asks nothing where the claim could not be written: a store that cannot answer is no absence', () => {
    const unclaimed = green({ claimFails: true });
    expect(unclaimed.decision).toBe('merge');
    expect(unclaimed.statuses.get('claim-merge')).toBe('failed');
    expect(unclaimed.ran).not.toContain('merge');
    expect(unclaimed.ran).toContain('release');
  });
});

describe('Local PR Shepherd — a green pull request costs one pass', () => {
  const path = `/shepherd/aflowai/aflow/pulls/94/merges/${HEAD}.json`;
  /** The first pass on a pull request: nothing pinned for it yet. */
  const UNPINNED = { pinned: undefined, handoff: undefined } as const;

  it('merges on the pass that finds no pin, and pins its record after the merge in that same pass', () => {
    const store = new Map<string, Record<string, unknown>>();
    const first = green({ ...UNPINNED, mergeOutcomes: store });
    // The record was read with no pinned author: nothing was trusted from it.
    expect(first.outputs.get('read-pr-handoff')).toMatchObject({
      data: { found: false, trust: 'undecided' },
    });
    expect(first.decision).toBe('merge');
    expect(first.statuses.get('merge')).toBe('succeeded');
    expect(store.get(path)).toMatchObject({ outcome: 'merged', mergeCommit: MERGE_COMMIT });
    // pin → decide → merge is one pass: the handoff is posted and pinned after the merge.
    const order = [
      'decide',
      'lease',
      'claim-merge',
      'merge',
      'record-merge',
      'release',
      'handoff',
      'remember-handoff',
    ];
    for (const [earlier, later] of order.slice(1).map((task, i) => [order[i]!, task] as const)) {
      expect(first.ran.indexOf(later)).toBeGreaterThan(first.ran.indexOf(earlier));
    }
    expect(first.statuses.get('remember-handoff')).toBe('succeeded');
    expect(
      MemoryPutInputSchema.parse(first.inputs.get('remember-handoff')).content.inlineJson,
    ).toMatchObject({ commentId: 9, author: LOOP_LOGIN });
    expect(first.handoff).toMatchObject({ decision: 'merge', mergeCommitSha: MERGE_COMMIT });
  });

  // What the pinned record once guarded is the claim's: with no pin to show a
  // decline, the head an earlier pass asked about is still never asked again.
  it.each([
    ['declined', 'merge_declined'],
    ['refused', 'merge_refused'],
    ['asked about', MERGE_ASKED],
  ])(
    'on the pass that finds no pin, asks nothing for a head an earlier pass %s',
    (_how, outcome) => {
      const store = new Map<string, Record<string, unknown>>([[path, { headSha: HEAD, outcome }]]);
      const first = green({ ...UNPINNED, mergeOutcomes: store });
      expect(first.decision).toBe('merge');
      expect(first.statuses.get('claim-merge')).toBe('failed');
      expect(first.ran).not.toContain('merge');
      expect(store.get(path)).toMatchObject({ outcome });
      expect(first.ran).toContain('release');
      expect(first.statuses.get('remember-handoff')).toBe('succeeded');
    },
  );

  // A pass that a real blocker holds back still ends there, and the next one
  // merges: only those cost a second pass.
  it.each<[string, Scenario, (first: Pass) => Scenario]>([
    [
      'CI is still running on the head',
      { checks: { state: 'pending', total: 2, failing: [] } },
      (first) => ({ handoff: readBack(first) }),
    ],
    [
      'another pass holds a live lease on the branch',
      { lease: { owner: 'running', ageMs: 60_000, decision: 'merge' } },
      (first) => ({ handoff: readBack(first) }),
    ],
    [
      'a publication of the branch is in flight',
      { publicationInFlight: true },
      (first) => ({ handoff: readBack(first) }),
    ],
    ['the pin could not be read', { pinRead: 'fails' }, () => ({ ...UNPINNED })],
  ])('takes two passes where %s', (_why, blocker, next) => {
    const store = new Map<string, Record<string, unknown>>();
    const first = green({ ...UNPINNED, ...blocker, mergeOutcomes: store });
    expect(first.decision).toBe('wait');
    for (const task of ['lease', 'lease-takeover', 'claim-merge', 'merge']) {
      expect(first.statuses.get(task)).not.toBe('succeeded');
    }
    expect(store.has(path)).toBe(false);

    const second = green({ ...next(first), mergeOutcomes: store });
    expect(second.decision).toBe('merge');
    expect(second.statuses.get('merge')).toBe('succeeded');
    expect(store.get(path)).toMatchObject({ outcome: 'merged' });
  });

  it('no rule reads whether the record is pinned', () => {
    expect(JSON.stringify(SHEPHERD_RULES)).not.toMatch(/trust/);
  });
});

describe('Local PR Shepherd — what its rules cannot act on goes to the agent', () => {
  const PR_CASES = `/shepherd/aflowai/aflow/pulls/94/handovers/${HEAD}`;
  const PR_CASE = `${PR_CASES}/does_not_merge.json`;
  const CONFLICTING: Scenario = {
    mergePosture: 'when-green',
    checks: GREEN,
    pullRequest: { mergeable: false, mergeableState: 'dirty' },
    pinned: 'found',
    handoff: EARLIER_ROUND,
  };
  const scheduleOf = (p: Pass) =>
    FlowScheduleCreateInputSchema.parse(p.inputs.get('hand-over-to-agent'));
  const briefOf = (p: Pass) => String(scheduleOf(p).input?.input);
  const handoffBodyOf = (p: Pass) =>
    String(
      (
        (p.inputs.get('handoff-edit') ?? p.inputs.get('handoff'))!['params'] as {
          body: { body: string };
        }
      ).body.body,
    );

  it('hands a conflicting head to the Helmsman — not to the operator — with what the pass read, decided and tried', () => {
    const handOvers = new Map<string, Record<string, unknown>>();
    const conflicting = pass({ ...CONFLICTING, handOvers });
    expect(conflicting.decision).toBe('leave');
    const reason = String(conflicting.outputs.get('decide')?.['reason']);
    expect(reason).toMatch(/does not merge into its base/);
    expect(reason).toMatch(/handed to the Helmsman/);
    expect(reason).not.toMatch(/operator/);
    // It acts on nothing itself: no lease, no commission, no merge.
    for (const action of [...ACTIONS, 'claim-merge', 'merge']) {
      expect(conflicting.ran).not.toContain(action);
    }

    expect(conflicting.statuses.get('hand-over-to-agent')).toBe('succeeded');
    expect(scheduleOf(conflicting)).toMatchObject({
      action: 'start_run',
      target: SHEPHERD_HAND_OVER_TARGET,
      scheduledAt: new Date(NOW).toISOString(),
    });
    expect(
      CYBERNETIC_AGENTS.some((agent) => agent.flowId === SHEPHERD_HAND_OVER_TARGET.systemRole),
    ).toBe(true);
    const brief = briefOf(conflicting);
    for (const fact of [
      'What the pass decided: `leave`',
      reason,
      `run \`${RUN_ID}\``,
      '`hb_aflow`',
      'aflowai/aflow',
      `#94 ${PULL_REQUEST_URL}`,
      `\`${BRANCH}\` at \`${HEAD}\`, into \`main\``,
      'as GitHub says: false (`dirty`)',
      'CI on the head: passing',
      'failures acted on 1; the last decision `fix`',
      'the last publication run `pub-run-1`',
      COMMISSION_CHANGE.bundle.workflow.slug,
      PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
    ]) {
      expect(brief).toContain(fact);
    }
    // The claim is the head's, beside its pinned handoff; the handoff names the conversation.
    expect(handOvers.get(PR_CASE)).toMatchObject({
      headSha: HEAD,
      case: 'does_not_merge',
      runId: RUN_ID,
    });
    expect(conflicting.ran.indexOf('handoff-edit')).toBeGreaterThan(
      conflicting.ran.indexOf('hand-over-to-agent'),
    );
    expect(handoffBodyOf(conflicting)).toContain(`handed the case to the Helmsman`);
    expect(handoffBodyOf(conflicting)).toContain(HAND_OVER_SCHEDULE);
  });

  it('hands a head over once, however many passes find it, and a push that moves it is a new case', () => {
    const handOvers = new Map<string, Record<string, unknown>>();
    const first = pass({ ...CONFLICTING, handOvers });
    expect(first.statuses.get('hand-over-to-agent')).toBe('succeeded');

    const again = pass({ ...CONFLICTING, handoff: readBack(first), handOvers });
    expect(again.decision).toBe('leave');
    expect(again.statuses.get('claim-hand-over')).toBe('failed');
    expect(again.statuses.get('hand-over-to-agent')).toBe('skipped');
    expect(handoffBodyOf(again)).not.toContain('handed the case to the Helmsman');
    // The reason speaks of the case, not of this pass, so it holds on a refused claim too.
    expect(String(again.outputs.get('decide')?.['reason'])).toMatch(
      /handed to the Helmsman once for this head, by the first pass that ends on it/,
    );

    const pushed = 'a'.repeat(40);
    const moved = pass({
      ...CONFLICTING,
      handoff: readBack(first),
      handOvers,
      pullRequest: { mergeable: false, mergeableState: 'dirty', headSha: pushed },
      publication: { verdict: 'approve', at: pushed },
    });
    expect(moved.statuses.get('hand-over-to-agent')).toBe('succeeded');
    expect(
      handOvers.has(`/shepherd/aflowai/aflow/pulls/94/handovers/${pushed}/does_not_merge.json`),
    ).toBe(true);
  });

  it('hands over another case on a head already handed over, and that case once', () => {
    const handOvers = new Map<string, Record<string, unknown>>();
    const conflicting = pass({ ...CONFLICTING, handOvers });
    expect(conflicting.statuses.get('hand-over-to-agent')).toBe('succeeded');

    // The base moved and the head merges again, unpushed: GitHub refuses its
    // merge for another reason, a case of its own on the same head.
    const refused = green({ merge: 'not-mergeable', handoff: readBack(conflicting), handOvers });
    expect(refused.outputs.get('name-hand-over-case')?.['decision']).toBe('merge_refused');
    expect(refused.statuses.get('claim-hand-over')).toBe('succeeded');
    expect(refused.statuses.get('hand-over-to-agent')).toBe('succeeded');
    expect([...handOvers.keys()].sort()).toEqual([PR_CASE, `${PR_CASES}/merge_refused.json`]);

    // The pass after it ends on the refused head: the same case, not handed over again.
    const after = green({ handoff: readBack(refused), handOvers });
    expect(after.outputs.get('name-hand-over-case')?.['decision']).toBe('merge_refused');
    expect(after.statuses.get('claim-hand-over')).toBe('failed');
    expect(after.statuses.get('hand-over-to-agent')).toBe('skipped');
    expect(handOvers.size).toBe(2);
  });

  it('commissions the fix of a red head that conflicts, as before: its commission merges the base in', () => {
    const red = pass({ pullRequest: { mergeable: false, mergeableState: 'dirty' } });
    expect(red.decision).toBe('fix');
    expect(red.ran).toContain('fix');
    expect(red.statuses.get('claim-hand-over')).toBe('skipped');
  });

  it.each<[string, Scenario, RegExp]>([
    [
      'the operator declined to merge it',
      { handoff: { ...EARLIER_ROUND, mergeDeclinedSha: HEAD } },
      /declined to merge this head/,
    ],
    [
      'a person’s review requests changes',
      {
        reviews: { changesRequestedBy: ['octo'], approvedBy: [], count: 1, complete: true },
      },
      /requests changes/,
    ],
    [
      'the publication’s review did not approve it',
      { publication: { verdict: 'request_changes', at: HEAD } },
      /did not return `approve`/,
    ],
    [
      'no publication’s review is on record for it',
      { publication: { verdict: 'approve', at: 'd'.repeat(40) } },
      /No publication's Local Code Review is on record for this head/,
    ],
  ])(
    'leaves a head that does not merge with its person, handing nothing over, where %s',
    (_why, hold, reason) => {
      const handOvers = new Map<string, Record<string, unknown>>();
      // Every check the base requires passed, so the person's own rule is the one that decides.
      const held = pass({
        ...CONFLICTING,
        checkConclusions: { Test: 'success', Lint: 'success' },
        ...hold,
        handOvers,
      });
      expect(held.decision).toBe('leave');
      expect(String(held.outputs.get('decide')?.['reason'])).toMatch(reason);
      expect(held.statuses.get('claim-hand-over')).toBe('skipped');
      expect(held.ran).not.toContain('hand-over-to-agent');
      expect(handOvers.size).toBe(0);
    },
  );

  it('waits on a head that does not merge while its CI runs, then fixes it if CI fails, handing nothing over', () => {
    const handOvers = new Map<string, Record<string, unknown>>();
    const running = pass({
      ...CONFLICTING,
      checks: { state: 'pending', total: 2, failing: [] },
      handOvers,
    });
    expect(running.decision).toBe('wait');
    expect(String(running.outputs.get('decide')?.['reason'])).toMatch(/CI has not failed/);
    expect(running.statuses.get('claim-hand-over')).toBe('skipped');
    expect(running.ran).not.toContain('hand-over-to-agent');

    const red = pass({ ...CONFLICTING, checks: FAILING });
    expect(red.decision).toBe('fix');
    expect(red.statuses.get('claim-hand-over')).toBe('skipped');

    const concluded = pass({ ...CONFLICTING, handOvers });
    expect(concluded.statuses.get('hand-over-to-agent')).toBe('succeeded');
    expect(handOvers.has(PR_CASE)).toBe(true);
  });

  it('hands over a merge GitHub refused for anything but a moved base, in the pass it was refused, with GitHub’s answer', () => {
    const handOvers = new Map<string, Record<string, unknown>>();
    const refused = green({ merge: 'not-mergeable', handOvers });
    expect(refused.outputs.get('record-merge')?.['decision']).toBe('merge_refused');
    expect(refused.statuses.get('hand-over-to-agent')).toBe('succeeded');
    expect(briefOf(refused)).toContain('GitHub answered 405: Pull Request is not mergeable');
    expect(briefOf(refused)).toContain('What the pass decided: `merge`');
    expect(handOvers.has(`${PR_CASES}/merge_refused.json`)).toBe(true);

    // The pass after it ends on the refused head, and hands nothing over twice.
    const after = green({ handoff: readBack(refused), handOvers });
    expect(after.decision).toBe('leave');
    expect(String(after.outputs.get('decide')?.['reason'])).toMatch(/handed to the Helmsman/);
    expect(String(after.outputs.get('decide')?.['reason'])).not.toMatch(/operator/);
    expect(after.statuses.get('claim-hand-over')).toBe('failed');
    expect(after.statuses.get('hand-over-to-agent')).toBe('skipped');
  });

  it('hands nothing over on a merge refused only because the base moved: that one is sent again', () => {
    const raced = green({ merge: 'base-moved' });
    expect(raced.statuses.get('claim-hand-over')).toBe('skipped');
    const handedBack = green({ merge: 'base-moved', mergeAgain: 'base-moved' });
    expect(handedBack.statuses.get('claim-hand-over')).toBe('skipped');
  });

  describe('a repository it cannot list', () => {
    const PERSISTS = SHEPHERD_UNLISTED_PERSISTS_AFTER_MS;
    const noteOf = (p: Pass) =>
      MemoryPutInputSchema.parse(p.inputs.get('note-unlisted')).content.inlineJson;
    const turnCase = (unlistedForMs: number) =>
      `/shepherd/aflowai/aflow/handovers/${hashOf({ pullNumber: 94, unlistedAtMs: NOW - unlistedForMs })}/unlisted.json`;

    it('waits on a single failed listing, hands nothing over, and notes on the turn when it failed', () => {
      const handOvers = new Map<string, Record<string, unknown>>();
      const first = pass({ listStatus: 401, turn: 94, handOvers });
      expect(first.decision).toBe('wait');
      expect(String(first.outputs.get('decide')?.['reason'])).toMatch(/next pass reads them again/);
      expect(first.statuses.get('claim-hand-over')).toBe('skipped');
      expect(first.ran).not.toContain('hand-over-to-agent');
      expect(handOvers.size).toBe(0);
      expect(MemoryPutInputSchema.parse(first.inputs.get('note-unlisted')).path).toBe(
        '/shepherd/aflowai/aflow/turn.json',
      );
      // Whose turn it is stands: the next pass that lists them tends the one after 94.
      expect(noteOf(first)).toEqual({ pullNumber: 94, runId: RUN_ID, unlistedAtMs: NOW });
    });

    it('waits while the refusal has not lasted, and keeps the time it first failed', () => {
      const handOvers = new Map<string, Record<string, unknown>>();
      for (const ageMs of [5 * 60_000, PERSISTS - 1]) {
        const within = pass({ listStatus: 401, turn: 94, unlistedForMs: ageMs, handOvers });
        expect(within.decision).toBe('wait');
        expect(String(within.outputs.get('decide')?.['reason'])).toMatch(/nor on an earlier one/);
        expect(within.statuses.get('note-unlisted')).toBe('skipped');
        expect(within.statuses.get('claim-hand-over')).toBe('skipped');
      }
      expect(handOvers.size).toBe(0);
    });

    it('hands over a listing refused on every pass for the whole bound, once, until a pass lists them again', () => {
      const handOvers = new Map<string, Record<string, unknown>>();
      const persisted = pass({ listStatus: 401, turn: 94, unlistedForMs: PERSISTS, handOvers });
      expect(persisted.decision).toBe('wait');
      expect(persisted.outputs.get('name-hand-over-case')?.['decision']).toBe('unlisted');
      expect(persisted.statuses.get('hand-over-to-agent')).toBe('succeeded');
      expect(persisted.statuses.get('note-unlisted')).toBe('skipped');
      expect([...handOvers.keys()]).toEqual([turnCase(PERSISTS)]);
      const brief = briefOf(persisted);
      expect(brief).toContain('open pull requests: 401 — Bad credentials');
      expect(brief).not.toContain('The pull request: #');
      expect(scheduleOf(persisted).name).toBe('Local PR Shepherd hands over aflowai/aflow');

      for (let next = 0; next < 3; next += 1) {
        const again = pass({ listStatus: 401, turn: 94, unlistedForMs: PERSISTS, handOvers });
        expect(again.decision).toBe('wait');
        expect(again.statuses.get('claim-hand-over')).toBe('failed');
        expect(again.statuses.get('hand-over-to-agent')).toBe('skipped');
      }

      // A pass that lists them records the turn without the note — whether
      // it tends a pull request or finds none of the loop's — so a refusal
      // after it is a first one again, waited on before it is handed over.
      for (const listed of [
        pass({ turn: 94, unlistedForMs: PERSISTS }),
        pass({ buried: true, turn: 94, unlistedForMs: PERSISTS }),
      ]) {
        expect(
          MemoryPutInputSchema.parse(listed.inputs.get('remember-turn')).content.inlineJson,
        ).toEqual({ pullNumber: 94, runId: RUN_ID });
      }
      const later = pass({ listStatus: 401, turn: 94, handOvers });
      expect(later.statuses.get('claim-hand-over')).toBe('skipped');
      expect(later.statuses.get('note-unlisted')).toBe('succeeded');
    });

    it('notes nothing over a turn it could not read, and hands nothing over', () => {
      const unread = pass({ listStatus: 401, turn: 'fails' });
      expect(unread.decision).toBe('wait');
      expect(unread.statuses.get('note-unlisted')).toBe('skipped');
      expect(unread.statuses.get('claim-hand-over')).toBe('skipped');
    });
  });

  it.each<[string, () => Pass]>([
    ['the merge posture is `never`', () => green({ mergePosture: 'never' })],
    ['the pull request is a draft', () => green({ pullRequest: { draft: true } })],
    [
      'a draft does not merge into its base',
      () => pass({ ...CONFLICTING, pullRequest: { ...CONFLICTING.pullRequest, draft: true } }),
    ],
    [
      'a draft does not merge into its base and CI is still running',
      () =>
        pass({
          ...CONFLICTING,
          checks: { state: 'pending', total: 2, failing: [] },
          pullRequest: { ...CONFLICTING.pullRequest, draft: true },
        }),
    ],
    [
      'the head does not merge under the merge posture `never`',
      () => pass({ ...CONFLICTING, mergePosture: 'never' }),
    ],
    [
      'the head does not merge where the push posture runs no review',
      () => pass({ ...CONFLICTING, pushApproval: 'always' }),
    ],
    ['GitHub did not return the rulesets once', () => green({ required: { rulesStatus: 500 } })],
    [
      'a person’s review requests changes',
      () =>
        green({
          reviews: { changesRequestedBy: ['octo'], approvedBy: [], count: 1, complete: true },
        }),
    ],
    [
      'a person’s review requests changes on a head that does not merge and has no check run',
      () =>
        pass({
          ...CONFLICTING,
          checks: { state: 'none', total: 0, failing: [] },
          reviews: { changesRequestedBy: ['octo'], approvedBy: [], count: 1, complete: true },
        }),
    ],
    [
      'the publication’s review did not approve a head that does not merge and has no check run',
      () =>
        pass({
          ...CONFLICTING,
          checks: { state: 'none', total: 0, failing: [] },
          publication: { verdict: 'request_changes', at: HEAD },
        }),
    ],
    ['the operator declined the merge', () => green({ merge: 'declined' })],
    ['the pull request is labelled hands-off', () => pass({ pullRequest: { handsOff: true } })],
    ['a publication of the branch is in flight', () => pass({ publicationInFlight: true })],
    ['CI is still running', () => pass({ checks: { state: 'pending', total: 2, failing: [] } })],
    [
      'the budget is spent',
      () =>
        pass({
          pinned: 'found',
          handoff: { ...EARLIER_ROUND, attemptCount: 3, nextAttemptCount: 4 },
        }),
    ],
  ])('hands nothing over where %s: that is a person’s or the folder’s own hold', (_why, run) => {
    const held = run();
    expect(held.statuses.get('claim-hand-over')).toBe('skipped');
    expect(held.ran).not.toContain('hand-over-to-agent');
  });

  it('leaves the pass as it decided where the conversation could not be started', () => {
    const handOvers = new Map<string, Record<string, unknown>>();
    const unstarted = pass({ ...CONFLICTING, handOvers, handOverFails: true });
    expect(unstarted.decision).toBe('leave');
    expect(unstarted.statuses.get('hand-over-to-agent')).toBe('failed');
    expect(unstarted.ran).toContain('handoff-edit');
    expect(handoffBodyOf(unstarted)).not.toContain('handed the case to the Helmsman');
  });

  it('hands over only from rules that end the pass on wait or leave, each read to one comparison', () => {
    expect(HAND_OVER_RULES.length).toBeGreaterThan(0);
    for (const rule of HAND_OVER_RULES) {
      expect(['wait', 'leave']).toContain(rule.decision);
      expect(rule.reason).toMatch(/handed to the Helmsman/);
      expect(rule.reason).not.toMatch(/operator/);
    }
    expect(DECIDED_HAND_OVER).toHaveLength(HAND_OVER_RULES.length);
    expect(taskById.get('claim-hand-over')?.when).toMatchObject({
      anyOf: expect.arrayContaining([...DECIDED_HAND_OVER]),
    });
  });

  it('names every case it hands over, one name per case — the refused merge and its refused head one', () => {
    const name = (state: Record<string, unknown>) =>
      decideByRules({
        state,
        rules: [...HAND_OVER_CASE_RULES],
        otherwise: HAND_OVER_CASE_OTHERWISE,
      }).decision;
    const names = HAND_OVER_RULES.map((rule) => name({ rule: SHEPHERD_RULES.indexOf(rule) }));
    expect(names).not.toContain(HAND_OVER_CASE_OTHERWISE.decision);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('merge_refused');
    expect(name({ rule: SHEPHERD_RULES.length - 1, mergeOutcome: 'merge_refused' })).toBe(
      'merge_refused',
    );
    // A read that failed once is no case: the next pass reads it again.
    for (const rule of HAND_OVER_RULES) {
      expect(JSON.stringify(rule.when)).not.toMatch(
        /requiredRulesStatus|requiredProtectionStatus|reviewsStatus/,
      );
    }
  });
});

describe('Local PR Shepherd — it merges only what GitHub says merges', () => {
  it('waits on a green head whose mergeability GitHub has not computed, asks nothing, and merges once it has', () => {
    const store = new Map<string, Record<string, unknown>>();
    const unknown = green({
      pullRequest: { mergeable: null, mergeableState: 'unknown' },
      mergeOutcomes: store,
    });
    expect(unknown.decision).toBe('wait');
    expect(String(unknown.outputs.get('decide')?.['reason'])).toMatch(/read again next pass/);
    for (const task of ['lease', 'claim-merge', 'merge', 'claim-hand-over']) {
      expect(unknown.statuses.get(task)).not.toBe('succeeded');
    }
    expect(store.size).toBe(0);

    const computed = green({ handoff: readBack(unknown), mergeOutcomes: store });
    expect(computed.decision).toBe('merge');
    expect(computed.statuses.get('merge')).toBe('succeeded');
  });
});

describe('Local PR Shepherd — the decision reads a bounded state', () => {
  /** Where a path through the decide task's state template ends: at a value bound whole, or the field itself. */
  function bindsPath(template: unknown, path: string[]): boolean {
    let node = template;
    for (const segment of path) {
      if (node !== null && typeof node === 'object' && '$bind' in node) return true;
      if (node !== null && typeof node === 'object' && '$firstOf' in node) return true;
      const [, key, index] = /^([^[]+)(?:\[(\d+)\])?$/.exec(segment) ?? [];
      node = (node as Record<string, unknown> | undefined)?.[key!];
      if (index !== undefined) node = (node as unknown[] | undefined)?.[Number(index)];
      if (node === undefined) return false;
    }
    return true;
  }

  it('binds every state path a rule reads, and nothing beside them', () => {
    const template = (taskById.get('decide')?.inputTemplate as { state: unknown }).state;
    const read = new Set(
      [...JSON.stringify(SHEPHERD_RULES).matchAll(/state\.([A-Za-z0-9_.[\]]+)/g)].map(
        (match) => match[1]!,
      ),
    );
    expect(read.size).toBeGreaterThan(20);
    for (const path of read) {
      expect([path, bindsPath(template, path.split('.'))]).toEqual([path, true]);
    }
  });

  it('keeps a real pass’s decision input well under the 64 KiB inline cap, whatever GitHub returns', () => {
    const failing = Array.from({ length: 100 }, (_, i) => ({
      id: String(600 + i),
      name: `Integration tests (shard ${String(i)} of 100) — node 22, ubuntu-latest`,
      conclusion: 'failure',
      runId: 37460214524,
    }));
    const heaviest = pass({
      listed: 100,
      pullRequest: { body: 'A body as long as a brief carries. '.repeat(600) },
      checks: { state: 'failing', total: 100, failing, firstFailing: failing[0]! },
      mergePosture: 'when-green',
      pinned: 'found',
      handoff: EARLIER_ROUND,
      lease: { owner: 'completed', ageMs: 60_000 },
      planNode: 'in-flight',
    });
    for (const run of [heaviest, green()]) {
      const bytes = Buffer.byteLength(JSON.stringify(run.inputs.get('decide')));
      expect(bytes).toBeLessThan(24 * 1024);
      const state = Buffer.byteLength(
        JSON.stringify((run.inputs.get('decide') as { state: unknown }).state),
      );
      expect(state).toBeLessThan(4 * 1024);
    }
  });
});

describe('Local PR Shepherd — it stops', () => {
  it('abandons at the budget instead of commissioning a fourth fix', () => {
    const spent = pass({
      pinned: 'found',
      handoff: {
        found: true,
        trust: 'verified',
        commentId: 9,
        attemptCount: 3,
        nextAttemptCount: 4,
        checkRunId: '554',
      },
    });
    expect(spent.decision).toBe('abandon');
    for (const action of ACTIONS) expect(spent.ran).not.toContain(action);
    expect(spent.handoff).toMatchObject({ decision: 'abandon', attemptCount: 3 });
  });

  // Plan 321 P2's exit: the fourth failure on one pull request ends in a
  // comment and an Action Center item.
  describe('the fourth failure ends in a comment and one Action Center item', () => {
    const spentRecord: ShepherdHandoffRead = {
      found: true,
      trust: 'verified',
      commentId: 9,
      attemptCount: 3,
      nextAttemptCount: 4,
      checkRunId: '554',
    };
    const spent = (claims: Map<string, Record<string, unknown>>, over: Scenario = {}) =>
      pass({ pinned: 'found', handoff: spentRecord, abandonClaims: claims, ...over });

    it('says why in the handoff comment, then claims the head and raises the item', () => {
      const claims = new Map<string, Record<string, unknown>>();
      const stopped = spent(claims);
      expect(stopped.decision).toBe('abandon');
      expect(stopped.handoff).toMatchObject({ decision: 'abandon', attemptCount: 3 });
      const body = (stopped.inputs.get('handoff-edit')?.['params'] as { body: { body: string } })
        .body.body;
      expect(body).toMatch(/budget allows, and CI fails again/);
      expect(body).toMatch(/Action Center item/);
      const claim = MemoryPutInputSchema.parse(stopped.inputs.get('claim-abandon'));
      expect(claim).toMatchObject({
        path: `/shepherd/aflowai/aflow/pulls/94/abandons/${HEAD}.json`,
        writeMode: 'create',
      });
      expect(claim.content.inlineJson).toMatchObject({
        headSha: HEAD,
        checkRunId: FAILING_CHECK,
        runId: RUN_ID,
      });
      expect(stopped.statuses.get('hand-over')).toBe('succeeded');
      // The comment first, then the claim, then the item.
      const at = (taskId: string) => stopped.ran.indexOf(taskId);
      expect(at('handoff-edit')).toBeLessThan(at('claim-abandon'));
      expect(at('remember-handoff')).toBeLessThan(at('claim-abandon'));
      expect(at('claim-abandon')).toBeLessThan(at('hand-over'));
      for (const action of ACTIONS) expect(stopped.ran).not.toContain(action);
    });

    it.each([
      ['paused at its item', { status: 'paused' }],
      ['ended with its item answered', { status: 'completed', answered: true }],
      ['still running within the bound', { status: 'running' }],
    ] as const)(
      'raises no second item on the same head while the pass that claimed it is %s',
      (_case, abandonOwner) => {
        const claims = new Map<string, Record<string, unknown>>();
        expect(spent(claims).statuses.get('hand-over')).toBe('succeeded');
        for (let firing = 0; firing < 3; firing += 1) {
          const again = spent(claims, { abandonOwner });
          expect(again.decision).toBe('abandon');
          expect(again.outputs.get('judge-abandon-claim')?.['decision']).toBe('live');
          for (const claim of ['claim-abandon', 'claim-abandon-takeover']) {
            expect(again.statuses.get(claim)).toBe('skipped');
          }
          expect(again.statuses.get('hand-over')).toBe('skipped');
          // The comment still holds the decision Local Publish verifies an override by.
          expect(again.handoff).toMatchObject({ decision: 'abandon' });
        }
        expect(claims.size).toBe(1);
      },
    );

    it('keeps a live claim where its pass cannot be read, and raises no second item', () => {
      const claims = new Map<string, Record<string, unknown>>();
      expect(spent(claims).statuses.get('hand-over')).toBe('succeeded');
      const [path, live] = [...claims.entries()][0]!;
      const unread = spent(claims, { abandonOwner: 'gone' });
      expect(unread.statuses.get('read-abandon-owner')).toBe('failed');
      expect(unread.outputs.get('judge-abandon-claim')?.['decision']).toBe('live');
      for (const claim of ['claim-abandon', 'claim-abandon-takeover']) {
        expect(unread.statuses.get(claim)).toBe('skipped');
      }
      expect(unread.statuses.get('hand-over')).toBe('skipped');
      expect(claims).toEqual(new Map([[path, live]]));
    });

    it('raises one item of two overlapping passes that both read no claim: the second create is refused', () => {
      const claims = new Map<string, Record<string, unknown>>();
      const unread = new Map(claims);
      const first = spent(claims);
      const second = spent(claims, { claimsAsRead: unread });
      expect(first.statuses.get('hand-over')).toBe('succeeded');
      expect(second.outputs.get('judge-abandon-claim')?.['decision']).toBe('create');
      expect(second.statuses.get('claim-abandon')).toBe('failed');
      expect(second.statuses.get('hand-over')).toBe('skipped');
      expect(claims.size).toBe(1);
    });

    // A claim whose write landed while its task never reported success — it
    // crashed, timed out or was cancelled — raised no item. It must not hold
    // the head forever: once the pass that wrote it has ended without an
    // answered item, a later pass takes it over and raises the item.
    describe('a claim persisted by a task that did not report success', () => {
      it('leaves that pass without an item, and does not keep a later pass from raising it', () => {
        const claims = new Map<string, Record<string, unknown>>();
        const crashed = spent(claims, { claimUnreported: true });
        expect(crashed.statuses.get('claim-abandon')).toBe('failed');
        expect(crashed.statuses.get('hand-over')).toBe('skipped');
        expect(claims.size).toBe(1);
        const [path, stale] = [...claims.entries()][0]!;

        const later = spent(claims, { abandonOwner: { status: 'completed' } });
        expect(later.decision).toBe('abandon');
        expect(later.inputs.get('read-abandon-owner')).toMatchObject({
          runId: RUN_ID,
          taskOutput: 'hand-over',
        });
        expect(later.outputs.get('judge-abandon-claim')?.['decision']).toBe('overwrite');
        // Taken over exactly as read, so two later passes cannot both take it.
        expect(
          MemoryPutInputSchema.parse(later.inputs.get('claim-abandon-takeover')),
        ).toMatchObject({
          path,
          writeMode: 'overwrite',
          expectedHash: hashOf(stale),
        });
        expect(later.statuses.get('hand-over')).toBe('succeeded');
      });

      it.each([
        ['its pass failed', { status: 'failed' }],
        ['its pass was cancelled', { status: 'cancelled' }],
      ] as const)('takes it over where %s', (_case, abandonOwner) => {
        const claims = new Map<string, Record<string, unknown>>();
        spent(claims, { claimUnreported: true });
        const later = spent(claims, { abandonOwner });
        expect(later.outputs.get('judge-abandon-claim')?.['decision']).toBe('overwrite');
        expect(later.statuses.get('hand-over')).toBe('succeeded');
      });

      it('takes it over from a pass still running past the bound', () => {
        const claims = new Map<string, Record<string, unknown>>();
        spent(claims, { claimUnreported: true });
        const [path, claim] = [...claims.entries()][0]!;
        claims.set(path, { ...claim, handedOverAtMs: NOW - SHEPHERD_LEASE_STALE_AFTER_MS - 1 });
        const later = spent(claims, { abandonOwner: { status: 'running' } });
        expect(later.outputs.get('judge-abandon-claim')?.['decision']).toBe('overwrite');
        expect(later.statuses.get('hand-over')).toBe('succeeded');
      });

      it('lets only one of two overlapping later passes take it over: the second overwrite no longer matches', () => {
        const claims = new Map<string, Record<string, unknown>>();
        spent(claims, { claimUnreported: true });
        // Written by an earlier run than the two that follow.
        const [path, claim] = [...claims.entries()][0]!;
        claims.set(path, { ...claim, runId: 'shepherd-run-1' });
        const dead = new Map(claims);
        const first = spent(claims, { abandonOwner: { status: 'failed' } });
        // The second read the dead claim, and its dead pass, before the first took it over.
        const second = spent(claims, { claimsAsRead: dead, abandonOwner: { status: 'failed' } });
        expect(first.statuses.get('hand-over')).toBe('succeeded');
        expect(second.outputs.get('judge-abandon-claim')?.['decision']).toBe('overwrite');
        expect(second.statuses.get('claim-abandon-takeover')).toBe('failed');
        expect(second.statuses.get('hand-over')).toBe('skipped');
      });
    });

    it('raises one for a new head a push moved it to, if CI fails there too', () => {
      const claims = new Map<string, Record<string, unknown>>();
      spent(claims);
      const pushed = spent(claims, { pullRequest: { headSha: 'd'.repeat(40) } });
      expect(pushed.statuses.get('hand-over')).toBe('succeeded');
      expect(claims.size).toBe(2);
    });

    it('raises nothing on any other decision', () => {
      for (const s of [{}, { checks: GREEN }, { pullRequest: { handsOff: true } }]) {
        const other = pass({ ...s, abandonClaims: new Map() });
        expect(other.decision).not.toBe('abandon');
        expect(other.ran).not.toContain('claim-abandon');
        expect(other.ran).not.toContain('claim-abandon-takeover');
        expect(other.ran).not.toContain('hand-over');
      }
    });
  });

  it('takes the budget as a run input', () => {
    const tight = pass({
      inputs: { attemptBudget: 1 },
      pinned: 'found',
      handoff: {
        found: true,
        trust: 'verified',
        commentId: 9,
        attemptCount: 1,
        nextAttemptCount: 2,
        checkRunId: '554',
      },
    });
    expect(tight.decision).toBe('abandon');
  });
});

describe('Local PR Shepherd — the remedy a failure wants', () => {
  it('asks one choice over the five remedies, with a bar set', () => {
    expect(Object.keys(REMEDY_QUESTION.options).sort()).toEqual([...REMEDY_ROUTES].sort());
    expect(REMEDY_QUESTION.minConfidence).toBeGreaterThan(0);
  });

  it.each([
    ['flaky_or_timeout', ['rerun-jobs']],
    ['code_defect', ['fix', 'publish']],
    ['dependency_advisory', ['bump-dependency', 'publish']],
    ['base_conflict', ['merge-round', 'publish']],
    ['ci_outage', []],
  ] as const)('routes a confident %s to %j', (remedy, acted) => {
    const routed = pass({ remedy: { value: remedy, decided: true } });
    expect(
      routed.ran.filter((task) => [...ACTIONS].includes(task) && !task.startsWith('lease')),
    ).toEqual([...acted]);
  });

  // The remedy recorded is the one the routes took: each answer, confident or
  // not, names the task that ran.
  const TAKEN: Record<string, string> = {
    'rerun-jobs': 'rerun_failed_jobs',
    fix: 'fix_commission',
    'bump-dependency': 'dependency_bump',
    'merge-round': 'merge_round',
  };
  it.each(
    REMEDY_ROUTES.flatMap((value) => [true, false].map((decided) => [value, decided] as const)),
  )('records the remedy the routes took for %s (confident: %s)', (value, decided) => {
    const routed = pass({ remedy: { value, decided } });
    const remedies = Object.keys(TAKEN).filter((task) => routed.ran.includes(task));
    expect(remedies.length).toBeLessThanOrEqual(1);
    const taken = remedies.length === 1 ? TAKEN[remedies[0]!] : 'wait_on_ci';
    expect(routed.outputs.get('record-remedy')?.['decision']).toBe(taken);
    expect(routed.handoff).toMatchObject({ remedy: taken });
  });

  it('records no remedy where the remedy question could not be asked', () => {
    const unasked = pass({ remedy: 'unavailable' });
    expect(unasked.outputs.get('record-remedy')?.['decision']).toBe('none');
    expect(unasked.handoff).toMatchObject({ remedy: 'none' });
  });

  it('takes the fix commission on an answer below its bar, whatever it leaned to', () => {
    const unsure = pass({ remedy: { value: 'flaky_or_timeout', decided: false } });
    expect(unsure.ran).toContain('fix');
    expect(unsure.ran).not.toContain('rerun-jobs');
  });

  it('reads the log of each failing job, up to three', () => {
    const two = pass({ failingJobs: 2 });
    expect(two.ran).toEqual(expect.arrayContaining(['read-failure-log-1', 'read-failure-log-2']));
    expect(two.statuses.get('read-failure-log-3')).toBe('skipped');
    expect((two.inputs.get('fix')!['inputs'] as { logs: unknown[] }).logs).toHaveLength(2);
  });
});

describe('Local PR Shepherd — what it tends', () => {
  it('aimed at none, lists the loop’s pull requests under the folder’s prefix and reads the first', () => {
    const discovered = pass();
    expect(discovered.outputs.get('aim')?.['decision']).toBe('discover');
    expect(presetOf(discovered.inputs.get('list-prs')!)).toBe('loop_pulls:aflow/');
    expect(discovered.inputs.get('read-pr')).toMatchObject({ params: { pull_number: 94 } });
  });

  // A list is one page of the repository's open pull requests, most recently
  // updated first: an aimed pull request is read by its number, so however
  // many others are open, the pass tends the one it was aimed at.
  it('aimed at a number, reads that pull request directly and tends it, though the first page of open pull requests does not hold it', () => {
    const aimed = pass({ inputs: { pullNumber: '94' }, buried: true });
    expect(aimed.statuses.get('list-prs')).toBe('skipped');
    expect(aimed.inputs.get('read-pr')).toMatchObject({
      endpointId: 'getPullRequest',
      params: { pull_number: '94' },
    });
    expect(aimed.statuses.get('read-pr')).toBe('succeeded');
    expect(aimed.decision).toBe('fix');
    expect(aimed.ran).toEqual(expect.arrayContaining(['lease', 'fix', 'publish', 'handoff']));
    expect(aimed.inputs.get('handoff')).toMatchObject({ params: { issue_number: 94 } });

    // Unaimed, the same repository offers the pass nothing to tend.
    expect(pass({ buried: true }).decision).toBe('leave');
  });

  it('aimed at a number the repository has no pull request of, leaves, saying so, and writes nothing', () => {
    const missing = pass({ inputs: { pullNumber: '7' } });
    expect(missing.outputs.get('read-pr')).toMatchObject({ statusCode: 404 });
    expect(missing.decision).toBe('leave');
    expect(missing.outputs.get('decide')?.['reason']).toMatch(/aimed at/);
    for (const action of ACTIONS) expect(missing.ran).not.toContain(action);
    expect(missing.ran).not.toContain('handoff');
  });

  it('leaves a pull request that is not the loop’s, and a green one, writing only the record on its own', () => {
    expect(pass({ pullRequest: { ours: false } }).decision).toBe('leave');
    const green = pass({ checks: { state: 'passing', total: 3, failing: [] } });
    expect(green.decision).toBe('leave');
    expect(green.ran).toContain('handoff');
  });

  // Cold, on a schedule: each pass aimed at none tends the one after the
  // last one tended, so a red pull request tended every pass cannot keep
  // every other waiting.
  it('takes its turn after the pull request the last unaimed pass tended, and records its own', () => {
    const first = pass();
    expect(MemoryGetInputSchema.parse(first.inputs.get('read-turn'))).toMatchObject({
      target: { path: '/shepherd/aflowai/aflow/turn.json' },
      ifMissing: 'absent',
    });
    expect(presetOf(first.inputs.get('list-prs')!)).toBe('loop_pulls:aflow/');
    const turned = pass({ turn: 97 });
    expect(presetOf(turned.inputs.get('list-prs')!)).toBe('loop_pulls:aflow/:97');
    expect(MemoryPutInputSchema.parse(turned.inputs.get('remember-turn'))).toMatchObject({
      path: '/shepherd/aflowai/aflow/turn.json',
      writeMode: 'upsert',
      content: { inlineJson: { pullNumber: 94 } },
    });
  });

  it('tends the newest where the turn cannot be read, and takes no turn when aimed', () => {
    const unread = pass({ turn: 'fails' });
    expect(presetOf(unread.inputs.get('list-prs')!)).toBe('loop_pulls:aflow/');
    expect(unread.decision).toBe('fix');
    const aimed = pass({ inputs: { pullNumber: '94' }, turn: 97 });
    expect(aimed.statuses.get('read-turn')).toBe('skipped');
    expect(aimed.statuses.get('remember-turn')).toBe('skipped');
  });

  it('leaves a head whose check runs outrun the one page read, saying whether CI failed is unknown — never a wait on checks still running', () => {
    const unknown = pass({ checks: { state: 'unknown', total: 140, failing: [] } });
    expect(unknown.decision).toBe('leave');
    expect(unknown.outputs.get('decide')?.['reason']).toMatch(/more check runs.*unknown/);
    expect(unknown.outputs.get('decide')?.['reason']).not.toMatch(/checks are still running/);
    for (const action of ACTIONS) expect(unknown.ran).not.toContain(action);
    expect(unknown.ran).not.toContain('merge');
    expect(unknown.handoff).toMatchObject({ decision: 'leave' });
    // Under when-green too: an unknown head is never green.
    const merging = pass({
      mergePosture: 'when-green',
      checks: { state: 'unknown', total: 140, failing: [] },
      pinned: 'found',
      handoff: readBack(pass({ checks: GREEN })),
    });
    expect(merging.decision).toBe('leave');
    expect(merging.ran).not.toContain('merge');
  });

  it('waits, acting on nothing, on a read GitHub refused', () => {
    const refused = pass({ listStatus: 401 });
    expect(refused.decision).toBe('wait');
    expect(refused.ran).not.toContain('read-pr');
    expect(refused.ran).not.toContain('handoff');
  });

  it('closes every body Local Publish writes with the marker it tends by', () => {
    expect(LOCAL_PUBLISH_PULL_REQUEST_MARKER).toMatch(/^<!-- aflow:local-publish -->$/);
  });
});

describe('Local PR Shepherd — the schedule renews itself', () => {
  const SCHEDULE = '5247eee7-0000-4000-8000-000000000001';
  const nearCap = { firingCount: MAX_FIRINGS_CAP - SCHEDULE_RENEWAL_WINDOW };
  const withHeadroom = { firingCount: MAX_FIRINGS_CAP - SCHEDULE_RENEWAL_WINDOW - 1 };
  const scheduled = (schedule: Scenario['schedule'], s: Scenario = {}) =>
    pass({ ...s, inputs: { ...s.inputs, scheduleId: SCHEDULE }, schedule });

  it(`a pass whose schedule is within ${String(SCHEDULE_RENEWAL_WINDOW)} firings of its cap creates its successor`, () => {
    const p = scheduled(nearCap);
    expect(p.statuses.get('renew-schedule')).toBe('succeeded');
    expect(p.inputs.get('renew-schedule')).toEqual({ renews: SCHEDULE });
  });

  it('a pass whose schedule has headroom creates none', () => {
    const p = scheduled(withHeadroom);
    expect(p.statuses.get('read-schedule')).toBe('succeeded');
    expect(p.statuses.get('renew-schedule')).toBe('skipped');
    expect(p.ran).not.toContain('renew-schedule');
  });

  it('two overlapping passes near the cap renew the one schedule, which keeps one successor', () => {
    const renewals = [scheduled(nearCap), scheduled(nearCap)].map((p) =>
      p.inputs.get('renew-schedule'),
    );
    expect(renewals).toEqual([{ renews: SCHEDULE }, { renews: SCHEDULE }]);
  });

  it('a schedule its owner paused is not renewed', () => {
    const p = scheduled({ ...nearCap, status: 'paused' });
    expect(p.statuses.get('renew-schedule')).toBe('skipped');
  });

  it('a pass not started by a schedule reads none and renews nothing', () => {
    const p = pass();
    expect(p.outputs.get('read-firing')?.['decision']).toBe('unscheduled');
    expect(p.ran).not.toContain('read-schedule');
    expect(p.ran).not.toContain('renew-schedule');
  });

  it('a schedule that cannot be read or renewed leaves the pass deciding as it would', () => {
    const unscheduled = pass({ checks: FAILING, handoff: NO_HANDOFF });
    const unread = scheduled('unread', { checks: FAILING, handoff: NO_HANDOFF });
    const refused = scheduled(nearCap, {
      checks: FAILING,
      handoff: NO_HANDOFF,
      renewalFails: true,
    });
    expect(unread.decision).toBe(unscheduled.decision);
    expect(refused.decision).toBe(unscheduled.decision);
    expect(refused.statuses.get('renew-schedule')).toBe('failed');
  });

  it('the skill and the bundle say the schedule renews itself, and the agent hands it on', () => {
    const bundle = getSkillBundleEntry('local-shepherd');
    expect(skillGuidance(LOCAL_PR_SHEPHERD)).toContain('The schedule renews itself');
    expect(bundle?.description).toContain('The schedule renews itself');
    const [agent] = bundle?.agents ?? [];
    expect(agent?.scheduleInput).toBe('scheduleId');
    expect(wf.runInputs.find((input) => input.id === agent?.scheduleInput)?.required).toBe(false);
  });
});

describe('Local PR Shepherd bundle', () => {
  const bundle = getSkillBundleEntry('local-shepherd');

  it('installs the skill and the agent that starts it, under the skill’s slug', () => {
    expect(bundle?.skillCatalogIds).toEqual([LOCAL_PR_SHEPHERD.catalogId]);
    expect(bundle?.prerequisiteBundleIds).toContain('local-publish');
    expect(bundle?.agents).toEqual([
      expect.objectContaining({
        kind: 'skill_starter',
        skillCatalogId: 'local-pr-shepherd',
        folderInput: 'bindingId',
      }),
    ]);
    expect(wf.runInputs.find((input) => input.id === 'bindingId')?.required).toBe(true);
  });

  it('writes an agent of one operation step, the skill’s start with literal inputs, and no model turn', () => {
    const definition = AgentDefinitionSchema.parse(
      skillStarterAgentDefinition({
        slug: wf.slug,
        catalogId: LOCAL_PR_SHEPHERD.catalogId,
        name: 'Local PR Shepherd',
        description: 'Starts a pass.',
        folderInput: 'bindingId',
        folders: ['hb_aflow'],
      }),
    );
    expect(definition.flowId).toBe('local-pr-shepherd');
    expect(definition.steps).toHaveLength(1);
    const [step] = definition.steps;
    expect(step!.operation).toBe('workflow.run.start');
    expect(step!.config).toEqual({
      slug: 'local-pr-shepherd',
      catalogId: 'local-pr-shepherd',
      inputs: { bindingId: 'hb_aflow' },
      wait: 'none',
    });
    expect(JSON.stringify(definition)).not.toMatch(/ai\.|\$\{|\$memoryRef/);
  });

  describe('on several folders', () => {
    const folders = ['hb_aflow', 'hb_docs', 'hb_site'];
    const raw = (count: number) =>
      skillStarterAgentDefinition({
        slug: wf.slug,
        catalogId: LOCAL_PR_SHEPHERD.catalogId,
        name: 'Local PR Shepherd',
        description: 'Starts a pass.',
        folderInput: 'bindingId',
        folders: folders.slice(0, count),
      });
    const starter = (count: number) => AgentDefinitionSchema.parse(raw(count));
    type Starter = ReturnType<typeof starter>;
    const folderOf = (step: Starter['steps'][number]) =>
      (step.config as { inputs: { bindingId: string } }).inputs.bindingId;

    /**
     * The run the orchestrator makes of the graph from `from`: a step that
     * succeeds takes its first success edge, one that fails its first failure
     * edge, and the step with nowhere to go ends the run as it ended. A run
     * retried starts from the step it failed on, as `retryRun` reschedules it.
     * A start fails where `refuses` says so of its folder.
     */
    function walk(definition: Starter, refuses: (folder: string) => boolean, from?: string) {
      const byId = new Map(definition.steps.map((step) => [step.stepId, step]));
      const started: string[] = [];
      let stepId = from ?? definition.startStepId;
      for (let guard = 0; guard < 50; guard += 1) {
        const step = byId.get(stepId);
        if (step === undefined) throw new Error(`no step ${stepId}`);
        expect(step.operation).toBe('workflow.run.start');
        const folder = folderOf(step);
        started.push(folder);
        const succeeded = !refuses(folder);
        const next = (succeeded ? step.onSuccess : step.onFailure).next[0]?.stepId ?? undefined;
        if (next === undefined) {
          return succeeded
            ? { started, status: 'COMPLETED' as const }
            : { started, status: 'FAILED' as const, failedOn: step };
        }
        stepId = next;
      }
      throw new Error('the graph does not end');
    }

    /** Every set of refused folders of the first `count`. */
    function* refusals(count: number) {
      const own = folders.slice(0, count);
      for (let mask = 0; mask < 1 << count; mask += 1) {
        yield { own, refused: own.filter((_, index) => (mask & (1 << index)) !== 0) };
      }
    }

    it('is a valid agent of start steps only, every one taking its config alone', () => {
      for (const count of [2, 3]) {
        expect(
          validateAgentDefinition(raw(count)).issues.filter((i) => i.level === 'error'),
        ).toEqual([]);
        const definition = starter(count);
        expect(definition.startStepId).toBe('start-skill');
        expect(definition.steps.every((step) => step.inputPassthrough === false)).toBe(true);
        expect(new Set(definition.steps.map((step) => step.operation))).toEqual(
          new Set(['workflow.run.start']),
        );
        expect(definition.allowedOperations).toEqual(['workflow.run.start']);
        expect(new Set(definition.steps.map((step) => step.stepId)).size).toBe(
          definition.steps.length,
        );
        expect(JSON.stringify(definition)).not.toMatch(/ai\.|\$\{|\$memoryRef/);
      }
    });

    it('grows by one start and one fail step per folder, so a space of many folders still installs', () => {
      for (let count = 2; count <= 12; count += 1) {
        const many = Array.from({ length: count }, (_, i) => `hb_folder_${String(i + 1)}`);
        const definition = skillStarterAgentDefinition({
          slug: wf.slug,
          catalogId: LOCAL_PR_SHEPHERD.catalogId,
          name: 'Local PR Shepherd',
          description: 'Starts a pass.',
          folderInput: 'bindingId',
          folders: many,
        });
        expect(
          validateAgentDefinition(definition).issues.filter((i) => i.level === 'error'),
        ).toEqual([]);
        const steps = AgentDefinitionSchema.parse(definition).steps;
        expect({ count, steps: steps.length }).toEqual({ count, steps: 2 * count });
        for (const [index, folder] of many.entries()) {
          const own = steps.filter((step) => folderOf(step) === folder);
          expect(own.map((step) => step.stepId)).toEqual([
            index === 0 ? 'start-skill' : `start-skill-${String(index + 1)}`,
            index === 0 ? 'start-skill-again' : `start-skill-${String(index + 1)}-again`,
          ]);
        }
      }
    });

    it('fails the run exactly when a folder’s start fails twice, on that folder’s fail step', () => {
      for (const count of [2, 3]) {
        const definition = starter(count);
        for (const { own, refused } of refusals(count)) {
          const run = walk(definition, (folder) => refused.includes(folder));
          const at = { count, refused };
          expect({ ...at, status: run.status }).toEqual({
            ...at,
            status: refused.length === 0 ? 'COMPLETED' : 'FAILED',
          });
          if (run.status === 'COMPLETED') {
            expect(run.started).toEqual(own);
            continue;
          }
          // The first refused folder: started, made again, and failed on there.
          const folder = refused[0]!;
          expect({ ...at, failedOn: run.failedOn.stepId }).toEqual({
            ...at,
            failedOn: `${definition.steps.find((s) => folderOf(s) === folder)!.stepId}-again`,
          });
          expect(folderOf(run.failedOn)).toBe(folder);
          expect(run.failedOn.name).toBe(`Start Local PR Shepherd on ${folder} again`);
          const before = own.slice(0, own.indexOf(folder));
          expect({ ...at, started: run.started }).toEqual({
            ...at,
            started: [...before, folder, folder],
          });
        }
      }
    });

    it('a retry after a failed start step proceeds: it starts the refused folder and those after it, and completes', () => {
      for (const count of [2, 3]) {
        const definition = starter(count);
        for (const { own, refused } of refusals(count)) {
          if (refused.length === 0) continue;
          const failed = walk(definition, (folder) => refused.includes(folder));
          if (failed.status !== 'FAILED') throw new Error('a refused start fails the run');
          // The cause has cleared: the retry re-runs the step the run failed on.
          const retried = walk(definition, () => false, failed.failedOn.stepId);
          const at = { count, refused, failedOn: failed.failedOn.stepId };
          expect({ ...at, status: retried.status }).toEqual({ ...at, status: 'COMPLETED' });
          // What the run still owed, and never a folder whose start went through.
          expect({ ...at, started: retried.started }).toEqual({
            ...at,
            started: own.slice(own.indexOf(folderOf(failed.failedOn))),
          });
        }
      }
    });

    it('fails a retry on the step of the folder still refused, and the next retry completes', () => {
      const definition = starter(3);
      const first = walk(definition, (folder) => folder !== 'hb_aflow');
      if (first.status !== 'FAILED') throw new Error('two refused starts fail the run');
      expect(first.failedOn.stepId).toBe('start-skill-2-again');
      expect(first.failedOn.name).toBe('Start Local PR Shepherd on hb_docs again');
      // hb_docs now starts; hb_site is still refused, and the retry fails on its step.
      const second = walk(definition, (folder) => folder === 'hb_site', first.failedOn.stepId);
      if (second.status !== 'FAILED') throw new Error('a refused start fails the retry');
      expect(second.started).toEqual(['hb_docs', 'hb_site', 'hb_site']);
      expect(second.failedOn.stepId).toBe('start-skill-3-again');
      expect(walk(definition, () => false, second.failedOn.stepId)).toEqual({
        started: ['hb_site'],
        status: 'COMPLETED',
      });
    });

    it('goes on to the next folder where a refused start goes through when it is made again', () => {
      const definition = starter(2);
      let attempts = 0;
      const run = walk(definition, (folder) => folder === 'hb_aflow' && (attempts += 1) === 1);
      expect(run).toEqual({ started: ['hb_aflow', 'hb_aflow', 'hb_docs'], status: 'COMPLETED' });
    });
  });

  it('refuses to write a starter that starts nothing', () => {
    expect(() =>
      skillStarterAgentDefinition({
        slug: wf.slug,
        catalogId: LOCAL_PR_SHEPHERD.catalogId,
        name: 'Local PR Shepherd',
        description: 'Starts a pass.',
        folderInput: 'bindingId',
        folders: [],
      }),
    ).toThrow(/at least one folder/);
  });

  // D2: a schedule starts the agent, never the skill; the one live value its
  // template carries is its own id, which the agent hands each pass.
  it('is started on a schedule: the default cron, the agent as its target, its own id as config', () => {
    expect(validateCronExpression(SHEPHERD_SCHEDULE_CRON_DEFAULT)).toBeNull();
    const schedule = FlowScheduleCreateInputSchema.parse({
      name: 'Local PR Shepherd',
      action: 'start_run',
      target: { kind: 'custom-agent', agentId: '00000000-0000-4000-8000-000000000001' },
      cron: SHEPHERD_SCHEDULE_CRON_DEFAULT,
      input: { input: 'tend', config: { [SKILL_STARTER_SCHEDULE_VARIABLE]: { $schedule: 'id' } } },
    });
    expect(schedule.cron).toBe('*/5 * * * *');
    const pitfall = wf.usage?.pitfalls.find((p) => p.includes(SHEPHERD_SCHEDULE_CRON_DEFAULT));
    expect(pitfall).toContain(`${SKILL_STARTER_SCHEDULE_VARIABLE}: { $schedule: 'id' }`);
    // The agent is scheduled by its id, which agent search returns for its slug.
    expect(pitfall).toContain("sources ['agent']");
    expect(wf.usage?.next[0]?.operation).toBe('agent.schedule.create');
  });

  it('fits the workflow task ceiling', () => {
    expect(wf.tasks.length).toBeLessThanOrEqual(WORKFLOW_TASKS_MAX);
  });
});
