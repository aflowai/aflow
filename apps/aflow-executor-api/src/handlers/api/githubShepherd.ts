/**
 * GitHub's answers as the Local PR Shepherd reads them (Plan 321): each preset
 * turns one endpoint's response into the record its rules compare, so every
 * decision the shepherd makes is read off typed fields rather than GitHub's
 * whole objects, and nothing it reads is cut to an inline summary first.
 *
 * Each throws on a body that is not the shape GitHub answers with, which the
 * caller turns into a failed step: a read that cannot be read is never a guess.
 */
import {
  type CheckRunsState,
  type CheckRunsSummary,
  type FailingCheckRun,
  type FailingJobs,
  JOB_LOG_EXCERPT_MAX_BYTES,
  JOB_LOG_EXCERPT_MAX_LINES,
  type JobLogExcerpt,
  LOCAL_PUBLISH_PULL_REQUEST_MARKER,
  LOOP_PULL_REQUEST_BODY_MAX_CHARS,
  type LoopPullRequest,
  type LoopPullRequests,
  type LoopPullRequestSummary,
  parseShepherdHandoff,
  SHEPHERD_HANDS_OFF_LABEL,
  SHEPHERD_RESPONSE_PRESETS,
  type ShepherdHandoffRead,
} from '@aflow/schemas';
import { NOTHING_SKIPPED, type SkippedPrefix } from './bodyTail.js';

type Json = Record<string, unknown>;

function record(value: unknown, what: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Json;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not text`);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error(`${what} is not a number`);
  return value;
}

function requirePrefix(arg: string | undefined, preset: string): string {
  if (arg === undefined || arg === '') {
    throw new Error(
      `${preset} reads under a branch prefix, given after a colon: ${preset}:<prefix>`,
    );
  }
  return arg;
}

function labelled(pr: Json, label: string): boolean {
  return list(pr['labels'] ?? [], 'labels').some(
    (entry) => typeof entry === 'object' && entry !== null && (entry as Json)['name'] === label,
  );
}

function carriesMarker(body: unknown): boolean {
  return typeof body === 'string' && body.includes(LOCAL_PUBLISH_PULL_REQUEST_MARKER);
}

/**
 * Whether a head and a base are one repository. The loop pushes its branches
 * to the repository it opens pull requests on, so a head in a fork — or in a
 * fork since deleted, which GitHub answers as no repository — is someone
 * else's branch, whatever its name and whatever its body says.
 */
function sameRepository(head: unknown, base: unknown): boolean {
  if (head === null || typeof head !== 'object' || base === null || typeof base !== 'object') {
    return false;
  }
  const headId = (head as Json)['id'];
  const baseId = (base as Json)['id'];
  return typeof headId === 'number' && headId === baseId;
}

interface PullRequestFields {
  number: number;
  title: string;
  body: unknown;
  headRef: string;
  headSha: string;
  baseRef: string;
  handsOff: boolean;
  updatedAt: string;
  /** Its head branch is in the repository it targets, not a fork. */
  fromBaseRepository: boolean;
}

function pullRequestFields(value: unknown): PullRequestFields {
  const pr = record(value, 'a pull request');
  const head = record(pr['head'], 'its head');
  const base = record(pr['base'], 'its base');
  return {
    number: count(pr['number'], 'its number'),
    title: text(pr['title'], 'its title'),
    body: pr['body'],
    headRef: text(head['ref'], 'its head branch'),
    headSha: text(head['sha'], 'its head sha'),
    baseRef: text(base['ref'], 'its base branch'),
    handsOff: labelled(pr, SHEPHERD_HANDS_OFF_LABEL),
    updatedAt: typeof pr['updated_at'] === 'string' ? pr['updated_at'] : '',
    fromBaseRepository: sameRepository(head['repo'], base['repo']),
  };
}

/**
 * `listPullRequests` → the loop's open pull requests under the prefix: those
 * whose body carries Local Publish's marker, those not labelled hands-off
 * first, then the most recently updated. With a number after the prefix, only
 * that pull request, and only where it is one of them.
 */
export function loopPullRequests(body: unknown, arg: string | undefined): LoopPullRequests {
  const separator = arg?.lastIndexOf(':') ?? -1;
  const tail = separator === -1 ? undefined : arg?.slice(separator + 1);
  const named = tail !== undefined && /^\d+$/.test(tail) ? Number(tail) : undefined;
  const prefix = requirePrefix(
    named === undefined ? arg : arg?.slice(0, separator),
    SHEPHERD_RESPONSE_PRESETS.pullRequests,
  );
  const pullRequests: LoopPullRequestSummary[] = list(body, 'the pull requests')
    .filter((value) => carriesMarker(record(value, 'a pull request')['body']))
    .map((value) => pullRequestFields(value))
    .filter((fields) => fields.fromBaseRepository)
    .map((fields) => {
      return {
        number: fields.number,
        title: fields.title,
        headRef: fields.headRef,
        headSha: fields.headSha,
        baseRef: fields.baseRef,
        updatedAt: fields.updatedAt,
        handsOff: fields.handsOff,
      };
    })
    .filter((pr) => pr.headRef.startsWith(prefix))
    .filter((pr) => named === undefined || pr.number === named)
    .sort(
      (a, b) =>
        Number(a.handsOff) - Number(b.handsOff) ||
        (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0),
    );
  return { pullRequests, count: pullRequests.length };
}

/** `getPullRequest` → the fields a pass reads, with whether it is the loop's under the prefix. */
export function loopPullRequest(body: unknown, arg: string | undefined): LoopPullRequest {
  const prefix = requirePrefix(arg, SHEPHERD_RESPONSE_PRESETS.pullRequest);
  const pr = record(body, 'the pull request');
  const fields = pullRequestFields(pr);
  const raw = typeof fields.body === 'string' ? fields.body : '';
  const mergeableState = pr['mergeable_state'];
  return {
    number: fields.number,
    state: text(pr['state'], 'its state'),
    title: fields.title,
    body: raw
      .replace(LOCAL_PUBLISH_PULL_REQUEST_MARKER, '')
      .trim()
      .slice(0, LOOP_PULL_REQUEST_BODY_MAX_CHARS),
    headRef: fields.headRef,
    headSha: fields.headSha,
    baseRef: fields.baseRef,
    ours: carriesMarker(raw) && fields.fromBaseRepository && fields.headRef.startsWith(prefix),
    handsOff: fields.handsOff,
    draft: pr['draft'] === true,
    commentPages: Math.max(1, Math.ceil(nonNegative(pr['comments']) / COMMENTS_PER_PAGE)),
    ...(typeof mergeableState === 'string' ? { mergeableState } : {}),
  };
}

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const STOPPED_CONCLUSIONS = new Set(['cancelled', 'action_required', 'stale']);

/** `/actions/runs/<id>/` in a check run's details URL: the Actions run it is a job of. */
function actionsRunId(detailsUrl: unknown): number | undefined {
  if (typeof detailsUrl !== 'string') return undefined;
  const id = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(detailsUrl)?.[1];
  return id === undefined ? undefined : Number(id);
}

/** `listCheckRuns` on the head → what CI says of it, and the failure a pass acts on. */
export function loopCheckRuns(body: unknown): CheckRunsSummary {
  const runs = list(record(body, 'the check runs')['check_runs'], 'check_runs').map((value) =>
    record(value, 'a check run'),
  );
  const failing: FailingCheckRun[] = runs
    .filter(
      (run) => run['status'] === 'completed' && FAILED_CONCLUSIONS.has(String(run['conclusion'])),
    )
    .map((run) => {
      const runId = actionsRunId(run['details_url']);
      return {
        id: String(count(run['id'], 'a check run id')),
        name: text(run['name'], 'a check run name'),
        conclusion: String(run['conclusion']),
        ...(runId !== undefined ? { runId } : {}),
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
  const pending = runs.some((run) => run['status'] !== 'completed');
  const stopped = runs.some((run) => STOPPED_CONCLUSIONS.has(String(run['conclusion'])));
  const state: CheckRunsState =
    failing.length > 0
      ? 'failing'
      : pending
        ? 'pending'
        : runs.length === 0
          ? 'none'
          : stopped
            ? 'stopped'
            : 'passing';
  const [firstFailing] = failing;
  return {
    state,
    total: runs.length,
    failing,
    ...(firstFailing !== undefined ? { firstFailing } : {}),
  };
}

/** The page size the shepherd reads a conversation in: GitHub's largest. */
export const COMMENTS_PER_PAGE = 100;

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Who wrote a comment, by login. GitHub logins are matched without regard to
 * case, as GitHub matches them.
 */
function authoredBy(comment: Json, login: string): boolean {
  const user = comment['user'];
  if (user === null || typeof user !== 'object') return false;
  const author = (user as Json)['login'];
  return typeof author === 'string' && author.toLowerCase() === login.toLowerCase();
}

/**
 * `listIssueComments` (or `getIssueComment`, for the one a pass pinned) → the
 * newest handoff the loop itself left on this pull request, read back as its
 * record. The record sits in an HTML comment no one sees on GitHub, so it is
 * trusted only from the login the loop's own handoff was posted as — read off
 * GitHub's answer to that post and pinned with it, never asked of `/user`,
 * which an App installation token cannot answer — and only on the pull
 * request it is read for: a comment by any other author, or on another pull
 * request, is never the record, marker or no marker. A forged count would
 * lift the budget, a forged check run hold the pull request at `wait`. The
 * argument is `<login>:<number>`; with no login nothing is trusted, and the
 * read says `undecided` rather than guessing.
 */
export function loopHandoff(body: unknown, arg: string | undefined): ShepherdHandoffRead {
  const separator = arg?.lastIndexOf(':') ?? -1;
  const number = separator === -1 ? undefined : arg?.slice(separator + 1);
  if (number === undefined || !/^\d+$/.test(number)) {
    throw new Error(
      `${SHEPHERD_RESPONSE_PRESETS.handoff} reads one pull request's handoff: give <login>:<number> after a colon`,
    );
  }
  const login = arg?.slice(0, separator) ?? '';
  if (login === '') {
    return { found: false, attemptCount: 0, nextAttemptCount: 1, trust: 'undecided' };
  }
  const comments = (Array.isArray(body) ? body : [body]).map((value) => record(value, 'a comment'));
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]!;
    if (!authoredBy(comment, login) || !onPullRequest(comment, number)) continue;
    const parsed =
      typeof comment['body'] === 'string' ? parseShepherdHandoff(comment['body']) : null;
    if (parsed === null) continue;
    return {
      found: true,
      commentId: count(comment['id'], 'a comment id'),
      ...parsed,
      nextAttemptCount: parsed.attemptCount + 1,
      trust: 'verified',
    };
  }
  return { found: false, attemptCount: 0, nextAttemptCount: 1, trust: 'verified' };
}

/** Whether a comment is on pull request `number`: its `issue_url` ends `/issues/<number>`. */
function onPullRequest(comment: Json, number: string): boolean {
  const url = comment['issue_url'];
  return typeof url === 'string' && url.endsWith(`/issues/${number}`);
}

/** `listWorkflowRunJobs` → the jobs that failed, each with the steps that did. */
export function loopFailingJobs(body: unknown): FailingJobs {
  const jobs = list(record(body, 'the jobs')['jobs'], 'jobs')
    .map((value) => record(value, 'a job'))
    .filter((job) => FAILED_CONCLUSIONS.has(String(job['conclusion'])))
    .map((job) => ({
      id: count(job['id'], 'a job id'),
      name: text(job['name'], 'a job name'),
      conclusion: String(job['conclusion']),
      failedSteps: list(job['steps'] ?? [], 'its steps')
        .map((step) => record(step, 'a step'))
        .filter((step) => FAILED_CONCLUSIONS.has(String(step['conclusion'])))
        .map((step) => text(step['name'], 'a step name')),
    }))
    .sort((a, b) => a.id - b.id);
  return { jobs, count: jobs.length };
}

/**
 * A job's log → its end: the last {@link JOB_LOG_EXCERPT_MAX_LINES} lines, fewer
 * where those pass {@link JOB_LOG_EXCERPT_MAX_BYTES}. A failure's assertion
 * and a dependency audit's advisories both sat in that span (Plan 321 P0.3).
 *
 * `log` may be only the log's end, read past `skipped`: its first line is then
 * a fragment unless the skipped bytes ended one, and is left out of the
 * excerpt while still counted once in `totalLines`.
 */
export function jobLogTail(log: string, skipped: SkippedPrefix = NOTHING_SKIPPED): JobLogExcerpt {
  const all = log.replace(/\r\n/g, '\n').replace(ANSI_ESCAPE, '').replace(/\n+$/, '').split('\n');
  const total = skipped.lineBreaks + (log.length === 0 ? 0 : all.length);
  const fragment = !skipped.endsLine && all.length > 1;
  let kept = (fragment ? all.slice(1) : all).slice(-JOB_LOG_EXCERPT_MAX_LINES);
  while (kept.length > 1 && carriedBytes(kept.join('\n')) > JOB_LOG_EXCERPT_MAX_BYTES) {
    kept = kept.slice(1);
  }
  // One line alone over the bound keeps its end.
  let excerpt = kept.join('\n');
  const cut = carriedBytes(excerpt) > JOB_LOG_EXCERPT_MAX_BYTES;
  while (carriedBytes(excerpt) > JOB_LOG_EXCERPT_MAX_BYTES) {
    excerpt = excerpt.slice(Math.ceil(excerpt.length / 10));
  }
  const lines = total === 0 ? 0 : kept.length;
  return {
    excerpt,
    lines,
    totalLines: total,
    bytes: carriedBytes(excerpt),
    truncated: cut || lines < total || skipped.bytes > 0,
  };
}

/**
 * How much of a job's end {@link jobLogTail} reads: sixteen times the excerpt's
 * bound, so 300 lines fit with room for the colour codes taken out of them,
 * whatever the whole log's size.
 */
export const JOB_LOG_READ_WINDOW_BYTES = 16 * JOB_LOG_EXCERPT_MAX_BYTES;

/** Colour and cursor codes, which GitHub's runners write into every log and no reader needs. */
// eslint-disable-next-line no-control-regex -- the escape character is what is matched
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * The excerpt's size as a task carries it: escaped as JSON, which is how the
 * step's output stores it, so the bound holds where it is spent.
 */
function carriedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

/** The shepherd's presets over a parsed JSON body, by name; the argument is what follows the first colon. */
export const SHEPHERD_RECORD_PRESETS: Record<
  string,
  (body: unknown, arg: string | undefined) => unknown
> = {
  [SHEPHERD_RESPONSE_PRESETS.pullRequests]: loopPullRequests,
  [SHEPHERD_RESPONSE_PRESETS.pullRequest]: loopPullRequest,
  [SHEPHERD_RESPONSE_PRESETS.checkRuns]: (body) => loopCheckRuns(body),
  [SHEPHERD_RESPONSE_PRESETS.handoff]: loopHandoff,
  [SHEPHERD_RESPONSE_PRESETS.failingJobs]: (body) => loopFailingJobs(body),
};
