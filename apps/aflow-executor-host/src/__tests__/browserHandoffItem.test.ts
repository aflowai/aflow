/**
 * A hand-off in the Action Center, from the machine's side: the record is there
 * while the run waits and gone when the wait ends, however it ends, and the
 * operator's Done ends the wait as `completed`.
 */
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { readSpaceBrowserHandoffs } from '@aflow/redis';
import { type BrowserHandoffOutcome, type BrowserProfile, StreamKeys } from '@aflow/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRedisHandoffBoard, registrableSite } from '../browser/handoffBoard.js';
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
      hostname: 'laptop',
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
