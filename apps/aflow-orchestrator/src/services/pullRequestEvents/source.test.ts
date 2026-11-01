/**
 * The pull request event source (Plan 339 D2).
 *
 * Its idle cost is the property Plan 180 protects: with no loop pull request
 * open, an hour of cycles makes no GitHub request — that case fails where the
 * task scans rather than reads its candidates. Each poll is conditional, so an
 * unchanged pull request answers 304 and the source emits nothing. Its merge
 * or its close clears the candidate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  PULL_REQUEST_WATCH_KEY,
  armPullRequestWatch,
  countPullRequestWatches,
  readRecordedWaitEvent,
} from '@aflow/redis';
import { pullRequestSubject } from '@aflow/schemas';
import type { BackgroundTaskLogger } from '@aflow/lib';
import type { ConditionalAnswer, GitHubConditionalGet } from './github.js';
import {
  PULL_REQUEST_POLL_CADENCE_MS,
  parseChangesRequested,
  parseChecksState,
  pullRequestChanges,
  runPullRequestEventsCycle,
} from './source.js';

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const SUBJECT = pullRequestSubject('aflowai', 'aflow', 276);
const T0 = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

const logger: BackgroundTaskLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const ctx = { maxBatch: 20, budgetExhausted: () => false, mode: 'enabled' as const };

let redis: Redis;
let clock: number;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  clock = T0;
});

/** A GitHub that answers each path from a table, honours If-None-Match, and counts requests. */
function fakeGitHub(answers: Record<string, { etag: string; body: unknown }>) {
  const requests: Array<{ path: string; etag?: string }> = [];
  const get: GitHubConditionalGet = async ({ path, etag }) => {
    requests.push({ path, ...(etag !== undefined ? { etag } : {}) });
    const route = Object.keys(answers)
      .sort((x, y) => y.length - x.length)
      .find((prefix) => path.startsWith(prefix));
    if (route === undefined) throw new Error(`no answer for ${path}`);
    const answer = answers[route]!;
    const result: ConditionalAnswer =
      etag === answer.etag
        ? { status: 304, etag: answer.etag, body: null }
        : { status: 200, etag: answer.etag, body: answer.body };
    return result;
  };
  return { get, requests };
}

const PULL = '/repos/aflowai/aflow/pulls/276';
const pull = (overrides: Record<string, unknown> = {}) => ({
  state: 'open',
  merged: false,
  mergeable_state: 'blocked',
  head: { sha: 'abc123' },
  ...overrides,
});
const CHECKS = '/repos/aflowai/aflow/commits/abc123/check-runs';
const REVIEWS = '/repos/aflowai/aflow/pulls/276/reviews';
const STATUS = '/repos/aflowai/aflow/commits/abc123/status';
const passing = (n: number) =>
  Array.from({ length: n }, () => ({ status: 'completed', conclusion: 'success' }));

async function arm(): Promise<void> {
  await armPullRequestWatch(redis, {
    tenantId: TENANT,
    spaceId: SPACE,
    owner: 'aflowai',
    repo: 'aflow',
    number: 276,
    subject: SUBJECT,
    url: 'https://github.com/aflowai/aflow/pull/276',
    armedAt: clock,
  });
}

async function cycle(get: GitHubConditionalGet, emit = vi.fn(async () => true)) {
  return runPullRequestEventsCycle({ redis, get, logger, now: () => clock, emit }, ctx);
}

describe('with no loop pull request open', () => {
  it('makes no GitHub request over an hour of cycles', async () => {
    const { get, requests } = fakeGitHub({});
    const emit = vi.fn(async () => true);

    for (let elapsed = 0; elapsed <= HOUR_MS; elapsed += PULL_REQUEST_POLL_CADENCE_MS) {
      clock = T0 + elapsed;
      expect(await cycle(get, emit)).toEqual({ candidates: 0 });
    }

    expect(requests).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('makes none again once the last loop pull request has merged', async () => {
    await arm();
    const merged = fakeGitHub({
      [PULL]: { etag: '"m1"', body: pull({ state: 'closed', merged: true }) },
    });
    await cycle(merged.get);
    expect(await countPullRequestWatches(redis)).toBe(0);

    const after = fakeGitHub({});
    for (let elapsed = 0; elapsed <= HOUR_MS; elapsed += PULL_REQUEST_POLL_CADENCE_MS) {
      clock = T0 + PULL_REQUEST_POLL_CADENCE_MS + elapsed;
      await cycle(after.get);
    }
    expect(after.requests).toHaveLength(0);
  });
});

describe('a loop pull request the publication armed', () => {
  it('emits checks_green once, and sends each ETag back on the next poll', async () => {
    await arm();
    const github = fakeGitHub({
      [PULL]: { etag: '"p1"', body: pull() },
      [CHECKS]: {
        etag: '"c1"',
        body: { check_runs: [{ status: 'completed', conclusion: 'success' }] },
      },
      [REVIEWS]: { etag: '"r1"', body: [] },
    });
    const emit = vi.fn(async () => true);

    await cycle(github.get, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(redis, {
      tenantId: TENANT,
      spaceId: SPACE,
      subject: SUBJECT,
      change: 'checks_green',
      url: 'https://github.com/aflowai/aflow/pull/276',
      headSha: 'abc123',
    });
    expect(github.requests.map((r) => r.etag)).toEqual([undefined, undefined, undefined]);

    // Not due again until a cadence has passed.
    clock += PULL_REQUEST_POLL_CADENCE_MS - 1;
    await cycle(github.get, emit);
    expect(github.requests).toHaveLength(3);

    clock += 1;
    await cycle(github.get, emit);
    expect(github.requests.slice(3).map((r) => r.etag)).toEqual(['"p1"', '"c1"', '"r1"']);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('reaches the wait primitive through the entity event it emits', async () => {
    await arm();
    const github = fakeGitHub({
      [PULL]: { etag: '"p1"', body: pull({ mergeable_state: 'dirty' }) },
      [CHECKS]: { etag: '"c1"', body: { check_runs: [] } },
      [STATUS]: { etag: '"s1"', body: { state: 'pending', total_count: 0, statuses: [] } },
      [REVIEWS]: { etag: '"r1"', body: [] },
    });

    await runPullRequestEventsCycle({ redis, get: github.get, logger, now: () => clock }, ctx);

    expect(
      await readRecordedWaitEvent(redis, {
        tenantId: TENANT,
        spaceId: SPACE,
        kind: 'pull_request.changed',
        subject: SUBJECT,
      }),
    ).toMatchObject({ detail: { change: 'conflicting' } });
  });

  it('clears the candidate on a close, and reads nothing more of it', async () => {
    await arm();
    const github = fakeGitHub({ [PULL]: { etag: '"p1"', body: pull({ state: 'closed' }) } });
    const emit = vi.fn(async () => true);

    await cycle(github.get, emit);

    expect(emit).toHaveBeenCalledWith(redis, expect.objectContaining({ change: 'closed' }));
    expect(await countPullRequestWatches(redis)).toBe(0);
    expect(github.requests).toHaveLength(1);
  });

  it('keeps what it read when an event does not land, so the next poll reports it again', async () => {
    await arm();
    const github = fakeGitHub({
      [PULL]: { etag: '"p1"', body: pull() },
      [CHECKS]: {
        etag: '"c1"',
        body: { check_runs: [{ status: 'completed', conclusion: 'success' }] },
      },
      [REVIEWS]: { etag: '"r1"', body: [] },
    });
    const lost = vi.fn(async () => false);
    await cycle(github.get, lost);

    clock += PULL_REQUEST_POLL_CADENCE_MS;
    const emit = vi.fn(async () => true);
    await cycle(github.get, emit);
    expect(emit).toHaveBeenCalledWith(redis, expect.objectContaining({ change: 'checks_green' }));
  });
});

describe('checks a repository reports outside one page of check runs', () => {
  it('reads green from the combined status where the head has no check runs', async () => {
    await arm();
    const github = fakeGitHub({
      [PULL]: { etag: '"p1"', body: pull() },
      [CHECKS]: { etag: '"c1"', body: { total_count: 0, check_runs: [] } },
      [STATUS]: {
        etag: '"s1"',
        body: {
          state: 'success',
          total_count: 2,
          statuses: [{ state: 'success' }, { state: 'success' }],
        },
      },
      [REVIEWS]: { etag: '"r1"', body: [] },
    });
    const emit = vi.fn(async () => true);

    await cycle(github.get, emit);

    expect(emit).toHaveBeenCalledWith(redis, expect.objectContaining({ change: 'checks_green' }));
    expect(github.requests.map((r) => r.path)).toContain(STATUS);

    // The next poll sends the status's ETag back, and an unchanged head reports nothing new.
    clock += PULL_REQUEST_POLL_CADENCE_MS;
    await cycle(github.get, emit);
    expect(github.requests.find((r) => r.path === STATUS && r.etag === '"s1"')).toBeDefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('reads green from the combined status past 100 check runs', async () => {
    await arm();
    const github = fakeGitHub({
      [PULL]: { etag: '"p1"', body: pull() },
      [CHECKS]: { etag: '"c1"', body: { total_count: 150, check_runs: passing(100) } },
      [STATUS]: { etag: '"s1"', body: { state: 'success', total_count: 1, statuses: [{}] } },
      [REVIEWS]: { etag: '"r1"', body: [] },
    });
    const emit = vi.fn(async () => true);

    await cycle(github.get, emit);

    expect(emit).toHaveBeenCalledWith(redis, expect.objectContaining({ change: 'checks_green' }));
  });

  it('does not read green past 100 check runs while the combined status is pending', async () => {
    await arm();
    const github = fakeGitHub({
      [PULL]: { etag: '"p1"', body: pull() },
      [CHECKS]: { etag: '"c1"', body: { total_count: 150, check_runs: passing(100) } },
      [STATUS]: { etag: '"s1"', body: { state: 'pending', total_count: 1, statuses: [{}] } },
      [REVIEWS]: { etag: '"r1"', body: [] },
    });
    const emit = vi.fn(async () => true);

    await cycle(github.get, emit);

    expect(emit).not.toHaveBeenCalled();
  });

  it('asks for no combined status where one page of check runs decides', async () => {
    await arm();
    const github = fakeGitHub({
      [PULL]: { etag: '"p1"', body: pull() },
      [CHECKS]: { etag: '"c1"', body: { total_count: 2, check_runs: passing(2) } },
      [REVIEWS]: { etag: '"r1"', body: [] },
    });

    await cycle(github.get);

    expect(github.requests.map((r) => r.path)).not.toContain(STATUS);
  });
});

describe('a change whose event did not land', () => {
  it('is sent again at the next poll, and the changes that landed are not', async () => {
    await arm();
    const github = fakeGitHub({
      [PULL]: { etag: '"p1"', body: pull({ mergeable_state: 'dirty' }) },
      [CHECKS]: { etag: '"c1"', body: { total_count: 1, check_runs: passing(1) } },
      [REVIEWS]: { etag: '"r1"', body: [] },
    });
    let refuse = true;
    const emit = vi.fn(async (_redis: unknown, params: { change: string }) =>
      params.change === 'conflicting' && refuse ? false : true,
    );

    expect(await cycle(github.get, emit as never)).toMatchObject({ candidates: 1, failed: 1 });
    expect(emit.mock.calls.map(([, params]) => params.change)).toEqual([
      'checks_green',
      'conflicting',
    ]);

    refuse = false;
    clock += PULL_REQUEST_POLL_CADENCE_MS;
    expect(await cycle(github.get, emit as never)).toMatchObject({ candidates: 1, processed: 1 });
    expect(github.requests.slice(3).map((r) => r.etag)).toEqual(['"p1"', '"c1"', '"r1"']);
    expect(emit.mock.calls.slice(2).map(([, params]) => params.change)).toEqual(['conflicting']);

    clock += PULL_REQUEST_POLL_CADENCE_MS;
    await cycle(github.get, emit as never);
    expect(emit).toHaveBeenCalledTimes(3);
  });
});

describe('a watch whose polls keep failing', () => {
  it('keeps its lifetime as it stands, and is dropped once that lapses', async () => {
    await arm();
    const key = PULL_REQUEST_WATCH_KEY({ tenantId: TENANT, spaceId: SPACE, subject: SUBJECT });
    await redis.pexpire(key, 300);
    let requests = 0;
    const failing: GitHubConditionalGet = async () => {
      requests++;
      throw new Error('GitHub answered 502');
    };

    expect(await cycle(failing)).toMatchObject({ candidates: 1, failed: 1 });
    const left = await redis.pttl(key);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(300);

    await new Promise((resolve) => setTimeout(resolve, 350));
    clock += PULL_REQUEST_POLL_CADENCE_MS;
    expect(await cycle(failing)).toEqual({ candidates: 0 });
    expect(requests).toBe(1);
    expect(await countPullRequestWatches(redis)).toBe(0);
  });
});

describe('what a poll reads', () => {
  const snapshot = (overrides: Partial<Parameters<typeof pullRequestChanges>[1]> = {}) => ({
    pull: { state: 'open' as const, merged: false, mergeableState: 'blocked', headSha: 'a' },
    checks: 'pending' as const,
    changesRequested: false,
    ...overrides,
  });

  it('names checks going green again on a new head', () => {
    const before = snapshot({ checks: 'green' });
    expect(pullRequestChanges(before, snapshot({ checks: 'green' }))).toEqual([]);
    expect(
      pullRequestChanges(
        before,
        snapshot({ checks: 'green', pull: { ...before.pull, headSha: 'b' } }),
      ),
    ).toEqual(['checks_green']);
  });

  it('names a conflict and a request for changes once each', () => {
    const after = snapshot({
      pull: { state: 'open', merged: false, mergeableState: 'dirty', headSha: 'a' },
      changesRequested: true,
    });
    expect(pullRequestChanges(snapshot(), after)).toEqual(['conflicting', 'changes_requested']);
    expect(pullRequestChanges(after, after)).toEqual([]);
  });

  it('reads checks green only when every run completed and none failed', () => {
    expect(parseChecksState({ check_runs: [] })).toBe('none');
    expect(
      parseChecksState({
        check_runs: [
          { status: 'completed', conclusion: 'success' },
          { status: 'in_progress', conclusion: null },
        ],
      }),
    ).toBe('pending');
    expect(parseChecksState({ check_runs: [{ status: 'completed', conclusion: 'failure' }] })).toBe(
      'red',
    );
  });

  it("reads a reviewer's latest deciding review", () => {
    const review = (login: string, state: string) => ({ user: { login }, state });
    expect(parseChangesRequested([review('a', 'CHANGES_REQUESTED'), review('a', 'APPROVED')])).toBe(
      false,
    );
    expect(
      parseChangesRequested([review('a', 'CHANGES_REQUESTED'), review('a', 'COMMENTED')]),
    ).toBe(true);
  });
});
