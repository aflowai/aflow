/**
 * The browser driver: one Chrome per profile, started on first use, and the
 * pages each run opened in it.
 *
 * Every rule about who may open what lives here, so the step handler and any
 * later consumer of the same browser read one policy point: which profiles
 * exist, which spaces may use each, which origins a signed-in profile refuses,
 * and which run owns a page.
 */
import type { BrowserProfile } from '@aflow/schemas';

import { chromeMissingMessage, type ChromeDiscovery } from './chromeDiscovery.js';
import type { ChromeLauncher, LaunchedChrome } from './chromeProcess.js';
import { BrowserDriverError } from './errors.js';
import { applianceOriginRefusal, isApplianceOrigin } from './origins.js';
import { buildOutline, type Outline } from './outline.js';
import { PageTable, type HeldPage, type PageOwner } from './pageTable.js';
import { profileOpenToSpace } from './profiles.js';
import type { BrowserEngine, EngineBrowser } from './types.js';

const NAVIGATION_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 15_000;

export interface BrowserPolicy {
  readonly browsers: ReadonlyMap<string, BrowserProfile>;
  readonly chrome: ChromeDiscovery;
}

export interface BrowserDriverDeps {
  readonly engine: BrowserEngine;
  readonly launcher: ChromeLauncher;
  /** The directory holding host-policy.json; profiles live beneath it. */
  readonly hostDir: string;
  /** Read on every open, so a profile the operator removed is gone at once. */
  readonly loadPolicy: () => Promise<BrowserPolicy>;
  readonly navigationTimeoutMs?: number;
}

export interface OpenRequest extends PageOwner {
  readonly spaceId?: string;
  readonly profileId: string;
  readonly url: string;
}

export interface OpenedPage {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly outline: Outline;
}

interface RunningProfile {
  readonly browser: EngineBrowser;
  readonly chrome: LaunchedChrome;
}

function listed(ids: readonly string[]): string {
  return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(', ') : 'none';
}

export class BrowserDriver {
  private readonly pages = new PageTable();
  private readonly running = new Map<string, Promise<RunningProfile>>();

  constructor(private readonly deps: BrowserDriverDeps) {}

  async open(request: OpenRequest): Promise<OpenedPage> {
    const policy = await this.deps.loadPolicy();
    const profile = this.resolveProfile(policy, request.profileId, request.spaceId);

    // Every profile a policy declares persists sign-ins.
    const asked = new URL(request.url);
    if (isApplianceOrigin(asked)) {
      throw new BrowserDriverError(
        'appliance_origin',
        applianceOriginRefusal(profile.id, asked, 'asked'),
      );
    }

    const executable = policy.chrome.found?.path;
    if (executable === undefined) {
      throw new BrowserDriverError('no_browser', chromeMissingMessage(policy.chrome));
    }

    const { browser } = await this.ensureRunning(profile, executable);
    const page = await browser.newPage();
    try {
      await page.goto(request.url, this.deps.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS);
    } catch (error) {
      await page.close().catch(() => undefined);
      throw new BrowserDriverError(
        'navigation_failed',
        `${request.url} did not load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const landed = new URL(page.url());
    if (isApplianceOrigin(landed)) {
      await page.close().catch(() => undefined);
      throw new BrowserDriverError(
        'appliance_origin',
        applianceOriginRefusal(profile.id, landed, 'redirected'),
      );
    }

    const held = this.pages.add(request, profile.id, page, page.url());
    const [title, snapshot] = await Promise.all([page.title(), page.snapshot()]);
    return { pageId: held.pageId, url: held.lastUrl, title, outline: buildOutline(snapshot) };
  }

  /** A page this run opened, or `page_gone`. */
  page(owner: PageOwner, pageId: string): HeldPage {
    return this.pages.get(owner, pageId);
  }

  private resolveProfile(
    policy: BrowserPolicy,
    profileId: string,
    spaceId: string | undefined,
  ): BrowserProfile {
    const profile = policy.browsers.get(profileId);
    if (profile === undefined) {
      if (policy.browsers.size === 0 && policy.chrome.found === undefined) {
        throw new BrowserDriverError('no_browser', chromeMissingMessage(policy.chrome));
      }
      throw new BrowserDriverError(
        'unknown_profile',
        `This machine has no browser profile \`${profileId}\`. Profiles configured here: ` +
          `${listed([...policy.browsers.keys()])}. A profile is declared on the machine; a run ` +
          'cannot add one.',
      );
    }
    if (!profileOpenToSpace(profile, spaceId)) {
      const open = [...policy.browsers.values()]
        .filter((candidate) => profileOpenToSpace(candidate, spaceId))
        .map((candidate) => candidate.id);
      throw new BrowserDriverError(
        'profile_not_for_space',
        `Browser profile \`${profileId}\` is not open to this space. Profiles this space may ` +
          `use: ${listed(open)}. Which spaces a profile serves is set on the machine.`,
      );
    }
    return profile;
  }

  private async ensureRunning(
    profile: BrowserProfile,
    executable: string,
  ): Promise<RunningProfile> {
    const existing = this.running.get(profile.id);
    if (existing !== undefined) return await existing;

    const starting = this.start(profile, executable);
    this.running.set(profile.id, starting);
    try {
      return await starting;
    } catch (error) {
      if (this.running.get(profile.id) === starting) this.running.delete(profile.id);
      throw error;
    }
  }

  private async start(profile: BrowserProfile, executable: string): Promise<RunningProfile> {
    const chrome = await this.deps.launcher.launch({
      executable,
      hostDir: this.deps.hostDir,
      profile,
    });
    let browser: EngineBrowser;
    try {
      browser = await this.deps.engine.connect(chrome.endpoint, CONNECT_TIMEOUT_MS);
    } catch (error) {
      chrome.stop();
      throw new BrowserDriverError(
        'launch_failed',
        `The browser for profile \`${profile.id}\` started but could not be attached to: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const entry: RunningProfile = { browser, chrome };
    // Whoever ends it — withdrawal, shutdown, a crash — its pages go with it,
    // and the next open starts it again.
    void chrome.exited.then(() => {
      void browser.disconnect().catch(() => undefined);
      this.running.delete(profile.id);
      this.pages.dropProfile(profile.id);
    });
    return entry;
  }
}
