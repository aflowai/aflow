/**
 * The forge vocabulary (Plan 340 D1): the acts the loop asks of any forge, the
 * facts it reads a change request as, and the records its rules compare.
 *
 * Local Publish, the Local PR Shepherd and the pull request event source speak
 * these words only. A provider per forge answers them (D2) and is the one place
 * a forge's endpoints, parameters and response fields are spelled. A guard test
 * fails where a provider's field name appears outside its provider (D3).
 *
 * The records keep the names the rules already read. A pull request here is a
 * change request of whichever forge the folder lives on.
 */
import { z } from 'zod';

/** The forges a provider answers the vocabulary for. */
export const FORGE_PROVIDERS = ['github'] as const;
export const ForgeProviderIdSchema = z.enum(FORGE_PROVIDERS);
export type ForgeProviderId = z.infer<typeof ForgeProviderIdSchema>;

/**
 * The acts the loop performs on a forge, each in words. Local Publish lists,
 * opens and updates. The shepherd lists, reads and merges, and it keeps its
 * handoff in a comment. The event source reads.
 */
export const FORGE_ACTS = {
  listChangeRequests: 'List the open change requests of a repository.',
  readChangeRequest: "Read a change request's state as the facts of `ChangeRequestFactsSchema`.",
  openChangeRequest: 'Open a change request from a branch into a base branch.',
  updateChangeRequest: "Update a change request's title and body.",
  mergeChangeRequest: 'Merge a change request by squash, pinned to the head the pass read.',
  readHandoff: "Read the shepherd's handoff comment on a change request.",
  postHandoff: "Post the shepherd's handoff comment on a change request.",
  updateHandoff: "Update the shepherd's handoff comment on a change request.",
  nameProvider: "Name the provider for a folder from the repo coordinate's host.",
} as const;
export type ForgeAct = keyof typeof FORGE_ACTS;

/** How a change request's checks stand on its head. */
export const ChangeRequestChecksSchema = z.enum(['green', 'red', 'stopped', 'pending', 'none']);
export type ChangeRequestChecks = z.infer<typeof ChangeRequestChecksSchema>;

/**
 * A change request's state as the facts the rules decide on. Every provider
 * reads these from its own forge's answers. Merged and its merge commit are
 * here though no rule reads them today: a forge whose merge reply says less
 * needs them to report a merge.
 */
export const ChangeRequestFactsSchema = z.object({
  head: z.string().min(1).describe('The commit the change request’s branch points at.'),
  mergeable: z
    .boolean()
    .nullable()
    .describe(
      'Whether the head merges into its base as the base stands. Null while the forge has not computed it, so null is unknown, never yes.',
    ),
  checks: ChangeRequestChecksSchema.describe(
    '`green` only where every check on the head passed. `red` where one failed.',
  ),
  changesRequested: z
    .boolean()
    .describe('Whether a person’s standing review on the change request requests changes.'),
  merged: z.boolean(),
  mergeCommit: z
    .string()
    .nullable()
    .describe('The commit the merge made, where the change request merged.'),
});
export type ChangeRequestFacts = z.infer<typeof ChangeRequestFactsSchema>;

// ============================================================================
// The records the shepherd's rules compare
// ============================================================================

/** The most of a change request's body a brief carries. */
export const LOOP_PULL_REQUEST_BODY_MAX_CHARS = 20_000;

/**
 * The bound on a failing job's log the shepherd carries, measured (Plan 321
 * §5 P0.3): the last 300 lines held the failure and its assertion for both
 * job kinds observed, and stayed under 60 KB.
 */
export const JOB_LOG_EXCERPT_MAX_LINES = 300;
export const JOB_LOG_EXCERPT_MAX_BYTES = 60 * 1024;

/** One open change request the loop opened under the folder's prefix. */
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
 * The repository's open change requests as the shepherd reads them: only the
 * loop's under the prefix, those a person has not labelled hands-off first,
 * each group by number, newest first. Where the read was given the last one
 * tended, the list is turned so the one after it comes first. One pass tends
 * the first.
 */
export const LoopPullRequestsSchema = z.object({
  pullRequests: z.array(LoopPullRequestSummarySchema),
  count: z.number().int().nonnegative(),
});
export type LoopPullRequests = z.infer<typeof LoopPullRequestsSchema>;

/** One change request as the shepherd reads it. */
export const LoopPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z
    .string()
    .optional()
    .describe(
      'The change request’s web address — the ref a plan node’s `pull_request` link holds, as Local Publish records it.',
    ),
  state: z.string(),
  title: z.string(),
  body: z.string().describe('The body without the marker, cut to a brief’s length.'),
  headRef: z.string(),
  headSha: z.string(),
  baseRef: z.string(),
  ours: z
    .boolean()
    .describe(
      "Opened by Local Publish — its marker closes the body — from a branch of the repository itself, under the folder's prefix. A fork's change request is never the loop's: the loop pushes to its own repository.",
    ),
  handsOff: z.boolean(),
  draft: z.boolean(),
  mergeable: z
    .boolean()
    .nullable()
    .describe(
      'Whether the head merges into its base as the base stands. `null` while the forge has not computed it yet — the read asks it to, and a later read has the answer — so null is unknown, never yes.',
    ),
  mergeableState: z
    .string()
    .optional()
    .describe(
      "The forge's own word for the head's mergeability, carried to the Helmsman as the forge said it.",
    ),
  commentPages: z
    .number()
    .int()
    .positive()
    .describe(
      'How many pages of 100 its conversation runs to. The last is the newest, where a handoff no pass has pinned yet is looked for.',
    ),
});
export type LoopPullRequest = z.infer<typeof LoopPullRequestSchema>;

export const CheckRunsStateSchema = z.enum([
  'failing',
  'pending',
  'passing',
  'stopped',
  'none',
  'unknown',
]);
export type CheckRunsState = z.infer<typeof CheckRunsStateSchema>;

export const FailingCheckRunSchema = z.object({
  /** As text, so a handoff that wrote it compares equal to it. */
  id: z.string(),
  name: z.string(),
  conclusion: z.string(),
  /** The CI run it belongs to, where the forge's CI ran it as a job. */
  runId: z.number().int().positive().optional(),
});
export type FailingCheckRun = z.infer<typeof FailingCheckRunSchema>;

/**
 * The base branch's required checks, judged on the head (Plan 321 D6
 * condition 1): `passed` where every one has a check concluded `success`,
 * `none` where the base requires none — which is no pass, since such a base
 * has not said what green is — and `unmet` otherwise. A required name pending,
 * skipped, neutral, failed or with no check at all has not passed.
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
          "The check's conclusion, `pending` while it runs, or `no check run` where the head has none of that name.",
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
 * The required check names one read found. `encoded` is the set as the
 * provider writes it for the next read's argument.
 */
export const RequiredCheckNamesSchema = z.object({
  names: z.array(z.string()),
  encoded: z.string(),
});
export type RequiredCheckNames = z.infer<typeof RequiredCheckNamesSchema>;

/** The most reviews one read of a change request's reviews holds. */
export const PULL_REQUEST_REVIEWS_PER_PAGE = 100;

/**
 * A change request's reviews, one page, as the shepherd reads them (Plan 321
 * D6 condition 3): of each reviewer who is a person, the latest review that
 * carries a verdict is what that person says. A review that only comments
 * carries none and clears nothing.
 */
export const PullRequestReviewsSchema = z.object({
  changesRequestedBy: z
    .array(z.string())
    .describe('The people whose standing verdict requests changes, by login.'),
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
 * The checks on the head, as the shepherd reads them: `failing` where any
 * check on the page read failed, else `pending` while any on it has not
 * finished, else `unknown` where the forge holds more checks than the one page
 * read — those past it may have failed, and no later pass reads them either,
 * so this is no wait — else `passing` where every one succeeded or was
 * skipped, `stopped` where one was cancelled or needs an action, `none` where
 * there are none.
 */
export const CheckRunsSummarySchema = z.object({
  state: CheckRunsStateSchema,
  /** The forge's count of the head's checks, read or not. */
  total: z.number().int().nonnegative(),
  failing: z.array(FailingCheckRunSchema),
  /** The failing check with the lowest id: the one the shepherd acts on, and records. */
  firstFailing: FailingCheckRunSchema.optional(),
  /** Present only where the read was given the base branch's required checks. */
  required: RequiredChecksVerdictSchema.optional(),
});
export type CheckRunsSummary = z.infer<typeof CheckRunsSummarySchema>;

/** The shepherd's last handoff on a change request, read back. */
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
      '`verified` where the read knew the login the loop posts as, and so could tell its record from a forgery. `undecided` where it did not: no record is trusted, and the pass decides as on a change request with none — the default, never a wait.',
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

/** The jobs of a failing CI run that failed. */
export const FailingJobsSchema = z.object({
  jobs: z.array(FailingJobSchema),
  count: z.number().int().nonnegative(),
});
export type FailingJobs = z.infer<typeof FailingJobsSchema>;

/**
 * The end of one job's log, within {@link JOB_LOG_EXCERPT_MAX_LINES} and
 * {@link JOB_LOG_EXCERPT_MAX_BYTES} as a task carries it — escaped as JSON,
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
