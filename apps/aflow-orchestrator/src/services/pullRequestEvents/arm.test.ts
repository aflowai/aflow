/**
 * A completed publication arms the pull request its output names (Plan 339
 * D2), as the subject a wait names it by. Any other run, a publication that
 * did not complete and one that names no pull request arm nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  PULL_REQUEST_WATCH_KEY,
  countPullRequestWatches,
  listSpacePullRequestSubjects,
} from '@aflow/redis';
import { PLAN_STREAM_PUBLICATION_SLUG, RUN_PULL_REQUEST_URL_OUTPUT } from '@aflow/schemas';
import type { WorkflowRunDetail } from '@aflow/cybernetic-runtime';
import type { HarnessDeps } from '../cybernetic/harness/types.js';

const { buildResult, live } = vi.hoisted(() => ({ buildResult: vi.fn(), live: vi.fn() }));
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/cybernetic-runtime')>()),
  buildWorkflowRunResult: buildResult,
  isLiveConversation: (_db: unknown, _tenantId: string, sessionId: string) =>
    live(sessionId) as Promise<boolean>,
}));
const { armPullRequestOnPublication } = await import('./arm.js');

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const URL = 'https://github.com/AflowAI/Aflow/pull/276';
const T0 = 1_800_000_000_000;

let redis: Redis;
let deps: HarnessDeps;

function run(workflowSlug = PLAN_STREAM_PUBLICATION_SLUG): WorkflowRunDetail {
  return { workflowSlug, spaceId: SPACE } as unknown as WorkflowRunDetail;
}

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  deps = { redis, db: {}, payloadStore: {} } as unknown as HarnessDeps;
  buildResult.mockReset();
  buildResult.mockResolvedValue({ output: { [RUN_PULL_REQUEST_URL_OUTPUT]: URL } });
  live.mockReset().mockResolvedValue(false);
});

const REF = { tenantId: TENANT, spaceId: SPACE, subject: 'aflowai/aflow#276' };
const STARTER = 'e0000000-0000-4000-8000-000000000339';

function startedRun(): WorkflowRunDetail {
  return { ...run(), sessionId: STARTER } as unknown as WorkflowRunDetail;
}

describe('a completed publication', () => {
  it('arms the pull request its output names, under the subject a wait names', async () => {
    expect(await armPullRequestOnPublication(deps, TENANT, run(), 'completed', T0)).toBe('armed');

    const stored = await redis.get(
      PULL_REQUEST_WATCH_KEY({ tenantId: TENANT, spaceId: SPACE, subject: 'aflowai/aflow#276' }),
    );
    expect(JSON.parse(stored ?? 'null')).toMatchObject({
      owner: 'aflowai',
      repo: 'aflow',
      number: 276,
      subject: 'aflowai/aflow#276',
      url: URL,
      armedAt: T0,
    });
  });

  it('arms and indexes the pull request with no owner where the owner cannot be read', async () => {
    live.mockRejectedValue(new Error('connection reset'));

    expect(await armPullRequestOnPublication(deps, TENANT, startedRun(), 'completed', T0)).toBe(
      'armed',
    );
    const stored = JSON.parse((await redis.get(PULL_REQUEST_WATCH_KEY(REF))) ?? 'null') as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({ subject: REF.subject });
    expect(stored).not.toHaveProperty('ownerSessionId');
    expect(await listSpacePullRequestSubjects(redis, REF, 10)).toEqual([REF.subject]);
  });

  it("keeps the arm where the owner's wait cannot be declared", async () => {
    live.mockResolvedValueOnce(true).mockRejectedValue(new Error('connection reset'));

    expect(await armPullRequestOnPublication(deps, TENANT, startedRun(), 'completed', T0)).toBe(
      'armed',
    );
    expect(JSON.parse((await redis.get(PULL_REQUEST_WATCH_KEY(REF))) ?? 'null')).toMatchObject({
      ownerSessionId: STARTER,
    });
    expect(await listSpacePullRequestSubjects(redis, REF, 10)).toEqual([REF.subject]);
  });

  it('arms nothing where its output names no pull request', async () => {
    buildResult.mockResolvedValue({ output: {} });

    expect(await armPullRequestOnPublication(deps, TENANT, run(), 'completed', T0)).toBe(
      'no_pull_request',
    );
    expect(await countPullRequestWatches(redis)).toBe(0);
  });
});

describe('any other run', () => {
  it('arms nothing for a publication that did not complete, or a run of another skill', async () => {
    expect(await armPullRequestOnPublication(deps, TENANT, run(), 'failed', T0)).toBe(
      'not_a_publication',
    );
    expect(
      await armPullRequestOnPublication(deps, TENANT, run('commission-change'), 'completed', T0),
    ).toBe('not_a_publication');

    expect(buildResult).not.toHaveBeenCalled();
    expect(await countPullRequestWatches(redis)).toBe(0);
  });
});
