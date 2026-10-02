/**
 * What an edit to the machine's policy does to browsers already running and
 * the pages in them, and what a page in a profile the run may no longer use
 * answers before that edit has been applied.
 */
import type { BrowserProfile } from '@aflow/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAGE_CLOSE_DEADLINE_MS } from '../browser/pageTable.js';
import { followPolicy } from '../policyWatch.js';
import { CHROME, harness, profile, refusal, RUN_A, RUN_B } from './fixtures/fakeBrowser.js';

const RUN_ELSEWHERE = { tenantId: 't1', runId: 'run-c', spaceId: 'space-2' };

function policyOf(profiles: BrowserProfile[]) {
  return {
    browsers: new Map(profiles.map((p) => [p.id, p])),
    invalidBrowsers: new Map(),
    chrome: CHROME,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Holds every launch of the harness's browser until the returned function is called. */
function holdLaunch(h: ReturnType<typeof harness>): () => void {
  let release: () => void = () => undefined;
  h.launchHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

function opening(
  h: ReturnType<typeof harness>,
  run: { tenantId: string; runId: string; spaceId: string },
  profileId: string,
) {
  return h.driver.open({ ...run, redelivered: false, profileId, url: 'https://shop.example.com/' });
}

async function openIn(
  h: ReturnType<typeof harness>,
  run: { tenantId: string; runId: string; spaceId: string },
  profileId: string,
): Promise<string> {
  const opened = await h.driver.open({
    ...run,
    redelivered: false,
    profileId,
    url: 'https://shop.example.com/',
  });
  return opened.pageId;
}

describe('a policy change', () => {
  it('stops the browser of a profile removed from the policy and leaves none of its pages', async () => {
    const work = profile({ id: 'work' });
    const personal = profile({ id: 'personal' });
    const h = harness({ browsers: [work, personal] });
    const workPage = await openIn(h, RUN_A, 'work');
    const personalPage = await openIn(h, RUN_B, 'personal');

    h.setProfiles([personal]);
    await h.driver.policyChanged(policyOf([personal]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.stops).toHaveLength(1);
    expect(h.driver.runningProfileCount()).toBe(1);
    expect(h.proxies.map((p) => p.stopped)).toEqual([true, false]);
    expect((await refusal(h.driver.snapshot(RUN_A, workPage))).kind).toBe('page_gone');
    expect(await h.driver.list(RUN_A)).toEqual([]);
    expect((await h.driver.list(RUN_B)).map((p) => p.pageId)).toEqual([personalPage]);
  });

  it('closes exactly the pages of the spaces a profile no longer serves', async () => {
    const h = harness({ browsers: [profile({ spaces: ['space-1', 'space-2'] })] });
    const kept = await openIn(h, RUN_A, 'default');
    const alsoKept = await openIn(h, RUN_B, 'default');
    const closed = await openIn(h, RUN_ELSEWHERE, 'default');

    const narrowed = profile({ spaces: ['space-1'] });
    h.setProfiles([narrowed]);
    await h.driver.policyChanged(policyOf([narrowed]));

    expect(h.pages.map((page) => page.closed)).toEqual([false, false, true]);
    expect(h.stops).toEqual([]);
    expect((await h.driver.list(RUN_A)).map((p) => p.pageId)).toEqual([kept]);
    expect((await h.driver.list(RUN_B)).map((p) => p.pageId)).toEqual([alsoKept]);
    expect((await refusal(h.driver.snapshot(RUN_ELSEWHERE, closed))).kind).toBe('page_gone');
  });
});

describe('a page whose profile was just revoked', () => {
  it('is refused by snapshot and read as navigate refuses it, and is not listed', async () => {
    const h = harness();
    const pageId = await openIn(h, RUN_A, 'default');
    h.setProfiles([profile({ spaces: ['space-2'] })]);

    const moving = await refusal(
      h.driver.navigate({
        ...RUN_A,
        pageId,
        to: { kind: 'url', url: 'https://shop.example.com/2' },
        redelivered: false,
      }),
    );
    const looking = await refusal(h.driver.snapshot(RUN_A, pageId));
    const reading = await refusal(h.driver.readPage(RUN_A, pageId, 'text'));

    expect(moving.kind).toBe('profile_not_for_space');
    expect([looking.kind, looking.message]).toEqual([moving.kind, moving.message]);
    expect([reading.kind, reading.message]).toEqual([moving.kind, moving.message]);
    expect(await h.driver.list(RUN_A)).toEqual([]);

    h.setProfiles([profile({ id: 'other' })]);
    expect((await refusal(h.driver.snapshot(RUN_A, pageId))).kind).toBe('unknown_profile');
  });
});

describe('a policy change while a browser is starting', () => {
  it('stops a browser whose profile was removed as it started, and refuses the open waiting on it', async () => {
    const work = profile({ id: 'work' });
    const personal = profile({ id: 'personal' });
    const h = harness({ browsers: [work, personal] });
    const launched = holdLaunch(h);
    const open = opening(h, RUN_A, 'work');
    await settle();
    expect(h.launches).toHaveLength(1);

    h.setProfiles([personal]);
    await h.driver.policyChanged(policyOf([personal]));
    launched();

    expect((await refusal(open)).kind).toBe('unknown_profile');
    expect(h.pages).toEqual([]);
    expect(h.stops).toHaveLength(1);
    expect(h.proxies.map((p) => p.stopped)).toEqual([true]);
    expect(h.driver.runningProfileCount()).toBe(0);
    expect(await h.driver.list(RUN_A)).toEqual([]);
  });

  it('refuses the open from a space the profile stopped serving and keeps the one it still serves', async () => {
    const h = harness({ browsers: [profile({ spaces: ['space-1', 'space-2'] })] });
    const launched = holdLaunch(h);
    const fromRemoved = opening(h, RUN_ELSEWHERE, 'default');
    const fromKept = opening(h, RUN_A, 'default');
    await settle();

    const narrowed = profile({ spaces: ['space-1'] });
    h.setProfiles([narrowed]);
    await h.driver.policyChanged(policyOf([narrowed]));
    launched();

    expect((await refusal(fromRemoved)).kind).toBe('profile_not_for_space');
    const kept = await fromKept;
    expect(kept.outcome).toBe('performed');
    expect(h.launches).toHaveLength(1);
    expect(h.pages).toHaveLength(1);
    expect(h.stops).toEqual([]);
    expect(await h.driver.list(RUN_ELSEWHERE)).toEqual([]);
    expect((await h.driver.list(RUN_A)).map((p) => p.pageId)).toEqual([kept.pageId]);
  });

  it('leaves the proxy on the rules the change brought, not the ones the open read', async () => {
    const h = harness();
    const launched = holdLaunch(h);
    const open = opening(h, RUN_A, 'default');
    await settle();

    const ruled = profile({ rules: [{ origin: '*.bank.example.org', effect: 'deny' }] });
    h.setProfiles([ruled]);
    await h.driver.policyChanged(policyOf([ruled]));
    launched();
    await open;

    expect(h.proxies).toHaveLength(1);
    expect(h.proxies[0]?.check('pay.bank.example.org', '')?.kind).toBe('rule');
  });

  it('answers a failed start with the refusal the change brought', async () => {
    const h = harness({ browsers: [profile({ spaces: ['space-1', 'space-2'] })] });
    const launched = holdLaunch(h);
    const open = opening(h, RUN_A, 'default');
    await settle();

    const narrowed = profile({ spaces: ['space-2'] });
    h.setProfiles([narrowed]);
    await h.driver.policyChanged(policyOf([narrowed]));
    h.launchFails = new Error('Chrome exited before it was ready (exit 21)');
    launched();

    expect((await refusal(open)).kind).toBe('profile_not_for_space');
  });

  it('answers a failed start with its own error when the policy cannot be read again', async () => {
    const h = harness({ browsers: [profile({ spaces: ['space-1', 'space-2'] })] });
    const launched = holdLaunch(h);
    const open = opening(h, RUN_A, 'default');
    await settle();

    const narrowed = profile({ spaces: ['space-2'] });
    h.setProfiles([narrowed]);
    await h.driver.policyChanged(policyOf([narrowed]));
    const launchFailure = new Error('Chrome exited before it was ready (exit 21)');
    h.launchFails = launchFailure;
    h.policyReadFails = new Error('host-policy.json: Unexpected end of JSON input');
    launched();

    await expect(open).rejects.toBe(launchFailure);
  });
});

describe('a page whose close never settles', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a policy change up only until the deadline', async () => {
    const h = harness({ browsers: [profile({ spaces: ['space-1', 'space-2'] })] });
    await openIn(h, RUN_A, 'default');
    const closed = await openIn(h, RUN_ELSEWHERE, 'default');
    const hung = h.pages[1];
    if (hung === undefined) throw new Error('expected the second page');
    hung.closeHangs = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const narrowed = profile({ spaces: ['space-1'] });
    h.setProfiles([narrowed]);
    let done = false;
    const changing = h.driver.policyChanged(policyOf([narrowed])).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(PAGE_CLOSE_DEADLINE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await changing;

    expect(done).toBe(true);
    expect((await refusal(h.driver.snapshot(RUN_ELSEWHERE, closed))).kind).toBe('page_gone');
  });

  it('is closed by its run at the deadline, and is no longer listed while the close hangs', async () => {
    const h = harness();
    const pageId = await openIn(h, RUN_A, 'default');
    const hung = h.pages[0];
    if (hung === undefined) throw new Error('expected the page');
    hung.closeHangs = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let answer: 'closed' | 'already_gone' | undefined;
    const closing = h.driver.close(RUN_A, pageId).then((result) => {
      answer = result;
    });
    await vi.advanceTimersByTimeAsync(PAGE_CLOSE_DEADLINE_MS - 1);
    expect(answer).toBeUndefined();
    expect(await h.driver.list(RUN_A)).toEqual([]);
    expect((await refusal(h.driver.snapshot(RUN_A, pageId))).kind).toBe('page_gone');
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(answer).toBe('closed');
    expect(await h.driver.list(RUN_A)).toEqual([]);
  });

  it('is forgotten by the idle sweep at once, and holds the sweep only until the deadline', async () => {
    const h = harness({ browsers: [profile({ idleMinutes: 1 })] });
    const pageId = await openIn(h, RUN_A, 'default');
    const hung = h.pages[0];
    if (hung === undefined) throw new Error('expected the page');
    hung.closeHangs = true;
    h.clock.now += 2 * 60_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let swept: { closedPages: number; stoppedProfiles: number } | undefined;
    const sweeping = h.driver.sweepIdle(10).then((result) => {
      swept = result;
    });
    await vi.advanceTimersByTimeAsync(PAGE_CLOSE_DEADLINE_MS - 1);
    expect(swept).toBeUndefined();
    expect(await h.driver.list(RUN_A)).toEqual([]);
    expect((await refusal(h.driver.snapshot(RUN_A, pageId))).kind).toBe('page_gone');
    await vi.advanceTimersByTimeAsync(1);
    await sweeping;

    expect(swept?.closedPages).toBe(1);
  });

  it('holds an open whose navigation failed only until the deadline', async () => {
    const h = harness({
      world: {
        failures: new Map([['https://shop.example.com/', 'net::ERR_CONNECTION_RESET']]),
        duringLoad: () => {
          const page = h.pages.at(-1);
          if (page !== undefined) page.closeHangs = true;
          return Promise.resolve();
        },
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let failure: unknown;
    const failing = opening(h, RUN_A, 'default').catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(PAGE_CLOSE_DEADLINE_MS - 1);
    expect(h.pages[0]?.closeHangs).toBe(true);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await failing;

    expect((failure as { kind?: string } | undefined)?.kind).toBe('navigation_failed');
    expect(await h.driver.list(RUN_A)).toEqual([]);
  });
});

describe('following a changed policy', () => {
  it('ends withdrawn host work before the browsers follow, and a browser that throws skips nothing', async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    await followPolicy({
      reapHostWork: () => {
        order.push('reaped');
        return Promise.resolve();
      },
      followInBrowsers: () => {
        order.push('browsers');
        return Promise.reject(new Error('the browser did not answer'));
      },
      warn: (message) => {
        warnings.push(message);
      },
    });

    expect(order).toEqual(['reaped', 'browsers']);
    expect(warnings).toEqual(['Running browsers could not follow the changed host policy']);
  });
});
