/**
 * The driver's rules, against a fake engine and a fake launcher: no Chrome is
 * started here. What is asserted is who may open what, and what a run is told
 * when it may not.
 */
import { AflowErrorSchema, BrowserProfileSchema, type BrowserProfile } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import type { ChromeDiscovery } from '../browser/chromeDiscovery.js';
import type { ChromeLauncher, ChromeLaunchInput } from '../browser/chromeProcess.js';
import { BrowserDriver, type BrowserPolicy } from '../browser/driver.js';
import { BrowserDriverError } from '../browser/errors.js';
import type { BrowserEngine, EnginePage, PageSnapshot } from '../browser/types.js';
import { browserFailure } from '../handlers/browserHandler.js';

const CHROME: ChromeDiscovery = {
  found: {
    label: 'Google Chrome',
    path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  searched: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
};

const SNAPSHOT = [
  '- generic [ref=e1]:',
  '  - heading "Sign in" [level=1] [ref=e2]',
  '  - paragraph [ref=e3]: Welcome back to the example service.',
  '  - textbox "Email" [ref=e4]: op@example.com',
  '  - textbox "Password" [ref=e5]: hunter2-planted',
  '  - button "Continue" [ref=e6] [cursor=pointer]',
].join('\n');

class FakePage implements EnginePage {
  current = 'about:blank';
  closed = false;
  constructor(
    private readonly redirects: ReadonlyMap<string, string>,
    private readonly snapshotText: string,
  ) {}
  goto(url: string): Promise<void> {
    this.current = this.redirects.get(url) ?? url;
    return Promise.resolve();
  }
  url(): string {
    return this.current;
  }
  title(): Promise<string> {
    return Promise.resolve('Example');
  }
  snapshot(): Promise<PageSnapshot> {
    return Promise.resolve({ text: this.snapshotText, maskedRefs: new Set(['e5']) });
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  isClosed(): boolean {
    return this.closed;
  }
}

interface Harness {
  driver: BrowserDriver;
  launches: ChromeLaunchInput[];
  pages: FakePage[];
  /** End the browser of the most recent launch, as withdrawal or a crash would. */
  endBrowser: () => Promise<void>;
}

function harness(
  options: {
    browsers?: BrowserProfile[];
    chrome?: ChromeDiscovery;
    redirects?: Map<string, string>;
  } = {},
): Harness {
  const launches: ChromeLaunchInput[] = [];
  const pages: FakePage[] = [];
  let end: () => void = () => undefined;
  const launcher: ChromeLauncher = {
    launch: (input) => {
      launches.push(input);
      const exited = new Promise<void>((resolve) => {
        end = resolve;
      });
      return Promise.resolve({
        endpoint: 'ws://127.0.0.1:9/devtools/browser/x',
        exited,
        stop: end,
      });
    },
  };
  const engine: BrowserEngine = {
    connect: () =>
      Promise.resolve({
        newPage: () => {
          const page = new FakePage(options.redirects ?? new Map(), SNAPSHOT);
          pages.push(page);
          return Promise.resolve(page);
        },
        disconnect: () => Promise.resolve(),
      }),
  };
  const browsers = options.browsers ?? [BrowserProfileSchema.parse({ id: 'default' })];
  const policy: BrowserPolicy = {
    browsers: new Map(browsers.map((profile) => [profile.id, profile])),
    chrome: options.chrome ?? CHROME,
  };
  return {
    driver: new BrowserDriver({
      engine,
      launcher,
      hostDir: '/Users/op/.aflow',
      loadPolicy: () => Promise.resolve(policy),
    }),
    launches,
    pages,
    endBrowser: async () => {
      end();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const RUN_A = { tenantId: 't1', runId: 'run-a', spaceId: 'space-1' };
const RUN_B = { tenantId: 't1', runId: 'run-b', spaceId: 'space-1' };

async function refusal(promise: Promise<unknown>): Promise<BrowserDriverError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrowserDriverError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function thrown(fn: () => unknown): BrowserDriverError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BrowserDriverError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('pages belong to runs', () => {
  it('refuses run B the page run A opened, as page_gone, without saying where it is', async () => {
    const { driver } = harness();
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    expect(driver.page(RUN_A, opened.pageId).page.url()).toBe('https://example.com/');

    const refused = thrown(() => driver.page(RUN_B, opened.pageId));
    expect(refused.kind).toBe('page_gone');
    expect(refused.message).toMatch(/^page_gone:/);
    expect(refused.message).not.toContain('example.com');
    expect(refused.details).not.toHaveProperty('lastUrl');
  });

  it('keeps the same run id apart across tenants', async () => {
    const { driver } = harness();
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/',
    });
    expect(thrown(() => driver.page({ ...RUN_A, tenantId: 't2' }, opened.pageId)).kind).toBe(
      'page_gone',
    );
  });

  it("reports the run's own lost page with the address it was last at", async () => {
    const { driver, endBrowser, launches } = harness();
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'https://example.com/a',
    });
    await endBrowser();

    const gone = thrown(() => driver.page(RUN_A, opened.pageId));
    expect(gone.kind).toBe('page_gone');
    expect(gone.details['lastUrl']).toBe('https://example.com/a');
    expect(gone.message).toContain('https://example.com/a');

    // The next open starts the profile's browser again.
    await driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/b' });
    expect(launches).toHaveLength(2);
  });

  it('starts one browser per profile however many pages it serves', async () => {
    const { driver, launches } = harness();
    await Promise.all([
      driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/1' }),
      driver.open({ ...RUN_B, profileId: 'default', url: 'https://example.com/2' }),
    ]);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.hostDir).toBe('/Users/op/.aflow');
  });
});

describe('which profile a run may use', () => {
  it('refuses an unknown profile, naming the ones configured', async () => {
    const { driver, launches } = harness({
      browsers: [
        BrowserProfileSchema.parse({ id: 'default' }),
        BrowserProfileSchema.parse({ id: 'work' }),
      ],
    });
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
      browsers: [
        BrowserProfileSchema.parse({ id: 'default', spaces: ['space-1'] }),
        BrowserProfileSchema.parse({ id: 'work', spaces: ['space-2'] }),
      ],
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
    const { driver } = harness({
      browsers: [BrowserProfileSchema.parse({ id: 'default', spaces: ['space-1'] })],
    });
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

describe("a signed-in profile and the appliance's own origins", () => {
  for (const url of [
    'http://127.0.0.1:3000/v1/actions',
    'http://localhost:3001/action-center',
    'http://[::1]:3001/',
  ]) {
    it(`refuses ${url} before starting anything`, async () => {
      const { driver, launches } = harness();
      const refused = await refusal(driver.open({ ...RUN_A, profileId: 'default', url }));
      expect(refused.kind).toBe('appliance_origin');
      expect(refused.message).toContain('keeps sign-ins');
      expect(refused.message).toContain('Action Center');
      expect(launches).toHaveLength(0);
    });
  }

  it('closes a page that redirected there', async () => {
    const { driver, pages } = harness({
      redirects: new Map([['https://example.com/go', 'http://localhost:3001/action-center']]),
    });
    const refused = await refusal(
      driver.open({ ...RUN_A, profileId: 'default', url: 'https://example.com/go' }),
    );
    expect(refused.kind).toBe('appliance_origin');
    expect(refused.message).toContain('redirected');
    expect(pages[0]?.closed).toBe(true);
  });

  it('opens a loopback dev server on another port', async () => {
    const { driver } = harness();
    const opened = await driver.open({
      ...RUN_A,
      profileId: 'default',
      url: 'http://localhost:5173/',
    });
    expect(opened.url).toBe('http://localhost:5173/');
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
    for (const kind of ['unknown_profile', 'profile_not_for_space', 'appliance_origin'] as const) {
      const failure = browserFailure(new BrowserDriverError(kind, 'refused'));
      expect(AflowErrorSchema.parse(failure).classification).toBe('permission');
      expect(failure.retryable).toBe(false);
    }
  });
});
