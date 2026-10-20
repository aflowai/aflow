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
 * Where a merge's outcome is recorded — `<root>/<owner>/<repo>/pulls/<number>/merges/<headSha>.json`,
 * one document per head. It is written under the branch's lease, before the
 * lease is released, and read under the lease before a merge is asked for:
 * any pass that holds the lease after one recorded an outcome for a head
 * finds it, so no two passes ask to merge the same head, however they overlap.
 */
export const SHEPHERD_MERGE_OUTCOME_DOCS = 'merges';

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
  'mergeDeclinedSha',
  'mergeRefusedSha',
  'mergeCommitSha',
] as const;
export type ShepherdHandoffField = (typeof SHEPHERD_HANDOFF_FIELDS)[number];

/**
 * The three ways a merge the shepherd asked for ends — the operator declined
 * the card, GitHub refused the request pinned to the head, or GitHub merged
 * it — each the decision of the rule step that reads it, and the handoff field
 * that records it. A template has no condition, so the handoff writes this
 * pass's outcome as one line, `mergeOutcome: <outcome> <sha>`, and
 * {@link parseShepherdHandoff} files the sha under the outcome's field.
 */
export const SHEPHERD_MERGE_OUTCOMES = {
  merge_declined: 'mergeDeclinedSha',
  merge_refused: 'mergeRefusedSha',
  merged: 'mergeCommitSha',
} as const satisfies Record<string, ShepherdHandoffField>;
export type ShepherdMergeOutcome = keyof typeof SHEPHERD_MERGE_OUTCOMES;
export const SHEPHERD_MERGE_OUTCOME_FIELDS = Object.values(SHEPHERD_MERGE_OUTCOMES);

/** The handoff line that carries this pass's merge outcome; not itself a field of the record. */
export const SHEPHERD_MERGE_OUTCOME_LINE = 'mergeOutcome';

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
  /** A head whose merge the operator declined: no later pass asks again on it. */
  mergeDeclinedSha?: string;
  /** A head GitHub refused to merge on the shepherd's request: no later pass asks again on it. */
  mergeRefusedSha?: string;
  /** The commit GitHub's squash merge made, where the shepherd's merge went through. */
  mergeCommitSha?: string;
}

/**
 * The record a handoff comment's body carries, or null where the body is not
 * a handoff. A field written empty, or a count that is not a whole number, is
 * read as absent: the next pass then acts as on a first failure rather than
 * refusing to read the pull request at all. A merge outcome on the
 * {@link SHEPHERD_MERGE_OUTCOME_LINE} line stands over the same field carried
 * forward from an earlier pass.
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
  const outcome = /^([a-z_]+) (\S+)$/.exec(values.get(SHEPHERD_MERGE_OUTCOME_LINE) ?? '');
  if (outcome !== null && Object.hasOwn(SHEPHERD_MERGE_OUTCOMES, outcome[1]!)) {
    record[SHEPHERD_MERGE_OUTCOMES[outcome[1] as ShepherdMergeOutcome]] = outcome[2]!;
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
 *
 * The merge reads (D6): `requiredRules` shapes the base branch's ruleset rules
 * into the check names they require; `requiredProtection` shapes the branch
 * and its classic protection, taking the rules' names after a colon, into the
 * union of the two; `checkRuns` takes that union after a colon and says of
 * each required name whether a check run on the head passed it. Names travel
 * as {@link encodeRequiredChecks} writes them, since a template joins text
 * and nothing else. `reviews` shapes one page of reviews into each person's
 * standing verdict.
 */
export const SHEPHERD_RESPONSE_PRESETS = {
  pullRequests: 'loop_pulls',
  pullRequest: 'loop_pull',
  checkRuns: 'loop_checks',
  handoff: 'loop_handoff',
  failingJobs: 'loop_failing_jobs',
  requiredRules: 'loop_required_rules',
  requiredProtection: 'loop_required_protection',
  reviews: 'loop_reviews',
} as const;

/**
 * A set of check names as one line of text: each URI-encoded, so no name can
 * hold the separator, joined by commas in sorted order. The empty set is the
 * empty string, which is a set read and found empty — never a set unread.
 */
export function encodeRequiredChecks(names: Iterable<string>): string {
  return [...new Set(names)]
    .sort()
    .map((name) => encodeURIComponent(name))
    .join(',');
}

/** The names {@link encodeRequiredChecks} wrote. Throws on text it could not have written. */
export function decodeRequiredChecks(text: string): string[] {
  if (text === '') return [];
  return text.split(',').map((part) => {
    if (part === '') throw new Error('a required check name is empty');
    return decodeURIComponent(part);
  });
}

/** The page size the shepherd reads a pull request's reviews in: GitHub's largest, and one page only. */
export const PULL_REQUEST_REVIEWS_PER_PAGE = 100;

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
 * The base branch's required checks, judged on the head (D6 condition 1):
 * `passed` where every one has a check run concluded `success`, `none` where
 * the base requires none — which is no pass, since such a base has not said
 * what green is — and `unmet` otherwise. A required name pending, skipped,
 * neutral, failed or with no check run at all has not passed; one reported
 * only through the commit Statuses API has no check run, and is named so.
 */
export const RequiredChecksVerdictSchema = z.object({
  state: z.enum(['passed', 'unmet', 'none']),
  required: z.array(z.string()),
  unmet: z.array(
    z.object({
      name: z.string(),
      conclusion: z
        .string()
        .describe(
          "The check run's conclusion, `pending` while it runs, or `no check run` where the head has none of that name — a context reported only as a commit status among them.",
        ),
    }),
  ),
  summary: z
    .string()
    .optional()
    .describe('The unmet ones in words, for the handoff: absent where none is unmet.'),
});
export type RequiredChecksVerdict = z.infer<typeof RequiredChecksVerdictSchema>;

/**
 * The required check names one read found: `getBranchRules`' ruleset rules,
 * or `getBranch`'s classic protection united with them. `encoded` is the set
 * as {@link encodeRequiredChecks} writes it, for the next read's argument.
 */
export const RequiredCheckNamesSchema = z.object({
  names: z.array(z.string()),
  encoded: z.string(),
});
export type RequiredCheckNames = z.infer<typeof RequiredCheckNamesSchema>;

/**
 * `listPullRequestReviews`, one page, as the shepherd reads it (D6 condition
 * 3): of each reviewer who is a person, the latest review that carries a
 * verdict — `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` — is what that
 * person says; a `COMMENTED` review carries none and clears nothing.
 */
export const PullRequestReviewsSchema = z.object({
  changesRequestedBy: z
    .array(z.string())
    .describe('The people whose standing verdict is `CHANGES_REQUESTED`, by login.'),
  approvedBy: z.array(z.string()),
  count: z.number().int().nonnegative().describe('The reviews on the page read.'),
  complete: z
    .boolean()
    .describe(
      `Whether the page held every review: fewer than ${String(PULL_REQUEST_REVIEWS_PER_PAGE)}. A full page may hide a change request past it.`,
    ),
});
export type PullRequestReviews = z.infer<typeof PullRequestReviewsSchema>;

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
  /** Present only where the read was given the base branch's required checks. */
  required: RequiredChecksVerdictSchema.optional(),
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
  mergeDeclinedSha: z.string().optional(),
  mergeRefusedSha: z.string().optional(),
  mergeCommitSha: z.string().optional(),
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
