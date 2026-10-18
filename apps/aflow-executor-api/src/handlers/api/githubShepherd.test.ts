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
  FailingJobsSchema,
  JOB_LOG_EXCERPT_MAX_BYTES,
  JOB_LOG_EXCERPT_MAX_LINES,
  JobLogExcerptSchema,
  LOCAL_PUBLISH_PULL_REQUEST_MARKER,
  LoopPullRequestSchema,
  LoopPullRequestsSchema,
  ShepherdHandoffReadSchema,
} from '@aflow/schemas';
import {
  jobLogTail,
  loopCheckRuns,
  loopFailingJobs,
  loopHandoff,
  loopPullRequest,
  loopPullRequests,
} from './githubShepherd.js';
import {
  applyRecordTransformPreset,
  getTextTransform,
  isRecordTransformPreset,
} from './transforms.js';
import { withoutCredentials } from './execution.js';
import { credentialHeaderNames } from './headers.js';
import { ApiExecutionError } from './types.js';

function pr(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    state: 'open',
    title: `PR ${String(number)}`,
    body: `Body.\n\n${LOCAL_PUBLISH_PULL_REQUEST_MARKER}`,
    draft: false,
    labels: [],
    updated_at: `2026-10-1${String(number % 10)}T00:00:00Z`,
    head: { ref: `aflow/branch-${String(number)}`, sha: 'c'.repeat(40) },
    base: { ref: 'main' },
    ...over,
  };
}

describe('loop_pulls — the loop’s open pull requests under the prefix', () => {
  const listed = [
    pr(1),
    pr(2, { labels: [{ name: 'hands-off' }] }),
    pr(3, { body: 'A person’s pull request.' }),
    pr(4, { head: { ref: 'feature/x', sha: 'c'.repeat(40) } }),
    pr(5),
  ];

  it('keeps those Local Publish opened under the prefix, hands-off last, then the newest', () => {
    const shaped = LoopPullRequestsSchema.parse(loopPullRequests(listed, 'aflow/'));
    expect(shaped.pullRequests.map((p) => p.number)).toEqual([5, 1, 2]);
    expect(shaped.pullRequests.at(-1)?.handsOff).toBe(true);
    expect(shaped.count).toBe(3);
  });

  it('keeps only the one a pass is aimed at, and only where it is one of them', () => {
    expect(loopPullRequests(listed, 'aflow/:1').pullRequests.map((p) => p.number)).toEqual([1]);
    expect(loopPullRequests(listed, 'aflow/:3').count).toBe(0);
  });

  it('refuses to read without a prefix', () => {
    expect(() => loopPullRequests(listed, undefined)).toThrow(/prefix/);
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
});

describe('loop_handoff — the shepherd’s own record', () => {
  it('reads back the newest handoff, with the count a pass that acts writes', () => {
    const shaped = ShepherdHandoffReadSchema.parse(
      loopHandoff([
        { id: 1, body: '<!-- aflow:shepherd\nattemptCount: 1\ncheckRunId: 4\n-->' },
        { id: 2, body: 'Looks good to me.' },
        { id: 3, body: '<!-- aflow:shepherd\nattemptCount: 2\ncheckRunId: 9\n-->\nWords.' },
      ]),
    );
    expect(shaped).toEqual({
      found: true,
      commentId: 3,
      attemptCount: 2,
      nextAttemptCount: 3,
      checkRunId: '9',
    });
  });

  it('reads none as a first pass', () => {
    expect(loopHandoff([{ id: 2, body: 'Hi.' }])).toEqual({
      found: false,
      attemptCount: 0,
      nextAttemptCount: 1,
    });
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
    expect(getTextTransform('job_log_tail')).toBe(jobLogTail);
  });
});

describe('record presets', () => {
  it('take an argument after the first colon', () => {
    expect(isRecordTransformPreset('loop_pulls:aflow/')).toBe(true);
    expect(isRecordTransformPreset('loop_checks')).toBe(true);
    expect(isRecordTransformPreset('extract:data')).toBe(false);
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
