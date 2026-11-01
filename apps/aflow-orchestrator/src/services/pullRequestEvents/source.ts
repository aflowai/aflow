/**
 * The pull request event source (Plan 339 D2): polls only the pull requests
 * the loop has open, and emits `pull_request.changed` when one's checks go
 * green, it merges, it conflicts, a review asks for changes, or it closes.
 *
 * Candidate-driven under Plan 180. The publication that opens a pull request
 * arms it (`arm.ts`); its merge or its close clears it here. A cycle with no
 * loop pull request open reads one empty range and makes no GitHub request.
 * Every read is conditional on the ETag of the answer before it.
 */
import type { Redis } from 'ioredis';
import {
  claimDuePullRequestWatches,
  clearPullRequestWatch,
  reschedulePullRequestWatch,
  savePullRequestWatch,
  type PullRequestChecksState,
  type PullRequestReadState,
  type PullRequestWatch,
} from '@aflow/redis';
import { emitPullRequestChanged } from '@aflow/cybernetic-runtime';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskLogger,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane, type PullRequestChange } from '@aflow/schemas';
import type { ConditionalAnswer, GitHubConditionalGet } from './github.js';

export const PULL_REQUEST_EVENTS_TASK_ID = 'orchestrator.pull_request_events';

/** The proposed cadence; Plan 339 P2 measures it before it is settled. */
export const PULL_REQUEST_POLL_CADENCE_MS = 60_000;

// ============================================================================
// What one poll reads
// ============================================================================

export interface PullRequestSnapshot {
  pull: PullRequestReadState;
  /** Undefined once the pull request is closed: nothing reads its checks then. */
  checks?: PullRequestChecksState;
  changesRequested?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parsePullState(body: unknown): PullRequestReadState {
  const pull = record(body);
  const head = record(pull['head']);
  const sha = head['sha'];
  if (typeof sha !== 'string' || sha.length === 0) {
    throw new Error('GitHub answered a pull request with no head sha.');
  }
  const mergeable = pull['mergeable_state'];
  return {
    state: pull['state'] === 'closed' ? 'closed' : 'open',
    merged: pull['merged'] === true,
    mergeableState: typeof mergeable === 'string' ? mergeable : null,
    headSha: sha,
  };
}

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** Green only where every check run has completed and none failed; `none` where there are none. */
export function parseChecksState(body: unknown): PullRequestChecksState {
  const runs = record(body)['check_runs'];
  if (!Array.isArray(runs) || runs.length === 0) return 'none';
  let pending = false;
  for (const run of runs) {
    const entry = record(run);
    if (entry['status'] !== 'completed') {
      pending = true;
      continue;
    }
    const conclusion = entry['conclusion'];
    if (typeof conclusion !== 'string' || !PASSING_CONCLUSIONS.has(conclusion)) return 'red';
  }
  return pending ? 'pending' : 'green';
}

/** Whether a check-runs answer holds fewer runs than the head has: it stops at one page. */
export function checkRunsTruncated(body: unknown): boolean {
  const answer = record(body);
  const runs = answer['check_runs'];
  const total = answer['total_count'];
  return typeof total === 'number' && Array.isArray(runs) && total > runs.length;
}

/** The combined commit status of a head: `none` where no status was reported on it. */
export function parseCombinedStatus(body: unknown): PullRequestChecksState {
  const answer = record(body);
  const statuses = answer['statuses'];
  const total = answer['total_count'];
  if (
    (typeof total === 'number' && total === 0) ||
    (Array.isArray(statuses) && statuses.length === 0)
  ) {
    return 'none';
  }
  const state = answer['state'];
  if (state === 'success') return 'green';
  if (state === 'failure' || state === 'error') return 'red';
  return 'pending';
}

/**
 * Whether the check runs alone say what the head's checks are. A run read red
 * or pending decides it. Green does not where the answer stopped at one page,
 * and no runs say nothing: CI may report through commit statuses instead.
 */
function checkRunsDecide(checks: {
  state: PullRequestChecksState;
  truncated?: boolean | undefined;
}): boolean {
  if (checks.state === 'red' || checks.state === 'pending') return true;
  return checks.state === 'green' && checks.truncated !== true;
}

/**
 * The head's checks where the runs do not decide them, from its combined
 * status. Past one page of runs, green needs the combined status green: with
 * no status reported there, the runs not read keep it pending.
 */
function checksOfStatuses(
  checks: { state: PullRequestChecksState; truncated?: boolean | undefined },
  statuses: PullRequestChecksState,
): PullRequestChecksState {
  if (checks.state === 'none') return statuses;
  return statuses === 'none' ? 'pending' : statuses;
}

/** Changes are requested where a reviewer's latest deciding review asked for them. */
export function parseChangesRequested(body: unknown): boolean {
  if (!Array.isArray(body)) return false;
  const latest = new Map<string, string>();
  for (const review of body) {
    const entry = record(review);
    const login = record(entry['user'])['login'];
    const state = entry['state'];
    if (typeof login !== 'string' || typeof state !== 'string') continue;
    if (state === 'COMMENTED' || state === 'PENDING') continue;
    latest.set(login, state);
  }
  return [...latest.values()].includes('CHANGES_REQUESTED');
}

/**
 * What changed between two polls, by the four changes of D1 and a close. The
 * first poll compares with nothing, so what already holds is reported once.
 */
export function pullRequestChanges(
  before: PullRequestSnapshot | undefined,
  after: PullRequestSnapshot,
): PullRequestChange[] {
  if (after.pull.merged) return before?.pull.merged === true ? [] : ['merged'];
  if (after.pull.state === 'closed') return before?.pull.state === 'closed' ? [] : ['closed'];
  const changes: PullRequestChange[] = [];
  const sameHead = before?.pull.headSha === after.pull.headSha;
  if (after.checks === 'green' && !(sameHead && before?.checks === 'green')) {
    changes.push('checks_green');
  }
  if (after.pull.mergeableState === 'dirty' && before?.pull.mergeableState !== 'dirty') {
    changes.push('conflicting');
  }
  if (after.changesRequested === true && before?.changesRequested !== true) {
    changes.push('changes_requested');
  }
  return changes;
}

/** The checks the last poll read, as it decided them. */
function storedChecksState(
  checks: { state: PullRequestChecksState; truncated?: boolean | undefined },
  statuses: { headSha: string; state: PullRequestChecksState } | undefined,
  headSha: string,
): PullRequestChecksState {
  if (checkRunsDecide(checks)) return checks.state;
  return statuses?.headSha === headSha ? checksOfStatuses(checks, statuses.state) : checks.state;
}

function snapshotOf(watch: PullRequestWatch): PullRequestSnapshot | undefined {
  if (watch.pull === undefined) return undefined;
  const pull = watch.pull.value;
  return {
    pull,
    ...(watch.checks?.value.headSha === pull.headSha
      ? { checks: storedChecksState(watch.checks.value, watch.statuses?.value, pull.headSha) }
      : {}),
    ...(watch.reviews !== undefined
      ? { changesRequested: watch.reviews.value.changesRequested }
      : {}),
  };
}

/** A conditional read: the stored value on a 304, the parsed body on a fresh answer. */
async function readConditional<T>(
  get: GitHubConditionalGet,
  watch: PullRequestWatch,
  path: string,
  previous: { etag: string; value: T } | undefined,
  parse: (body: unknown) => T,
  signal: AbortSignal | undefined,
): Promise<{ etag: string; value: T }> {
  const answer: ConditionalAnswer = await get({
    tenantId: watch.tenantId,
    spaceId: watch.spaceId,
    path,
    ...(previous !== undefined && previous.etag.length > 0 ? { etag: previous.etag } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (answer.status === 304 && previous !== undefined) {
    return { etag: answer.etag ?? previous.etag, value: previous.value };
  }
  return { etag: answer.etag ?? '', value: parse(answer.body) };
}

/** Poll one pull request: the pull request, then — while it is open — its head's checks and its reviews. */
export async function pollPullRequest(
  get: GitHubConditionalGet,
  watch: PullRequestWatch,
  signal?: AbortSignal,
): Promise<{ watch: PullRequestWatch; snapshot: PullRequestSnapshot }> {
  const base = `/repos/${encodeURIComponent(watch.owner)}/${encodeURIComponent(watch.repo)}`;
  const pull = await readConditional(
    get,
    watch,
    `${base}/pulls/${String(watch.number)}`,
    watch.pull,
    parsePullState,
    signal,
  );
  const next: PullRequestWatch = { ...watch, pull };
  if (pull.value.state === 'closed') return { watch: next, snapshot: { pull: pull.value } };

  const headSha = pull.value.headSha;
  const checks = await readConditional(
    get,
    watch,
    `${base}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
    watch.checks?.value.headSha === headSha ? watch.checks : undefined,
    (body) => ({
      headSha,
      state: parseChecksState(body),
      ...(checkRunsTruncated(body) ? { truncated: true } : {}),
    }),
    signal,
  );
  // Read only where the runs do not decide, so a repository whose CI reports
  // through check runs spends no request on it.
  const statuses = checkRunsDecide(checks.value)
    ? undefined
    : await readConditional(
        get,
        watch,
        `${base}/commits/${encodeURIComponent(headSha)}/status`,
        watch.statuses?.value.headSha === headSha ? watch.statuses : undefined,
        (body) => ({ headSha, state: parseCombinedStatus(body) }),
        signal,
      );
  const checksState =
    statuses === undefined
      ? checks.value.state
      : checksOfStatuses(checks.value, statuses.value.state);
  const reviews = await readConditional(
    get,
    watch,
    `${base}/pulls/${String(watch.number)}/reviews?per_page=100`,
    watch.reviews,
    (body) => ({ changesRequested: parseChangesRequested(body) }),
    signal,
  );
  return {
    watch: { ...next, checks, reviews, ...(statuses !== undefined ? { statuses } : {}) },
    snapshot: {
      pull: pull.value,
      checks: checksState,
      changesRequested: reviews.value.changesRequested,
    },
  };
}

// ============================================================================
// The cycle
// ============================================================================

export interface PullRequestEventsDeps {
  redis: Redis;
  get: GitHubConditionalGet;
  logger: BackgroundTaskLogger;
  now?: () => number;
  cadenceMs?: number;
  emit?: typeof emitPullRequestChanged;
}

export async function runPullRequestEventsCycle(
  deps: PullRequestEventsDeps,
  ctx: {
    maxBatch: number;
    budgetExhausted(): boolean;
    mode: 'enabled' | 'observe';
    signal?: AbortSignal;
  },
): Promise<BackgroundTaskCycleResult> {
  const now = deps.now ?? Date.now;
  const cadenceMs = deps.cadenceMs ?? PULL_REQUEST_POLL_CADENCE_MS;
  const emit = deps.emit ?? emitPullRequestChanged;
  // A claim lasts one cadence at most: every outcome of a poll gives it up and
  // sets the next poll one cadence on.
  const watches = await claimDuePullRequestWatches(deps.redis, now(), ctx.maxBatch, cadenceMs);
  if (watches.length === 0) return { candidates: 0 };
  if (ctx.mode === 'observe') return { candidates: watches.length };

  let processed = 0;
  let failed = 0;
  for (const watch of watches) {
    if (ctx.budgetExhausted()) break;
    try {
      const polled = await pollPullRequest(deps.get, watch, ctx.signal);
      const found = pullRequestChanges(snapshotOf(watch), polled.snapshot);
      const changes = [...new Set([...(watch.unsent ?? []), ...found])];
      const unsent: PullRequestChange[] = [];
      for (const change of changes) {
        const ok = await emit(deps.redis, {
          tenantId: watch.tenantId,
          spaceId: watch.spaceId,
          subject: watch.subject,
          change,
          url: watch.url,
          headSha: polled.snapshot.pull.headSha,
        });
        if (!ok) unsent.push(change);
      }
      const read: PullRequestWatch = { ...polled.watch };
      delete read.unsent;
      // A merge or a close that landed ends the watch even where an older
      // change did not land: nothing changes on the pull request after it, so
      // a watch kept for the older change would be polled for as long as
      // GitHub answers. The older change is not sent again.
      const terminalLanded = (['merged', 'closed'] as const).some(
        (change) => changes.includes(change) && !unsent.includes(change),
      );
      if (terminalLanded) {
        await clearPullRequestWatch(deps.redis, watch);
        if (unsent.length > 0) {
          failed++;
          deps.logger.warn('[pull-request-events] cleared with changes that did not land', {
            subject: watch.subject,
            unsent,
          });
          continue;
        }
      } else if (unsent.length > 0) {
        // The poll's reads are saved with the changes that did not land, so the
        // next poll sends those again and not the ones that landed. GitHub
        // answered, so this poll did not fail, and the save renews the watch.
        failed++;
        await savePullRequestWatch(deps.redis, { ...read, unsent }, now() + cadenceMs);
        continue;
      } else {
        await savePullRequestWatch(deps.redis, read, now() + cadenceMs);
      }
      processed++;
      if (changes.length > 0 || backgroundWorkVerboseLogsEnabled()) {
        deps.logger.info('[pull-request-events] polled', {
          subject: watch.subject,
          changes,
        });
      }
    } catch (err) {
      failed++;
      deps.logger.warn('[pull-request-events] poll failed; due again next cadence', {
        subject: watch.subject,
        error: err instanceof Error ? err.message : String(err),
      });
      // Not saved: a save would renew the watch's lifetime, and one whose polls
      // keep failing must lapse. Where this write fails too, the claim lapses
      // after one cadence and the pull request, still due, is polled then.
      await reschedulePullRequestWatch(deps.redis, watch, now() + cadenceMs).catch(() => undefined);
    }
  }
  return { candidates: watches.length, processed, failed };
}

export function createPullRequestEventsTask(deps: PullRequestEventsDeps): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(PULL_REQUEST_EVENTS_TASK_ID);
  const cadenceMs = runtime.intervalMs ?? PULL_REQUEST_POLL_CADENCE_MS;
  return createBackgroundTaskRunner(
    {
      taskId: PULL_REQUEST_EVENTS_TASK_ID,
      scope: runtime.scope,
      intervalMs: cadenceMs,
      maxBatch: runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
      logger: deps.logger,
    },
    (ctx) => runPullRequestEventsCycle({ ...deps, cadenceMs }, ctx),
  );
}
