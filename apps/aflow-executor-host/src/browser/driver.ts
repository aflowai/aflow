/**
 * The browser driver: one Chrome per profile, started on first use behind its
 * own egress proxy, and the pages each run opened in it.
 *
 * Every rule lives here, so the step handler and any later consumer of the
 * same browser read one policy point: which profiles exist, which spaces may
 * use each, what a profile's posture and origin rules allow, which run owns a
 * page, and that an action is never performed twice.
 */
import type { BrowserProfile } from '@aflow/schemas';

import { type LocalAddressClassifier, machineAddresses } from './addresses.js';
import { chromeMissingMessage, type ChromeDiscovery } from './chromeDiscovery.js';
import type { ChromeLauncher, LaunchedChrome } from './chromeProcess.js';
import { type EgressProxy, type StartEgressProxy, startEgressProxy } from './egressProxy.js';
import { BrowserDriverError, errorText } from './errors.js';
import { boundEntries, boundText, PageObservations } from './observations.js';
import { localDestinationRefusal, obviouslyLocalDestination } from './origins.js';
import { applyPolicyChange } from './policyChange.js';
import {
  landedRefusal,
  navigationFailure,
  refusalError,
  urlOrNothing,
} from './refusalAttribution.js';
import type {
  ActionResult,
  ActRequest,
  ChangeReceipt,
  IdleSweep,
  ListedPage,
  ListedProfile,
  NavigateRequest,
  NavigationResult,
  OpenedPage,
  OpenRequest,
  PageView,
  ReadResult,
  RunScope,
  SnapshotResult,
} from './driverTypes.js';
import { boundSnapshot, buildOutline, describeRef } from './outline.js';
import { closeWithinDeadline, PageTable, type HeldPage, type PageOwner } from './pageTable.js';
import { profileOpenToSpace } from './profiles.js';
import { assertActionAllowed, assertNavigationAllowed, ruleRefusingHost } from './rules.js';
import {
  type BrowserEngine,
  type EngineBrowser,
  EngineCredentialField,
  type EnginePage,
  EngineRefNotFound,
  type PageEvents,
} from './types.js';

const CONNECT_TIMEOUT_MS = 15_000;
const MINUTE_MS = 60_000;

export interface BrowserPolicy {
  readonly browsers: ReadonlyMap<string, BrowserProfile>;
  readonly chrome: ChromeDiscovery;
}

export interface BrowserDriverDeps {
  readonly engine: BrowserEngine;
  readonly launcher: ChromeLauncher;
  /** The directory holding host-policy.json; profiles live beneath it. */
  readonly hostDir: string;
  /** Read on every open, move and action, so a profile the operator changed applies at once. */
  readonly loadPolicy: () => Promise<BrowserPolicy>;
  readonly startProxy?: StartEgressProxy;
  /** Tests fix it; otherwise this machine's addresses, read as each decision is made. */
  readonly classifier?: LocalAddressClassifier;
  readonly now?: () => number;
}

/**
 * What changes as the profile is used; the proxy reads the profile from here on
 * every connection. Only the start and a policy change write `profile`.
 */
interface ProfileState {
  profile: BrowserProfile;
  lastActivityAt: number;
  /** A policy change removed the profile while its browser was starting. */
  withdrawn: boolean;
}

interface RunningProfile {
  readonly browser: EngineBrowser;
  readonly chrome: LaunchedChrome;
  readonly proxy: EgressProxy;
  readonly state: ProfileState;
}

interface PageInUse {
  readonly held: HeldPage;
  readonly running: RunningProfile;
  readonly profile: BrowserProfile;
}

/** A profile's browser from the moment its start begins; `state` is the one it will run with. */
interface Launch {
  readonly ready: Promise<RunningProfile>;
  readonly state: ProfileState;
}

function listed(ids: readonly string[]): string {
  return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(', ') : 'none';
}

function pageEvents(observations: PageObservations): PageEvents {
  return {
    console: (level, text) => {
      observations.recordConsole(level, text);
    },
    request: (request) => {
      observations.recordRequest(request);
    },
  };
}

const HISTORY_WORDS: Readonly<Record<'back' | 'forward', string>> = {
  back: 'back to',
  forward: 'forward to',
};

export class BrowserDriver {
  private readonly pages = new PageTable();
  private readonly starting = new Map<string, Launch>();
  private readonly running = new Map<string, RunningProfile>();
  private readonly everStarted = new Set<string>();
  /** Operations holding a profile's browser; the idle sweep leaves those profiles alone. */
  private readonly inFlight = new Map<string, number>();
  /** Raised by every policy change, so an operation can tell its read of the policy is stale. */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly deps: BrowserDriverDeps) {
    this.now = deps.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Opening and moving
  // -------------------------------------------------------------------------

  async open(request: OpenRequest): Promise<OpenedPage> {
    const { policy, generation } = await this.currentPolicy();
    const profile = this.resolveProfile(policy, request.profileId, request.spaceId);
    const asked = new URL(request.url);
    this.refuseObviouslyLocal(profile, asked);
    assertNavigationAllowed(profile, asked);
    if (request.redelivered) return await this.reopened(request, profile, asked);

    const executable = policy.chrome.found?.path;
    if (executable === undefined) {
      throw new BrowserDriverError('no_browser', chromeMissingMessage(policy.chrome));
    }

    let running: RunningProfile;
    try {
      running = await this.ensureRunning(profile, executable);
    } catch (error) {
      // A start the policy change stopped is answered as the change answers it;
      // a policy file unreadable mid-save says nothing about why the start failed.
      try {
        await this.stillAllowed(generation, profile, request, asked);
      } catch (refusal) {
        if (refusal instanceof BrowserDriverError) throw refusal;
      }
      throw error;
    }
    try {
      const allowed = await this.stillAllowed(generation, profile, request, asked);
      return {
        outcome: 'performed',
        ...(await this.openIn(running, allowed, generation, request, asked)),
      };
    } finally {
      this.release(profile.id);
    }
  }

  /**
   * A later attempt of an open: the earlier one may have loaded the address
   * with the profile's sign-ins and left a page, so it is not loaded again.
   */
  private async reopened(
    request: OpenRequest,
    profile: BrowserProfile,
    asked: URL,
  ): Promise<OpenedPage> {
    const pages = this.pages.list(request);
    const earlier = pages
      .filter((held) => held.profileId === profile.id && held.requestedUrl === asked.href)
      .at(-1);
    if (earlier === undefined) {
      throw new BrowserDriverError(
        'open_uncertain',
        `This open of ${asked.href} was delivered again, and whether the earlier attempt loaded ` +
          `it is unknown; this run holds no page opened there, so nothing was opened now. The ` +
          `run's open pages: ${listed(pages.map((held) => held.pageId))}. List them to see ` +
          'where each is before opening the address again.',
        { url: asked.href },
      );
    }
    return {
      outcome: 'uncertain_outcome',
      ...(await this.observe(earlier, this.runningFor(earlier))),
    };
  }

  private async openIn(
    running: RunningProfile,
    allowed: BrowserProfile,
    generation: number,
    request: OpenRequest,
    asked: URL,
  ): Promise<PageView> {
    const observations = new PageObservations(this.now);
    let page: EnginePage;
    try {
      page = await running.browser.newPage(pageEvents(observations));
    } catch (error) {
      throw new BrowserDriverError(
        'navigation_failed',
        `${request.url} did not load: the browser for profile \`${allowed.id}\` could not open ` +
          `a page (${errorText(error)}). It may have been stopping; opening the address again ` +
          'starts it afresh.',
      );
    }
    const startedAt = this.now();
    try {
      await page.navigate({ kind: 'url', url: request.url });
    } catch (error) {
      await closeWithinDeadline(page);
      throw navigationFailure(
        running.proxy,
        allowed,
        asked,
        startedAt,
        `${request.url} did not load`,
        error,
      );
    }

    // A change applied while the page loaded never saw it, so it is checked here.
    let profile: BrowserProfile;
    try {
      profile = await this.stillAllowed(generation, allowed, request, asked);
    } catch (error) {
      await closeWithinDeadline(page);
      throw error;
    }
    const held = this.pages.add(
      request,
      profile.id,
      asked.href,
      page,
      observations,
      page.url(),
      this.now(),
    );
    try {
      this.assertLanded(running, profile, page.url(), startedAt);
      return await this.observe(held, running);
    } catch (error) {
      // Registered and then refused or unreadable: a run must not be left
      // holding a page it was told it does not have.
      this.pages.forget(held);
      await closeWithinDeadline(page);
      throw error;
    }
  }

  async navigate(request: NavigateRequest): Promise<NavigationResult> {
    return await this.usingPage(request, request.pageId, async (use) => {
      return await this.navigateOn(request, use);
    });
  }

  private async navigateOn(
    request: NavigateRequest,
    { held, running, profile }: PageInUse,
  ): Promise<NavigationResult> {
    const asked = request.to.kind === 'url' ? new URL(request.to.url) : undefined;
    if (asked !== undefined) {
      this.refuseObviouslyLocal(profile, asked);
      assertNavigationAllowed(profile, asked);
    }
    if (request.redelivered) {
      return { outcome: 'uncertain_outcome', view: await this.observe(held, running) };
    }

    const before = this.lastSeen(held);
    const startedAt = this.now();
    let moved: boolean;
    try {
      moved = await held.page.navigate(request.to);
    } catch (error) {
      throw navigationFailure(
        running.proxy,
        profile,
        asked,
        startedAt,
        asked !== undefined ? `${asked.href} did not load` : `The ${request.to.kind} did not load`,
        error,
      );
    }
    if (!moved && (request.to.kind === 'back' || request.to.kind === 'forward')) {
      throw new BrowserDriverError(
        'navigation_failed',
        `Page \`${held.pageId}\` has no page to go ${HISTORY_WORDS[request.to.kind]} in its ` +
          `history. It is still at ${held.page.url()}.`,
        { pageId: held.pageId },
      );
    }
    this.assertLanded(running, profile, held.page.url(), startedAt);
    const view = await this.observe(held, running);
    return { outcome: 'performed', view, changed: this.changes(before, view) };
  }

  async act(request: ActRequest): Promise<ActionResult> {
    return await this.usingPage(request, request.pageId, async (use) => {
      return await this.actOn(request, use);
    });
  }

  private async actOn(
    request: ActRequest,
    { held, running, profile }: PageInUse,
  ): Promise<ActionResult> {
    // Where the page is now, not where the agent believes it is.
    const pageUrl = urlOrNothing(held.page.url()) ?? new URL('about:blank');
    assertActionAllowed(profile, pageUrl);
    if (request.redelivered) {
      return { outcome: 'uncertain_outcome', view: await this.observe(held, running) };
    }

    const snapshot = held.lastSnapshot;
    const element = snapshot !== undefined ? describeRef(snapshot.text, request.ref) : undefined;
    if (snapshot === undefined || element === undefined) {
      throw await this.staleRef(held, running, request.ref);
    }
    if (request.action.kind === 'type' && snapshot.maskedRefs.has(request.ref)) {
      throw this.credentialRefusal(request.ref, element.name);
    }
    // A reference can belong to an element inside a frame from another site,
    // which a rule for the page around it says nothing about.
    let frameUrl: string;
    try {
      frameUrl = await held.page.frameUrl(request.ref);
    } catch (error) {
      if (error instanceof EngineRefNotFound) throw await this.staleRef(held, running, request.ref);
      throw new BrowserDriverError(
        'action_failed',
        `Which frame \`${request.ref}\` belongs to could not be read, so it was not acted on: ` +
          errorText(error),
        { ref: request.ref },
      );
    }
    assertActionAllowed(profile, pageUrl, urlOrNothing(frameUrl) ?? new URL('about:blank'));

    const before = this.lastSeen(held);
    const startedAt = this.now();
    try {
      await held.page.act(request.ref, request.action);
    } catch (error) {
      if (error instanceof EngineRefNotFound) throw await this.staleRef(held, running, request.ref);
      if (error instanceof EngineCredentialField) {
        throw this.credentialRefusal(request.ref, element.name);
      }
      throw new BrowserDriverError(
        'action_failed',
        `The ${request.action.kind} on \`${request.ref}\` did not complete: ${errorText(error)}`,
        { ref: request.ref },
      );
    }
    this.assertLanded(running, profile, held.page.url(), startedAt);
    const view = await this.observe(held, running);
    const action = request.action;
    return {
      outcome: 'performed',
      view,
      changed: this.changes(before, view),
      element,
      ...(action.kind === 'type'
        ? {
            typed: {
              field: element.name ?? element.role,
              characters: [...new Intl.Segmenter().segment(action.text)].length,
              submitted: action.submit,
            },
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Looking
  // -------------------------------------------------------------------------

  async snapshot(scope: RunScope, pageId: string, ref?: string): Promise<SnapshotResult> {
    return await this.usingPage(scope, pageId, async ({ held, running }) => {
      const snap = await this.read(held, async () => await held.page.snapshot());
      const title = await this.read(held, async () => await held.page.title());
      held.lastSnapshot = snap;
      held.lastTitle = title;
      held.lastUrl = held.page.url();
      this.touch(held, running);
      const bounded = boundSnapshot(snap, ref);
      if (bounded === undefined) {
        throw this.staleRefError(held, ref ?? '', buildOutline(snap).text);
      }
      return { pageId, url: held.lastUrl, title, snapshot: bounded };
    });
  }

  async readPage(
    scope: RunScope,
    pageId: string,
    what: ReadResult['what'],
    contains?: string,
  ): Promise<ReadResult> {
    return await this.usingPage(scope, pageId, async ({ held }) => {
      return await this.readOn(held, what, contains);
    });
  }

  private async readOn(
    held: HeldPage,
    what: ReadResult['what'],
    contains: string | undefined,
  ): Promise<ReadResult> {
    const url = held.page.url();
    if (what === 'text') {
      const text = await this.read(held, async () => await held.page.text());
      return { what, url, ...boundText(text, contains) };
    }
    if (what === 'console') {
      const { kept, withheld } = boundEntries(
        held.observations.console.entries(),
        contains,
        (entry) => entry.text,
      );
      return {
        what,
        url,
        console: kept,
        withheld,
        notRetained: held.observations.console.notRetained,
      };
    }
    const { kept, withheld } = boundEntries(
      held.observations.network.entries(),
      contains,
      (entry) => entry.url,
    );
    return {
      what,
      url,
      network: kept,
      withheld,
      notRetained: held.observations.network.notRetained,
    };
  }

  /**
   * The run's open pages in profiles its space may still use. A page in one it
   * may not is refused by every operation but close, so it is not offered.
   * Listing touches none of them.
   */
  async list(scope: RunScope): Promise<ListedPage[]> {
    const policy = await this.deps.loadPolicy();
    const pages = this.pages.list(scope).filter((held) => {
      const profile = policy.browsers.get(held.profileId);
      return profile !== undefined && profileOpenToSpace(profile, scope.spaceId);
    });
    return await Promise.all(
      pages.map(async (held) => ({
        pageId: held.pageId,
        url: held.page.url(),
        title: await held.page.title().catch(() => held.lastTitle),
        profileId: held.profileId,
        lastUsedAt: held.lastUsedAt,
      })),
    );
  }

  async close(owner: PageOwner, pageId: string): Promise<'closed' | 'already_gone'> {
    const held = this.pages.find(owner, pageId);
    if (held === undefined) return 'already_gone';
    // Forgotten before the close is awaited, so a hung close leaves nothing usable.
    this.pages.forget(held);
    await closeWithinDeadline(held.page);
    const running = this.running.get(held.profileId);
    if (running !== undefined) running.state.lastActivityAt = this.now();
    return 'closed';
  }

  /** The profiles a space may use. Never starts a browser to answer. */
  async listProfiles(spaceId: string | undefined): Promise<ListedProfile[]> {
    const policy = await this.deps.loadPolicy();
    const open = [...policy.browsers.values()].filter((profile) =>
      profileOpenToSpace(profile, spaceId),
    );
    return await Promise.all(
      open.map(async (profile): Promise<ListedProfile> => {
        const base = { profileId: profile.id, posture: profile.posture, window: profile.window };
        const running = this.running.get(profile.id);
        if (running === undefined) {
          return {
            ...base,
            running: false,
            sitesUnknown: this.everStarted.has(profile.id) ? 'stopped' : 'not_started',
          };
        }
        let sites: string[];
        try {
          sites = await running.browser.cookieSites();
        } catch (error) {
          throw new BrowserDriverError(
            'observation_failed',
            `The browser for profile \`${profile.id}\` is running but did not say which sites ` +
              `it holds cookies for: ${errorText(error)}`,
          );
        }
        return { ...base, running: true, sites };
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Lifetime
  // -------------------------------------------------------------------------

  /** Profiles whose browser is running now: the idle sweep's whole work. */
  runningProfileCount(): number {
    return this.running.size;
  }

  /**
   * Close pages nothing has touched for their profile's idle limit, then stop
   * browsers that have had no page for as long — at most `limit` of the two
   * together, the rest left for the next sweep. A profile with an operation
   * in flight is passed over.
   */
  async sweepIdle(limit: number): Promise<IdleSweep> {
    const now = this.now();
    let closedPages = 0;
    for (const held of this.pages.all()) {
      if (closedPages >= limit) break;
      const running = this.running.get(held.profileId);
      if (running === undefined || this.busy(held.profileId)) continue;
      if (now - held.lastUsedAt < running.state.profile.idleMinutes * MINUTE_MS) continue;
      this.pages.forget(held);
      await closeWithinDeadline(held.page);
      running.state.lastActivityAt = Math.max(running.state.lastActivityAt, now);
      closedPages += 1;
    }
    let stoppedProfiles = 0;
    for (const [profileId, running] of [...this.running]) {
      if (closedPages + stoppedProfiles >= limit) break;
      if (this.busy(profileId) || this.pages.countForProfile(profileId) > 0) continue;
      if (now - running.state.lastActivityAt < running.state.profile.idleMinutes * MINUTE_MS) {
        continue;
      }
      this.stopBrowser(profileId);
      stoppedProfiles += 1;
    }
    return { closedPages, stoppedProfiles };
  }

  /**
   * The machine's policy changed: browsers running or starting, and their
   * pages, follow it at once.
   */
  async policyChanged(policy: BrowserPolicy): Promise<void> {
    this.generation += 1;
    const browsers = new Map<string, { state: ProfileState }>(this.starting);
    for (const [profileId, running] of this.running) browsers.set(profileId, running);
    await applyPolicyChange(
      {
        pages: this.pages,
        browsers,
        stop: (id) => {
          this.stopBrowser(id);
        },
      },
      policy.browsers,
    );
  }

  private stopBrowser(profileId: string): void {
    const running = this.running.get(profileId);
    const launch = this.starting.get(profileId);
    // Gone from both maps before it has exited, so the next open starts a
    // fresh browser rather than being handed this one.
    this.running.delete(profileId);
    this.starting.delete(profileId);
    if (running !== undefined) running.chrome.stop();
    else if (launch !== undefined) launch.state.withdrawn = true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Runs an operation on one of the run's pages, its profile counted as in
   * flight throughout and the page marked used before the engine is called, so
   * the idle sweep cannot close the page under it.
   */
  private async usingPage<T>(
    scope: RunScope,
    pageId: string,
    operation: (use: PageInUse) => Promise<T>,
  ): Promise<T> {
    const held = this.pages.get(scope, pageId);
    this.inFlight.set(held.profileId, (this.inFlight.get(held.profileId) ?? 0) + 1);
    try {
      const policy = await this.deps.loadPolicy();
      const profile = this.resolveProfile(policy, held.profileId, scope.spaceId);
      const running = this.runningFor(held);
      this.touch(held, running);
      return await operation({ held, running, profile });
    } finally {
      this.release(held.profileId);
    }
  }

  private runningFor(held: HeldPage): RunningProfile {
    const running = this.running.get(held.profileId);
    if (running !== undefined) return running;
    this.pages.forget(held);
    throw new BrowserDriverError(
      'page_gone',
      `page_gone: page \`${held.pageId}\` is no longer open — its browser stopped. It was last ` +
        `at ${held.lastUrl}; open that address again to carry on.`,
      { pageId: held.pageId, lastUrl: held.lastUrl },
    );
  }

  private touch(held: HeldPage, running: RunningProfile): void {
    const now = this.now();
    held.lastUsedAt = now;
    running.state.lastActivityAt = now;
  }

  private async read<T>(held: HeldPage, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new BrowserDriverError(
        'observation_failed',
        `Page \`${held.pageId}\` could not be read: ${errorText(error)}`,
        { pageId: held.pageId },
      );
    }
  }

  private async observe(held: HeldPage, running: RunningProfile): Promise<PageView> {
    const snapshot = await this.read(held, async () => await held.page.snapshot());
    const title = await this.read(held, async () => await held.page.title());
    held.lastSnapshot = snapshot;
    held.lastTitle = title;
    held.lastUrl = held.page.url();
    this.touch(held, running);
    return { pageId: held.pageId, url: held.lastUrl, title, outline: buildOutline(snapshot) };
  }

  private lastSeen(held: HeldPage): { url: string; title: string; outline?: string } {
    return {
      url: held.page.url(),
      title: held.lastTitle,
      ...(held.lastSnapshot !== undefined ? { outline: buildOutline(held.lastSnapshot).text } : {}),
    };
  }

  private changes(
    before: { url: string; title: string; outline?: string },
    after: PageView,
  ): ChangeReceipt {
    return {
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
      outlineChanged: before.outline !== after.outline.text,
    };
  }

  private staleRefError(held: HeldPage, ref: string, outline?: string): BrowserDriverError {
    return new BrowserDriverError(
      'stale_ref',
      `Reference \`${ref}\` does not resolve on page \`${held.pageId}\` as it is now ` +
        `(${held.lastUrl}). References come from the newest outline or snapshot of the page; the ` +
        'current outline is in this error’s details — act on its references.',
      {
        ref,
        pageId: held.pageId,
        url: held.lastUrl,
        ...(outline !== undefined ? { outline } : {}),
      },
    );
  }

  private async staleRef(
    held: HeldPage,
    running: RunningProfile,
    ref: string,
  ): Promise<BrowserDriverError> {
    const outline = await this.observe(held, running)
      .then((view) => view.outline.text)
      .catch(() => undefined);
    return this.staleRefError(held, ref, outline);
  }

  private credentialRefusal(ref: string, name: string | undefined): BrowserDriverError {
    return new BrowserDriverError(
      'credential_field',
      `\`${ref}\`${name !== undefined ? ` (${JSON.stringify(name)})` : ''} is a password field. ` +
        'Credentials are entered by the operator, in the browser window, never typed by an ' +
        'agent; nothing was typed.',
      { ref },
    );
  }

  private refuseObviouslyLocal(profile: BrowserProfile, url: URL): void {
    const reason = obviouslyLocalDestination(url, this.deps.classifier ?? machineAddresses);
    if (reason === undefined) return;
    throw new BrowserDriverError(
      'appliance_origin',
      localDestinationRefusal(profile.id, reason, 'asked'),
      {
        origin: url.origin,
      },
    );
  }

  private assertLanded(
    running: RunningProfile,
    profile: BrowserProfile,
    landedUrl: string,
    since: number,
  ): void {
    const landed = urlOrNothing(landedUrl);
    if (landed === undefined || (landed.protocol !== 'http:' && landed.protocol !== 'https:')) {
      return;
    }
    const refused = landedRefusal(running.proxy, landed, since);
    if (refused !== undefined) throw refusalError(profile, refused);
    this.refuseObviouslyLocal(profile, landed);
    assertNavigationAllowed(profile, landed);
  }

  /** The policy, with the generation it is current for. */
  private async currentPolicy(): Promise<{ policy: BrowserPolicy; generation: number }> {
    for (;;) {
      const generation = this.generation;
      const policy = await this.deps.loadPolicy();
      // A change applied during the read may be newer than the file it read.
      if (generation === this.generation) return { policy, generation };
    }
  }

  /**
   * The profile an open that read the policy at `generation` goes on with:
   * the one it read, unless a change has landed since — then the profile as
   * the policy now has it, refused as any open is if the run may no longer
   * use it or the address.
   */
  private async stillAllowed(
    generation: number,
    profile: BrowserProfile,
    request: OpenRequest,
    asked: URL,
  ): Promise<BrowserProfile> {
    if (generation === this.generation) return profile;
    const { policy } = await this.currentPolicy();
    const now = this.resolveProfile(policy, request.profileId, request.spaceId);
    this.refuseObviouslyLocal(now, asked);
    assertNavigationAllowed(now, asked);
    return now;
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

  private busy(profileId: string): boolean {
    return (this.inFlight.get(profileId) ?? 0) > 0;
  }

  private release(profileId: string): void {
    const count = (this.inFlight.get(profileId) ?? 0) - 1;
    if (count > 0) this.inFlight.set(profileId, count);
    else this.inFlight.delete(profileId);
  }

  private withdrawnWhileStarting(profileId: string): BrowserDriverError {
    return new BrowserDriverError(
      'launch_failed',
      `The browser for profile \`${profileId}\` was stopped as it started: the profile was ` +
        "removed from this machine's policy meanwhile.",
    );
  }

  /** The profile's browser, counted as in use until the caller's `release`. */
  private async ensureRunning(
    profile: BrowserProfile,
    executable: string,
  ): Promise<RunningProfile> {
    let launch = this.starting.get(profile.id);
    if (launch === undefined) {
      const state: ProfileState = { profile, lastActivityAt: this.now(), withdrawn: false };
      launch = { state, ready: this.start(profile.id, executable, state) };
      this.starting.set(profile.id, launch);
    }
    let running: RunningProfile;
    try {
      running = await launch.ready;
    } catch (error) {
      if (this.starting.get(profile.id) === launch) this.starting.delete(profile.id);
      throw error;
    }
    this.inFlight.set(profile.id, (this.inFlight.get(profile.id) ?? 0) + 1);
    return running;
  }

  private async start(
    profileId: string,
    executable: string,
    state: ProfileState,
  ): Promise<RunningProfile> {
    // Before Chrome, so no request of Chrome's ever goes out unchecked.
    const proxy = await (this.deps.startProxy ?? startEgressProxy)({
      refuseHost: (host) => ruleRefusingHost(state.profile, host),
      classifier: this.deps.classifier ?? machineAddresses,
      now: this.now,
    });
    let chrome: LaunchedChrome;
    try {
      chrome = await this.deps.launcher.launch({
        executable,
        hostDir: this.deps.hostDir,
        profile: state.profile,
        proxyServer: proxy.server,
      });
    } catch (error) {
      await proxy.stop().catch(() => undefined);
      throw error;
    }
    let browser: EngineBrowser;
    try {
      browser = await this.deps.engine.connect(chrome.endpoint, CONNECT_TIMEOUT_MS);
    } catch (error) {
      chrome.stop();
      await proxy.stop().catch(() => undefined);
      throw new BrowserDriverError(
        'launch_failed',
        `The browser for profile \`${profileId}\` started but could not be attached to: ` +
          errorText(error),
      );
    }
    if (state.withdrawn) {
      chrome.stop();
      await browser.disconnect().catch(() => undefined);
      await proxy.stop().catch(() => undefined);
      throw this.withdrawnWhileStarting(profileId);
    }
    const entry: RunningProfile = { browser, chrome, proxy, state };
    this.running.set(profileId, entry);
    this.everStarted.add(profileId);
    // Whoever ends it — the idle sweep, withdrawal, shutdown, a crash — its
    // proxy and its pages go with it, and the next open starts it again.
    void chrome.exited.then(async () => {
      // A browser the sweep stopped is already out of both maps, and the
      // profile may be running again in a fresh one by now.
      if (this.running.get(profileId) === entry) {
        this.running.delete(profileId);
        this.starting.delete(profileId);
        this.pages.dropProfile(profileId);
      }
      await browser.disconnect().catch(() => undefined);
      await proxy.stop().catch(() => undefined);
    });
    return entry;
  }
}
