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
  HANDED_ON_FINDINGS_MAX_COUNT,
  LOCAL_PUBLISH_PULL_REQUEST_MARKER,
  NEEDS_SETUP_FINDING_KIND,
  PULL_REQUEST_BODY_MAX_CHARS,
} from '@aflow/schemas';

import { createHostHandler } from '../handlers/hostHandler.js';
import {
  CHANGES_KEPT_BESIDE_FINDINGS,
  composePullRequest,
  NOT_SEEN_IN_BROWSER_LEAD,
  SUMMARY_KEPT_BESIDE_FINDINGS,
} from '../pullRequestText.js';
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

    // This range's review, then — last — the review round's findings, closed and left open.
    const review = at('## Review');
    const findings = at('## Findings');
    expect(findings).toBeLessThan(at('### Closed'));
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

    expect([changes, review, verification, gaps, findings]).toEqual(
      [changes, review, verification, gaps, findings].sort((a, b) => a - b),
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
    expect(output.findingsLeftOut).toBeUndefined();
    expect(output.afterReviewOverride).toBeUndefined();

    const override = { by: 'hands_off_label', reason: 'A person labelled it hands-off.' } as const;
    const overridden = await describeRange({
      range: `${start}..${head}`,
      review: { verdict: 'comment', outcome: 'completed', findings: [finding] },
      afterReview: 'fix_before_merge',
      override,
    });
    expect(HostCommitDescribeOutputSchema.parse(overridden.captured.output)).toMatchObject({
      afterReview: 'publish_as_is',
      afterReviewOverride: { ...override, overrode: 'fix_before_merge' },
    });
  });

  it('says how many findings the bounded hand-on left out, where it left any', async () => {
    const head = await commit('The slice', 'What the slice does.', 'a.txt');
    const findings = Array.from({ length: HANDED_ON_FINDINGS_MAX_COUNT + 2 }, (_, index) => ({
      severity: 'nit' as const,
      file: `f${String(index)}.txt`,
      claim: 'Says what it was.',
      evidence: 'Its name.',
    }));
    const { captured } = await describeRange({
      range: `${start}..${head}`,
      review: { verdict: 'comment', outcome: 'completed', reviewSummary: 'Read.', findings },
    });
    const output = HostCommitDescribeOutputSchema.parse(captured.output);
    expect(output.findings).toHaveLength(HANDED_ON_FINDINGS_MAX_COUNT);
    expect(output.findingsLeftOut).toBe(2);
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

  it("keeps a person's own title as it is, and heads the composed body with their summary rather than replacing it", () => {
    const composed = composePullRequest(
      { bindingId: 'hb_app', range, title: 'Their title', summary: 'Their words.' },
      commits,
    );
    expect(composed.title).toBe('Their title');
    expect(composed.body).toBe(`Their words.\n\n${bodyOf({})}`);
    expect(composed.findings).toEqual([]);
  });

  it("holds a summary too long for the rest of the body to its room, and keeps everything under it, within GitHub's limit", () => {
    const body = bodyOf({ summary: 'y'.repeat(PULL_REQUEST_BODY_MAX_CHARS) });
    expect(body.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_CHARS);
    expect(body).toContain('The summary stops here');
    for (const heading of ['## Review', '## Verification', '## Known gaps']) {
      expect(body).toContain(heading);
    }
    expect(body.endsWith(LOCAL_PUBLISH_PULL_REQUEST_MARKER)).toBe(true);
  });

  it('closes every body it composes with the marker the shepherd tends by, within GitHub’s limit', () => {
    const body = bodyOf({});
    expect(body.endsWith(`\n\n${LOCAL_PUBLISH_PULL_REQUEST_MARKER}`)).toBe(true);
    const huge = composePullRequest(
      { bindingId: 'hb_app', range },
      commits.map((commit) => ({ ...commit, body: 'x'.repeat(PULL_REQUEST_BODY_MAX_CHARS) })),
    ).body;
    expect(huge.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_CHARS);
    expect(huge.endsWith(LOCAL_PUBLISH_PULL_REQUEST_MARKER)).toBe(true);
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
  /** The same finding as a minor: the most a decision clears a push over without asking. */
  const MINOR_FINDING = { ...REVIEW_FINDING, severity: 'minor' } as const;
  const reviewed = (
    afterReview?: 'fix_before_merge' | 'publish_as_is',
    finding: typeof REVIEW_FINDING | typeof MINOR_FINDING = REVIEW_FINDING,
  ) =>
    HostCommitDescribeInputSchema.parse({
      bindingId: 'hb_app',
      range,
      findings: FINDINGS,
      review: {
        verdict: 'request_changes',
        outcome: 'completed',
        reviewSummary: REVIEW_SUMMARY,
        findings: [finding],
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

  it("says each finding once where nothing merges past it: the earlier rounds' listed, this review's in its own summary", () => {
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

  it('records the decision on those findings as the rounds rule settled it, and none where none was handed', () => {
    for (const decided of ['fix_before_merge', 'publish_as_is'] as const) {
      const composed = composePullRequest(reviewed(decided), commits);
      expect(composed.afterReview, decided).toBe(decided);
      expect(composed.body, decided).toContain(`Decided after the review: \`${decided}\``);
    }
    const handedNone = composePullRequest(reviewed(), commits);
    expect(handedNone.afterReview).toBeUndefined();
    expect(handedNone.body).not.toContain('Decided after the review');
  });

  it('takes no decision but the two the rounds rule makes', () => {
    for (const afterReview of ['undecided', null]) {
      expect(
        HostCommitDescribeInputSchema.safeParse({ bindingId: 'hb_app', range, afterReview })
          .success,
        String(afterReview),
      ).toBe(false);
    }
  });

  it('lists the findings a publish_as_is leaves open — and lists them for no other answer', () => {
    const listed = '- **major** `src/cache.ts:40` — The cache is never invalidated after a write.';
    const asIs = composePullRequest(reviewed('publish_as_is'), commits).body;
    // A major among them: the push it is pushed with was the operator's to clear.
    expect(asIs).toContain(
      "With a major among them, the push went out only on the operator's approval, and leaves this review's findings open, listed under **Left open by `publish_as_is`**.",
    );
    expect(asIs).toContain(`### Left open by \`publish_as_is\`\n\n${listed}`);
    expect(asIs).not.toContain(REVIEW_FINDING.evidence);
    const minor = composePullRequest(reviewed('publish_as_is', MINOR_FINDING), commits);
    expect(minor.severest).toBe('minor');
    expect(minor.body).toContain(
      "The push went without asking, and leaves this review's findings open, listed under **Left open by `publish_as_is`**.",
    );
    expect(minor.body).toContain('- **minor** `src/cache.ts:40`');
    for (const answer of ['fix_before_merge', undefined] as const) {
      expect(composePullRequest(reviewed(answer), commits).body, String(answer)).not.toContain(
        listed,
      );
    }
  });

  it('lists a range the review did not see in a browser on one line, from its needs_setup finding, and hands that finding on to none (Plan 320 D20, D21)', () => {
    const claim = 'UI change not seen in a browser: the folder declares no preview';
    const setup = {
      kind: NEEDS_SETUP_FINDING_KIND,
      severity: 'minor',
      file: 'src/web/Checkout.vue',
      claim,
      evidence: 'The range changes `src/web/Checkout.vue`, which matches the folder’s `uiPaths`.',
      suggestion: 'A person declares it once, on the machine: `aflow folder hb_app preview …`.',
    } as const;
    const approved = (findings: readonly unknown[]) =>
      HostCommitDescribeInputSchema.parse({
        bindingId: 'hb_app',
        range,
        review: {
          verdict: 'approve',
          outcome: 'completed',
          reviewSummary: REVIEW_SUMMARY,
          findings,
        },
        afterReview: 'publish_as_is',
      });
    const composed = composePullRequest(approved([MINOR_FINDING, setup]), commits);
    const line = `${NOT_SEEN_IN_BROWSER_LEAD} This range changes the folder's UI and was published without a review that saw it in a preview: \`src/web/Checkout.vue\` — ${claim}`;
    expect(composed.body).toContain(`## Review\n\nThe review of this range returned \`approve\`.`);
    expect(composed.body.split('\n').filter((l) => l.startsWith(NOT_SEEN_IN_BROWSER_LEAD))).toEqual(
      [line],
    );
    // Not a defect: neither handed on, nor listed among what the merge leaves open.
    expect(composed.findings.map((f) => f.claim)).toEqual([MINOR_FINDING.claim]);
    expect(composed.body).not.toContain(`- **minor** \`src/web/Checkout.vue\``);
    expect(composed.severest).toBe('minor');
    // Alone, it leaves nothing to hand on and no severity for the push to be held to.
    const alone = composePullRequest(approved([setup]), commits);
    expect(alone.findings).toEqual([]);
    expect(alone.severest).toBeUndefined();
    expect(alone.body).toContain(line);
    // A review that saw it, or found nothing of the kind, says nothing of a browser.
    expect(composePullRequest(reviewed('publish_as_is'), commits).body).not.toContain(
      NOT_SEEN_IN_BROWSER_LEAD,
    );
  });

  it('says a publish_as_is settled over an approval of nits alone, or of nothing, was asked of no decision — and how the push was cleared', () => {
    const NIT_FINDING = { ...REVIEW_FINDING, severity: 'nit' } as const;
    const nitsUnder = (verdict: 'approve' | 'comment' | 'request_changes') =>
      composePullRequest(
        HostCommitDescribeInputSchema.parse({
          bindingId: 'hb_app',
          range,
          review: {
            verdict,
            outcome: 'completed',
            reviewSummary: REVIEW_SUMMARY,
            findings: [NIT_FINDING],
          },
          afterReview: 'publish_as_is',
        }),
        commits,
      );
    const NITS_SETTLED = 'Its findings are nits alone, which end the rounds: no decision was asked';
    const nits = nitsUnder('approve');
    expect(nits.severest).toBe('nit');
    expect(nits.body).toContain(
      `${NITS_SETTLED}, and the push went without asking, and leaves this review's findings open, listed under **Left open by \`publish_as_is\`**.`,
    );
    expect(nits.body).toContain('- **nit** `src/cache.ts:40`');
    // Nits under any other verdict were the decision model's to weigh, so the text claims no settlement.
    for (const verdict of ['comment', 'request_changes'] as const) {
      const decided = nitsUnder(verdict).body;
      expect(decided, verdict).not.toContain(NITS_SETTLED);
      expect(decided, verdict).toContain("The push went without asking, and leaves this review's");
    }

    const nothingFound = (verdict: 'approve' | 'comment') =>
      composePullRequest(
        HostCommitDescribeInputSchema.parse({
          bindingId: 'hb_app',
          range,
          review: { verdict, outcome: 'completed', reviewSummary: REVIEW_SUMMARY, findings: [] },
          afterReview: 'publish_as_is',
        }),
        commits,
      );
    const approved = nothingFound('approve');
    expect(approved.afterReview).toBe('publish_as_is');
    expect(approved.body).toContain(
      'The review found nothing, so no decision was asked, and the push went without asking.',
    );
    expect(approved.body).not.toContain('### Left open by `publish_as_is`');
    // The gate asks over a review that found nothing and did not approve, so the text says so.
    expect(nothingFound('comment').body).toContain(
      "The review found nothing and did not approve, so the push went out only on the operator's approval.",
    );
  });

  it('records an override as publish_as_is, with whose act it was, its reason and the decision it set aside', () => {
    const reason = 'The operator said to merge it and fix the cache in the next slice.';
    const composed = composePullRequest(
      HostCommitDescribeInputSchema.parse({
        ...reviewed('fix_before_merge'),
        override: { by: 'operator', reason },
      }),
      commits,
    );
    expect(composed.afterReview).toBe('publish_as_is');
    expect(composed.afterReviewOverride).toEqual({
      by: 'operator',
      reason,
      overrode: 'fix_before_merge',
    });
    expect(composed.body).toContain(
      `The decision was \`fix_before_merge\`, set aside by the operator's word: ${reason}`,
    );
    expect(composed.body).toContain('- **major** `src/cache.ts:40`');
  });

  it("keeps a publish_as_is's open findings and its override record under a person's summary", () => {
    const reason = 'A person labelled the pull request hands-off: they take the finding on.';
    const composed = composePullRequest(
      HostCommitDescribeInputSchema.parse({
        ...reviewed('fix_before_merge', MINOR_FINDING),
        summary: 'Their own account of the change.',
        override: { by: 'hands_off_label', reason },
      }),
      commits,
    );
    expect(composed.body.startsWith('Their own account of the change.\n\n')).toBe(true);
    expect(composed.body).toContain('Decided after the review: `publish_as_is`');
    expect(composed.body).toContain(
      '- **minor** `src/cache.ts:40` — The cache is never invalidated after a write.',
    );
    expect(composed.body).toContain(
      `The decision was \`fix_before_merge\`, set aside by the \`hands-off\` label: ${reason}`,
    );
    expect(composed.afterReviewOverride).toEqual({
      by: 'hands_off_label',
      reason,
      overrode: 'fix_before_merge',
    });
  });

  it("carries a publish_as_is's decision, override record, checks and gaps whatever the length of its findings: the findings come after them, listed whole as far as GitHub's limit leaves room and the rest counted", () => {
    const reason = 'A person labelled the pull request hands-off: they take the findings on.';
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...MINOR_FINDING,
      line: index + 1,
      claim: `Finding ${String(index)}: ${'the cache is never invalidated after a write. '.repeat(80)}`,
    }));
    const check = {
      passed: true,
      summary: '`node scripts/verify-commit.mjs` passed.',
      tail: CHECK_TAIL,
    };
    for (const summary of [undefined, 'Their own account of the change.']) {
      const label = summary === undefined ? 'no summary' : 'a summary';
      const { body, findings } = composePullRequest(
        HostCommitDescribeInputSchema.parse({
          bindingId: 'hb_app',
          range,
          review: {
            verdict: 'comment',
            outcome: 'completed',
            reviewSummary: 'Read.',
            findings: many,
          },
          afterReview: 'fix_before_merge',
          override: { by: 'hands_off_label', reason },
          check,
          gaps: GAPS,
          ...(summary !== undefined ? { summary } : {}),
        }),
        commits,
      );
      expect(
        many.reduce((sum, f) => sum + f.claim.length, 0),
        label,
      ).toBeGreaterThan(PULL_REQUEST_BODY_MAX_CHARS);
      expect(body.length, label).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_CHARS);
      expect(body.endsWith(LOCAL_PUBLISH_PULL_REQUEST_MARKER), label).toBe(true);
      // Fitted by the findings' own cap, never by the cut that drops the end of the body.
      expect(body, label).not.toContain('The description stops here');
      if (summary !== undefined) expect(body.startsWith(`${summary}\n\n`), label).toBe(true);

      const recorded = [
        'Decided after the review: `publish_as_is`',
        `The decision was \`fix_before_merge\`, set aside by the \`hands-off\` label: ${reason}`,
        '## Verification',
        check.summary,
        "The pull request's own checks remain the proof.",
        '## Known gaps',
        `- ${GAPS[0] ?? ''}`,
      ];
      const listing = body.indexOf('## Findings');
      expect(listing, label).toBeGreaterThan(0);
      for (const text of recorded) {
        const index = body.indexOf(text);
        expect(index, `${label}: ${text}`).toBeGreaterThan(0);
        expect(index, `${label}: ${text}`).toBeLessThan(listing);
      }

      // Each listed finding whole, in the review's order, and the rest counted.
      const listed = many.filter((f) =>
        body.includes(`- **minor** \`src/cache.ts:${String(f.line)}\` — ${f.claim}`),
      );
      expect(listed.length, label).toBeGreaterThan(0);
      expect(listed, label).toEqual(many.slice(0, listed.length));
      expect(body, label).toContain(`…and ${String(many.length - listed.length)} more`);
      // The hand-on is its own bound, untouched by the body's.
      expect(findings, label).toHaveLength(HANDED_ON_FINDINGS_MAX_COUNT);
    }
  });

  it('records no decision where the review did not finish, since there was nothing to decide on', () => {
    for (const review of [
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

  it('records the fix_before_merge the rounds rule makes of a finished review that found nothing and did not approve', () => {
    const composed = composePullRequest(
      HostCommitDescribeInputSchema.parse({
        bindingId: 'hb_app',
        range,
        review: { verdict: 'comment', outcome: 'completed', reviewSummary: 'Read.', findings: [] },
        afterReview: 'fix_before_merge',
      }),
      commits,
    );
    expect(composed.afterReview).toBe('fix_before_merge');
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

  describe('beside findings longer than the body', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...MINOR_FINDING,
      line: index + 1,
      claim: `Finding ${String(index)}: ${'the cache is never invalidated after a write. '.repeat(80)}`,
    }));
    const earlier = Array.from({ length: 20 }, (_, index) => ({
      severity: 'minor' as const,
      file: 'src/earlier.ts',
      line: index + 1,
      claim: `Earlier ${String(index)}: ${'a round before this one found it. '.repeat(40)}`,
      state: index % 2 === 0 ? ('closed' as const) : ('open' as const),
    }));
    const compose = (summary: string, withCommits = commits) =>
      composePullRequest(
        HostCommitDescribeInputSchema.parse({
          bindingId: 'hb_app',
          range,
          summary,
          findings: earlier,
          review: { verdict: 'approve', outcome: 'completed', findings: many },
          afterReview: 'publish_as_is',
          gaps: GAPS,
        }),
        withCommits,
      ).body;
    const section = (body: string, heading: string, next: string) =>
      body.slice(body.indexOf(heading), body.indexOf(next));

    it('keeps a summary of the most it keeps whole, and at least that much of a far longer one', () => {
      const atBoundary = 's'.repeat(SUMMARY_KEPT_BESIDE_FINDINGS);
      const whole = compose(atBoundary);
      expect(whole.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_CHARS);
      expect(whole.startsWith(`${atBoundary}\n\n## What changes`)).toBe(true);
      expect(whole).not.toContain('The summary stops here');
      // The findings gave way to it: they are still cut, and counted.
      expect(whole).toMatch(/…and \d+ more/);

      const past = compose(atBoundary.repeat(3));
      expect(past.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_CHARS);
      expect(past).toContain('The summary stops here');
      const kept = past.slice(0, past.indexOf('\n\nThe summary stops here'));
      expect(kept.length).toBeGreaterThanOrEqual(SUMMARY_KEPT_BESIDE_FINDINGS - 200);
    });

    it('keeps the account of the commits whole within what it keeps, and readable past it', () => {
      const whole = compose('Their account.');
      for (const round of ROUNDS) {
        expect(whole).toContain(`### ${round.subject}\n\n${round.body}`);
      }

      const longCommits = commits.map((c) => ({ ...c, body: `${'x'.repeat(99)}\n`.repeat(400) }));
      const cut = compose('Their account.', longCommits);
      expect(cut.length).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_CHARS);
      const account = section(cut, '## What changes', '## Review');
      expect(account).toContain(`### ${ROUNDS[0]?.subject ?? ''}`);
      expect(account).toContain("every commit's whole message is on the branch.");
      expect(account.length).toBeGreaterThanOrEqual(CHANGES_KEPT_BESIDE_FINDINGS - 200);
    });

    it('lists the findings in their order — this review’s, then closed, then left open — and counts the rest', () => {
      const body = compose('s'.repeat(SUMMARY_KEPT_BESIDE_FINDINGS + 1));
      const order = [
        ...many.map((f) => `\`src/cache.ts:${String(f.line)}\``),
        ...earlier
          .filter((f) => f.state === 'closed')
          .map((f) => `\`src/earlier.ts:${String(f.line)}\``),
        ...earlier
          .filter((f) => f.state === 'open')
          .map((f) => `\`src/earlier.ts:${String(f.line)}\``),
      ];
      const listed = order.filter((where) => body.includes(where));
      expect(listed.length).toBeGreaterThan(0);
      expect(listed).toEqual(order.slice(0, listed.length));
      const positions = listed.map((where) => body.indexOf(where));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(body).toContain(`…and ${String(order.length - listed.length)} more`);
      expect(body).not.toContain('The description stops here');
    });
  });
});
