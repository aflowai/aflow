/**
 * The driver's rules, against a fake engine, proxy and launcher: no Chrome is
 * started here. What is asserted is who may open what, what a run is told
 * when it may not, and that a profile keeping sign-ins does not reach this
 * machine — refused cheaply on the address asked for, and otherwise by the
 * proxy at the connection.
 */
import { AflowErrorSchema } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { BrowserDriverError } from '../browser/errors.js';
import { browserFailure } from '../handlers/browserHandler.js';
import { harness, profile, refusal, RUN_A, RUN_B } from './fixtures/fakeBrowser.js';

describe('pages belong to runs', () => {
  it('refuses run B the page run A opened, as page_gone, without saying where it is', async () => {
    const { driver } = harness();
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    expect((await driver.list(RUN_A)).map((page) => page.pageId)).toEqual([opened.pageId]);

    const refused = await refusal(driver.snapshot(RUN_B, opened.pageId));
    expect(refused.kind).toBe('page_gone');
    expect(refused.message).toMatch(/^page_gone:/);
    expect(refused.message).not.toContain('example.com');
    expect(refused.details).not.toHaveProperty('lastUrl');
    expect(await driver.list(RUN_B)).toEqual([]);
  });

  it('keeps the same run id apart across tenants', async () => {
    const { driver } = harness();
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    const refused = await refusal(driver.snapshot({ ...RUN_A, tenantId: 't2' }, opened.pageId));
    expect(refused.kind).toBe('page_gone');
  });

  it("reports the run's own lost page with the address it was last at", async () => {
    const { driver, endBrowser, launches, proxies } = harness();
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/a',
    });
    await endBrowser();

    const gone = await refusal(driver.snapshot(RUN_A, opened.pageId));
    expect(gone.kind).toBe('page_gone');
    expect(gone.details['lastUrl']).toBe('https://example.com/a');
    expect(gone.message).toContain('https://example.com/a');
    // The proxy goes with the browser it served.
    expect(proxies[0]?.stopped).toBe(true);

    // The next open starts the profile's browser again, behind a new proxy.
    await driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/b' });
    expect(launches).toHaveLength(2);
    expect(proxies).toHaveLength(2);
  });

  it('starts one browser per profile, behind one proxy started first', async () => {
    const { driver, launches, proxies } = harness();
    await Promise.all([
      driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/1' }),
      driver.open({ ...RUN_B, profileId: 'default', url: 'https://example.com/2' }),
    ]);
    expect(launches).toHaveLength(1);
    expect(proxies).toHaveLength(1);
    expect(launches[0]?.hostDir).toBe('/Users/op/.aflow');
    expect(launches[0]?.proxyServer).toBe(proxies[0]?.server);
  });

  it('closes and forgets a page that could not be read once registered, and fails the open', async () => {
    const { driver, pages } = harness({
      world: { sites: new Map([['https://example.com/', { unreadable: true }]]) },
    });
    const refused = await refusal(
      driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/' }),
    );
    expect(refused.kind).toBe('observation_failed');
    expect(pages[0]?.closed).toBe(true);
    expect(await driver.list(RUN_A)).toEqual([]);
  });
});

describe('which profile a run may use', () => {
  it('refuses an unknown profile, naming the ones configured', async () => {
    const { driver, launches } = harness({ browsers: [profile(), profile({ id: 'work' })] });
    const refused = await refusal(
      driver.open({ ...RUN_A, profileId: 'personal', url: 'https://example.com/' }),
    );
    expect(refused.kind).toBe('unknown_profile');
    expect(refused.message).toContain('`personal`');
    expect(refused.message).toContain('`default`, `work`');
    expect(launches).toHaveLength(0);
  });

  it('refuses a profile closed to the space, naming the ones it may use', async () => {
    const { driver, launches } = harness({
      browsers: [profile({ spaces: ['space-1'] }), profile({ id: 'work', spaces: ['space-2'] })],
    });
    const refused = await refusal(
      driver.open({ ...RUN_A, profileId: 'work', url: 'https://example.com/' }),
    );
    expect(refused.kind).toBe('profile_not_for_space');
    expect(refused.message).toContain('`work` is not open to this space');
    expect(refused.message).toContain('may use: `default`');
    expect(launches).toHaveLength(0);
  });

  it('refuses a profile pinned to spaces when the run names none', async () => {
    const { driver } = harness({ browsers: [profile({ spaces: ['space-1'] })] });
    const { spaceId: _omitted, ...noSpace } = RUN_A;
    const refused = await refusal(
      driver.open({ ...noSpace, profileId: 'default', url: 'https://example.com/' }),
    );
    expect(refused.kind).toBe('profile_not_for_space');
    expect(refused.message).toContain('may use: none');
  });

  it('says where it looked when no browser is installed', async () => {
    const { driver } = harness({
      browsers: [],
      chrome: { searched: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
    });
    const refused = await refusal(
      driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/' }),
    );
    expect(refused.kind).toBe('no_browser');
    expect(refused.message).toContain('/Applications/Google Chrome.app');
  });
});

describe('a profile that keeps sign-ins and this machine', () => {
  for (const url of [
    'http://127.0.0.1:3000/v1/actions',
    'http://localhost:3001/action-center',
    'http://[::1]:3001/',
    'http://[::ffff:127.0.0.1]:3001/',
    'http://0.0.0.0:3001/',
    'http://localhost:5173/',
    'http://127.0.0.2:47123/',
  ]) {
    it(`refuses ${url} before starting anything, on any port`, async () => {
      const { driver, launches } = harness();
      const refused = await refusal(driver.open({ ...RUN_A, profileId: 'default', url }));
      expect(refused.kind).toBe('appliance_origin');
      expect(refused.message).toContain('keeps sign-ins');
      expect(refused.message).toContain('does not reach services on this machine');
      expect(launches).toHaveLength(0);
    });
  }

  it('refuses at the connection a public name that resolves to this machine', async () => {
    const { driver, pages, proxies } = harness({
      world: { localHosts: new Set(['rebound.example.net']) },
    });
    const refused = await refusal(
      driver.open({ ...RUN_A, profileId: 'default', url: 'https://rebound.example.net/' }),
    );
    expect(refused.kind).toBe('appliance_origin');
    expect(refused.message).toContain('resolves to 127.0.0.1');
    expect(proxies[0]?.refusals.map((r) => r.host)).toEqual(['rebound.example.net']);
    expect(pages[0]?.closed).toBe(true);
    expect(await driver.list(RUN_A)).toEqual([]);
  });

  it('closes a page whose redirect the proxy refused', async () => {
    const { driver, pages } = harness({
      world: {
        redirects: new Map([['https://example.com/go', 'http://intranet.example.net:3001/']]),
        localHosts: new Set(['intranet.example.net']),
      },
    });
    const refused = await refusal(
      driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/go' }),
    );
    expect(refused.kind).toBe('appliance_origin');
    expect(refused.message).toContain('The connection was refused');
    expect(pages[0]?.closed).toBe(true);
  });

  it('fails a later navigation the proxy refused, leaving the page open', async () => {
    const { driver } = harness({ world: { localHosts: new Set(['rebound.example.net']) } });
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    const refused = await refusal(
      driver.navigate({
        ...RUN_A,
        pageId: opened.pageId,
        to: { kind: 'url', url: 'https://rebound.example.net/' },
        redelivered: false,
      }),
    );
    expect(refused.kind).toBe('appliance_origin');
    expect((await driver.list(RUN_A)).map((page) => page.pageId)).toEqual([opened.pageId]);
  });
});

describe('what an open returns', () => {
  it('is an outline with no password value in it', async () => {
    const { driver } = harness();
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    expect(opened.outline.text).not.toContain('hunter2-planted');
    expect(opened.outline.text).toContain('- textbox "Password" [ref=e5]');
    expect(opened.outline.text).toContain('- textbox "Email" [ref=e4]: op@example.com');
    expect(opened.outline.text).not.toContain('Welcome back');
    expect(opened.title).toBe('Example');
  });
});

describe('what the step is told', () => {
  it('carries page_gone as its own code, with where the page was', () => {
    const failure = browserFailure(
      new BrowserDriverError('page_gone', 'page_gone: gone', {
        pageId: 'pg_x',
        lastUrl: 'https://example.com/a',
      }),
    );
    expect(AflowErrorSchema.parse(failure)).toMatchObject({
      code: 'PAGE_GONE',
      classification: 'not_found',
      retryable: false,
      details: { lastUrl: 'https://example.com/a' },
    });
  });

  it('reads every refusal as one that resending will not change', () => {
    for (const kind of [
      'unknown_profile',
      'profile_not_for_space',
      'appliance_origin',
      'origin_denied',
      'posture_refused',
      'ask_unavailable',
      'credential_field',
    ] as const) {
      const failure = browserFailure(new BrowserDriverError(kind, 'refused'));
      expect(AflowErrorSchema.parse(failure).classification).toBe('permission');
      expect(failure.retryable).toBe(false);
    }
  });

  it('reads a stale reference as a failure the agent corrects, never retried as is', () => {
    const failure = browserFailure(
      new BrowserDriverError('stale_ref', 'Reference `e9` does not resolve', {
        ref: 'e9',
        outline: '- button "Next" [ref=e12]',
      }),
    );
    expect(AflowErrorSchema.parse(failure)).toMatchObject({
      code: 'BROWSER_REF_STALE',
      classification: 'validation',
      retryable: false,
      details: { ref: 'e9', outline: '- button "Next" [ref=e12]' },
    });
  });
});
