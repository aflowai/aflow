/**
 * A browser for the driver's tests: pages, a proxy and a launcher that keep
 * their state in memory. No Chrome is started and no socket is opened.
 *
 * The fake proxy answers the way the real one does — the operator's rules
 * through the callback the driver hands it, this machine's addresses by name —
 * and records its refusals where the driver reads them. A navigation to a
 * refused https host fails as Chrome's does; a refused plain-http one lands on
 * the proxy's 403 page, as Chrome shows it.
 */
import { BrowserProfileSchema, type BrowserProfile } from '@aflow/schemas';

import { createLocalAddressClassifier } from '../../browser/addresses.js';
import type { ChromeDiscovery } from '../../browser/chromeDiscovery.js';
import type { ChromeLauncher, ChromeLaunchInput } from '../../browser/chromeProcess.js';
import { BrowserDriver, type BrowserPolicy } from '../../browser/driver.js';
import type { EgressProxy, EgressProxyOptions, ProxyRefusal } from '../../browser/egressProxy.js';
import { BrowserDriverError } from '../../browser/errors.js';
import {
  type BrowserEngine,
  type EngineAction,
  EngineCredentialField,
  type EngineNavigation,
  EngineNavigationFailed,
  type EnginePage,
  EngineRefNotFound,
  type PageEvents,
  type PageSnapshot,
} from '../../browser/types.js';

export const CHROME: ChromeDiscovery = {
  found: {
    label: 'Google Chrome',
    path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  searched: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
};

export const SIGN_IN = [
  '- generic [ref=e1]:',
  '  - heading "Sign in" [level=1] [ref=e2]',
  '  - paragraph [ref=e3]: Welcome back to the example service.',
  '  - textbox "Email" [ref=e4]: op@example.com',
  '  - textbox "Password" [ref=e5]: hunter2-planted',
  '  - button "Continue" [ref=e6] [cursor=pointer]',
].join('\n');

export interface FakeSite {
  readonly title?: string;
  readonly snapshot?: string;
  readonly masked?: readonly string[];
  readonly text?: string;
  /** Its snapshot fails, as a page torn down mid-read does. */
  readonly unreadable?: boolean;
  /** The frame each reference belongs to, by address; any other is in the page itself. */
  readonly frames?: Readonly<Record<string, string>>;
}

export interface FakeWorld {
  /** Content by URL; anything else is the sign-in page. */
  readonly sites: Map<string, FakeSite>;
  readonly redirects: Map<string, string>;
  /** Hosts the fake proxy treats as this machine, as resolving would. */
  readonly localHosts: Set<string>;
  /** A load of the address fails with this, after its document and subresources were asked for. */
  readonly failures: Map<string, string>;
  /** What a page at the address loads besides its document, each through the proxy. */
  readonly subresources: Map<string, readonly string[]>;
  /** Runs while a navigation to an address is under way, before it settles. */
  duringLoad?: (url: string) => Promise<void>;
  /** What an action does to the page, beyond being recorded. */
  onAct?: (page: FakePage, ref: string, action: EngineAction) => void;
  /** Every navigation waits on this while it is set, as a page still loading does. */
  navigationHeld?: Promise<void>;
  /** Opening a page fails with this, as it does on a browser on its way out. */
  newPageFails?: string;
}

export class FakePage implements EnginePage {
  current = 'about:blank';
  history: string[] = [];
  index = -1;
  closed = false;
  snapshotFails = false;
  /** Its close never settles, as a hung page's does. */
  closeHangs = false;
  readonly actions: Array<{ ref: string; action: EngineAction }> = [];
  readonly navigations: EngineNavigation[] = [];

  constructor(
    private readonly world: FakeWorld,
    private readonly proxy: () => FakeProxy,
    readonly events: PageEvents,
  ) {}

  private site(): FakeSite {
    return this.world.sites.get(this.current) ?? {};
  }

  private connect(url: string): ProxyRefusal | undefined {
    const parsed = new URL(url);
    return this.proxy().check(parsed.hostname.replace(/^\[(.*)\]$/, '$1'), parsed.port);
  }

  /** Where a load ends, after redirects and the proxy. A failure carries its redirect chain, as the engine's does. */
  load(url: string): void {
    const chain = [url];
    let refused = this.connect(url);
    const target = this.world.redirects.get(url);
    if (refused === undefined && target !== undefined) {
      chain.push(target);
      refused = this.connect(target);
    }
    const landed = chain.at(-1) ?? url;
    if (refused !== undefined && landed.startsWith('https:')) {
      throw new EngineNavigationFailed(`net::ERR_TUNNEL_CONNECTION_FAILED at ${landed}`, chain);
    }
    for (const subresource of this.world.subresources.get(landed) ?? []) this.connect(subresource);
    const failure = this.world.failures.get(landed);
    if (failure !== undefined) throw new EngineNavigationFailed(failure, chain);
    this.history = [...this.history.slice(0, this.index + 1), landed];
    this.index = this.history.length - 1;
    this.current = landed;
    this.events.request({
      method: 'GET',
      url: landed,
      status: refused !== undefined ? 403 : 200,
      resourceType: 'document',
    });
  }

  async navigate(to: EngineNavigation): Promise<boolean> {
    this.navigations.push(to);
    if (this.world.navigationHeld !== undefined) await this.world.navigationHeld;
    if (to.kind === 'url') {
      await this.world.duringLoad?.(to.url);
      this.load(to.url);
    }
    if (to.kind === 'back' || to.kind === 'forward') {
      const next = this.index + (to.kind === 'back' ? -1 : 1);
      const target = this.history[next];
      if (target === undefined) return false;
      this.index = next;
      this.current = target;
    }
    return true;
  }

  act(ref: string, action: EngineAction): Promise<void> {
    if (!this.snapshotText().includes(`[ref=${ref}]`)) {
      return Promise.reject(new EngineRefNotFound(ref));
    }
    if (action.kind === 'type' && /textbox "Password"/.test(this.lineOf(ref))) {
      return Promise.reject(new EngineCredentialField(ref));
    }
    this.actions.push({ ref, action });
    try {
      this.world.onAct?.(this, ref, action);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve();
  }

  frameUrl(ref: string): Promise<string> {
    if (!this.snapshotText().includes(`[ref=${ref}]`)) {
      return Promise.reject(new EngineRefNotFound(ref));
    }
    return Promise.resolve(this.site().frames?.[ref] ?? this.current);
  }

  private snapshotText(): string {
    return this.site().snapshot ?? SIGN_IN;
  }

  private lineOf(ref: string): string {
    return (
      this.snapshotText()
        .split('\n')
        .find((line) => line.includes(`[ref=${ref}]`)) ?? ''
    );
  }

  url(): string {
    return this.current;
  }
  title(): Promise<string> {
    return Promise.resolve(this.site().title ?? 'Example');
  }
  snapshot(): Promise<PageSnapshot> {
    if (this.snapshotFails || this.site().unreadable === true)
      return Promise.reject(new Error('Target page, context or browser has been closed'));
    const site = this.site();
    return Promise.resolve({
      text: this.snapshotText(),
      maskedRefs: new Set(site.masked ?? (site.snapshot === undefined ? ['e5'] : [])),
    });
  }
  text(): Promise<string> {
    return Promise.resolve(this.site().text ?? 'Sign in\nWelcome back to the example service.');
  }
  close(): Promise<void> {
    if (this.closeHangs) return new Promise(() => undefined);
    this.closed = true;
    return Promise.resolve();
  }
  isClosed(): boolean {
    return this.closed;
  }
}

export class FakeProxy implements EgressProxy {
  readonly port = 41_000;
  readonly server = 'http://127.0.0.1:41000';
  readonly refusals: ProxyRefusal[] = [];
  stopped = false;

  constructor(
    private readonly options: EgressProxyOptions,
    private readonly world: FakeWorld,
    private readonly now: () => number,
  ) {}

  /** The real proxy's decision, by name: the operator's rules first, then this machine. */
  check(host: string, port: string): ProxyRefusal | undefined {
    const at = this.now();
    const numericPort = port === '' ? 443 : Number(port);
    const ruled = this.options.refuseHost?.(host);
    const refusal: ProxyRefusal | undefined =
      ruled !== undefined
        ? { host, port: numericPort, kind: 'rule', reason: ruled, at }
        : this.world.localHosts.has(host)
          ? {
              host,
              port: numericPort,
              kind: 'local',
              reason: `${host} resolves to 127.0.0.1, a loopback address`,
              at,
            }
          : undefined;
    if (refusal !== undefined) this.refusals.push(refusal);
    return refusal;
  }

  refusalsSince(sinceMs: number): readonly ProxyRefusal[] {
    return this.refusals.filter((refusal) => refusal.at >= sinceMs);
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

export interface Harness {
  readonly driver: BrowserDriver;
  readonly world: FakeWorld;
  readonly launches: ChromeLaunchInput[];
  readonly pages: FakePage[];
  readonly proxies: FakeProxy[];
  readonly stops: number[];
  readonly clock: { now: number };
  /** Replace the profiles the machine offers, as an edit to the policy file would. */
  setProfiles(profiles: BrowserProfile[]): void;
  /** End the browser of the most recent launch, as withdrawal or a crash would. */
  endBrowser(): Promise<void>;
  /** End the browser of one launch, counted from the first. */
  endLaunch(index: number): Promise<void>;
  /** This machine's interface addresses, as the classifier reads them; push to add one. */
  readonly interfaces: string[];
  cookieSites: string[];
  /** Every launch waits on this while it is set, as a Chrome still starting does. */
  launchHeld?: Promise<void>;
}

export function harness(
  options: {
    browsers?: BrowserProfile[];
    chrome?: ChromeDiscovery;
    world?: Partial<FakeWorld>;
    /** A browser told to stop goes on running until the test ends it, as a slow exit does. */
    slowExit?: boolean;
  } = {},
): Harness {
  const world: FakeWorld = {
    sites: options.world?.sites ?? new Map(),
    redirects: options.world?.redirects ?? new Map(),
    localHosts: options.world?.localHosts ?? new Set(),
    failures: options.world?.failures ?? new Map(),
    subresources: options.world?.subresources ?? new Map(),
    ...(options.world?.onAct !== undefined ? { onAct: options.world.onAct } : {}),
    ...(options.world?.duringLoad !== undefined ? { duringLoad: options.world.duringLoad } : {}),
  };
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const launches: ChromeLaunchInput[] = [];
  const pages: FakePage[] = [];
  const proxies: FakeProxy[] = [];
  const stops: number[] = [];
  const interfaces: string[] = [];
  const ends: Array<() => void> = [];
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const launcher: ChromeLauncher = {
    launch: async (input) => {
      launches.push(input);
      let end: () => void = () => undefined;
      const exited = new Promise<void>((resolve) => {
        end = resolve;
      });
      ends.push(end);
      if (state.launchHeld !== undefined) await state.launchHeld;
      return {
        endpoint: 'ws://127.0.0.1:9/devtools/browser/x',
        exited,
        stop: () => {
          stops.push(clock.now);
          if (options.slowExit !== true) end();
        },
      };
    },
  };
  const state: Harness = {
    driver: undefined as unknown as BrowserDriver,
    world,
    launches,
    pages,
    proxies,
    stops,
    clock,
    cookieSites: ['accounts.example.com', 'mail.example.com'],
    setProfiles: (profiles) => {
      policy = { ...policy, browsers: new Map(profiles.map((profile) => [profile.id, profile])) };
    },
    endBrowser: async () => {
      ends.at(-1)?.();
      await settle();
    },
    endLaunch: async (index) => {
      ends[index]?.();
      await settle();
    },
    interfaces,
  };
  const engine: BrowserEngine = {
    connect: () =>
      Promise.resolve({
        newPage: (events: PageEvents) => {
          if (world.newPageFails !== undefined) {
            return Promise.reject(new Error(world.newPageFails));
          }
          const page = new FakePage(world, () => proxies[proxies.length - 1] as FakeProxy, events);
          pages.push(page);
          return Promise.resolve(page);
        },
        cookieSites: () => Promise.resolve([...state.cookieSites]),
        disconnect: () => Promise.resolve(),
      }),
  };
  const browsers = options.browsers ?? [BrowserProfileSchema.parse({ id: 'default' })];
  let policy: BrowserPolicy = {
    browsers: new Map(browsers.map((profile) => [profile.id, profile])),
    chrome: options.chrome ?? CHROME,
  };
  const driver = new BrowserDriver({
    engine,
    launcher,
    hostDir: '/Users/op/.aflow',
    loadPolicy: () => Promise.resolve(policy),
    startProxy: (proxyOptions) => {
      const proxy = new FakeProxy(proxyOptions, world, now);
      proxies.push(proxy);
      return Promise.resolve(proxy);
    },
    // The real ranges, with the interfaces the test sets rather than this
    // machine's, so the answer does not depend on where the test runs.
    classifier: createLocalAddressClassifier({ readInterfaces: () => interfaces, now }),
    now,
  });
  return Object.assign(state, { driver });
}

export const RUN_A = { tenantId: 't1', runId: 'run-a', spaceId: 'space-1' };
export const RUN_B = { tenantId: 't1', runId: 'run-b', spaceId: 'space-1' };

export async function refusal(promise: Promise<unknown>): Promise<BrowserDriverError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BrowserDriverError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

export function thrown(fn: () => unknown): BrowserDriverError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BrowserDriverError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

export function profile(fields: Record<string, unknown> & { id?: string } = {}): BrowserProfile {
  return BrowserProfileSchema.parse({ id: 'default', ...fields });
}
