/**
 * A hand-off in the Action Center, from the machine's side: the record is there
 * while the run waits and gone when the wait ends, however it ends, and the
 * operator's Done ends the wait as `completed`.
 */
import { hostname } from 'node:os';

import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import {
  browserHandoffKey,
  browserHandoffMachineIndexKey,
  joinBrowserHandoff,
  readSpaceBrowserHandoffs,
} from '@aflow/redis';
import {
  BrowserHandoffOriginSchema,
  type BrowserHandoffOutcome,
  type BrowserProfile,
  StreamKeys,
} from '@aflow/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearHandoffsLeftBehind,
  createRedisHandoffBoard,
  registrableSite,
  startHandoffBoard,
} from '../browser/handoffBoard.js';
import { type HandoffWait, waitInWindow, type WaitForOperator } from '../browser/operatorWindow.js';
import { harness, type Harness, profile, refusal, RUN_A } from './fixtures/fakeBrowser.js';

const LOGIN = 'https://accounts.example.com/login';
const STEP = 'step-a';

let redis: Redis;
let subscriber: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  subscriber = redis.duplicate();
  await redis.flushall();
});

afterEach(() => {
  subscriber.disconnect();
  redis.disconnect();
});

function world(waitForOperator?: WaitForOperator, browsers?: BrowserProfile[]): Harness {
  return harness({
    handoffs: createRedisHandoffBoard({
      redis,
      subscriber,
      machine: 'laptop',
      log: { warn: () => undefined },
    }),
    ...(waitForOperator !== undefined ? { waitForOperator } : {}),
    ...(browsers !== undefined ? { browsers } : {}),
  });
}

async function openLogin(h: Harness): Promise<string> {
  return (await h.driver.open({ ...RUN_A, redelivered: false, profileId: 'default', url: LOGIN }))
    .pageId;
}

const handOver = (h: Harness, pageId: string) =>
  h.driver.handoff({
    ...RUN_A,
    stepExecutionId: STEP,
    sessionId: RUN_A.runId,
    pageId,
    reason: 'sign_in',
    message: 'Sign in to the mail account; the run then reads the inbox.',
  });

const openItems = () => readSpaceBrowserHandoffs(redis, RUN_A.tenantId, RUN_A.spaceId);

describe('a hand-off in the Action Center', () => {
  it('is there while the run waits, under the profile and the page’s site', async () => {
    let seen: Awaited<ReturnType<typeof openItems>> = [];
    const h = world(async () => {
      seen = await openItems();
      return 'window_closed';
    });
    await handOver(h, await openLogin(h));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      hostname: 'laptop',
      profileId: 'default',
      site: 'example.com',
      reason: 'sign_in',
      message: 'Sign in to the mail account; the run then reads the inbox.',
    });
    expect(seen[0]?.waiting).toEqual([
      expect.objectContaining({ runId: RUN_A.runId, stepExecutionId: STEP, sessionId: 'run-a' }),
    ]);
  });

  it.each<BrowserHandoffOutcome>(['completed', 'window_closed', 'timed_out'])(
    'is gone once the wait ends %s',
    async (outcome) => {
      let during = 0;
      const h = world(async () => {
        during = (await openItems()).length;
        return outcome;
      });
      const result = await handOver(h, await openLogin(h));

      expect(result.outcome).toBe(outcome);
      expect(during).toBe(1);
      expect(await openItems()).toEqual([]);
    },
  );

  it('is gone when the wait fails, too', async () => {
    const h = world(async () => {
      expect(await openItems()).toHaveLength(1);
      throw new Error('the window went away');
    });
    const failed = await refusal(handOver(h, await openLogin(h)));

    expect(failed.kind).toBe('window_failed');
    expect(await openItems()).toEqual([]);
  });

  it('ends the wait as completed when the operator presses Done, and stops listening after', async () => {
    const channel = StreamKeys.browserHandoffDoneChannel(STEP);
    // The window's own wait, with a clock that does not move, so nothing but
    // Done can end it: the page stays on the sign-in site and the window open.
    const h = world((wait: HandoffWait) => {
      void redis.publish(channel, JSON.stringify({ resolvedBy: 'u1' }));
      return waitInWindow({
        ...wait,
        clock: {
          now: () => wait.clock.now(),
          sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
        },
      });
    });
    const result = await handOver(h, await openLogin(h));

    expect(result.outcome).toBe('completed');
    expect(await openItems()).toEqual([]);
    expect(await redis.publish(channel, 'late')).toBe(0);
  });

  it('lists one run: a second hand-off of the same site while the window is shown is refused', async () => {
    const meanwhile: { second?: () => Promise<string> } = {};
    let second: string | undefined;
    let listed: Awaited<ReturnType<typeof openItems>> = [];
    // A window already on screen, so showing it closes no page of the second run.
    const h = world(async () => {
      second = await meanwhile.second?.();
      listed = await openItems();
      return 'window_closed';
    }, [profile({ window: 'visible' })]);
    const mine = await openLogin(h);
    const other = await openLogin(h);
    meanwhile.second = async () =>
      (
        await refusal(
          h.driver.handoff({
            ...RUN_A,
            stepExecutionId: 'step-b',
            sessionId: RUN_A.runId,
            pageId: other,
            reason: 'sign_in',
            message: 'Sign in to the mail account.',
          }),
        )
      ).kind;
    await handOver(h, mine);

    expect(second).toBe('window_shown');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.waiting.map((waiter) => waiter.stepExecutionId)).toEqual([STEP]);
  });
});

describe('the site a hand-off is shared by', () => {
  it('is the registrable host, so one sign-in serves the site’s other hosts', () => {
    expect(registrableSite('https://accounts.example.com/login')).toBe('example.com');
    expect(registrableSite('https://mail.example.com/inbox')).toBe('example.com');
    expect(registrableSite('https://www.shop.example.co.uk/basket')).toBe('example.co.uk');
  });

  it('is the host itself where there is no registrable one', () => {
    expect(registrableSite('http://127.0.0.1:8080/')).toBe('127.0.0.1');
    expect(registrableSite('http://localhost:3001/')).toBe('localhost');
  });
});

describe('a page that is not on a site', () => {
  const NOWHERE = [
    'about:blank',
    'data:text/html,<form><input type=password></form>',
    'file:///Users/operator/Downloads/login.html',
  ];

  it.each(NOWHERE)(
    'is not handed over from %s, and nothing reaches the Action Center',
    async (at) => {
      let waited = false;
      const h = world(async () => {
        waited = true;
        return 'window_closed';
      });
      const pageId = await openLogin(h);
      const page = h.pages.at(-1);
      if (page === undefined) throw new Error('the run opened no page');
      page.current = at;
      const launches = h.launches.length;

      const refused = await refusal(handOver(h, pageId));

      expect(refused.kind).toBe('no_site');
      expect(refused.message).toContain('the operator cannot sign in to a page that has no site');
      expect(waited).toBe(false);
      expect(h.launches).toHaveLength(launches);
      expect(await openItems()).toEqual([]);
      expect(await redis.zcard(browserHandoffMachineIndexKey('laptop'))).toBe(0);
    },
  );

  it.each([...NOWHERE, 'javascript:void(0)', 'not an address'])('has no site: %s', (at) => {
    expect(registrableSite(at)).toBeUndefined();
  });
});

describe('the site a record carries', () => {
  const longLabel = 'a'.repeat(63);
  const longHost = `${[longLabel, longLabel, longLabel, longLabel, longLabel].join('.')}.com`;

  it('is a host no longer than the Action Center item allows, or none at all', () => {
    const site = BrowserHandoffOriginSchema.shape.site;
    for (const at of [
      `https://${longHost}/login`,
      `https://${'b'.repeat(300)}/`,
      `blob:https://${longHost}/1b4e28ba`,
      `data:text/html,${'x'.repeat(10_000)}`,
      'https://accounts.example.com/login',
    ]) {
      const named = registrableSite(at);
      if (named !== undefined) expect(site.safeParse(named).success).toBe(true);
    }
    expect(registrableSite(`https://${longHost}/login`)).toBeUndefined();
  });

  it('is the site that made a blob: page', () => {
    expect(registrableSite('blob:https://mail.example.com/1b4e28ba')).toBe('example.com');
  });

  it('is never written longer than that, whoever asks', async () => {
    const site = 'c'.repeat(254);
    const startedAt = Date.now();
    await expect(
      joinBrowserHandoff(redis, {
        hostname: 'laptop',
        profileId: 'default',
        site,
        reason: 'sign_in',
        message: 'Sign in.',
        startedAt,
        waiter: { ...RUN_A, stepExecutionId: STEP, deadlineAt: startedAt + 60_000 },
      }),
    ).rejects.toThrow(/253/);
    expect(await redis.exists(browserHandoffKey('laptop', 'default', site))).toBe(0);
    expect(await openItems()).toEqual([]);
  });
});

describe('the hand-offs a previous run of the executor left', () => {
  it('are taken down when the executor starts, and their spaces told', async () => {
    const startedAt = Date.now();
    const leftBehind = {
      profileId: 'default',
      reason: 'sign_in' as const,
      message: 'Sign in to the mail account.',
      startedAt,
      waiter: { ...RUN_A, stepExecutionId: STEP, deadlineAt: startedAt + 15 * 60_000 },
    };
    await joinBrowserHandoff(redis, { ...leftBehind, hostname: 'laptop', site: 'example.com' });
    await joinBrowserHandoff(redis, { ...leftBehind, hostname: 'desktop', site: 'example.com' });
    expect(await openItems()).toHaveLength(2);
    const wakes: string[] = [];
    await subscriber.subscribe(StreamKeys.actionCenterWakeChannel(RUN_A.tenantId, RUN_A.spaceId));
    subscriber.on('message', (channel: string) => wakes.push(channel));
    const info: string[] = [];

    await clearHandoffsLeftBehind({
      redis,
      machine: 'laptop',
      log: { warn: () => undefined, info: (message) => info.push(message) },
    });

    expect((await openItems()).map((item) => item.hostname)).toEqual(['desktop']);
    expect(await redis.exists(browserHandoffKey('laptop', 'default', 'example.com'))).toBe(0);
    expect(await redis.zcard(browserHandoffMachineIndexKey('laptop'))).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wakes).toHaveLength(1);
    expect(info).toHaveLength(1);
  });

  it('leave nothing to say when there were none', async () => {
    const info: string[] = [];
    await clearHandoffsLeftBehind({
      redis,
      machine: 'laptop',
      log: { warn: () => undefined, info: (message) => info.push(message) },
    });
    expect(info).toEqual([]);
  });

  it('are found by a restarted executor, whose pid and process name are new', async () => {
    const pid = Object.getOwnPropertyDescriptor(process, 'pid');
    const asProcess = async (processPid: number, processName: string | undefined) => {
      Object.defineProperty(process, 'pid', { value: processPid, configurable: true });
      if (processName === undefined) vi.stubEnv('HOSTNAME', undefined);
      else vi.stubEnv('HOSTNAME', processName);
      return await startHandoffBoard({
        redis,
        subscriber,
        log: { warn: () => undefined, info: () => undefined },
      });
    };
    try {
      const first = await asProcess(4101, undefined);
      await first.post({
        ...RUN_A,
        stepExecutionId: STEP,
        profileId: 'default',
        site: 'example.com',
        reason: 'sign_in',
        message: 'Sign in to the mail account.',
        waitMs: 15 * 60_000,
      });
      expect(await openItems()).toHaveLength(1);

      await asProcess(4102, 'executor-after-restart');

      expect(await openItems()).toEqual([]);
      expect(await redis.zcard(browserHandoffMachineIndexKey(hostname()))).toBe(0);
    } finally {
      if (pid !== undefined) Object.defineProperty(process, 'pid', pid);
      vi.unstubAllEnvs();
    }
  });
});
