/**
 * What an edit to the machine's policy does to browsers already running and
 * the pages in them, and what a page in a profile the run may no longer use
 * answers before that edit has been applied.
 */
import type { BrowserProfile } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { CHROME, harness, profile, refusal, RUN_A, RUN_B } from './fixtures/fakeBrowser.js';

const RUN_ELSEWHERE = { tenantId: 't1', runId: 'run-c', spaceId: 'space-2' };

function policyOf(profiles: BrowserProfile[]) {
  return { browsers: new Map(profiles.map((p) => [p.id, p])), chrome: CHROME };
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
