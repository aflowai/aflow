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
} from '@aflow/cybernetic-runtime';
import {
  AgentDefinitionSchema,
  FlowScheduleCreateInputSchema,
  SHEPHERD_SCHEDULE_CRON_DEFAULT,
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
  SHEPHERD_LEASE_STALE_AFTER_MS,
  type ShepherdHandoffRead,
  ShepherdHandoffReadSchema,
  skillStarterAgentDefinition,
  substituteTemplateBinds,
  type WorkflowTask,
  WorkflowRunDecideInputSchema,
  WorkflowRunListInputSchema,
  WorkflowRunStartInputSchema,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { COMMISSION_CHANGE } from './commissionChange.js';
import { LOCAL_PR_SHEPHERD } from './localPrShepherd.js';
import { MERGE_ASKED } from './localPrShepherdMerge.js';
import {
  BASE_MOVED_MESSAGE,
  MERGE_REFUSAL_OTHERWISE,
  MERGE_REFUSAL_RULES,
  SHEPHERD_RULES,
} from './localPrShepherdRules.js';
import { REMEDY_QUESTION, REMEDY_ROUTES, type Remedy } from './localPrShepherdDecisions.js';
import { BUMP_BRIEF, FIX_BRIEF, MERGE_BRIEF } from './localPrShepherdRemedies.js';
import { PUBLISH_LOCAL_CHANGES } from './publishLocalChanges.js';

const wf = LOCAL_PR_SHEPHERD.bundle.workflow;
const tasks = materializeSkillTasks(wf.tasks as unknown as WorkflowTask[]);
const taskById = new Map(tasks.map((task) => [task.taskId, task]));

const HEAD = 'c'.repeat(40);
const MERGED_FROM = 'e'.repeat(40);
const FAILING_CHECK = '555';
const BRANCH = 'aflow/fix-flaky-test';

const PULL_REQUEST: LoopPullRequest = {
  number: 94,
  state: 'open',
  title: 'Planted failing test',
  body: 'A test that fails.',
  headRef: BRANCH,
  headSha: HEAD,
  baseRef: 'main',
  ours: true,
  handsOff: false,
  draft: false,
  mergeableState: 'clean',
  commentPages: 3,
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
  remedy?: { value: Remedy | null; decided: boolean } | 'unavailable';
  failingJobs?: number;
  /** What the commission returned: a patch, only the merge, or nothing. */
  commission?: 'patch' | 'merge-only' | 'failed';
  /** The folder's merge posture, and its push approval: `when-green` merges only beside `unless-unreviewed`. */
  mergePosture?: 'never' | 'when-green';
  pushApproval?: 'always' | 'never' | 'unless-unreviewed';
  /** The base branch's required checks: from its rulesets, and from its classic protection. */
  required?: { rules?: string[]; protection?: string[]; rulesStatus?: number };
  /** How each check run on the head concluded, by name, where a required check is judged on it. */
  checkConclusions?: Record<string, string>;
  reviews?: PullRequestReviews;
  /** The newest finished publication of the branch: the verdict its review returned, for the commit it reviewed. */
  publication?: { verdict: string | null; at: string } | 'none';
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
  pinState?: { attemptCount: string; checkRunId: string };
  /** The pull request the last pass aimed at none tended; `fails` where its read failed. */
  turn?: number | 'fails';
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
    if (binding.kind === 'clock') value = NOW + (binding.offsetMs ?? 0);
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
  const github = (data: unknown, statusCode = 200) => ok({ statusCode, headers: {}, data });
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
          ],
          count: 1,
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
      WorkflowRunListInputSchema.parse(input);
      return ok({
        runs:
          s.publication === 'none'
            ? []
            : [
                {
                  id: PUBLICATION_RUN,
                  status: 'completed',
                  startedAt: '2026-10-18T07:00:00Z',
                  own: false,
                },
              ],
        hasMore: false,
      });
    }
    case 'read-publication-review': {
      const publication = s.publication ?? { verdict: 'approve', at: HEAD };
      if (publication === 'none') return { ok: false };
      return ok({
        run: { runId: PUBLICATION_RUN, status: 'completed' },
        tasks: [],
        activeWaiters: [],
        taskOutput: {
          taskId: 'review-commit',
          output: {
            verdict: publication.verdict,
            reviewSummary: 'Read.',
            findings: [],
            outcome: 'completed',
            reviewRunId: 'review-run',
            reviewed: { bindingId: 'hb_aflow', from: 'b'.repeat(40), at: publication.at },
          },
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
      return ok(
        s.turn === undefined
          ? { found: false }
          : { stat: { path: 'turn' }, dataJson: { pullNumber: s.turn } },
      );
    }
    case 'remember-turn':
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
    case 'fix':
    case 'bump-dependency':
    case 'merge-round': {
      HostHarnessRunInputSchema.parse(input);
      const commission = s.commission ?? 'patch';
      if (commission === 'failed') return { ok: false };
      return ok({
        runId: 'hp_1',
        harness: { id: 'claude', selectedBy: 'default' },
        continued: false,
        baseSha: HEAD,
        merge: { from: MERGED_FROM, conflicts: [] },
        ...(commission === 'patch' ? { patchRef: 'gs://bucket/patch-1', filesChanged: 1 } : {}),
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

const COMMISSIONS = ['fix', 'bump-dependency', 'merge-round'];
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
    });
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
    ).toEqual({ commentId: 9, author: LOOP_LOGIN, attemptCount: '1', checkRunId: FAILING_CHECK });
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

    // The one rule that decides `merge` is the last of the merge rules, and
    // the first of them leaves every pull request of a folder not `when-green`.
    const merges = SHEPHERD_RULES.filter((rule) => rule.decision === 'merge');
    expect(merges).toHaveLength(1);
    const first = SHEPHERD_RULES.findIndex((rule) =>
      JSON.stringify(rule.when).includes('mergePosture'),
    );
    expect(SHEPHERD_RULES[first]).toMatchObject({ decision: 'leave' });
    expect(SHEPHERD_RULES.indexOf(merges[0]!)).toBeGreaterThan(first);
    // Every wait that can hold on a green head — hands-off, a live lease, a
    // publication or commission in flight, a read that failed — is read first.
    // The waits after them hold only where CI is not passing.
    for (const [index, rule] of SHEPHERD_RULES.entries()) {
      if (rule.decision !== 'wait' || index < first) continue;
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

  it('leaves where the rulesets could not be read, reading no protection', () => {
    const left = green({ required: { rulesStatus: 403 } });
    expect(left.decision).toBe('leave');
    expect(left.statuses.get('read-required-protection')).toBe('skipped');
    expect(presetOf(left.inputs.get('read-pr-checks')!)).toBe('loop_checks');
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

  it('reads the verdict from the newest finished publication of the branch, never from the pull request', () => {
    const merged = green();
    expect(WorkflowRunListInputSchema.parse(merged.inputs.get('read-publication'))).toMatchObject({
      slug: PUBLISH_LOCAL_CHANGES.bundle.workflow.slug,
      input: { field: 'branch', equals: BRANCH },
      status: ['completed', 'failed', 'cancelled'],
      limit: 1,
    });
    expect(merged.inputs.get('read-publication-review')).toEqual({
      runId: PUBLICATION_RUN,
      compact: true,
      taskOutput: 'review-commit',
    });
  });

  it('does not merge on a record read with no pinned author, which could not show a declined merge; the next pass does', () => {
    const first = green({ pinned: undefined, handoff: undefined });
    expect(first.decision).toBe('leave');
    expect(first.ran).toContain('remember-handoff');
    expect(green({ handoff: readBack(first) }).decision).toBe('merge');
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
        ['its pass cannot be read', 'gone'],
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
        inputs: { bindingId: 'hb_aflow' },
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

  // D2: a schedule starts the agent, never the skill, with a static template
  // the agent reads none of.
  it('is started on a schedule: the default cron, the agent as its target, a static input', () => {
    expect(validateCronExpression(SHEPHERD_SCHEDULE_CRON_DEFAULT)).toBeNull();
    const schedule = FlowScheduleCreateInputSchema.parse({
      name: 'Local PR Shepherd',
      action: 'start_run',
      target: { kind: 'custom-agent', agentId: '00000000-0000-4000-8000-000000000001' },
      cron: SHEPHERD_SCHEDULE_CRON_DEFAULT,
      input: { input: 'pass' },
    });
    expect(schedule.cron).toBe('*/5 * * * *');
    expect(
      bundle?.helmsmanHints.some((hint) => hint.includes(SHEPHERD_SCHEDULE_CRON_DEFAULT)),
    ).toBe(true);
  });

  it('fits the workflow task ceiling', () => {
    expect(wf.tasks.length).toBeLessThanOrEqual(WORKFLOW_TASKS_MAX);
  });
});
