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
      'runs, is added as it returns.',
  );

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
    })
    .optional()
    .describe(
      "The publication's own review of the range, where one ran: its verdict — null where it " +
        'did not finish — how it ended, and its summary, which names every finding it read.',
    ),
  check: CheckRunSchema.optional().describe("The folder's checks on the commit, as they ran."),
  recheck: CheckRunSchema.optional().describe(
    'Their second run, where the first lost only to tests running out of time.',
  ),
  gaps: PullRequestGapsSchema.optional(),
});
export type HostCommitDescribeInput = z.infer<typeof HostCommitDescribeInputSchema>;

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
});
export type HostCommitDescribeOutput = z.infer<typeof HostCommitDescribeOutputSchema>;
