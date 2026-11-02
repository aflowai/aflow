/**
 * GitHub's reads of one pull request for the event source (Plan 339 D2), as
 * GitHub's provider of the forge vocabulary answers them (Plan 340 D2).
 *
 * The source reads no events API. It polls four paths: the pull request, its
 * check runs, its combined status and its reviews. Every read is conditional
 * on the ETag of the answer before it.
 */
import type { PullRequestChecksState, PullRequestReadState, PullRequestWatch } from '@aflow/redis';
import { CHECK_RUN_FAILED_CONCLUSIONS } from '@aflow/schemas';
import type {
  ConditionalAnswer,
  ForgeConditionalGet,
  ForgeEventReader,
  PullRequestSnapshot,
} from '../vocabulary.js';

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

/**
 * Red where a check run concluded failure, by the shepherd's own conclusions,
 * so the source fires `checks_failed` only on a head a pass reads as failing.
 * A run still going keeps the head pending. A run that concluded neither
 * passing nor failed — cancelled, say — reads `stopped`, which a pass waits
 * on. Green only where every run passed, and `none` where there are none.
 */
export function parseChecksState(body: unknown): PullRequestChecksState {
  const runs = record(body)['check_runs'];
  if (!Array.isArray(runs) || runs.length === 0) return 'none';
  let pending = false;
  let stopped = false;
  for (const run of runs) {
    const entry = record(run);
    if (entry['status'] !== 'completed') {
      pending = true;
      continue;
    }
    const conclusion = entry['conclusion'];
    if (typeof conclusion === 'string' && CHECK_RUN_FAILED_CONCLUSIONS.has(conclusion)) {
      return 'red';
    }
    if (typeof conclusion !== 'string' || !PASSING_CONCLUSIONS.has(conclusion)) stopped = true;
  }
  if (pending) return 'pending';
  return stopped ? 'stopped' : 'green';
}

/** Whether a check-runs answer holds fewer runs than the head has: it stops at one page. */
export function checkRunsTruncated(body: unknown): boolean {
  const answer = record(body);
  const runs = answer['check_runs'];
  const total = answer['total_count'];
  return typeof total === 'number' && Array.isArray(runs) && total > runs.length;
}

/**
 * The combined commit status of a head: `none` where no status was reported on
 * it. A failed status reads `stopped`, never `red`. A shepherd pass reads only
 * check runs, so it cannot act on a failure the statuses alone report: that
 * failure is the operator's.
 */
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
  if (state === 'failure' || state === 'error') return 'stopped';
  return 'pending';
}

/**
 * Whether the check runs alone say what the head's checks are. A run read red,
 * stopped or pending decides it. Green does not where the answer stopped at
 * one page, and no runs say nothing: CI may report through commit statuses
 * instead.
 */
function checkRunsDecide(checks: {
  state: PullRequestChecksState;
  truncated?: boolean | undefined;
}): boolean {
  if (checks.state === 'red' || checks.state === 'stopped' || checks.state === 'pending') {
    return true;
  }
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
  get: ForgeConditionalGet,
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
  get: ForgeConditionalGet,
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

/** GitHub's `mergeable_state` for a head that conflicts with its base. */
const CONFLICTING_MERGEABLE_STATE = 'dirty';

export const GITHUB_EVENT_READER: ForgeEventReader = {
  poll: pollPullRequest,
  snapshotOf,
  conflicting: (pull) => pull.mergeableState === CONFLICTING_MERGEABLE_STATE,
};
