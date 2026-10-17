/**
 * Contract: a pull request is described from the branch as a whole — the
 * slice's title, every commit's message in the range the push sends, the
 * review's findings closed and left open, the checks as verification and the
 * gaps the commissions recorded — and its text is read for secrets before it
 * is handed back.
 *
 * Every planted value is assembled at run time, so this file holds none of
 * them and cannot trip the scan it tests.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  type HostCommitDescribeInput,
  HostCommitDescribeInputSchema,
  HostCommitDescribeOutputSchema,
  PULL_REQUEST_BODY_MAX_CHARS,
} from '@aflow/schemas';

import { createHostHandler } from '../handlers/hostHandler.js';
import { composePullRequest } from '../pullRequestText.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout;
}

/** A GitHub token's shape, built here so no line of this file holds one. */
function plantedToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let state = 7;
  let out = 'ghp' + '_';
  for (let i = 0; i < 36; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

/** The three rounds of one slice, as their commits record them. */
const ROUNDS = [
  {
    subject: 'Remove the build cache from the check',
    body: 'The check kept built outputs across checkouts; the key could not cover what a build reads, so a stale entry passed a broken commit. Every check now builds what it needs.',
  },
  {
    subject: 'Size the test timeout for a loaded machine',
    body: 'One constant, `CHECK_TEST_TIMEOUT_MS`, three times the runner default.',
  },
  {
    subject: "Fix the review's findings",
    body: 'The removed cache directory is deleted on the first check after the upgrade.',
  },
] as const;

const FINDINGS = [
  {
    severity: 'major',
    file: 'scripts/verify-commit.mjs',
    line: 412,
    claim: 'The old cache directory is left on disk.',
    state: 'closed',
  },
  {
    severity: 'nit',
    file: 'scripts/check-tests.mjs',
    claim: 'The constant is named for the old default.',
    state: 'open',
  },
] as const;

const REVIEW_SUMMARY =
  'Removes the check’s build cache and sizes its test timeout. One nit: scripts/check-tests.mjs names the constant for the old default. Ran `yarn test:file` on the touched tests: passed.';

const CHECK_TAIL = 'ok   large-files guard (2.0 s)\nok   tsc apps/aflow-executor-host (41.3 s)\n';

const GAPS = ['The check was not timed on a machine running two commissions.'];

let base: string;
let root: string;
let policyPath: string;
let start: string;

async function commit(subject: string, body: string, file: string): Promise<string> {
  await writeFile(join(root, file), `${subject}\n`);
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', subject, '-m', body);
  return (await git(root, 'rev-parse', 'HEAD')).trim();
}

interface Captured {
  output?: unknown;
  error?: unknown;
}

function contextFor(input: unknown, captured: Captured): never {
  const log = () => {};
  return {
    operationId: 'host.commit.describe',
    spaceId: 'space-a',
    runId: 'run-a',
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: log, warn: log, info: log, debug: log },
    readPayload: () => Promise.resolve(input),
    writePayload: (kind: string, data: unknown) => {
      if (kind === 'error') captured.error = data;
      else captured.output = data;
      return Promise.resolve('inline:out');
    },
  } as never;
}

async function describeRange(input: Omit<HostCommitDescribeInput, 'bindingId'>) {
  const captured: Captured = {};
  const result = await createHostHandler(policyPath, noPushApprovals).execute(
    contextFor({ bindingId: 'hb_app', ...input }, captured),
  );
  return { result, captured };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'commit-describe-'));
  root = join(base, 'repo');
  await run('git', ['init', '-q', '-b', 'main', root]);
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'README.md'), '# app\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'init');
  start = (await git(root, 'rev-parse', 'HEAD')).trim();
  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [{ id: 'hb_app', root, mode: 'read', allowsExecution: false, spaceId: 'space-a' }],
    }),
  );
});

describe('host.commit.describe', () => {
  it('describes a range of three commits with one review round: the slice, every message, the findings, the checks and the gaps', async () => {
    let head = start;
    for (const [index, round] of ROUNDS.entries()) {
      head = await commit(round.subject, round.body, `round-${String(index)}.txt`);
    }

    const input = HostCommitDescribeInputSchema.parse({
      range: `${start}..${head}`,
      findings: FINDINGS,
      review: { verdict: 'approve', outcome: 'completed', reviewSummary: REVIEW_SUMMARY },
      check: {
        passed: true,
        skipped: null,
        summary: '`node scripts/verify-commit.mjs` passed.',
        tail: CHECK_TAIL,
      },
      gaps: GAPS,
      bindingId: 'hb_app',
    });
    const { result, captured } = await describeRange(input);
    expect(result.status).toBe('SUCCEEDED');
    const output = HostCommitDescribeOutputSchema.parse(captured.output);

    // The slice's title: the round that started the branch, not the last fix.
    expect(output.title).toBe(ROUNDS[0].subject);
    expect(output.commits.map((c) => c.subject)).toEqual(ROUNDS.map((r) => r.subject));

    const { body } = output;
    const at = (text: string) => {
      const index = body.indexOf(text);
      expect(index, text).toBeGreaterThanOrEqual(0);
      return index;
    };
    // What changes: every commit's message, oldest first.
    const changes = at('## What changes');
    const messages = ROUNDS.flatMap((round) => [at(`### ${round.subject}`), at(round.body)]);
    expect(messages).toEqual([...messages].sort((a, b) => a - b));
    expect(changes).toBeLessThan(messages[0] ?? -1);

    // The review round's findings, closed and left open, and this range's review.
    const review = at('## Review');
    expect(at('### Closed')).toBeLessThan(
      at('- **major** `scripts/verify-commit.mjs:412` — The old cache directory is left on disk.'),
    );
    expect(at('### Left open')).toBeLessThan(
      at('- **nit** `scripts/check-tests.mjs` — The constant is named for the old default.'),
    );
    expect(at('### Closed')).toBeLessThan(at('### Left open'));
    at('The review of this range returned `approve`.');
    at(REVIEW_SUMMARY);

    // The check's results, as verification.
    const verification = at('## Verification');
    at('`node scripts/verify-commit.mjs` passed.');
    at(`\`\`\`\n${CHECK_TAIL.trimEnd()}\n\`\`\``);
    at("The pull request's own checks remain the proof.");

    // The gaps the commissions recorded.
    const gaps = at('## Known gaps');
    at(`- ${GAPS[0] ?? ''}`);

    expect([changes, review, verification, gaps]).toEqual(
      [changes, review, verification, gaps].sort((a, b) => a - b),
    );
  });

  it("hands back the findings and the decision it recorded, so the run carries the pull request's record", async () => {
    const head = await commit('The slice', 'What the slice does.', 'a.txt');
    const finding = {
      severity: 'minor',
      file: 'a.txt',
      line: 1,
      claim: 'Says what it was.',
      evidence: 'The first line.',
    } as const;
    const { captured } = await describeRange({
      range: `${start}..${head}`,
      review: {
        verdict: 'comment',
        outcome: 'completed',
        reviewSummary: 'Read.',
        findings: [finding],
      },
      afterReview: 'publish_as_is',
    });
    const output = HostCommitDescribeOutputSchema.parse(captured.output);
    expect(output.findings).toEqual([
      { severity: 'minor', file: 'a.txt', line: 1, claim: 'Says what it was.', state: 'open' },
    ]);
    expect(output.afterReview).toBe('publish_as_is');
  });

  it('describes only the range it is given, from its base', async () => {
    const first = await commit('Earlier work', 'Already on the base.', 'a.txt');
    const head = await commit('The slice', 'What the slice does.', 'b.txt');
    const { captured } = await describeRange({ range: `${first}..${head}` });
    const output = HostCommitDescribeOutputSchema.parse(captured.output);
    expect(output.title).toBe('The slice');
    expect(output.body).not.toContain('Earlier work');
  });

  it('refuses text that looks like a secret, by where it is and never by what, and composes nothing to send', async () => {
    const head = await commit('The slice', 'What the slice does.', 'a.txt');
    const token = plantedToken();
    const { result, captured } = await describeRange({
      range: `${start}..${head}`,
      gaps: [`The token ${token} was not rotated.`],
    });
    expect(result.status).toBe('FAILED');
    expect(captured.output).toBeUndefined();
    const message = JSON.stringify(captured.error);
    expect(message).toContain('pull request body');
    expect(message).toContain('github-token');
    expect(message).not.toContain(token);
  });

  it('refuses a range that holds no commit', async () => {
    const { result } = await describeRange({ range: `${start}..${start}` });
    expect(result.status).toBe('FAILED');
  });
});

describe('composePullRequest', () => {
  const commits = ROUNDS.map((round, index) => ({
    sha: String(index).repeat(40),
    subject: round.subject,
    body: round.body,
  }));
  const range = `${'a'.repeat(40)}..${'c'.repeat(40)}`;
  const bodyOf = (input: Partial<HostCommitDescribeInput>) =>
    composePullRequest({ bindingId: 'hb_app', range, ...input }, commits).body;

  it("keeps a person's own title and summary as they are", () => {
    expect(
      composePullRequest(
        { bindingId: 'hb_app', range, title: 'Their title', summary: 'Their words.' },
        commits,
      ),
    ).toEqual({ title: 'Their title', body: 'Their words.', findings: [] });
  });

  /** A finding as Local Code Review returns it, its evidence and suggestion beside what the record reads. */
  const REVIEW_FINDING = {
    severity: 'major',
    file: 'src/cache.ts',
    line: 40,
    claim: 'The cache is never invalidated after a write.',
    evidence: 'put() writes the store and leaves the map entry.',
    suggestion: 'Delete the entry in put().',
  } as const;
  const reviewed = (afterReview?: 'fix_before_merge' | 'publish_as_is' | null) =>
    HostCommitDescribeInputSchema.parse({
      bindingId: 'hb_app',
      range,
      findings: FINDINGS,
      review: {
        verdict: 'request_changes',
        outcome: 'completed',
        reviewSummary: REVIEW_SUMMARY,
        findings: [REVIEW_FINDING],
      },
      ...(afterReview !== undefined ? { afterReview } : {}),
    });

  it("hands on the latest review's findings as the open ones, replacing the earlier rounds', with only what the record reads", () => {
    const composed = composePullRequest(reviewed('fix_before_merge'), commits);
    expect(composed.findings).toEqual([
      {
        severity: 'major',
        file: 'src/cache.ts',
        line: 40,
        claim: 'The cache is never invalidated after a write.',
        state: 'open',
      },
    ]);
    // Round after round, what goes on is one review's findings, never every round's.
    const next = composePullRequest(
      HostCommitDescribeInputSchema.parse({
        bindingId: 'hb_app',
        range,
        findings: composed.findings,
        review: {
          verdict: 'request_changes',
          outcome: 'completed',
          reviewSummary: REVIEW_SUMMARY,
          findings: [REVIEW_FINDING],
        },
      }),
      commits,
    );
    expect(next.findings).toHaveLength(1);
  });

  it("says each finding once: the earlier rounds' listed, this review's in its own summary", () => {
    const summary = 'One major: src/cache.ts:40 — the cache is never invalidated after a write.';
    const { body } = composePullRequest(
      HostCommitDescribeInputSchema.parse({
        bindingId: 'hb_app',
        range,
        findings: FINDINGS,
        review: {
          verdict: 'request_changes',
          outcome: 'completed',
          reviewSummary: summary,
          findings: [REVIEW_FINDING],
        },
      }),
      commits,
    );
    for (const finding of FINDINGS) expect(body).toContain(finding.claim);
    expect(body).toContain(summary);
    expect(body).not.toContain('- **major** `src/cache.ts:40`');
    expect(body).not.toContain(REVIEW_FINDING.evidence);
  });

  it('passes on the open findings it was given where no review of its own finished', () => {
    for (const review of [
      undefined,
      { verdict: null, outcome: 'failed', reviewSummary: null, findings: null },
    ]) {
      const composed = composePullRequest(
        HostCommitDescribeInputSchema.parse({
          bindingId: 'hb_app',
          range,
          findings: FINDINGS,
          ...(review !== undefined ? { review } : {}),
        }),
        commits,
      );
      expect(composed.findings).toEqual(FINDINGS.filter((f) => f.state === 'open'));
    }
  });

  it('records the decision on those findings for each answer, and undecided where none cleared the bar or none was made', () => {
    for (const [answer, recorded] of [
      ['fix_before_merge', 'fix_before_merge'],
      ['publish_as_is', 'publish_as_is'],
      [null, 'undecided'],
      [undefined, 'undecided'],
    ] as const) {
      const composed = composePullRequest(reviewed(answer), commits);
      expect(composed.afterReview, String(answer)).toBe(recorded);
      expect(composed.body, String(answer)).toContain(`Decided after the review: \`${recorded}\``);
    }
  });

  it('records no decision where the review returned no findings, since none was asked', () => {
    for (const review of [
      { verdict: 'approve', outcome: 'completed', reviewSummary: 'Read.', findings: [] },
      { verdict: null, outcome: 'failed', reviewSummary: null, findings: null },
      undefined,
    ]) {
      const composed = composePullRequest(
        HostCommitDescribeInputSchema.parse({
          bindingId: 'hb_app',
          range,
          ...(review !== undefined ? { review } : {}),
        }),
        commits,
      );
      expect(composed.afterReview).toBeUndefined();
      expect(composed.body).not.toContain('Decided after the review');
    }
  });

  it('says where nothing was reviewed, no checks ran, or no gaps were recorded', () => {
    const body = bodyOf({
      check: { passed: true, skipped: true, summary: '`hb_app` declares no checks, so none ran.' },
    });
    expect(body).toContain('No review of this range finished before it was pushed.');
    expect(body).toContain('The folder declares no checks, so none ran before the push.');
    expect(body).toContain('None recorded by the commissions.');
    expect(bodyOf({ review: { verdict: null, outcome: 'failed', reviewSummary: null } })).toContain(
      'The review of this range ended `failed` without a verdict, so it cleared nothing.',
    );
  });

  it('names both runs of the checks where the first lost only to time', () => {
    const body = bodyOf({
      check: {
        passed: false,
        summary: 'exited 1, and nothing failed but 1 test running out of time.',
      },
      recheck: { passed: true, summary: 'passed.', tail: 'ok   tests\n' },
    });
    expect(body).toContain(
      'Their first run lost only to tests running out of time: exited 1, and nothing failed but 1 test running out of time.',
    );
    expect(body).toContain('Their second run, which the push carries: passed.');
    expect(body).toContain('```\nok   tests\n```');
  });

  it('fences output with more backticks than any run inside it', () => {
    expect(bodyOf({ check: { passed: true, summary: 'passed.', tail: 'a ```` b\n' } })).toContain(
      '`````\na ```` b\n`````',
    );
  });

  it("stays within GitHub's limit by cutting the account of the commits, never the rest", () => {
    const long = commits.map((c) => ({ ...c, body: `${'x'.repeat(99)}\n`.repeat(400) }));
    const { body } = composePullRequest(
      { bindingId: 'hb_app', range, gaps: GAPS, findings: [...FINDINGS] },
      long,
    );
    expect(body.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_CHARS);
    expect(body).toContain("every commit's whole message is on the branch.");
    expect(body).toContain('## Known gaps');
    expect(body).toContain(`- ${GAPS[0] ?? ''}`);
    expect(body).toContain('### Left open');
  });
});
