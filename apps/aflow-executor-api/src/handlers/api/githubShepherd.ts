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
  decodeRequiredChecks,
  encodeRequiredChecks,
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
  PULL_REQUEST_REVIEWS_PER_PAGE,
  type PullRequestReviews,
  type RequiredCheckNames,
  type RequiredChecksVerdict,
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
 * `<prefix>` or `<prefix>:<last>`: a branch name holds no colon, so a colon
 * after the prefix starts the number of the pull request last tended.
 */
function prefixAndTurn(arg: string | undefined): { prefix: string; last?: number } {
  const prefix = requirePrefix(arg, SHEPHERD_RESPONSE_PRESETS.pullRequests);
  const colon = prefix.lastIndexOf(':');
  if (colon === -1) return { prefix };
  const last = prefix.slice(colon + 1);
  if (!/^[1-9]\d{0,9}$/.test(last)) {
    throw new Error(
      `${SHEPHERD_RESPONSE_PRESETS.pullRequests} takes the number of the pull request last tended after the prefix: ${SHEPHERD_RESPONSE_PRESETS.pullRequests}:<prefix>:<number>`,
    );
  }
  return {
    prefix: requirePrefix(prefix.slice(0, colon), SHEPHERD_RESPONSE_PRESETS.pullRequests),
    last: Number(last),
  };
}

/**
 * Newest first by number, and turned past `last`: the one below it first,
 * wrapping to the newest after the oldest. Each pass tends the first, so
 * passes take the pull requests in turn — a red one tended on every pass
 * would otherwise keep every other waiting.
 */
function inTurn(pullRequests: LoopPullRequestSummary[], last: number | undefined) {
  const newestFirst = [...pullRequests].sort((a, b) => b.number - a.number);
  if (last === undefined) return newestFirst;
  const after = newestFirst.filter((pr) => pr.number < last);
  return [...after, ...newestFirst.filter((pr) => pr.number >= last)];
}

/**
 * `listPullRequests` → the loop's open pull requests under the prefix: those
 * whose body carries Local Publish's marker, those not labelled hands-off
 * first, each group in turn after the pull request last tended.
 */
export function loopPullRequests(body: unknown, arg: string | undefined): LoopPullRequests {
  const { prefix, last } = prefixAndTurn(arg);
  const loops: LoopPullRequestSummary[] = list(body, 'the pull requests')
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
    .filter((pr) => pr.headRef.startsWith(prefix));
  const pullRequests = [
    ...inTurn(
      loops.filter((pr) => !pr.handsOff),
      last,
    ),
    ...inTurn(
      loops.filter((pr) => pr.handsOff),
      last,
    ),
  ];
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

/**
 * `listCheckRuns` on the head → what CI says of it, and the failure a pass acts on.
 *
 * One page is read, never more, so a pass's latency does not grow with the
 * head's check runs. Where GitHub holds more than the page carries, the runs
 * left unread may fail, so nothing but a failure seen on the page is a
 * verdict: the head reads `pending` while a run on the page is still going,
 * and `unknown` once none is — never `passing`, `stopped` or `none`. It is
 * not `pending` then: nothing on the page is running, and every later pass
 * reads the same page, so a wait on it would never end.
 */
export function loopCheckRuns(body: unknown, arg?: string): CheckRunsSummary {
  const page = record(body, 'the check runs');
  const totalCount = count(page['total_count'], 'total_count');
  const runs = list(page['check_runs'], 'check_runs').map((value) => record(value, 'a check run'));
  const unread = totalCount > runs.length;
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
        : unread
          ? 'unknown'
          : runs.length === 0
            ? 'none'
            : stopped
              ? 'stopped'
              : 'passing';
  const [firstFailing] = failing;
  return {
    state,
    total: totalCount,
    failing,
    ...(firstFailing !== undefined ? { firstFailing } : {}),
    ...(arg !== undefined
      ? { required: requiredChecksVerdict(runs, decodeRequiredChecks(arg)) }
      : {}),
  };
}

const NO_CHECK_RUN = 'no check run';

/**
 * Each required name judged on the head's check runs: passed only where it has
 * a run and every run of that name completed `success`. A name with no run on
 * the page — including a context only the commit Statuses API reports, which
 * is never a check run — has not passed.
 */
function requiredChecksVerdict(runs: Json[], required: string[]): RequiredChecksVerdict {
  const unmet = required.flatMap((name) => {
    const named = runs.filter((run) => run['name'] === name);
    if (named.length === 0) return [{ name, conclusion: NO_CHECK_RUN }];
    const short = named.find(
      (run) => run['status'] !== 'completed' || run['conclusion'] !== 'success',
    );
    if (short === undefined) return [];
    const conclusion = short['conclusion'];
    return [
      {
        name,
        conclusion:
          short['status'] !== 'completed'
            ? 'pending'
            : typeof conclusion === 'string'
              ? conclusion
              : 'none',
      },
    ];
  });
  return {
    state: required.length === 0 ? 'none' : unmet.length === 0 ? 'passed' : 'unmet',
    required,
    unmet,
    ...(unmet.length > 0
      ? { summary: unmet.map((check) => `\`${check.name}\` (${check.conclusion})`).join(', ') }
      : {}),
  };
}

/**
 * `getBranchRules` → the check names the rulesets that apply to the branch
 * require. GitHub answers every active rule of every ruleset on the branch,
 * one entry per rule; only `required_status_checks` names checks.
 */
export function loopRequiredRules(body: unknown): RequiredCheckNames {
  const names = list(body, 'the branch rules')
    .map((value) => record(value, 'a branch rule'))
    .filter((rule) => rule['type'] === 'required_status_checks')
    .flatMap((rule) =>
      list(
        record(rule['parameters'], 'its parameters')['required_status_checks'],
        'its required checks',
      ).map((check) => text(record(check, 'a required check')['context'], 'a check context')),
    );
  return { names: [...new Set(names)].sort(), encoded: encodeRequiredChecks(names) };
}

/**
 * `getBranch` → the classic protection's required checks, united with the
 * rulesets' names given after the colon. A token that reads the repository
 * sees `protection.required_status_checks` here; an unprotected branch has
 * none. Both spellings GitHub keeps are read: `contexts` and `checks`.
 */
export function loopRequiredProtection(body: unknown, arg: string | undefined): RequiredCheckNames {
  if (arg === undefined) {
    throw new Error(
      `${SHEPHERD_RESPONSE_PRESETS.requiredProtection} unites the branch's protection with the rulesets' checks, given after a colon`,
    );
  }
  const branch = record(body, 'the branch');
  const protection = branch['protection'];
  const checks =
    protection !== null && typeof protection === 'object'
      ? (protection as Json)['required_status_checks']
      : undefined;
  const classic: string[] = [];
  if (checks !== null && typeof checks === 'object') {
    const declared = checks as Json;
    for (const context of list(declared['contexts'] ?? [], 'its contexts')) {
      classic.push(text(context, 'a context'));
    }
    for (const check of list(declared['checks'] ?? [], 'its checks')) {
      classic.push(text(record(check, 'a check')['context'], 'a check context'));
    }
  }
  const names = [...new Set([...decodeRequiredChecks(arg), ...classic])].sort();
  return { names, encoded: encodeRequiredChecks(names) };
}

const VERDICT_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * `listPullRequestReviews`, one page → each person's standing verdict. GitHub
 * answers oldest first, so a later verdict of the same reviewer replaces an
 * earlier one; a `COMMENTED` or `PENDING` review is not a verdict and replaces
 * nothing. A bot's review is not a person's.
 */
export function loopReviews(body: unknown): PullRequestReviews {
  const reviews = list(body, 'the reviews').map((value) => record(value, 'a review'));
  const standing = new Map<string, string>();
  for (const review of reviews) {
    const state = review['state'];
    if (typeof state !== 'string' || !VERDICT_STATES.has(state)) continue;
    const user = review['user'];
    if (user === null || typeof user !== 'object') continue;
    if ((user as Json)['type'] !== 'User') continue;
    const login = text((user as Json)['login'], 'a reviewer login').toLowerCase();
    standing.set(login, state);
  }
  const by = (wanted: string) =>
    [...standing.entries()]
      .filter(([, state]) => state === wanted)
      .map(([login]) => login)
      .sort();
  return {
    changesRequestedBy: by('CHANGES_REQUESTED'),
    approvedBy: by('APPROVED'),
    count: reviews.length,
    complete: reviews.length < PULL_REQUEST_REVIEWS_PER_PAGE,
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
 *
 * `<login>:<number>:<attempts>:<checkRunId>` is the read made after the
 * pinned comment answered 404: the pin kept the attempt state that comment
 * recorded, and a record deleted from GitHub is not a pull request with no
 * record. With no handoff on the page, the read answers that state, so the
 * budget and the guard on a check run already acted on stand; a handoff
 * found there keeps the higher count of the two.
 */
export function loopHandoff(body: unknown, arg: string | undefined): ShepherdHandoffRead {
  const { login, number, carried } = handoffArgument(arg);
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
    const record =
      carried !== undefined && carried.attemptCount > parsed.attemptCount
        ? { ...parsed, ...carried }
        : parsed;
    return {
      found: true,
      commentId: count(comment['id'], 'a comment id'),
      ...record,
      nextAttemptCount: record.attemptCount + 1,
      trust: 'verified',
    };
  }
  const kept = carried ?? { attemptCount: 0 };
  return {
    found: false,
    ...kept,
    nextAttemptCount: kept.attemptCount + 1,
    trust: 'verified',
  };
}

interface CarriedAttempts {
  attemptCount: number;
  checkRunId?: string;
}

function handoffArgument(arg: string | undefined): {
  login: string;
  number: string;
  carried?: CarriedAttempts;
} {
  const parts = arg?.split(':') ?? [];
  const [login = '', number, attempts, checkRunId] = parts;
  const shaped =
    number !== undefined &&
    /^\d+$/.test(number) &&
    (parts.length === 2 ||
      (parts.length === 4 && /^\d{1,6}$/.test(attempts ?? '') && /^\d*$/.test(checkRunId ?? '')));
  if (!shaped) {
    throw new Error(
      `${SHEPHERD_RESPONSE_PRESETS.handoff} reads one pull request's handoff: give <login>:<number>, or <login>:<number>:<attempts>:<checkRunId> with the state a pin kept, after a colon`,
    );
  }
  if (parts.length === 2) return { login, number };
  return {
    login,
    number,
    carried: {
      attemptCount: Number(attempts),
      ...(checkRunId !== undefined && checkRunId !== '' ? { checkRunId } : {}),
    },
  };
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
  [SHEPHERD_RESPONSE_PRESETS.checkRuns]: loopCheckRuns,
  [SHEPHERD_RESPONSE_PRESETS.handoff]: loopHandoff,
  [SHEPHERD_RESPONSE_PRESETS.failingJobs]: (body) => loopFailingJobs(body),
  [SHEPHERD_RESPONSE_PRESETS.requiredRules]: (body) => loopRequiredRules(body),
  [SHEPHERD_RESPONSE_PRESETS.requiredProtection]: loopRequiredProtection,
  [SHEPHERD_RESPONSE_PRESETS.reviews]: (body) => loopReviews(body),
};
