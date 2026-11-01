/**
 * Who holds a watched pull request (Plan 339 D4) and what its polls read are
 * written by different parties: the publication's arm and the owner's
 * disown on one side, the poll cycle's save on the other. The save writes
 * from the copy it claimed a poll earlier, so it must not undo an owner change
 * made since, and an owner change must not put back an older poll.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  PULL_REQUEST_WATCH_KEY,
  armPullRequestWatch,
  claimDuePullRequestWatches,
  disownPullRequestWatch,
  readPullRequestWatch,
  savePullRequestWatch,
  type PullRequestWatch,
} from '../pullRequestWatch.js';

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';
const SUBJECT = 'aflowai/aflow#276';
const REF = { tenantId: TENANT, spaceId: SPACE, subject: SUBJECT };
const OWNER = 'c0ffee00-0000-4000-8000-000000000339';
const NEXT_OWNER = 'b0b00000-0000-4000-8000-000000000339';
const T0 = 1_800_000_000_000;

const ARM = {
  ...REF,
  owner: 'aflowai',
  repo: 'aflow',
  number: 276,
  url: 'https://github.com/AflowAI/Aflow/pull/276',
  armedAt: T0,
};

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

async function claimed(): Promise<PullRequestWatch> {
  const [watch] = await claimDuePullRequestWatches(redis, T0 + 1, 10, 60_000);
  if (!watch) throw new Error('nothing was claimed');
  return watch;
}

function polled(watch: PullRequestWatch, headSha: string): PullRequestWatch {
  return {
    ...watch,
    pull: {
      etag: `"${headSha}"`,
      value: { state: 'open', merged: false, mergeableState: 'clean', headSha },
    },
  };
}

describe("a poll's save", () => {
  it('does not put back an owner a disown cleared after the poll claimed the watch', async () => {
    await armPullRequestWatch(redis, { ...ARM, ownerSessionId: OWNER, bindingId: 'hb_aflow' });
    const watch = await claimed();
    expect(watch.ownerSessionId).toBe(OWNER);

    await disownPullRequestWatch(redis, REF, OWNER);
    await savePullRequestWatch(redis, polled(watch, 'a'.repeat(40)), T0 + 60_000);

    const saved = await readPullRequestWatch(redis, REF);
    expect(saved?.ownerSessionId).toBeUndefined();
    expect(saved?.bindingId).toBe('hb_aflow');
    expect(saved?.pull?.value.headSha).toBe('a'.repeat(40));
  });

  it('does not drop an owner an arm named after the poll claimed the watch', async () => {
    await armPullRequestWatch(redis, ARM);
    const watch = await claimed();
    expect(watch.ownerSessionId).toBeUndefined();

    await armPullRequestWatch(redis, { ...ARM, ownerSessionId: NEXT_OWNER });
    await savePullRequestWatch(redis, polled(watch, 'a'.repeat(40)), T0 + 60_000);

    expect((await readPullRequestWatch(redis, REF))?.ownerSessionId).toBe(NEXT_OWNER);
  });

  it('writes no owner into the record its polls own', async () => {
    await armPullRequestWatch(redis, { ...ARM, ownerSessionId: OWNER });
    await savePullRequestWatch(redis, polled(await claimed(), 'a'.repeat(40)), T0 + 60_000);

    const record = JSON.parse((await redis.get(PULL_REQUEST_WATCH_KEY(REF))) ?? 'null') as Record<
      string,
      unknown
    >;
    expect(record).not.toHaveProperty('ownerSessionId');
    expect(record).not.toHaveProperty('bindingId');
  });
});

describe('an owner change', () => {
  it('leaves the newer poll a save wrote: a disown does not put back an older snapshot', async () => {
    await armPullRequestWatch(redis, { ...ARM, ownerSessionId: OWNER });
    const watch = await claimed();
    await savePullRequestWatch(redis, polled(watch, 'b'.repeat(40)), T0 + 60_000);

    await disownPullRequestWatch(redis, REF, OWNER);

    const read = await readPullRequestWatch(redis, REF);
    expect(read?.pull?.value.headSha).toBe('b'.repeat(40));
    expect(read?.ownerSessionId).toBeUndefined();
  });

  it('leaves what the polls read when the pull request is armed again', async () => {
    await armPullRequestWatch(redis, ARM);
    await savePullRequestWatch(redis, polled(await claimed(), 'b'.repeat(40)), T0 + 60_000);

    await armPullRequestWatch(redis, { ...ARM, armedAt: T0 + 5, ownerSessionId: OWNER });

    const read = await readPullRequestWatch(redis, REF);
    expect(read?.pull?.value.headSha).toBe('b'.repeat(40));
    expect(read?.ownerSessionId).toBe(OWNER);
  });

  it('forgets an owner only where it is still the one named', async () => {
    await armPullRequestWatch(redis, { ...ARM, ownerSessionId: OWNER });
    await armPullRequestWatch(
      redis,
      { ...ARM, ownerSessionId: NEXT_OWNER },
      {
        replacingOwner: OWNER,
      },
    );

    await disownPullRequestWatch(redis, REF, OWNER);

    expect((await readPullRequestWatch(redis, REF))?.ownerSessionId).toBe(NEXT_OWNER);
  });

  it('takes the pull request from a recorded owner only where the arm names it as replaced', async () => {
    await armPullRequestWatch(redis, { ...ARM, ownerSessionId: OWNER });

    await armPullRequestWatch(redis, { ...ARM, ownerSessionId: NEXT_OWNER });
    expect((await readPullRequestWatch(redis, REF))?.ownerSessionId).toBe(OWNER);

    await armPullRequestWatch(
      redis,
      { ...ARM, ownerSessionId: NEXT_OWNER },
      {
        replacingOwner: 'e0000000-0000-4000-8000-000000000339',
      },
    );
    expect((await readPullRequestWatch(redis, REF))?.ownerSessionId).toBe(OWNER);

    await armPullRequestWatch(
      redis,
      { ...ARM, ownerSessionId: NEXT_OWNER },
      {
        replacingOwner: OWNER,
      },
    );
    expect((await readPullRequestWatch(redis, REF))?.ownerSessionId).toBe(NEXT_OWNER);
  });
});
