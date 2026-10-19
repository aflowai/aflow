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
  type AfterReviewOverrideRecord,
  HOST_COMMIT_RANGE_PATTERN,
  type HostCommitDescribeCommit,
  type HostCommitDescribeInput,
  LOCAL_PUBLISH_PULL_REQUEST_MARKER,
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

/** The least of the account of the commits a body keeps: its heading, and the note saying it stops. */
const CHANGES_LEAST = `## What changes${CHANGES_CUT_NOTE}`;

/** What closes a person's summary where the rest of the body leaves it too little room. */
const SUMMARY_CUT_NOTE =
  "\n\nThe summary stops here, at the room GitHub's limit leaves it beside the rest of the description.";

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
    "Decided after the review: `fix_before_merge` — this review's findings are to be fixed on this branch before it merges, so this publication pushed nothing.",
  publish_as_is:
    "Decided after the review: `publish_as_is` — this review's findings can merge as they stand.",
  undecided:
    "Decided after the review: `undecided` — no answer cleared the decision's bar, so the push waited for the operator, and this review's findings are the reader's to weigh.",
};

const OVERRIDE_BY: Record<AfterReviewOverrideRecord['by'], string> = {
  operator: "the operator's word",
  hands_off_label: 'the `hands-off` label',
  shepherd_rule: "a rule of the shepherd's",
};

function overrideLine(override: AfterReviewOverrideRecord): string {
  return `The decision was \`${override.overrode}\`, set aside by ${OVERRIDE_BY[override.by]}: ${override.reason}`;
}

const AS_IS_LIST = 'Left open by `publish_as_is`';

/**
 * How a `publish_as_is` cleared its push, as the gate decides it from the
 * same record and the verdict: over a blocker or a major, on the operator's
 * word, or over no findings from a review that did not approve, it went out
 * only on the operator's approval — this text is pushed only after it.
 */
function publishedAsIsClearance(
  record: PullRequestReviewRecord,
  verdict: string | null | undefined,
): string {
  if (record.severest === undefined) {
    return verdict === 'approve'
      ? 'The review found nothing, so no decision was asked, and the push went without asking.'
      : "The review found nothing and did not approve, so the push went out only on the operator's approval.";
  }
  const leaves = `and leaves this review's findings open, listed under **${AS_IS_LIST}**.`;
  if (record.severest === 'nit') {
    return `Its findings are nits alone, which end the rounds: no decision was asked, and the push went without asking, ${leaves}`;
  }
  if (record.severest === 'blocker' || record.severest === 'major') {
    return `With a ${record.severest} among them, the push went out only on the operator's approval, ${leaves}`;
  }
  if (record.afterReviewOverride?.by === 'operator') {
    return `The push went out on the operator's approval, the word that set the decision aside, ${leaves}`;
  }
  return `The push went without asking, ${leaves}`;
}

/**
 * This round's review is told by its summary, which names every finding it
 * read with its severity and `file:line` beside the checks it ran, and then
 * by what the publication recorded of it: the decision, how a `publish_as_is`
 * was pushed, and an override. The findings themselves are listed last, in
 * `findingsSection`, so no length of them can push this record out.
 */
function reviewSection(input: HostCommitDescribeInput, record: PullRequestReviewRecord): string {
  const parts = ['## Review'];
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
  if (record.afterReview === 'publish_as_is') {
    parts.push(publishedAsIsClearance(record, review?.verdict));
  }
  if (record.afterReviewOverride !== undefined) {
    parts.push(overrideLine(record.afterReviewOverride));
  }
  return parts.join(SECTION_BREAK);
}

/** What closes a list of findings the body had no room to finish. */
function moreFindings(count: number): string {
  return `…and ${String(count)} more, past the room GitHub's limit leaves the list; the review's run holds every one.`;
}

/**
 * The findings, under the record of what was decided about them: those a
 * `publish_as_is` leaves open first — what the merge lets through — then the
 * earlier rounds', closed and left open, since no text of this round names
 * them. They are listed as far as `room` reaches, a whole line at a time, and
 * the rest counted, so the list never runs past the limit into what the
 * body must carry. Empty where there is none to list.
 */
function findingsSection(
  input: HostCommitDescribeInput,
  record: PullRequestReviewRecord,
  room: number,
): string {
  const earlier = input.findings ?? [];
  const groups: Array<[heading: string, lines: string[]]> = [
    [
      `### ${AS_IS_LIST}`,
      record.afterReview === 'publish_as_is'
        ? (input.review?.findings ?? []).map((finding) =>
            findingLine({ ...finding, state: 'open' }),
          )
        : [],
    ],
    ['### Closed', earlier.filter((f) => f.state === 'closed').map(findingLine)],
    ['### Left open', earlier.filter((f) => f.state === 'open').map(findingLine)],
  ];
  const total = groups.reduce((sum, [, lines]) => sum + lines.length, 0);
  if (total === 0) return '';

  const heading = '## Findings';
  // Held back for the count of the rest, at the most it can say.
  const reserve = SECTION_BREAK.length + moreFindings(total).length;
  const parts = [heading];
  let used = heading.length;
  let listed = 0;
  let full = false;
  for (const [groupHeading, lines] of groups) {
    const kept: string[] = [];
    for (const line of lines) {
      const cost =
        (kept.length === 0
          ? SECTION_BREAK.length + groupHeading.length + SECTION_BREAK.length
          : 1) + line.length;
      const reserved = listed + 1 < total ? reserve : 0;
      if (used + cost + reserved > room) {
        full = true;
        break;
      }
      kept.push(line);
      used += cost;
      listed += 1;
    }
    if (kept.length > 0) parts.push(groupHeading, kept.join('\n'));
    if (full) break;
  }
  if (listed < total) parts.push(moreFindings(total - listed));
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
 * title a person gave stands as it is; otherwise the title is the slice's —
 * the subject of the first commit, the round that started the branch. The
 * body is always composed, and a summary a person gave heads it, never
 * replaces it: what the publication records — the decision on the findings,
 * an override, the checks, the gaps, the findings it leaves open — is under
 * it whatever they wrote. The findings come last and are listed only as far
 * as the room the rest leaves them, the remainder counted; where the body
 * would still pass GitHub's limit, the account of the commits gives way
 * first, then the summary: the rest is what a reader acts on, and the
 * commits are on the branch whole.
 */
export function composePullRequest(
  input: HostCommitDescribeInput,
  commits: readonly HostCommitDescribeCommit[],
): { title: string; body: string } & PullRequestReviewRecord {
  const title = input.title ?? commits[0]?.subject ?? '';
  const record = pullRequestReviewRecord(input);
  const recorded = [
    reviewSection(input, record),
    verificationSection(input),
    gapsSection(input.gaps),
  ].join(SECTION_BREAK);
  // The least a summary keeps: itself where shorter than the note cutting it, else the note.
  const summaryLeast =
    input.summary === undefined
      ? 0
      : Math.min(input.summary.length, SUMMARY_CUT_NOTE.length) + SECTION_BREAK.length;
  const findings = findingsSection(
    input,
    record,
    BODY_ROOM - recorded.length - 2 * SECTION_BREAK.length - CHANGES_LEAST.length - summaryLeast,
  );
  const rest = findings === '' ? recorded : `${recorded}${SECTION_BREAK}${findings}`;
  const summaryRoom = BODY_ROOM - rest.length - 2 * SECTION_BREAK.length - CHANGES_LEAST.length;
  const head =
    input.summary === undefined
      ? ''
      : `${fit(input.summary, summaryRoom, SUMMARY_CUT_NOTE)}${SECTION_BREAK}`;
  const changes = fit(
    changesSection(commits),
    BODY_ROOM - head.length - rest.length - SECTION_BREAK.length,
    CHANGES_CUT_NOTE,
  );
  return {
    title,
    body: marked(fit(`${head}${changes}${SECTION_BREAK}${rest}`, BODY_ROOM, BODY_CUT_NOTE)),
    ...record,
  };
}

/** What a body may hold beside the marker, which closes every one. */
const BODY_ROOM =
  PULL_REQUEST_BODY_MAX_CHARS - SECTION_BREAK.length - LOCAL_PUBLISH_PULL_REQUEST_MARKER.length;

/**
 * Every body the loop writes ends with its marker, a person's own summary
 * included: the marker says who opened the pull request, which is what the
 * shepherd tends by, and a summary changes only what the body says.
 */
function marked(body: string): string {
  return `${body}${SECTION_BREAK}${LOCAL_PUBLISH_PULL_REQUEST_MARKER}`;
}
