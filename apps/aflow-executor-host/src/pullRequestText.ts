/**
 * A pull request's title and body, composed from the branch it carries.
 *
 * The branch is described as a whole — every commit the push sends, oldest
 * first — rather than by the round that published last, and beside it what
 * read the branch and what it leaves: the review rounds' findings, closed and
 * left open, the folder's checks, and what its commissions said they did not
 * do. None of that is in any one commit, and a reader acting on the pull
 * request needs each of it.
 */
import {
  type AfterReview,
  HOST_COMMIT_RANGE_PATTERN,
  type HostCommitDescribeCommit,
  type HostCommitDescribeInput,
  PULL_REQUEST_BODY_MAX_CHARS,
  type PullRequestCheckRun,
  type PullRequestFinding,
  type PullRequestReviewRecord,
  pullRequestReviewRecord,
} from '@aflow/schemas';

import { messageBody } from './branchCommit.js';
import { resolveRangeEnd } from './commitScan.js';
import { APPLY_OUTPUT_CAP_BYTES, git, WorktreeError } from './worktree.js';

/**
 * Every commit of the range, oldest first, with its subject and the rest of
 * its message. Read as `log` formats it, which ends a message at a NUL byte:
 * this is text for a person, and the scan reads the objects themselves.
 */
export async function readRangeCommits(
  root: string,
  range: string,
): Promise<HostCommitDescribeCommit[]> {
  const ends = HOST_COMMIT_RANGE_PATTERN.exec(range);
  if (ends?.[1] === undefined || ends[2] === undefined) {
    throw new WorktreeError(`\`${range}\` is not a range of two shas.`, 'unknown_ref');
  }
  const base = await resolveRangeEnd(root, ends[1]);
  const head = await resolveRangeEnd(root, ends[2]);
  const log = await git(
    root,
    [
      '-c',
      'log.showSignature=false',
      'log',
      '--no-color',
      '--reverse',
      '--topo-order',
      '--format=%H%x00%B%x00',
      `${base}..${head}`,
    ],
    APPLY_OUTPUT_CAP_BYTES,
  );
  const fields = log.split('\0');
  const commits: HostCommitDescribeCommit[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const message = (fields[index + 1] ?? '').replace(/\n+$/, '');
    const body = messageBody(message);
    commits.push({
      sha: (fields[index] ?? '').trim(),
      subject: message.split('\n', 1)[0] ?? '',
      ...(body !== undefined ? { body } : {}),
    });
  }
  if (commits.length === 0) {
    throw new WorktreeError(
      `\`${base}..${head}\` holds no commit, so there is no change to describe.`,
      'unknown_ref',
    );
  }
  return commits;
}

/** What closes a section's account of the commits where GitHub's limit cuts it. */
const CHANGES_CUT_NOTE =
  "\n\nThe account stops here, at the length GitHub takes for a pull request's body; " +
  "every commit's whole message is on the branch.";

/** What closes a body cut whole, where even the rest of it is past the limit. */
const BODY_CUT_NOTE =
  "\n\nThe description stops here, at the length GitHub takes for a pull request's body.";

const SECTION_BREAK = '\n\n';

/** `text` held to `max` characters, cut at a line where one is in reach, with `note` saying so. */
function fit(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - note.length);
  const lineEnd = text.lastIndexOf('\n', room);
  return `${text.slice(0, lineEnd > 0 ? lineEnd : room)}${note}`;
}

/** A fence no run of backticks inside `text` can close. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

function changesSection(commits: readonly HostCommitDescribeCommit[]): string {
  const parts = commits.map((commit) =>
    commit.body === undefined
      ? `### ${commit.subject}`
      : `### ${commit.subject}${SECTION_BREAK}${commit.body}`,
  );
  return ['## What changes', ...parts].join(SECTION_BREAK);
}

function findingLine(finding: PullRequestFinding): string {
  const where =
    finding.line === undefined ? finding.file : `${finding.file}:${String(finding.line)}`;
  return `- **${finding.severity}** \`${where}\` — ${finding.claim}`;
}

const AFTER_REVIEW_LINES: Record<AfterReview, string> = {
  fix_before_merge:
    'Decided after the review: `fix_before_merge` — the findings left open are to be fixed on this branch before it merges.',
  publish_as_is:
    'Decided after the review: `publish_as_is` — the findings left open can merge as they stand.',
  undecided:
    "Decided after the review: `undecided` — no answer cleared the decision's bar, so the findings left open are the reader's to weigh.",
};

function reviewSection(input: HostCommitDescribeInput, record: PullRequestReviewRecord): string {
  const { findings } = record;
  const parts = ['## Review'];
  for (const [state, heading] of [
    ['closed', '### Closed'],
    ['open', '### Left open'],
  ] as const) {
    const listed = findings.filter((finding) => finding.state === state);
    if (listed.length > 0) parts.push(heading, listed.map(findingLine).join('\n'));
  }
  const review = input.review;
  if (review === undefined) {
    parts.push('No review of this range finished before it was pushed.');
  } else if (review.verdict === null) {
    parts.push(
      `The review of this range ended \`${review.outcome}\` without a verdict, so it cleared nothing.`,
    );
  } else {
    parts.push(`The review of this range returned \`${review.verdict}\`.`);
    if (review.reviewSummary) parts.push(review.reviewSummary);
  }
  if (record.afterReview !== undefined) parts.push(AFTER_REVIEW_LINES[record.afterReview]);
  return parts.join(SECTION_BREAK);
}

function checkRunLines(run: PullRequestCheckRun): string[] {
  return run.tail ? [run.summary, fenced(run.tail)] : [run.summary];
}

function verificationSection(input: HostCommitDescribeInput): string {
  const parts = ['## Verification'];
  const { check, recheck } = input;
  if (check === undefined) {
    parts.push("The folder's checks did not run on this range.");
  } else if (check.skipped === true) {
    parts.push('The folder declares no checks, so none ran before the push.');
  } else if (recheck === undefined) {
    parts.push(...checkRunLines(check));
  } else {
    // The first run is named for what it was, and the second, which the push
    // carries, is the one whose output is shown.
    parts.push(
      `Their first run lost only to tests running out of time: ${check.summary}`,
      `Their second run, which the push carries: ${recheck.summary}`,
    );
    if (recheck.tail) parts.push(fenced(recheck.tail));
  }
  parts.push("The pull request's own checks remain the proof.");
  return parts.join(SECTION_BREAK);
}

function gapsSection(gaps: readonly string[] | undefined): string {
  const listed = gaps ?? [];
  return [
    '## Known gaps',
    listed.length === 0
      ? 'None recorded by the commissions.'
      : listed.map((gap) => `- ${gap.replace(/\n/g, '\n  ')}`).join('\n'),
  ].join(SECTION_BREAK);
}

/**
 * The pull request for `commits`, the range's every commit oldest first. A
 * title or summary a person gave stands as it is; otherwise the title is the
 * slice's — the subject of the first commit, the round that started the
 * branch — and the body is composed. Where it would pass GitHub's limit, the
 * account of the commits gives way first: the rest is what a reader acts on,
 * and the commits are on the branch whole.
 */
export function composePullRequest(
  input: HostCommitDescribeInput,
  commits: readonly HostCommitDescribeCommit[],
): { title: string; body: string } & PullRequestReviewRecord {
  const title = input.title ?? commits[0]?.subject ?? '';
  const record = pullRequestReviewRecord(input);
  if (input.summary !== undefined) return { title, body: input.summary, ...record };
  const rest = [
    reviewSection(input, record),
    verificationSection(input),
    gapsSection(input.gaps),
  ].join(SECTION_BREAK);
  const changes = fit(
    changesSection(commits),
    PULL_REQUEST_BODY_MAX_CHARS - rest.length - SECTION_BREAK.length,
    CHANGES_CUT_NOTE,
  );
  return {
    title,
    body: fit(`${changes}${SECTION_BREAK}${rest}`, PULL_REQUEST_BODY_MAX_CHARS, BODY_CUT_NOTE),
    ...record,
  };
}
