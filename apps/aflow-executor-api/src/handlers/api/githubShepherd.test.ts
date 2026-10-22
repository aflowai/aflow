/**
 * Contract: GitHub's answers reach the Local PR Shepherd's rules as typed
 * records, shaped before anything is cut to fit inline; a body that does not
 * shape fails the read rather than passing GitHub's object on; the end of a
 * job's log is bounded at Plan 321 P0.3's measurement as it is carried; and a
 * redirect off the API's host carries none of the binding's credential.
 */
import { describe, expect, it } from 'vitest';
import {
  CheckRunsSummarySchema,
  decodeRequiredChecks,
  encodeRequiredChecks,
  FailingJobsSchema,
  JOB_LOG_EXCERPT_MAX_BYTES,
  JOB_LOG_EXCERPT_MAX_LINES,
  JobLogExcerptSchema,
  LOCAL_PUBLISH_PULL_REQUEST_MARKER,
  LoopPullRequestSchema,
  LoopPullRequestsSchema,
  PULL_REQUEST_REVIEWS_PER_PAGE,
  PullRequestReviewsSchema,
  RequiredCheckNamesSchema,
  ShepherdHandoffReadSchema,
} from '@aflow/schemas';
import { NOTHING_SKIPPED } from './bodyTail.js';
import {
  JOB_LOG_READ_WINDOW_BYTES,
  jobLogTail,
  loopCheckRuns,
  loopFailingJobs,
  loopHandoff,
  loopPullRequest,
  loopPullRequests,
  loopRequiredProtection,
  loopRequiredRules,
  loopReviews,
} from './githubShepherd.js';
import {
  applyRecordTransformPreset,
  applyTextTransformPreset,
  isRecordTransformPreset,
  isTextTransformPreset,
  textPresetTailWindow,
} from './transforms.js';
import { withoutCredentials } from './execution.js';
import { credentialHeaderNames } from './headers.js';
import { ApiExecutionError } from './types.js';

/** The repository the loop pushes to and opens its pull requests on. */
const REPO = { id: 101, full_name: 'aflowai/aflow' };
const FORK = { id: 202, full_name: 'someone/aflow' };

function pr(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    state: 'open',
    title: `PR ${String(number)}`,
    body: `Body.\n\n${LOCAL_PUBLISH_PULL_REQUEST_MARKER}`,
    draft: false,
    labels: [],
    updated_at: `2026-10-1${String(number % 10)}T00:00:00Z`,
    comments: 3,
    head: { ref: `aflow/branch-${String(number)}`, sha: 'c'.repeat(40), repo: REPO },
    base: { ref: 'main', repo: REPO },
    ...over,
  };
}

describe('loop_pulls — the loop’s open pull requests under the prefix', () => {
  const listed = [
    pr(1),
    pr(2, { labels: [{ name: 'hands-off' }] }),
    pr(3, { body: 'A person’s pull request.' }),
    pr(4, { head: { ref: 'feature/x', sha: 'c'.repeat(40), repo: REPO } }),
    pr(5),
  ];

  it('keeps those Local Publish opened under the prefix, hands-off last, then the newest', () => {
    const shaped = LoopPullRequestsSchema.parse(loopPullRequests(listed, 'aflow/'));
    expect(shaped.pullRequests.map((p) => p.number)).toEqual([5, 1, 2]);
    expect(shaped.pullRequests.at(-1)?.handsOff).toBe(true);
    expect(shaped.count).toBe(3);
  });

  it('refuses to read without a prefix', () => {
    expect(() => loopPullRequests(listed, undefined)).toThrow(/prefix/);
    expect(() => loopPullRequests(listed, ':5')).toThrow(/prefix/);
  });

  // A pass tends the first, so each takes the one after the last one tended:
  // ordered by `updated_at`, the one just written on could stay first forever.
  it('turns past the pull request last tended, wrapping to the newest, hands-off still last', () => {
    const turn = (last: number) =>
      loopPullRequests(listed, `aflow/:${String(last)}`).pullRequests.map((p) => p.number);
    expect(turn(5)).toEqual([1, 5, 2]);
    expect(turn(1)).toEqual([5, 1, 2]);
    // A number no longer listed — merged since — still turns to the one below it.
    expect(turn(3)).toEqual([1, 5, 2]);
    const newestUpdatedFirst = [pr(9, { updated_at: '2026-10-01T00:00:00Z' }), pr(4), pr(7)].map(
      (p) => ({ ...p, head: { ...p.head, ref: `aflow/branch-${String(p.number)}` } }),
    );
    expect(
      loopPullRequests(newestUpdatedFirst, 'aflow/:9').pullRequests.map((p) => p.number),
    ).toEqual([7, 4, 9]);
  });

  it('refuses a turn that is not a pull request number', () => {
    expect(() => loopPullRequests(listed, 'aflow/:x')).toThrow(/number/);
  });

  // The loop pushes to its own repository: a fork can copy the marker and a
  // branch name under the prefix, and is still someone else's branch.
  it('lists no pull request from a fork, marker and prefix notwithstanding', () => {
    const fromFork = pr(6, {
      head: { ref: 'aflow/branch-6', sha: 'c'.repeat(40), repo: FORK },
    });
    const fromDeletedFork = pr(8, {
      head: { ref: 'aflow/branch-8', sha: 'c'.repeat(40), repo: null },
    });
    expect(
      loopPullRequests([...listed, fromFork, fromDeletedFork], 'aflow/').pullRequests.map(
        (p) => p.number,
      ),
    ).toEqual([5, 1, 2]);
    expect(loopPullRequests([fromFork], 'aflow/').count).toBe(0);
  });
});

describe('loop_pull — one pull request', () => {
  it('says whether it is the loop’s under the prefix, and drops the marker from the body', () => {
    const shaped = LoopPullRequestSchema.parse(
      loopPullRequest(pr(7, { mergeable_state: 'dirty' }), 'aflow/'),
    );
    expect(shaped).toMatchObject({
      number: 7,
      ours: true,
      handsOff: false,
      mergeableState: 'dirty',
    });
    expect(shaped.body).toBe('Body.');
    expect(loopPullRequest(pr(7, { body: 'Mine.' }), 'aflow/').ours).toBe(false);
    expect(loopPullRequest(pr(7), 'other/').ours).toBe(false);
  });

  it('is never the loop’s from a fork', () => {
    const fromFork = pr(7, { head: { ref: 'aflow/branch-7', sha: 'c'.repeat(40), repo: FORK } });
    expect(loopPullRequest(fromFork, 'aflow/').ours).toBe(false);
  });

  it('carries GitHub’s html_url, the ref a plan node’s pull_request link holds', () => {
    const url = 'https://github.com/aflowai/aflow/pull/7';
    expect(
      LoopPullRequestSchema.parse(loopPullRequest(pr(7, { html_url: url }), 'aflow/')).url,
    ).toBe(url);
    expect(loopPullRequest(pr(7), 'aflow/')).not.toHaveProperty('url');
  });

  it('counts the pages of its conversation, the last the newest', () => {
    expect(loopPullRequest(pr(7, { comments: 0 }), 'aflow/').commentPages).toBe(1);
    expect(loopPullRequest(pr(7, { comments: 100 }), 'aflow/').commentPages).toBe(1);
    expect(loopPullRequest(pr(7, { comments: 101 }), 'aflow/').commentPages).toBe(2);
    expect(loopPullRequest(pr(7, { comments: 250 }), 'aflow/').commentPages).toBe(3);
  });
});

describe('loop_checks — what CI says of the head', () => {
  const run = (id: number, status: string, conclusion: string | null) => ({
    id,
    name: `check-${String(id)}`,
    status,
    conclusion,
    details_url: `https://github.com/aflowai/aflow/actions/runs/37460214524/job/${String(id)}`,
  });

  it.each([
    [[run(2, 'completed', 'success'), run(3, 'completed', 'failure')], 'failing'],
    [[run(2, 'completed', 'success'), run(3, 'in_progress', null)], 'pending'],
    [[run(2, 'completed', 'success'), run(3, 'completed', 'skipped')], 'passing'],
    [[run(2, 'completed', 'cancelled')], 'stopped'],
    [[], 'none'],
  ])('reads %j as %s', (runs, state) => {
    expect(loopCheckRuns({ total_count: runs.length, check_runs: runs }).state).toBe(state);
  });

  it('names the failing run with the lowest id, as text, with the Actions run it is a job of', () => {
    const shaped = CheckRunsSummarySchema.parse(
      loopCheckRuns({
        total_count: 2,
        check_runs: [run(9, 'completed', 'timed_out'), run(4, 'completed', 'failure')],
      }),
    );
    expect(shaped.firstFailing).toEqual({
      id: '4',
      name: 'check-4',
      conclusion: 'failure',
      runId: 37460214524,
    });
  });

  // Every pass reads the same first page, so a verdict of `pending` on a
  // finished page would be a wait that never ends, with a reason — checks
  // still running — that is false. Such a head is `unknown`, and says so.
  describe('a head with more check runs than the one page read', () => {
    const greenPage = Array.from({ length: 100 }, (_, i) => run(i + 1, 'completed', 'success'));

    it('is unknown, never passing, from a finished first page while a failure may sit on the second', () => {
      const shaped = CheckRunsSummarySchema.parse(
        loopCheckRuns({ total_count: 101, check_runs: greenPage }),
      );
      expect(shaped.state).toBe('unknown');
      expect(shaped.total).toBe(101);
      expect(shaped.failing).toEqual([]);
    });

    it.each([
      ['stopped', [run(1, 'completed', 'cancelled'), ...greenPage.slice(1)]],
      ['none', []],
    ])('nor %s from a page that would read so alone', (alone, page) => {
      expect(loopCheckRuns({ total_count: page.length, check_runs: page }).state).toBe(alone);
      expect(loopCheckRuns({ total_count: 150, check_runs: page }).state).toBe('unknown');
    });

    it('is pending only while a run on the page itself is still going, and unknown once none is', () => {
      const running = [...greenPage.slice(1), run(101, 'in_progress', null)];
      expect(loopCheckRuns({ total_count: 150, check_runs: running }).state).toBe('pending');
      const finished = [...greenPage.slice(1), run(101, 'completed', 'success')];
      expect(loopCheckRuns({ total_count: 150, check_runs: finished }).state).toBe('unknown');
    });

    it('is failing where the page itself carries a failure, which no later page undoes', () => {
      const page = [...greenPage.slice(1), run(101, 'completed', 'failure')];
      expect(loopCheckRuns({ total_count: 150, check_runs: page }).state).toBe('failing');
    });
  });

  it('fails the read where GitHub gives no count of the runs, rather than trust the page', () => {
    expect(() => loopCheckRuns({ check_runs: [run(2, 'completed', 'success')] })).toThrow(
      'total_count is not a number',
    );
  });
});

describe('loop_handoff — the shepherd’s own record', () => {
  const loop = { login: 'aflow-app[bot]' };
  const stranger = { login: 'someone' };
  const ON_94 = 'https://api.github.com/repos/aflowai/aflow/issues/94';
  const handoff = (
    id: number,
    attemptCount: number,
    checkRunId: string,
    user = loop,
    issueUrl = ON_94,
  ) => ({
    id,
    user,
    issue_url: issueUrl,
    body: `<!-- aflow:shepherd\nattemptCount: ${String(attemptCount)}\ncheckRunId: ${checkRunId}\n-->\nWords.`,
  });
  const AS_PINNED = 'aflow-app[bot]:94';

  it('trusts a record whose author is the login the loop’s handoff was pinned with', () => {
    const shaped = ShepherdHandoffReadSchema.parse(
      loopHandoff(
        [
          handoff(1, 1, '4'),
          { id: 2, user: stranger, issue_url: ON_94, body: 'Looks good.' },
          handoff(3, 2, '9'),
        ],
        AS_PINNED,
      ),
    );
    expect(shaped).toEqual({
      found: true,
      commentId: 3,
      attemptCount: 2,
      nextAttemptCount: 3,
      checkRunId: '9',
      trust: 'verified',
    });
  });

  // The record is an HTML comment nobody sees on GitHub: from anyone but the
  // loop it would lift the budget (`attemptCount: 0`) or pin a pull request
  // at `wait` (a `checkRunId`), so it is no record at all.
  it('ignores a record from a mismatched author, newest or not', () => {
    const read = loopHandoff([handoff(1, 3, '9'), handoff(2, 0, '10', stranger)], AS_PINNED);
    expect(read).toMatchObject({ found: true, commentId: 1, attemptCount: 3, checkRunId: '9' });
    expect(loopHandoff([handoff(2, 0, '10', stranger)], AS_PINNED)).toMatchObject({
      found: false,
      attemptCount: 0,
      trust: 'verified',
    });
  });

  // With no author pinned — the first pass, or a pin lost — no comment can be
  // told from a forgery, so none is the record, and the read says so: the pass
  // decides as on a pull request with no handoff, never waiting on it.
  it('trusts nothing, and is undecided, where no author is known', () => {
    expect(loopHandoff([handoff(1, 3, '9')], ':94')).toEqual({
      found: false,
      attemptCount: 0,
      nextAttemptCount: 1,
      trust: 'undecided',
    });
  });

  it('takes no record from another pull request’s comment, its author notwithstanding', () => {
    const elsewhere = handoff(
      5,
      2,
      '12',
      loop,
      'https://api.github.com/repos/aflowai/aflow/issues/93',
    );
    expect(loopHandoff(elsewhere, AS_PINNED).found).toBe(false);
    expect(loopHandoff(handoff(5, 2, '12'), AS_PINNED)).toMatchObject({
      found: true,
      commentId: 5,
    });
  });

  it('matches the author as GitHub does, without regard to case', () => {
    expect(loopHandoff([handoff(3, 1, '11', { login: 'AFLOW-APP[BOT]' })], AS_PINNED).found).toBe(
      true,
    );
  });

  it('refuses to read without the pull request it reads for', () => {
    expect(() => loopHandoff([handoff(1, 1, '4')], 'aflow-app[bot]')).toThrow(/<login>:<number>/);
  });

  // Read after the pinned comment answered 404: the pin kept the state that
  // comment recorded, and a deleted record is no first pass.
  describe('with the attempt state a pin kept', () => {
    it('answers that state where the newest page holds no handoff — the budget and the guard stand', () => {
      const read = ShepherdHandoffReadSchema.parse(
        loopHandoff(
          [{ id: 2, user: stranger, issue_url: ON_94, body: 'Hm.' }],
          `${AS_PINNED}:3:555`,
        ),
      );
      expect(read).toEqual({
        found: false,
        attemptCount: 3,
        nextAttemptCount: 4,
        checkRunId: '555',
        trust: 'verified',
      });
    });

    it('carries a count with no check run acted on', () => {
      expect(loopHandoff([], `${AS_PINNED}:0:`)).toEqual({
        found: false,
        attemptCount: 0,
        nextAttemptCount: 1,
        trust: 'verified',
      });
    });

    it('keeps the higher count of a handoff found on the page and the state the pin kept', () => {
      expect(loopHandoff([handoff(4, 1, '7')], `${AS_PINNED}:2:9`)).toMatchObject({
        found: true,
        commentId: 4,
        attemptCount: 2,
        nextAttemptCount: 3,
        checkRunId: '9',
      });
      expect(loopHandoff([handoff(4, 3, '12')], `${AS_PINNED}:2:9`)).toMatchObject({
        attemptCount: 3,
        checkRunId: '12',
      });
    });

    it('trusts nothing with no author, whatever state is given', () => {
      expect(loopHandoff([handoff(1, 3, '9')], ':94:3:9')).toMatchObject({
        found: false,
        attemptCount: 0,
        trust: 'undecided',
      });
    });

    it.each([`${AS_PINNED}:x:9`, `${AS_PINNED}:3`, `${AS_PINNED}:3:9a`, `${AS_PINNED}:3:9:1`])(
      'refuses a state it could not have been given: %s',
      (arg) => {
        expect(() => loopHandoff([], arg)).toThrow(/<attempts>:<checkRunId>/);
      },
    );
  });
});

describe('loop_failing_jobs — the jobs that failed', () => {
  it('keeps the failed jobs, each with its failed steps', () => {
    const shaped = FailingJobsSchema.parse(
      loopFailingJobs({
        jobs: [
          { id: 2, name: 'Lint', conclusion: 'success', steps: [] },
          {
            id: 1,
            name: 'Test',
            conclusion: 'failure',
            steps: [
              { name: 'Install', conclusion: 'success' },
              { name: 'Run tests', conclusion: 'failure' },
            ],
          },
        ],
      }),
    );
    expect(shaped).toEqual({
      jobs: [{ id: 1, name: 'Test', conclusion: 'failure', failedSteps: ['Run tests'] }],
      count: 1,
    });
  });
});

describe('job_log_tail — the end of a job’s log', () => {
  it('keeps the last 300 lines, colour codes taken out', () => {
    const log = Array.from({ length: 5955 }, (_, i) => `\u001b[36mline ${String(i)}\u001b[0m`).join(
      '\n',
    );
    const tail = JobLogExcerptSchema.parse(jobLogTail(`${log}\n`));
    expect(tail.lines).toBe(JOB_LOG_EXCERPT_MAX_LINES);
    expect(tail.totalLines).toBe(5955);
    expect(tail.truncated).toBe(true);
    expect(tail.excerpt.split('\n').at(-1)).toBe('line 5954');
    expect(tail.excerpt).not.toContain('\u001b');
  });

  it('holds under 60 KB as it is carried, fewer lines where 300 would pass it', () => {
    const wide = Array.from({ length: 400 }, (_, i) => `${String(i)} ${'"x"'.repeat(200)}`).join(
      '\n',
    );
    const tail = jobLogTail(wide);
    expect(tail.lines).toBeLessThan(JOB_LOG_EXCERPT_MAX_LINES);
    expect(Buffer.byteLength(JSON.stringify(tail.excerpt))).toBeLessThanOrEqual(
      JOB_LOG_EXCERPT_MAX_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(tail))).toBeLessThan(64 * 1024);
  });

  it('keeps the end of one line too long alone', () => {
    const tail = jobLogTail(`start\n${'y'.repeat(200_000)}end`);
    expect(tail.excerpt.endsWith('end')).toBe(true);
    expect(tail.bytes).toBeLessThanOrEqual(JOB_LOG_EXCERPT_MAX_BYTES);
  });

  it('keeps a short log whole', () => {
    expect(jobLogTail('a\nb\n')).toMatchObject({ excerpt: 'a\nb', lines: 2, truncated: false });
  });

  it('is getJobLogs’ own transform, applied to the text before it is shaped', () => {
    const log = { text: 'a\nb\n', skipped: NOTHING_SKIPPED };
    expect(applyTextTransformPreset('job_log_tail', log)).toEqual(jobLogTail(log.text));
    expect(textPresetTailWindow('job_log_tail')).toBe(JOB_LOG_READ_WINDOW_BYTES);
  });

  it('read past a skipped prefix, leaves out the fragment it starts with and counts the lines skipped', () => {
    const tail = jobLogTail('ment\nline 41\nline 42\n', {
      bytes: 9000,
      lineBreaks: 40,
      endsLine: false,
    });
    expect(tail).toMatchObject({
      excerpt: 'line 41\nline 42',
      lines: 2,
      totalLines: 43,
      truncated: true,
    });
  });

  it('read from a line’s start, keeps that line', () => {
    const tail = jobLogTail('line 40\nline 41', { bytes: 9000, lineBreaks: 40, endsLine: true });
    expect(tail).toMatchObject({ excerpt: 'line 40\nline 41', lines: 2, totalLines: 42 });
  });
});

describe('the merge reads — what the base branch requires, judged on the head (Plan 321 D6)', () => {
  const check = (name: string, status: string, conclusion: string | null, id = 1) => ({
    id,
    name,
    status,
    conclusion,
    details_url: 'https://github.com/aflowai/aflow/actions/runs/1/job/1',
  });
  const page = (...runs: ReturnType<typeof check>[]) => ({
    total_count: runs.length,
    check_runs: runs,
  });

  it('unites the rulesets’ required checks with the classic protection’s, both spellings', () => {
    const rules = RequiredCheckNamesSchema.parse(
      applyRecordTransformPreset('loop_required_rules', [
        { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'Test' }, { context: 'a,b:c' }] },
        },
      ]),
    );
    expect(rules.names).toEqual(['Test', 'a,b:c']);
    expect(decodeRequiredChecks(rules.encoded)).toEqual(['Test', 'a,b:c']);

    const united = RequiredCheckNamesSchema.parse(
      applyRecordTransformPreset(`loop_required_protection:${rules.encoded}`, {
        name: 'main',
        protected: true,
        protection: {
          required_status_checks: {
            contexts: ['Lint', 'Test'],
            checks: [{ context: 'Lint', app_id: 15368 }, { context: 'legacy-ci' }],
          },
        },
      }),
    );
    expect(united.names).toEqual(['Lint', 'Test', 'a,b:c', 'legacy-ci']);
  });

  it('reads an unprotected branch with no rules as requiring nothing — a set read and found empty', () => {
    const rules = loopRequiredRules([]);
    expect(rules).toEqual({ names: [], encoded: '' });
    const united = loopRequiredProtection({ name: 'main', protected: false }, rules.encoded);
    expect(united).toEqual({ names: [], encoded: '' });
    expect(loopCheckRuns(page(check('Test', 'completed', 'success')), '').required).toMatchObject({
      state: 'none',
    });
  });

  it('judges no required check on a read given none — the posture is never, or the set was not read', () => {
    expect(loopCheckRuns(page(check('Test', 'completed', 'success'))).required).toBeUndefined();
  });

  it('passes the required checks only where each has a check run on the head concluded success', () => {
    const required = encodeRequiredChecks(['Test', 'Lint']);
    const passed = CheckRunsSummarySchema.parse(
      loopCheckRuns(
        page(
          check('Test', 'completed', 'success', 1),
          check('Lint', 'completed', 'success', 2),
          check('Docs', 'completed', 'failure', 3),
        ),
        required,
      ),
    );
    // A red check the base does not require fails CI, which the shepherd fixes first.
    expect(passed.state).toBe('failing');
    expect(passed.required).toMatchObject({ state: 'passed', unmet: [] });
    expect(passed.required?.summary).toBeUndefined();
  });

  it.each([
    ['red', check('Test', 'completed', 'failure'), 'failure'],
    ['still running', check('Test', 'in_progress', null), 'pending'],
    ['skipped', check('Test', 'completed', 'skipped'), 'skipped'],
    ['neutral', check('Test', 'completed', 'neutral'), 'neutral'],
  ])('holds back a required check that is %s', (_how, run, conclusion) => {
    const shaped = loopCheckRuns(
      page(run, check('Lint', 'completed', 'success', 2)),
      encodeRequiredChecks(['Test', 'Lint']),
    );
    expect(shaped.required).toEqual({
      state: 'unmet',
      required: ['Lint', 'Test'],
      unmet: [{ name: 'Test', conclusion }],
      summary: `\`Test\` (${conclusion})`,
    });
  });

  it('names a required context reported only as a commit status: it has no check run, and never passes', () => {
    const shaped = loopCheckRuns(
      page(check('Test', 'completed', 'success')),
      encodeRequiredChecks(['Test', 'ci/jenkins']),
    );
    expect(shaped.state).toBe('passing');
    expect(shaped.required).toMatchObject({
      state: 'unmet',
      unmet: [{ name: 'ci/jenkins', conclusion: 'no check run' }],
    });
  });

  it('fails a protection read given no rulesets’ set to unite with', () => {
    expect(() => applyRecordTransformPreset('loop_required_protection', { name: 'main' })).toThrow(
      ApiExecutionError,
    );
  });
});

describe('loop_reviews — each person’s standing verdict', () => {
  const review = (login: string, state: string, type = 'User') => ({
    id: Math.floor(Math.random() * 1e9),
    user: { login, type },
    state,
    submitted_at: '2026-10-18T08:00:00Z',
  });

  it('holds a change request that the same person’s later COMMENTED review does not clear', () => {
    const shaped = PullRequestReviewsSchema.parse(
      applyRecordTransformPreset('loop_reviews', [
        review('octo', 'CHANGES_REQUESTED'),
        review('octo', 'COMMENTED'),
      ]),
    );
    expect(shaped).toEqual({
      changesRequestedBy: ['octo'],
      approvedBy: [],
      count: 2,
      complete: true,
    });
  });

  it('clears a change request the same person dismissed or then approved, and no one else’s approval clears it', () => {
    expect(
      loopReviews([review('octo', 'CHANGES_REQUESTED'), review('octo', 'APPROVED')])
        .changesRequestedBy,
    ).toEqual([]);
    expect(
      loopReviews([review('octo', 'CHANGES_REQUESTED'), review('octo', 'DISMISSED')])
        .changesRequestedBy,
    ).toEqual([]);
    expect(
      loopReviews([review('octo', 'CHANGES_REQUESTED'), review('cat', 'APPROVED')]),
    ).toMatchObject({ changesRequestedBy: ['octo'], approvedBy: ['cat'] });
  });

  it('counts a person’s review, not a bot’s', () => {
    expect(
      loopReviews([review('ci-bot[bot]', 'CHANGES_REQUESTED', 'Bot')]).changesRequestedBy,
    ).toEqual([]);
  });

  it('says a full page may hide a change request past it', () => {
    const full = Array.from({ length: PULL_REQUEST_REVIEWS_PER_PAGE }, (_, i) =>
      review(`r${String(i)}`, 'APPROVED'),
    );
    expect(loopReviews(full)).toMatchObject({ complete: false, count: 100 });
    expect(loopReviews(full.slice(1)).complete).toBe(true);
  });

  it('fails the read on a body that is not a list of reviews', () => {
    expect(() => applyRecordTransformPreset('loop_reviews', { message: 'Not Found' })).toThrow(
      ApiExecutionError,
    );
  });
});

describe('record presets', () => {
  it('take an argument after the first colon', () => {
    expect(isRecordTransformPreset('loop_pulls:aflow/')).toBe(true);
    expect(isRecordTransformPreset('loop_checks')).toBe(true);
    expect(isRecordTransformPreset('extract:data')).toBe(false);
  });

  it('are never an Object.prototype key, whatever the id', () => {
    for (const id of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'toString:x']) {
      expect(isRecordTransformPreset(id)).toBe(false);
      expect(isTextTransformPreset(id)).toBe(false);
      expect(() => applyRecordTransformPreset(id, {})).toThrowError(/Unknown record transform/);
      expect(() =>
        applyTextTransformPreset(id, { text: '', skipped: NOTHING_SKIPPED }),
      ).toThrowError(/Unknown text transform/);
    }
  });

  it('fail the read on a body they cannot shape, never passing it on', () => {
    expect(() => applyRecordTransformPreset('loop_checks', { message: 'Not Found' })).toThrowError(
      ApiExecutionError,
    );
  });
});

describe('a redirect off the API’s host', () => {
  const sent = {
    Accept: 'application/vnd.github+json',
    authorization: 'Bearer ghp_secret',
    'X-Api-Key': 'k',
    Cookie: 'c=1',
  };

  it('carries none of the binding’s credential, whatever its case', () => {
    expect(
      withoutCredentials(
        sent,
        credentialHeaderNames({ type: 'bearer', credentialKey: 'gh' } as never),
      ),
    ).toEqual({ Accept: 'application/vnd.github+json', 'X-Api-Key': 'k' });
    expect(
      withoutCredentials(
        sent,
        credentialHeaderNames({
          type: 'api_key',
          placement: 'header',
          headerName: 'x-api-key',
          credentialKey: 'k',
        } as never),
      ),
    ).toEqual({ Accept: 'application/vnd.github+json' });
  });
});
