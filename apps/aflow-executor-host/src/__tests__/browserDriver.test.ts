/**
 * The driver's rules, against a fake engine, proxy and launcher: no Chrome is
 * started here. What is asserted is who may open what, what a run is told
 * when it may not, and that a profile keeping sign-ins does not reach this
 * machine — refused cheaply on the address asked for, and otherwise by the
 * proxy at the connection.
 */
import { AflowErrorSchema } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { INTERFACE_ADDRESSES_TTL_MS } from '../browser/addresses.js';
import type { BrowserDriver } from '../browser/driver.js';
import { BrowserDriverError } from '../browser/errors.js';
import { browserFailure } from '../handlers/browserHandler.js';
import { harness, profile, refusal, RUN_A, RUN_B } from './fixtures/fakeBrowser.js';

describe('pages belong to runs', () => {
  it('refuses run B the page run A opened, as page_gone, without saying where it is', async () => {
    const { driver } = harness();
    const opened = await driver.open({
      ...RUN_A,
      redelivered: false,
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
      redelivered: false,
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
      redelivered: false,
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
    await driver.open({
      ...RUN_A,
      redelivered: false,
      profileId: 'default',
      url: 'https://example.com/b',
    });
    expect(launches).toHaveLength(2);
    expect(proxies).toHaveLength(2);
  });

  it('starts one browser per profile, behind one proxy started first', async () => {
    const { driver, launches, proxies } = harness();
    await Promise.all([
      driver.open({
        ...RUN_A,
        redelivered: false,
        profileId: 'default',
        url: 'https://example.com/1',
      }),
      driver.open({
        ...RUN_B,
        redelivered: false,
        profileId: 'default',
        url: 'https://example.com/2',
      }),
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
      driver.open({
        ...RUN_A,
        redelivered: false,
        profileId: 'default',
        url: 'https://example.com/',
      }),
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
      driver.open({
        ...RUN_A,
        redelivered: false,
        profileId: 'personal',
        url: 'https://example.com/',
      }),
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
      driver.open({ ...RUN_A, redelivered: false, profileId: 'work', url: 'https://example.com/' }),
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
      driver.open({
        ...noSpace,
        redelivered: false,
        profileId: 'default',
        url: 'https://example.com/',
      }),
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
      driver.open({
        ...RUN_A,
        redelivered: false,
        profileId: 'default',
        url: 'https://example.com/',
      }),
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
      const refused = await refusal(
        driver.open({ ...RUN_A, redelivered: false, profileId: 'default', url }),
      );
      expect(refused.kind).toBe('appliance_origin');
      expect(refused.message).toContain('keeps sign-ins');
      expect(refused.message).toContain(
        'reaches this machine only on the loopback ports the operator opened for it',
      );
      expect(launches).toHaveLength(0);
    });
  }

  it('lists no local port for a profile that names none', async () => {
    const { driver } = harness();
    expect((await driver.listProfiles(RUN_A)).map((listed) => listed.localPorts)).toEqual([[]]);
  });

  it('refuses an address the machine gained after its browser started, once the TTL has passed', async () => {
    const { driver, interfaces, clock } = harness();
    const gained = 'http://192.0.2.77:3001/';
    await driver.open({ ...RUN_A, redelivered: false, profileId: 'default', url: gained });

    interfaces.push('192.0.2.77');
    await driver.open({ ...RUN_A, redelivered: false, profileId: 'default', url: gained });
    clock.now += INTERFACE_ADDRESSES_TTL_MS;
    const refused = await refusal(
      driver.open({ ...RUN_A, redelivered: false, profileId: 'default', url: gained }),
    );
    expect(refused.kind).toBe('appliance_origin');
    expect(refused.message).toContain('192.0.2.77 is an address of this machine');
  });

  it('refuses at the connection a public name that resolves to this machine', async () => {
    const { driver, pages, proxies } = harness({
      world: { localHosts: new Set(['rebound.example.net']) },
    });
    const refused = await refusal(
      driver.open({
        ...RUN_A,
        redelivered: false,
        profileId: 'default',
        url: 'https://rebound.example.net/',
      }),
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
      driver.open({
        ...RUN_A,
        redelivered: false,
        profileId: 'default',
        url: 'https://example.com/go',
      }),
    );
    expect(refused.kind).toBe('appliance_origin');
    expect(refused.message).toContain('The connection was refused');
    expect(pages[0]?.closed).toBe(true);
  });

  it('fails a later navigation the proxy refused, leaving the page open', async () => {
    const { driver } = harness({ world: { localHosts: new Set(['rebound.example.net']) } });
    const opened = await driver.open({
      ...RUN_A,
      redelivered: false,
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

describe('a profile the operator opened local ports to', () => {
  const open = (driver: BrowserDriver, url: string): Promise<unknown> =>
    driver.open({ ...RUN_A, redelivered: false, profileId: 'default', url });

  it('opens a page on loopback on a port in its list, by every loopback spelling', async () => {
    const { driver, launches } = harness({ browsers: [profile({ localPorts: [5173] })] });
    for (const url of [
      'http://localhost:5173/',
      'http://127.0.0.1:5173/',
      'http://[::1]:5173/',
      'http://app.localhost:5173/',
    ]) {
      await expect(open(driver, url), url).resolves.toMatchObject({ url });
    }
    expect(launches).toHaveLength(1);
  });

  it('refuses a port not in the list, and every other address of this machine on the one that is', async () => {
    const { driver, interfaces } = harness({ browsers: [profile({ localPorts: [5173] })] });
    interfaces.push('192.0.2.10');
    for (const url of [
      'http://localhost:5174/',
      'http://127.0.0.1:3000/',
      'http://192.0.2.10:5173/',
      'http://0.0.0.0:5173/',
      'http://169.254.169.254:5173/',
      'http://[fe80::1]:5173/',
    ]) {
      const refused = await refusal(open(driver, url));
      expect(refused.kind, url).toBe('appliance_origin');
      expect(refused.message, url).toContain('only on the loopback ports the operator opened');
    }
  });

  it('refuses a name that resolves to loopback on a port in the list as on any other', async () => {
    const { driver, proxies } = harness({
      browsers: [profile({ localPorts: [5173] })],
      world: { localHosts: new Set(['dev.example.test']) },
    });
    for (const url of ['http://dev.example.test:5173/', 'http://dev.example.test:5174/']) {
      const refused = await refusal(open(driver, url));
      expect(refused.kind, url).toBe('appliance_origin');
      expect(refused.message, url).toContain('resolves to 127.0.0.1');
    }
    expect(proxies[0]?.refusals.map((r) => `${r.host}:${String(r.port)}`)).toEqual([
      'dev.example.test:5173',
      'dev.example.test:5174',
    ]);
  });

  it('refuses every port this stack serves on, though the policy file lists it, and lists only what is open', async () => {
    const stack = [3000, 3001, 3002, 3100, 5433, 6379, 6380, 8080, 8081];
    const { driver, clock } = harness({
      browsers: [profile({ localPorts: [...stack, 5173] })],
    });
    for (const port of stack) {
      for (const host of ['localhost', '127.0.0.1']) {
        const url = `http://${host}:${String(port)}/`;
        clock.now += 1_000;
        const refused = await refusal(open(driver, url));
        expect(refused.kind, url).toBe('appliance_origin');
        expect(refused.message, url).toContain(`port ${String(port)} is this stack's own`);
        expect(refused.message, url).toContain("could approve the agent's requests");
      }
    }
    expect((await driver.listProfiles(RUN_A)).map((listed) => listed.localPorts)).toEqual([[5173]]);
  });

  it('gives the machine page every listed port, the stack’s own marked refused, and the agent only the open ones', async () => {
    const { driver } = harness({ browsers: [profile({ localPorts: [3001, 5173] })] });
    const [machine] = await driver.machineProfiles();
    expect(machine?.localPorts).toEqual([
      {
        port: 3001,
        refused:
          "port 3001 is this stack's own — the web application, by default — and a page from " +
          "it could approve the agent's requests",
      },
      { port: 5173 },
    ]);
    expect((await driver.listProfiles(RUN_A)).map((listed) => listed.localPorts)).toEqual([[5173]]);
  });

  it('holds a local origin to the same rules as any other: a deny names its host', async () => {
    const { driver } = harness({
      browsers: [
        profile({
          localPorts: [5173, 8000],
          rules: [{ origin: 'http://localhost:5173', effect: 'deny' }],
        }),
      ],
    });
    for (const url of ['http://localhost:5173/', 'http://localhost:8000/']) {
      const refused = await refusal(open(driver, url));
      expect(refused.kind, url).toBe('origin_denied');
      expect(refused.message, url).toContain('http://localhost:5173');
    }
    await expect(open(driver, 'http://127.0.0.1:8000/')).resolves.toMatchObject({
      url: 'http://127.0.0.1:8000/',
    });
  });
});

describe('what an open returns', () => {
  it('is an outline with no password value in it', async () => {
    const { driver } = harness();
    const opened = await driver.open({
      ...RUN_A,
      redelivered: false,
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
      'approval_denied',
      'ask_unanswerable',
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
