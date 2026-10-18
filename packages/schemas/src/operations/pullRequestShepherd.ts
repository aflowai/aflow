/**
 * What the Local PR Shepherd reads off a pull request, and the records it
 * writes there (Plan 321).
 *
 * Every value here is read by two sides — Local Publish writing a pull
 * request and the API executor shaping GitHub's answers for the shepherd, or
 * the shepherd writing its handoff and reading it back on its next pass — so
 * each is written once.
 */
import { z } from 'zod';

/**
 * Closes the body of every pull request Local Publish writes. A pull request
 * whose body carries it was opened by the loop; one without it is a person's,
 * and the shepherd leaves it alone.
 */
export const LOCAL_PUBLISH_PULL_REQUEST_MARKER = '<!-- aflow:local-publish -->';

/** The label a person puts on a pull request the shepherd is to leave alone. */
export const SHEPHERD_HANDS_OFF_LABEL = 'hands-off';

/** How many failures of one pull request the shepherd acts on before it stops. */
export const SHEPHERD_ATTEMPT_BUDGET_DEFAULT = 3;

/** Where the shepherd's leases live in the space's memory: `<root>/<owner>/<repo>/<branch>/`. */
export const SHEPHERD_LEASE_ROOT = '/shepherd';
export const SHEPHERD_LEASE_DOCUMENT = 'lease.json';

/**
 * Where a pull request's handoff is pinned — `<root>/<owner>/<repo>/pulls/<number>.json`,
 * per pull request, never per branch, since a branch can carry a second pull
 * request after the first closes. It holds the comment's id and the login the
 * comment was posted as, both read off GitHub's answer to the pass that wrote
 * it: the comment is read by its id wherever it sits in a long conversation,
 * and its record is trusted only from that author.
 */
export const SHEPHERD_HANDOFF_PINS = 'pulls';

/**
 * A lease older than this is stale whatever its run says: a pass that holds
 * one longer — a commission's two hours and a publication waiting at its
 * approval besides — has stopped, and the next pass takes the lease over.
 */
export const SHEPHERD_LEASE_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * The handoff comment opens with this and carries its record as `key: value`
 * lines up to {@link SHEPHERD_HANDOFF_CLOSE}, so the record is invisible on
 * the pull request and the text after it is what a person reads.
 */
export const SHEPHERD_HANDOFF_OPEN = '<!-- aflow:shepherd';
export const SHEPHERD_HANDOFF_CLOSE = '-->';

export const SHEPHERD_HANDOFF_FIELDS = [
  'attemptCount',
  'checkRunId',
  'headSha',
  'decision',
  'classification',
  'remedy',
  'publicationRunId',
] as const;
export type ShepherdHandoffField = (typeof SHEPHERD_HANDOFF_FIELDS)[number];

export interface ShepherdHandoffRecord {
  /** Failures acted on so far. */
  attemptCount: number;
  /** The check run the last action answered; the same one again is not acted on. */
  checkRunId?: string;
  headSha?: string;
  decision?: string;
  /** What the remedy question answered, which the routes turn into the remedy taken. */
  classification?: string;
  /** The remedy the pass took: what its brief and the next classification read as the round before. */
  remedy?: string;
  publicationRunId?: string;
}

/**
 * The record a handoff comment's body carries, or null where the body is not
 * a handoff. A field written empty, or a count that is not a whole number, is
 * read as absent: the next pass then acts as on a first failure rather than
 * refusing to read the pull request at all.
 */
export function parseShepherdHandoff(body: string): ShepherdHandoffRecord | null {
  const text = body.trimStart();
  if (!text.startsWith(SHEPHERD_HANDOFF_OPEN)) return null;
  const end = text.indexOf(SHEPHERD_HANDOFF_CLOSE, SHEPHERD_HANDOFF_OPEN.length);
  const block = text.slice(SHEPHERD_HANDOFF_OPEN.length, end === -1 ? undefined : end);
  const values = new Map<string, string>();
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value !== '') values.set(key, value);
  }
  const count = values.get('attemptCount');
  const record: ShepherdHandoffRecord = {
    attemptCount: count !== undefined && /^\d{1,6}$/.test(count) ? Number(count) : 0,
  };
  for (const field of SHEPHERD_HANDOFF_FIELDS) {
    if (field === 'attemptCount') continue;
    const value = values.get(field);
    if (value !== undefined) record[field] = value;
  }
  return record;
}

// ============================================================================
// GitHub's answers, as the shepherd reads them
// ============================================================================

/**
 * The response transforms (`response.transformPresetId`) that shape GitHub's
 * answers into the records below, before anything is cut to fit inline: a
 * shepherd's rules read these fields, never GitHub's own, and a list too long
 * to inline would otherwise reach them as a summary. `pullRequests` and
 * `pullRequest` take the folder's prefix after a colon — `loop_pulls:aflow/`.
 * A pass aimed at one pull request reads it by its number and lists none.
 * `handoff` takes the login the loop posted the pinned handoff as and the pull
 * request's number, `loop_handoff:aflow-bot:94`: a record from any other author,
 * or on another pull request, is no record. With no login, `loop_handoff::94`,
 * no record is trusted. A login holds no colon.
 */
export const SHEPHERD_RESPONSE_PRESETS = {
  pullRequests: 'loop_pulls',
  pullRequest: 'loop_pull',
  checkRuns: 'loop_checks',
  handoff: 'loop_handoff',
  failingJobs: 'loop_failing_jobs',
} as const;

/** `getJobLogs`' own transform: the log cut to its excerpt (below). */
export const JOB_LOG_TAIL_PRESET = 'job_log_tail';

/** The most of a pull request's body a brief carries. */
export const LOOP_PULL_REQUEST_BODY_MAX_CHARS = 20_000;

/**
 * The bound on a failing job's log the shepherd carries, measured (Plan 321
 * §5 P0.3): the last 300 lines held the failure and its assertion for both
 * job kinds observed, and stayed under 60 KB.
 */
export const JOB_LOG_EXCERPT_MAX_LINES = 300;
export const JOB_LOG_EXCERPT_MAX_BYTES = 60 * 1024;

/** One open pull request the loop opened under the folder's prefix. */
export const LoopPullRequestSummarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  baseRef: z.string(),
  updatedAt: z.string(),
  handsOff: z.boolean(),
});
export type LoopPullRequestSummary = z.infer<typeof LoopPullRequestSummarySchema>;

/**
 * `listPullRequests` as the shepherd reads it: only the loop's pull requests
 * under the prefix, those a person has not labelled hands-off first, then the
 * most recently updated. One pass tends the first.
 */
export const LoopPullRequestsSchema = z.object({
  pullRequests: z.array(LoopPullRequestSummarySchema),
  count: z.number().int().nonnegative(),
});
export type LoopPullRequests = z.infer<typeof LoopPullRequestsSchema>;

/** `getPullRequest` as the shepherd reads it. */
export const LoopPullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  title: z.string(),
  body: z.string().describe('The body without the marker, cut to a brief’s length.'),
  headRef: z.string(),
  headSha: z.string(),
  baseRef: z.string(),
  ours: z
    .boolean()
    .describe(
      "Opened by Local Publish — its marker closes the body — from a branch of the repository itself, under the folder's prefix. A fork's pull request is never the loop's: the loop pushes to its own repository.",
    ),
  handsOff: z.boolean(),
  draft: z.boolean(),
  mergeableState: z
    .string()
    .optional()
    .describe('GitHub’s `mergeable_state`; `dirty` is a conflict with the base.'),
  commentPages: z
    .number()
    .int()
    .positive()
    .describe(
      'How many pages of 100 its conversation runs to. The last is the newest, where a handoff no pass has pinned yet is looked for.',
    ),
});
export type LoopPullRequest = z.infer<typeof LoopPullRequestSchema>;

export const CheckRunsStateSchema = z.enum(['failing', 'pending', 'passing', 'stopped', 'none']);
export type CheckRunsState = z.infer<typeof CheckRunsStateSchema>;

export const FailingCheckRunSchema = z.object({
  /** As text, so a handoff that wrote it compares equal to it. */
  id: z.string(),
  name: z.string(),
  conclusion: z.string(),
  /** The Actions workflow run it belongs to, where it is an Actions job. */
  runId: z.number().int().positive().optional(),
});
export type FailingCheckRun = z.infer<typeof FailingCheckRunSchema>;

/**
 * `listCheckRuns` on the head, as the shepherd reads it: `failing` where any
 * run failed, else `pending` while any has not finished or GitHub holds more
 * than the one page read, else `passing` where every one succeeded or was
 * skipped, `stopped` where one was cancelled or needs an action, `none` where
 * there are none.
 */
export const CheckRunsSummarySchema = z.object({
  state: CheckRunsStateSchema,
  /** GitHub's count of the head's check runs, read or not. */
  total: z.number().int().nonnegative(),
  failing: z.array(FailingCheckRunSchema),
  /** The failing run with the lowest id: the one the shepherd acts on, and records. */
  firstFailing: FailingCheckRunSchema.optional(),
});
export type CheckRunsSummary = z.infer<typeof CheckRunsSummarySchema>;

/** `listIssueComments` as the shepherd reads it: its own last handoff. */
export const ShepherdHandoffReadSchema = z.object({
  found: z.boolean(),
  commentId: z.number().int().positive().optional(),
  attemptCount: z.number().int().nonnegative(),
  /** The count a pass that acts on a failure writes: the template has no arithmetic. */
  nextAttemptCount: z.number().int().positive(),
  checkRunId: z.string().optional(),
  headSha: z.string().optional(),
  decision: z.string().optional(),
  classification: z.string().optional(),
  remedy: z.string().optional(),
  publicationRunId: z.string().optional(),
  trust: z
    .enum(['verified', 'undecided'])
    .describe(
      '`verified` where the read knew the login the loop posts as, and so could tell its record from a forgery. `undecided` where it did not: no record is trusted, and the pass decides as on a pull request with none — the default, never a wait.',
    ),
});
export type ShepherdHandoffRead = z.infer<typeof ShepherdHandoffReadSchema>;

export const FailingJobSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  conclusion: z.string(),
  failedSteps: z.array(z.string()),
});
export type FailingJob = z.infer<typeof FailingJobSchema>;

/** `listWorkflowRunJobs` as the shepherd reads it: the jobs that failed. */
export const FailingJobsSchema = z.object({
  jobs: z.array(FailingJobSchema),
  count: z.number().int().nonnegative(),
});
export type FailingJobs = z.infer<typeof FailingJobsSchema>;

/**
 * `getJobLogs`: the end of one job's log, within {@link JOB_LOG_EXCERPT_MAX_LINES}
 * and {@link JOB_LOG_EXCERPT_MAX_BYTES} as a task carries it — escaped as JSON,
 * colour codes taken out — so the step's output stays one inline payload a
 * later task binds to whole.
 */
export const JobLogExcerptSchema = z.object({
  excerpt: z.string(),
  lines: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative().describe('The excerpt’s size escaped as JSON.'),
  truncated: z.boolean().describe('True where the log was longer than the excerpt.'),
});
export type JobLogExcerpt = z.infer<typeof JobLogExcerptSchema>;
