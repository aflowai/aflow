/**
 * Every browser operation past `open`, against the fake browser: what each
 * returns, what the loop guards will count (D13), what posture and origin
 * rules let through (D7), and how long pages and browsers live (D6).
 */
import { describe, expect, it } from 'vitest';

import type { EngineAction } from '../browser/types.js';
import { createBrowserIdleSweep } from '../browser/idleSweep.js';
import { harness, profile, refusal, RUN_A, RUN_B, type FakePage } from './fixtures/fakeBrowser.js';

const MINUTE = 60_000;

const FORM = [
  '- main [ref=e1]:',
  '  - heading "Search" [level=1] [ref=e2]',
  '  - searchbox "Query" [ref=e3]',
  '  - combobox "Sort" [ref=e4]:',
  '    - option "Newest" [ref=e5]',
  '  - button "Go" [ref=e6]',
  '  - link "Next page" [ref=e7]:',
  '    - /url: https://shop.example.com/2',
].join('\n');

const RESULTS = [
  '- main [ref=e1]:',
  '  - heading "Results" [level=1] [ref=e8]',
  '  - link "First result" [ref=e9]:',
  '    - /url: https://shop.example.com/item/1',
].join('\n');

function shop(onAct?: (page: FakePage, ref: string, action: EngineAction) => void) {
  return harness({
    world: {
      sites: new Map([
        ['https://shop.example.com/', { title: 'Shop', snapshot: FORM }],
        ['https://shop.example.com/2', { title: 'Shop — results', snapshot: RESULTS }],
        ['https://bank.example.org/', { title: 'Bank', snapshot: FORM }],
      ]),
      ...(onAct !== undefined ? { onAct } : {}),
    },
  });
}

const goesToResults = (page: FakePage, ref: string): void => {
  if (ref === 'e6' || ref === 'e7') page.load('https://shop.example.com/2');
};

async function openShop(h: ReturnType<typeof shop>, run = RUN_A): Promise<string> {
  return (await h.driver.open({ ...run, profileId: 'default', url: 'https://shop.example.com/' }))
    .pageId;
}

function act(pageId: string, ref: string, action: EngineAction, redelivered = false) {
  return { ...RUN_A, pageId, ref, action, redelivered };
}

describe('browser.page.navigate', () => {
  it('moves the page and says what changed', async () => {
    const h = shop();
    const pageId = await openShop(h);
    const moved = await h.driver.navigate({
      ...RUN_A,
      pageId,
      to: { kind: 'url', url: 'https://shop.example.com/2' },
      redelivered: false,
    });
    expect(moved.outcome).toBe('performed');
    if (moved.outcome !== 'performed') return;
    expect(moved.view.url).toBe('https://shop.example.com/2');
    expect(moved.changed).toEqual({ urlChanged: true, titleChanged: true, outlineChanged: true });
    expect(moved.view.outline.text).toContain('[ref=e9]');

    const back = await h.driver.navigate({
      ...RUN_A,
      pageId,
      to: { kind: 'back' },
      redelivered: false,
    });
    expect(back.view.url).toBe('https://shop.example.com/');
  });

  it('fails a move back with nowhere to go, naming where the page still is', async () => {
    const h = shop();
    const pageId = await openShop(h);
    const refused = await refusal(
      h.driver.navigate({ ...RUN_A, pageId, to: { kind: 'back' }, redelivered: false }),
    );
    expect(refused.kind).toBe('navigation_failed');
    expect(refused.message).toContain('no page to go back to');
    expect(refused.message).toContain('https://shop.example.com/');
  });

  it('does not move again when delivered again, and returns the page as it stands', async () => {
    const h = shop();
    const pageId = await openShop(h);
    const before = h.pages[0]?.navigations.length;
    const again = await h.driver.navigate({
      ...RUN_A,
      pageId,
      to: { kind: 'url', url: 'https://shop.example.com/2' },
      redelivered: true,
    });
    expect(again.outcome).toBe('uncertain_outcome');
    expect(again.view.url).toBe('https://shop.example.com/');
    expect(again.view.outline.text).toContain('[ref=e6]');
    expect(h.pages[0]?.navigations.length).toBe(before);
  });
});

describe('browser.page.act', () => {
  it('clicks, and the receipt says the page changed', async () => {
    const h = shop(goesToResults);
    const pageId = await openShop(h);
    const result = await h.driver.act(act(pageId, 'e7', { kind: 'click' }));
    expect(result.outcome).toBe('performed');
    if (result.outcome !== 'performed') return;
    expect(result.element).toEqual({ role: 'link', name: 'Next page' });
    expect(result.changed).toEqual({ urlChanged: true, titleChanged: true, outlineChanged: true });
    expect(result.view.outline.text).toContain('"First result"');
  });

  it('succeeds with outlineChanged false when the action changed nothing', async () => {
    const h = shop();
    const pageId = await openShop(h);
    const result = await h.driver.act(act(pageId, 'e2', { kind: 'hover' }));
    expect(result.outcome).toBe('performed');
    if (result.outcome !== 'performed') return;
    expect(result.changed).toEqual({
      urlChanged: false,
      titleChanged: false,
      outlineChanged: false,
    });
  });

  it('fails a reference the newest outline does not carry, naming it and carrying the current outline', async () => {
    const h = shop(goesToResults);
    const pageId = await openShop(h);
    await h.driver.act(act(pageId, 'e6', { kind: 'click' }));
    // e3 was the search box before the click; the page has moved on.
    const refused = await refusal(
      h.driver.act(act(pageId, 'e3', { kind: 'type', text: 'shoes', submit: false })),
    );
    expect(refused.kind).toBe('stale_ref');
    expect(refused.message).toContain('`e3`');
    expect(refused.details['ref']).toBe('e3');
    expect(refused.details['outline']).toContain('[ref=e9]');
    expect(h.pages[0]?.actions.map((a) => a.ref)).toEqual(['e6']);
  });

  it('fails a reference the page no longer resolves, even when the outline still showed it', async () => {
    const h = shop();
    const pageId = await openShop(h);
    // The page changes under the outline without an operation seeing it.
    const page = h.pages[0];
    if (page !== undefined) page.current = 'https://shop.example.com/2';
    const refused = await refusal(h.driver.act(act(pageId, 'e6', { kind: 'click' })));
    expect(refused.kind).toBe('stale_ref');
    expect(refused.details['outline']).toContain('"First result"');
  });

  it('does not act again when delivered again, and returns the page as it stands', async () => {
    const h = shop(goesToResults);
    const pageId = await openShop(h);
    const again = await h.driver.act(act(pageId, 'e6', { kind: 'click' }, true));
    expect(again.outcome).toBe('uncertain_outcome');
    expect(again.view.outline.text).toContain('[ref=e6]');
    expect(h.pages[0]?.actions).toEqual([]);
  });

  it('records where text went and how much, never the text', async () => {
    const h = shop();
    const pageId = await openShop(h);
    const result = await h.driver.act(
      act(pageId, 'e3', { kind: 'type', text: 'red shoes size 9', submit: true }),
    );
    expect(result.outcome).toBe('performed');
    if (result.outcome !== 'performed') return;
    expect(result.typed).toEqual({ field: 'Query', characters: 16, submitted: true });
    expect(JSON.stringify(result)).not.toContain('red shoes');
  });

  it('refuses to type into a password field: credentials are the operator’s to enter', async () => {
    const h = harness();
    const { pageId } = await h.driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    const refused = await refusal(
      h.driver.act(act(pageId, 'e5', { kind: 'type', text: 'hunter2', submit: false })),
    );
    expect(refused.kind).toBe('credential_field');
    expect(refused.message).toContain('Credentials are entered by the operator');
    expect(refused.message).not.toContain('hunter2');
    expect(h.pages[0]?.actions).toEqual([]);
  });

  it('refuses a password field the engine finds at typing time, though the outline did not mark it', async () => {
    const h = harness({
      world: {
        sites: new Map([
          ['https://example.com/', { snapshot: '- textbox "Password" [ref=e5]', masked: [] }],
        ]),
      },
    });
    const { pageId } = await h.driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    const refused = await refusal(
      h.driver.act(act(pageId, 'e5', { kind: 'type', text: 'hunter2', submit: false })),
    );
    expect(refused.kind).toBe('credential_field');
  });
});

describe('posture and origin rules', () => {
  async function opened(rules: Parameters<typeof profile>[0]) {
    const h = shop(goesToResults);
    h.setProfiles([profile(rules)]);
    const pageId = await openShop(h);
    return { h, pageId };
  }

  it('read-only: action refused; navigation and every observation run', async () => {
    const { h, pageId } = await opened({ posture: 'read-only' });
    const refused = await refusal(h.driver.act(act(pageId, 'e6', { kind: 'click' })));
    expect(refused.kind).toBe('posture_refused');
    expect(refused.message).toContain('read-only');
    expect(h.pages[0]?.actions).toEqual([]);

    await h.driver.navigate({ ...RUN_A, pageId, to: { kind: 'reload' }, redelivered: false });
    await h.driver.snapshot(RUN_A, pageId);
    await h.driver.readPage(RUN_A, pageId, 'text');
    expect(await h.driver.list(RUN_A)).toHaveLength(1);
    expect(await h.driver.close(RUN_A, pageId)).toBe('closed');
  });

  it('ask-to-act: action refused, saying asking is not available yet, and nothing pauses', async () => {
    const { h, pageId } = await opened({ posture: 'ask-to-act' });
    const refused = await refusal(h.driver.act(act(pageId, 'e6', { kind: 'click' })));
    expect(refused.kind).toBe('ask_unavailable');
    expect(refused.message).toContain('not available yet');
    await h.driver.navigate({ ...RUN_A, pageId, to: { kind: 'reload' }, redelivered: false });
  });

  it('deny: refuses navigating to the origin and acting on a page there', async () => {
    const h = shop();
    const pageId = await openShop(h);
    h.setProfiles([profile({ rules: [{ origin: 'https://bank.example.org', effect: 'deny' }] })]);

    const going = await refusal(
      h.driver.navigate({
        ...RUN_A,
        pageId,
        to: { kind: 'url', url: 'https://bank.example.org/' },
        redelivered: false,
      }),
    );
    expect(going.kind).toBe('origin_denied');
    expect(going.message).toContain('https://bank.example.org');

    const opening = await refusal(
      h.driver.open({ ...RUN_A, profileId: 'default', url: 'https://bank.example.org/' }),
    );
    expect(opening.kind).toBe('origin_denied');
  });

  it('deny reaches the connection, so a redirect there is refused by the proxy', async () => {
    const h = harness({
      browsers: [profile({ rules: [{ origin: '*.bank.example.org', effect: 'deny' }] })],
      world: {
        redirects: new Map([['https://shop.example.com/pay', 'https://pay.bank.example.org/']]),
      },
    });
    const refused = await refusal(
      h.driver.open({ ...RUN_A, profileId: 'default', url: 'https://shop.example.com/pay' }),
    );
    expect(refused.kind).toBe('origin_denied');
    expect(h.proxies[0]?.refusals.map((r) => [r.host, r.kind])).toEqual([
      ['pay.bank.example.org', 'rule'],
    ]);
  });

  it('ask: treated as deny, saying asking is not available yet', async () => {
    const h = shop();
    const pageId = await openShop(h);
    h.setProfiles([profile({ rules: [{ origin: 'https://shop.example.com', effect: 'ask' }] })]);
    const refused = await refusal(h.driver.act(act(pageId, 'e6', { kind: 'click' })));
    expect(refused.kind).toBe('ask_unavailable');
    expect(refused.message).toContain('not available yet');
  });

  it('allow: lifts the posture for its origin and no other', async () => {
    const { h, pageId } = await opened({
      posture: 'read-only',
      rules: [{ origin: 'https://shop.example.com', effect: 'allow' }],
    });
    expect((await h.driver.act(act(pageId, 'e6', { kind: 'click' }))).outcome).toBe('performed');

    const bank = await h.driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://bank.example.org/',
    });
    const refused = await refusal(h.driver.act(act(bank.pageId, 'e6', { kind: 'click' })));
    expect(refused.kind).toBe('posture_refused');
  });

  it('a wildcard names the host and every name under it, and nothing that merely ends alike', async () => {
    const h = harness({
      browsers: [profile({ rules: [{ origin: '*.example.org', effect: 'deny' }] })],
    });
    for (const url of [
      'https://example.org/',
      'https://bank.example.org/',
      'http://a.b.example.org:8080/',
    ]) {
      const refused = await refusal(h.driver.open({ ...RUN_A, profileId: 'default', url }));
      expect(refused.kind, url).toBe('origin_denied');
    }
    await h.driver.open({ ...RUN_A, profileId: 'default', url: 'https://notexample.org/' });
  });

  it('gates an action on where the page is now, not where it was opened or what the call says', async () => {
    const h = shop();
    h.setProfiles([profile({ rules: [{ origin: 'https://bank.example.org', effect: 'deny' }] })]);
    const pageId = await openShop(h);
    // The page took itself somewhere else after it was opened.
    const page = h.pages[0];
    if (page !== undefined) page.current = 'https://bank.example.org/';
    const refused = await refusal(h.driver.act(act(pageId, 'e6', { kind: 'click' })));
    expect(refused.kind).toBe('origin_denied');
    expect(refused.details['origin']).toBe('https://bank.example.org');
    expect(page?.actions).toEqual([]);
  });

  it('applies a rule changed on the machine to a running browser’s proxy at once', async () => {
    const h = shop();
    await openShop(h);
    expect(h.proxies[0]?.check('bank.example.org', '')).toBeUndefined();
    const denying = profile({ rules: [{ origin: 'https://bank.example.org', effect: 'deny' }] });
    h.driver.policyChanged({ browsers: new Map([['default', denying]]), chrome: { searched: [] } });
    expect(h.proxies[0]?.check('bank.example.org', '')?.kind).toBe('rule');
  });
});

describe('browser.page.snapshot', () => {
  it('returns the whole tree with password values masked, or one subtree', async () => {
    const h = harness();
    const { pageId } = await h.driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    const whole = await h.driver.snapshot(RUN_A, pageId);
    expect(whole.snapshot.text).toContain('Welcome back');
    expect(whole.snapshot.text).toContain('- textbox "Password" [ref=e5]');
    expect(whole.snapshot.text).not.toContain('hunter2-planted');
    expect(whole.snapshot.census).toBeUndefined();

    const one = await h.driver.snapshot(RUN_A, pageId, 'e4');
    expect(one.snapshot.text).toBe('- textbox "Email" [ref=e4]: op@example.com');
  });

  it('fails a reference the page does not carry, with the current outline', async () => {
    const h = harness();
    const { pageId } = await h.driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    const refused = await refusal(h.driver.snapshot(RUN_A, pageId, 'e99'));
    expect(refused.kind).toBe('stale_ref');
    expect(refused.details['outline']).toContain('[ref=e6]');
  });
});

describe('browser.page.read', () => {
  it('reads console and network kept since the page opened, query values redacted', async () => {
    const h = harness();
    const { pageId } = await h.driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/?session=s3cr3t&lang=en',
    });
    const page = h.pages[0];
    page?.events.console('error', 'Uncaught TypeError: x is undefined');
    page?.events.console('log', 'ready');
    page?.events.request({
      method: 'POST',
      url: 'https://api.example.com/v1/login?cursor=abc123&next=%2Fhome',
      status: 401,
      resourceType: 'fetch',
    });

    const errors = await h.driver.readPage(RUN_A, pageId, 'console', 'typeerror');
    expect(errors.what === 'console' && errors.console.map((e) => [e.level, e.text])).toEqual([
      ['error', 'Uncaught TypeError: x is undefined'],
    ]);

    const network = await h.driver.readPage(RUN_A, pageId, 'network');
    if (network.what !== 'network') throw new Error('expected network');
    expect(network.network.map((e) => e.url)).toEqual([
      'https://example.com/?session=redacted&lang=redacted',
      'https://api.example.com/v1/login?cursor=redacted&next=redacted',
    ]);
    expect(JSON.stringify(network.network)).not.toMatch(/s3cr3t|abc123/);
    expect(network.network[1]).toMatchObject({
      method: 'POST',
      status: 401,
      resourceType: 'fetch',
    });
  });

  it('reads the page text, filtered to matching lines', async () => {
    const h = harness();
    const { pageId } = await h.driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    const read = await h.driver.readPage(RUN_A, pageId, 'text', 'welcome');
    expect(read).toMatchObject({
      what: 'text',
      text: 'Welcome back to the example service.',
      withheld: 0,
    });
  });
});

describe('the page table across list and close', () => {
  it('lists the run’s pages, closes one, and says when a page was already gone', async () => {
    const h = shop();
    const first = await openShop(h);
    h.clock.now += MINUTE;
    const second = await openShop(h);
    const other = await openShop(h, RUN_B);

    const listed = await h.driver.list(RUN_A);
    expect(listed.map((p) => [p.pageId, p.url, p.title, p.profileId])).toEqual([
      [first, 'https://shop.example.com/', 'Shop', 'default'],
      [second, 'https://shop.example.com/', 'Shop', 'default'],
    ]);
    expect(listed[1]?.lastUsedAt).toBe((listed[0]?.lastUsedAt ?? 0) + MINUTE);

    expect(await h.driver.close(RUN_A, first)).toBe('closed');
    expect((await h.driver.list(RUN_A)).map((p) => p.pageId)).toEqual([second]);
    expect(await h.driver.close(RUN_A, first)).toBe('already_gone');

    // Another run's page is answered as one this run never had, and stays open.
    expect(await h.driver.close(RUN_A, other)).toBe('already_gone');
    expect((await h.driver.list(RUN_B)).map((p) => p.pageId)).toEqual([other]);
  });
});

describe('the idle task', () => {
  it('closes a stale page, then stops the browser it left empty, on injected time', async () => {
    const h = harness({ browsers: [profile({ idleMinutes: 30 })] });
    const sweep = createBrowserIdleSweep(h.driver, {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    expect(await sweep.runOnce()).toMatchObject({ candidates: 0 });

    const { pageId } = await h.driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/a',
    });
    h.clock.now += 29 * MINUTE;
    await h.driver.snapshot(RUN_A, pageId);
    h.clock.now += 29 * MINUTE;
    await sweep.runOnce();
    expect(await h.driver.list(RUN_A)).toHaveLength(1);

    h.clock.now += 1 * MINUTE;
    expect(await sweep.runOnce()).toMatchObject({ candidates: 1, processed: 1 });
    expect(h.pages[0]?.closed).toBe(true);
    const gone = await refusal(h.driver.snapshot(RUN_A, pageId));
    expect(gone.kind).toBe('page_gone');
    expect(gone.details['lastUrl']).toBe('https://example.com/a');
    expect(h.stops).toEqual([]);

    h.clock.now += 29 * MINUTE;
    await sweep.runOnce();
    expect(h.stops).toEqual([]);
    h.clock.now += 1 * MINUTE;
    await sweep.runOnce();
    expect(h.stops).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.proxies[0]?.stopped).toBe(true);
    expect((await h.driver.listProfiles('space-1'))[0]).toMatchObject({
      running: false,
      sitesUnknown: 'stopped',
    });
  });
});

describe('browser.profile.list', () => {
  it('never starts a browser to answer, and names sites only while one runs', async () => {
    const h = harness({
      browsers: [profile(), profile({ id: 'work', spaces: ['space-2'], posture: 'read-only' })],
    });
    expect(await h.driver.listProfiles('space-1')).toEqual([
      {
        profileId: 'default',
        posture: 'autonomous',
        window: 'hidden',
        running: false,
        sitesUnknown: 'not_started',
      },
    ]);
    expect(h.launches).toHaveLength(0);

    await h.driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/' });
    expect(await h.driver.listProfiles('space-1')).toEqual([
      {
        profileId: 'default',
        posture: 'autonomous',
        window: 'hidden',
        running: true,
        sites: ['accounts.example.com', 'mail.example.com'],
      },
    ]);
    expect((await h.driver.listProfiles('space-2')).map((p) => [p.profileId, p.running])).toEqual([
      ['default', true],
      ['work', false],
    ]);
    expect(h.launches).toHaveLength(1);
  });
});
