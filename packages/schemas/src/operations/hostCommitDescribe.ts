/**
 * `host.commit.describe`: a pull request's title and body, composed from the
 * branch a publication pushes rather than from one round's brief.
 */
import { z } from 'zod';

import { HostBindingRef, HostCommitRangeSchema, HostCommitShaSchema } from './host.js';

/** GitHub's own limit on a pull request's body; a longer one is refused with a 422. */
export const PULL_REQUEST_BODY_MAX_CHARS = 65_536;

/** The longest title a publication takes from a person. */
export const PULL_REQUEST_TITLE_MAX_CHARS = 500;

export const PullRequestFindingSchema = z
  .object({
    severity: z
      .enum(['blocker', 'major', 'minor', 'nit'])
      .describe(
        'As the review named it. blocker: must not ship. major: wrong or unsafe in a case ' +
          'that will occur. minor: a real defect with narrow effect. nit: a preference.',
      ),
    file: z.string().min(1).max(1000).describe('Path relative to the repository root.'),
    line: z.number().int().positive().optional().describe('The line it is about, where it is.'),
    claim: z
      .string()
      .min(1)
      .max(4000)
      .describe('What the review said is wrong, in its words or near them.'),
    state: z
      .enum(['closed', 'open'])
      .describe(
        '`closed` where a commit of the branch fixed it; `open` where the branch leaves it as ' +
          'the review found it.',
      ),
  })
  .strict();
export type PullRequestFinding = z.infer<typeof PullRequestFindingSchema>;

export const PullRequestFindingsSchema = z
  .array(PullRequestFindingSchema)
  .describe(
    'The findings of the review rounds before this publication — each Local Code Review ' +
      'whose findings a later commission on the branch was briefed to fix — as the reviews ' +
      "named them, each marked `closed` or `open`. The publication's own review, where one " +
      'finishes, is recorded by its summary, and its findings replace these in what the ' +
      'publication hands on.',
  );

/**
 * A finding as the publication's own review returned it. Only what the pull
 * request records is read: the evidence and the suggestion stay on the
 * review's run.
 */
const ReviewFindingSchema = PullRequestFindingSchema.omit({ state: true }).strip();

/** The answers the decision after a review can clear its bar with. */
export const AFTER_REVIEW_DECIDED = ['fix_before_merge', 'publish_as_is'] as const;

/** What a publication records of that decision where it weighed findings and none cleared the bar. */
export const AFTER_REVIEW_UNDECIDED = 'undecided';

export const AfterReviewSchema = z
  .enum([...AFTER_REVIEW_DECIDED, AFTER_REVIEW_UNDECIDED])
  .describe(
    "What the publication decided about its review's findings: `fix_before_merge`, a fix " +
      'round on the branch before it merges; `publish_as_is`, they can merge as they stand; ' +
      "`undecided`, no answer cleared the decision's bar, or none could be made. Recorded, never " +
      'acted on by the publication: a fix round is the conversation’s, or the shepherd’s.',
  );
export type AfterReview = z.infer<typeof AfterReviewSchema>;

export const PullRequestGapsSchema = z
  .array(z.string().min(1).max(8000))
  .describe(
    "What the branch's commissions reported they left undone or could not verify, one item " +
      'each, in their words.',
  );

/** One run of the folder's checks, as a publication's check task projects it. */
const CheckRunSchema = z.object({
  passed: z.boolean(),
  skipped: z.boolean().nullable().optional(),
  summary: z.string(),
  tail: z.string().nullable().optional(),
});
export type PullRequestCheckRun = z.infer<typeof CheckRunSchema>;

export const HostCommitDescribeInputSchema = z.object({
  bindingId: HostBindingRef,
  range: HostCommitRangeSchema.describe(
    'Every commit the push sends, `<baseSha>..<sha>` — a publication passes its ' +
      "`pushRange`, measured from `origin`'s base branch, so an appended push describes the " +
      'whole branch and not only the round that appended to it.',
  ),
  title: z
    .string()
    .min(1)
    .max(PULL_REQUEST_TITLE_MAX_CHARS)
    .optional()
    .describe(
      "A title a person chose. Absent, the title is the slice's: the subject of the branch's " +
        'first commit, the round that started it.',
    ),
  summary: z
    .string()
    .min(1)
    .max(PULL_REQUEST_BODY_MAX_CHARS)
    .optional()
    .describe(
      'A body a person wrote. Given, it is the body as it stands, and nothing is composed.',
    ),
  findings: PullRequestFindingsSchema.optional(),
  review: z
    .object({
      verdict: z.string().nullable(),
      outcome: z.string(),
      reviewSummary: z.string().nullable().optional(),
      findings: z.array(ReviewFindingSchema).nullable().optional(),
    })
    .optional()
    .describe(
      "The publication's own review of the range, where one ran: its verdict — null where it " +
        'did not finish — how it ended, its summary, which names every finding it read, and ' +
        'the findings themselves, which the publication hands on as the open ones.',
    ),
  afterReview: z
    .enum(AFTER_REVIEW_DECIDED)
    .nullable()
    .optional()
    .describe(
      "The decision on the review's findings as it answered: null where the answer fell below " +
        'its bar, absent where none was made.',
    ),
  check: CheckRunSchema.optional().describe("The folder's checks on the commit, as they ran."),
  recheck: CheckRunSchema.optional().describe(
    'Their second run, where the first lost only to tests running out of time.',
  ),
  gaps: PullRequestGapsSchema.optional(),
});
export type HostCommitDescribeInput = z.infer<typeof HostCommitDescribeInputSchema>;

/** What a publication hands on of its review: the findings still open, and the decision on this round's. */
export interface PullRequestReviewRecord {
  findings: PullRequestFinding[];
  afterReview?: AfterReview;
}

/**
 * The review record a publication hands on: the open findings of the latest
 * review of the branch. Where this publication's own review finished, its
 * findings replace the earlier rounds' — it read the whole range, so it is
 * the latest word on every one of them, and nothing has fixed its findings
 * yet. Where no review finished, the open findings it was passed go on as
 * they are. Either way the list never outgrows one review's, so a later
 * publication taking it back as `findings` does not carry every round before.
 *
 * The decision on them is recorded exactly where this review returned
 * findings — the decision is asked only then — and an answer that is missing
 * there, below the bar or never made, is recorded as `undecided`.
 */
export function pullRequestReviewRecord(input: HostCommitDescribeInput): PullRequestReviewRecord {
  const reviewFindings = input.review?.findings;
  if (reviewFindings === null || reviewFindings === undefined) {
    return { findings: (input.findings ?? []).filter((finding) => finding.state === 'open') };
  }
  const findings: PullRequestFinding[] = reviewFindings.map((finding) => ({
    ...finding,
    state: 'open' as const,
  }));
  if (findings.length === 0) return { findings };
  return { findings, afterReview: input.afterReview ?? AFTER_REVIEW_UNDECIDED };
}

export const HostCommitDescribeCommitSchema = z.object({
  sha: HostCommitShaSchema.describe('The commit, as its full sha.'),
  subject: z.string().describe("The first line of the commit's message."),
  body: z
    .string()
    .optional()
    .describe('The message after its first line; absent for a one-line message.'),
});
export type HostCommitDescribeCommit = z.infer<typeof HostCommitDescribeCommitSchema>;

export const HostCommitDescribeOutputSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("The pull request's title: the one given, or the branch's first commit's subject."),
  body: z
    .string()
    .min(1)
    .max(PULL_REQUEST_BODY_MAX_CHARS)
    .describe(
      "The pull request's body: the summary given, or what the branch changes — every " +
        "commit's message, oldest first — the review's findings closed and left open, the " +
        "checks' results as verification, and the gaps the commissions recorded. Read for " +
        'secrets under the same rules as the commits before it is returned.',
    ),
  commits: z
    .array(HostCommitDescribeCommitSchema.pick({ sha: true, subject: true }))
    .describe('Every commit of the range, oldest first.'),
  findings: PullRequestFindingsSchema.describe(
    "The open findings of the latest review: this publication's own review's where it " +
      "finished, replacing the earlier rounds'; otherwise the open ones it was passed. What a " +
      'later publication of the branch takes as `findings`, with those its fix closed marked ' +
      '`closed`.',
  ),
  afterReview: AfterReviewSchema.optional().describe(
    "The decision on this publication's review findings, as the body records it; absent " +
      'where the review returned none.',
  ),
});
export type HostCommitDescribeOutput = z.infer<typeof HostCommitDescribeOutputSchema>;
