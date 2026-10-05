/**
 * The browser driver: one Chrome per profile, started on first use behind its
 * own egress proxy, and the pages each run opened in it.
 *
 * Every rule lives here, so the step handler and any later consumer of the
 * same browser read one policy point: which profiles exist, which spaces may
 * use each, what a profile's posture and origin rules allow, which run owns a
 * page, and that an action is never performed twice. Each profile's Chrome is
 * `ProfileBrowsers`'; the operator's window is `OperatorWindows`'.
 */
import {
  BROWSER_OUTLINE_MAX_CHARS,
  BROWSER_READ_DEFAULT_CHARS,
  type BrowserProfile,
  grantAnswersAsk,
} from '@aflow/schemas';

import {
  askStandsUntil,
  BrowserApprovalRequired,
  browserCallKey,
  clearAction,
  forfeitApproval,
} from './actionApproval.js';
import { type LocalAddressClassifier, machineAddresses } from './addresses.js';
import type { ChromeLauncher } from './chromeProcess.js';
import { CREDENTIAL_FIELD_KEYS, entersValue, MODIFIERS } from './credentialFields.js';
import {
  decideByName,
  egressHost,
  type StartEgressProxy,
  startEgressProxy,
} from './egressProxy.js';
import { EphemeralProfiles } from './ephemeralProfiles.js';
import { BrowserDriverError, errorText } from './errors.js';
import { boundEntries, boundText, PageObservations } from './observations.js';
import { type HandoffBoard, NO_BOARD } from './handoffBoard.js';
import { OperatorWindows, type WaitForOperator, waitInWindow } from './operatorWindow.js';
import type { HarnessReach } from './harnessReach.js';
import {
  executorStackPorts,
  listedLocalPorts,
  openLocalPorts,
  type StackOwnPorts,
} from './localPorts.js';
import { localDestinationRefusal, reachRefusal } from './origins.js';
import { applyPolicyChange } from './policyChange.js';
import { ProfileBrowsers, type RunningProfile } from './profileBrowsers.js';
import {
  type BrowserPolicy,
  chromeExecutable,
  listedIds,
  profileOpenToActivation,
  profileOpenToSpace,
  profileServesRun,
  resolveProfile,
} from './profiles.js';
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
  HandoffRequest,
  HandoffResult,
  IdleSweep,
  ListedPage,
  ListedProfile,
  MachineProfile,
  NavigateRequest,
  NavigationResult,
  OpenedPage,
  OpenRequest,
  PageView,
  EvaluateResult,
  ReadRequest,
  ReadResult,
  RunScope,
  ScreenshotResult,
  SignInOptions,
  SignInResult,
  SnapshotResult,
} from './driverTypes.js';
import { boundSnapshot, buildOutline, describeRef } from './outline.js';
import {
  closeWithinDeadline,
  pageAddress,
  pageGoneError,
  PageTable,
  type HeldPage,
  type PageOwner,
} from './pageTable.js';
import { askUnanswerable, assertNavigationAllowed, gateAction, scriptAsks } from './rules.js';
import { screenshotWithinCeiling, type ScreenshotRequest } from './screenshot.js';
import { readWhenQuiet, realClock, type SettleClock } from './settle.js';
import {
  type BrowserEngine,
  EngineCredentialField,
  EngineFieldUnchecked,
  type EnginePage,
  EngineRefNotFound,
  type PageSnapshot,
} from './types.js';

const MINUTE_MS = 60_000;
/** How long a script in the page may run before the call gives up on it. */
const EVALUATE_TIMEOUT_MS = 30_000;

const EPHEMERAL_ENDED = 'the harness run it belonged to ended, and its ephemeral profile with it';

export type { BrowserPolicy } from './profiles.js';

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
  /** Tests fix it; otherwise the ports this executor's environment and the defaults name. */
  readonly stackPorts?: StackOwnPorts;
  readonly now?: () => number;
  /** Waits between reads of a settling page and of the operator's window; tests advance a clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How a hand-off waits for the operator. */
  readonly waitForOperator?: WaitForOperator;
  /** Where a waiting hand-off is shown to the operator; none for the command line. */
  readonly handoffs?: HandoffBoard;
}

interface PageInUse {
  readonly held: HeldPage;
  readonly running: RunningProfile;
  readonly profile: BrowserProfile;
}

interface PageRead {
  readonly snapshot: PageSnapshot;
  readonly title: string;
}

const HISTORY_WORDS: Readonly<Record<'back' | 'forward', string>> = {
  back: 'back to',
  forward: 'forward to',
};

export class BrowserDriver {
  private readonly pages = new PageTable();
  private readonly ephemeral = new EphemeralProfiles();
  private readonly browsers: ProfileBrowsers;
  private readonly windows: OperatorWindows;
  /** Raised by every policy change, so an operation can tell its read of the policy is stale. */
  private generation = 0;
  private readonly now: () => number;
  private readonly clock: SettleClock;
  private readonly stackPorts: StackOwnPorts;

  constructor(private readonly deps: BrowserDriverDeps) {
    this.now = deps.now ?? Date.now;
    this.stackPorts = deps.stackPorts ?? executorStackPorts();
    this.clock = { now: this.now, sleep: deps.sleep ?? realClock.sleep };
    this.browsers = new ProfileBrowsers({
      engine: deps.engine,
      launcher: deps.launcher,
      hostDir: deps.hostDir,
      startProxy: deps.startProxy ?? startEgressProxy,
      classifier: deps.classifier ?? machineAddresses,
      stackPorts: this.stackPorts,
      pages: this.pages,
      now: this.now,
      ephemeral: (profileId) => this.ephemeral.launch(profileId),
    });
    this.windows = new OperatorWindows({
      pages: this.pages,
      browsers: this.browsers,
      clock: this.clock,
      waitForOperator: deps.waitForOperator ?? waitInWindow,
      handoffs: deps.handoffs ?? NO_BOARD,
      loadPolicy: deps.loadPolicy,
      mayGoTo: (profile, address) => this.mayGoTo(profile, address),
      settledView: async (held, running, maxChars) =>
        await this.settledView(held, running, maxChars),
      runningFor: (held) => this.runningFor(held),
    });
  }

  // -------------------------------------------------------------------------
  // Opening and moving
  // -------------------------------------------------------------------------

  async open(request: OpenRequest): Promise<OpenedPage> {
    const { policy, generation } = await this.currentPolicy();
    const profile = this.profileFor(policy, request.profileId, request);
    this.browsers.refuseWhileShown(profile.id);
    const asked = new URL(request.url);
    this.refuseBeforeConnecting(profile, asked);
    assertNavigationAllowed(profile, asked);
    if (request.redelivered) return await this.reopened(request, profile, asked);

    const executable = chromeExecutable(policy);
    let running: RunningProfile;
    try {
      running = await this.browsers.ensureRunning(profile, executable);
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
      this.browsers.release(profile.id);
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
          `run's open pages: ${listedIds(pages.map((held) => held.pageId))}. List them to see ` +
          'where each is before opening the address again.',
        { url: asked.href },
      );
    }
    return {
      outcome: 'uncertain_outcome',
      ...(await this.observe(earlier, this.runningFor(earlier), request.maxChars)),
      redirected: earlier.page.url() !== asked.href,
    };
  }

  private async openIn(
    running: RunningProfile,
    allowed: BrowserProfile,
    generation: number,
    request: OpenRequest,
    asked: URL,
  ): Promise<Omit<OpenedPage, 'outcome'>> {
    const observations = new PageObservations(this.now);
    let page: EnginePage;
    try {
      page = await running.browser.newPage(observations.events());
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
    const held = this.pages.add(request, profile.id, asked.href, page, observations, this.now());
    try {
      this.assertLanded(running, profile, page.url(), startedAt);
      const view = await this.settledView(held, running, request.maxChars);
      return { ...view, redirected: page.url() !== asked.href };
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
      this.refuseBeforeConnecting(profile, asked);
      assertNavigationAllowed(profile, asked);
      held.askedUrl = asked.href;
    }
    if (request.redelivered) {
      return {
        outcome: 'uncertain_outcome',
        view: await this.observe(held, running, request.maxChars),
      };
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
          `history. It is still at ${pageAddress(held)}.`,
        { pageId: held.pageId },
      );
    }
    this.assertLanded(running, profile, held.page.url(), startedAt);
    const view = await this.settledView(held, running, request.maxChars);
    return { outcome: 'performed', view, changed: this.changes(before, held) };
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
    const pageHref = held.page.url();
    const pageUrl = urlOrNothing(pageHref) ?? new URL('about:blank');
    gateAction(profile, pageUrl);
    if (request.redelivered) {
      return {
        outcome: 'uncertain_outcome',
        view: await this.observe(held, running, request.maxChars),
      };
    }

    const callKey = browserCallKey(held.pageId, request.ref, request.action);
    // A reference that no longer resolves spends any approval the call was
    // parked on: the operator approved an element that is not there to act on.
    const stale = async (): Promise<BrowserDriverError> => {
      if (request.approvals !== undefined) {
        await forfeitApproval(request.approvals, request, callKey);
      }
      return await this.staleRef(held, running, request.ref);
    };

    const snapshot = held.lastSnapshot;
    let element = snapshot !== undefined ? describeRef(snapshot.text, request.ref) : undefined;
    if (snapshot === undefined || element === undefined) throw await stale();
    if (entersValue(request.action) && snapshot.maskedRefs.has(request.ref)) {
      throw this.credentialRefusal(request.ref, element.name);
    }
    // A reference can belong to an element inside a frame from another site,
    // which a rule for the page around it says nothing about.
    let frameUrl: string;
    try {
      frameUrl = await held.page.frameUrl(request.ref);
    } catch (error) {
      if (error instanceof EngineRefNotFound) throw await stale();
      throw new BrowserDriverError(
        'action_failed',
        `Which frame \`${request.ref}\` belongs to could not be read, so it was not acted on: ` +
          errorText(error),
        { ref: request.ref },
      );
    }
    const frame = urlOrNothing(frameUrl) ?? new URL('about:blank');
    const gate = gateAction(profile, pageUrl, frame);
    if (gate.verdict === 'ask') {
      if (request.approvals === undefined) throw askUnanswerable(profile, frame.origin);
      // The operator judges the element as the page holds it now, and the
      // dispatch after an approval reads it again: a page that changed in
      // between hashes differently and is not acted on.
      const now = await this.readNow(held);
      const current = describeRef(now.snapshot.text, request.ref);
      if (current === undefined) throw await stale();
      if (entersValue(request.action) && now.snapshot.maskedRefs.has(request.ref)) {
        throw this.credentialRefusal(request.ref, current.name);
      }
      element = current;
      const approvals = request.approvals;
      const standsUntil = askStandsUntil(this.now());
      const cleared = await clearAction(
        approvals,
        request,
        callKey,
        {
          profileId: profile.id,
          pageId: held.pageId,
          pageUrl: pageHref,
          frameUrl,
          pageOrigin: frame.origin,
          pageTitle: now.title,
          ref: request.ref,
          element: current,
          action: request.action,
          credentialField: now.snapshot.maskedRefs.has(request.ref),
          askedBy: gate.askedBy,
        },
        standsUntil,
        async () => await this.approvalScreenshot(held),
      ).catch((error: unknown) => {
        if (error instanceof BrowserApprovalRequired) {
          held.pendingAsks.set(error.request.requestHash, {
            owner: { tenantId: request.tenantId, runId: request.runId },
            store: approvals.store,
            standsUntil,
            decidedBefore: error.request.decidedBefore,
          });
        }
        throw error;
      });
      if (cleared === 'superseded') {
        throw this.staleRefError(
          held,
          request.ref,
          (await this.observe(held, running).catch(() => undefined))?.outline.text,
          'The operator approved this action on the page as it stood when it was asked for, and ' +
            'the page has changed since, so it was not performed and the approval is spent. ',
        );
      }
    }

    const before = this.lastSeen(held);
    const startedAt = this.now();
    try {
      await held.page.act(request.ref, request.action);
    } catch (error) {
      if (error instanceof EngineRefNotFound) throw await this.staleRef(held, running, request.ref);
      if (error instanceof EngineCredentialField) {
        throw this.credentialRefusal(request.ref, element.name);
      }
      if (error instanceof EngineFieldUnchecked) {
        throw new BrowserDriverError(
          'field_unchecked',
          `Whether \`${request.ref}\` is a password field could not be checked ` +
            `(${error.reason}), so the ${request.action.kind} was not performed. The page may ` +
            'have changed under that reference; take a fresh outline for a current one.',
          { ref: request.ref },
        );
      }
      throw new BrowserDriverError(
        'action_failed',
        `The ${request.action.kind} on \`${request.ref}\` did not complete: ${errorText(error)}`,
        { ref: request.ref },
      );
    }
    this.assertLanded(running, profile, held.page.url(), startedAt);
    const view = await this.settledView(held, running, request.maxChars);
    const action = request.action;
    return {
      outcome: 'performed',
      view,
      changed: this.changes(before, held),
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

  async snapshot(
    scope: RunScope,
    pageId: string,
    ref?: string,
    maxChars?: number,
  ): Promise<SnapshotResult> {
    return await this.usingPage(scope, pageId, async ({ held, running }) => {
      const read = await this.readNow(held);
      const view = this.view(held, running, read, false, undefined);
      const bounded = boundSnapshot(read.snapshot, ref, maxChars);
      if (bounded === undefined) throw this.staleRefError(held, ref ?? '', view.outline.text);
      return { pageId, url: view.url, title: view.title, snapshot: bounded };
    });
  }

  async readPage(scope: RunScope, pageId: string, request: ReadRequest): Promise<ReadResult> {
    return await this.usingPage(scope, pageId, async ({ held }) => {
      return await this.readOn(held, request);
    });
  }

  private async readOn(held: HeldPage, request: ReadRequest): Promise<ReadResult> {
    const { what, contains, maxChars } = request;
    const url = pageAddress(held);
    if (what === 'text') {
      const text = await this.read(held, async () => await held.page.text());
      const bounded = boundText(text, contains, {
        ...(request.offset !== undefined ? { offset: request.offset } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
      });
      return {
        what,
        url,
        text: bounded.text,
        withheld: bounded.withheld,
        ...(bounded.nextOffset !== undefined ? { nextOffset: bounded.nextOffset } : {}),
      };
    }
    if (what === 'console') {
      const buffer = held.observations.console;
      const { kept, withheld } = boundEntries(
        buffer.entries(),
        contains,
        (entry) => entry.text,
        undefined,
        maxChars,
      );
      return { what, url, console: kept, withheld, notRetained: buffer.notRetained };
    }
    const buffer = held.observations.network;
    const { kept, withheld } = boundEntries(
      buffer.entries(),
      contains,
      (entry) => entry.url,
      undefined,
      maxChars,
    );
    return { what, url, network: kept, withheld, notRetained: buffer.notRetained };
  }

  async screenshot(
    scope: RunScope,
    pageId: string,
    request: ScreenshotRequest,
  ): Promise<ScreenshotResult> {
    return await this.usingPage(scope, pageId, async ({ held, running }) => {
      try {
        const taken = await screenshotWithinCeiling(held.page, request);
        const title = await held.page.title().catch(() => held.lastTitle);
        return { pageId, url: pageAddress(held), title, ...taken };
      } catch (error) {
        if (error instanceof BrowserDriverError) throw error;
        if (error instanceof EngineRefNotFound) throw await this.staleRef(held, running, error.ref);
        throw new BrowserDriverError(
          'observation_failed',
          `Page \`${pageId}\` could not be captured: ${errorText(error)}`,
          { pageId },
        );
      }
    });
  }

  /**
   * The run's open pages in profiles it may still use. A page in one it may
   * not is refused by every operation but close, so it is not offered.
   * Listing touches none of them.
   */
  async list(scope: RunScope): Promise<ListedPage[]> {
    const policy = await this.deps.loadPolicy();
    const pages = this.pages.list(scope).filter((held) => {
      if (this.ephemeral.has(held.profileId)) return true;
      const profile = policy.browsers.get(held.profileId);
      return profile !== undefined && profileServesRun(profile, scope);
    });
    return await Promise.all(
      pages.map(async (held) => ({
        pageId: held.pageId,
        url: pageAddress(held),
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
    const running = this.browsers.get(held.profileId);
    if (running !== undefined) running.state.lastActivityAt = this.now();
    return 'closed';
  }

  /**
   * The profiles the run's space may use, those closed to this run among them
   * and marked so: a run told nothing of a profile it cannot use would go
   * looking for one. Never starts a browser to answer.
   */
  async listProfiles(scope: RunScope): Promise<ListedProfile[]> {
    const policy = await this.deps.loadPolicy();
    const open = [...policy.browsers.values()].filter((profile) =>
      profileOpenToSpace(profile, scope.spaceId),
    );
    return await Promise.all(
      open.map(async (profile): Promise<ListedProfile> => {
        const base = {
          profileId: profile.id,
          posture: profile.posture,
          window: profile.window,
          unattended: profile.unattended,
          openToThisRun: profileOpenToActivation(profile, scope.activatedByPerson),
          localPorts: openLocalPorts(profile, this.stackPorts),
        };
        const running = this.browsers.get(profile.id);
        if (running === undefined) {
          return {
            ...base,
            running: false,
            sitesUnknown: this.browsers.hasStarted(profile.id) ? 'stopped' : 'not_started',
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

  /** Every profile this machine offers, whichever spaces it serves. Never starts a browser. */
  async machineProfiles(): Promise<MachineProfile[]> {
    const policy = await this.deps.loadPolicy();
    return await Promise.all(
      [...policy.browsers.values()].map(async (profile): Promise<MachineProfile> => {
        const windowShown = this.browsers.isShown(profile.id);
        const localPorts = listedLocalPorts(profile, this.stackPorts);
        const running = this.browsers.get(profile.id);
        if (running === undefined) return { profile, localPorts, running: false, windowShown };
        const sites = await running.browser.cookieSites().catch(() => undefined);
        return {
          profile,
          localPorts,
          running: true,
          windowShown,
          ...(sites !== undefined ? { sites } : {}),
        };
      }),
    );
  }

  /**
   * Runs a script in a page of an ephemeral profile and returns its value as
   * JSON, bounded. Refused on any other profile: a script there would act with
   * the operator's sign-ins, past every outline and receipt.
   */
  async evaluate(scope: RunScope, pageId: string, expression: string): Promise<EvaluateResult> {
    return await this.usingPage(scope, pageId, async ({ held, profile }) => {
      if (!this.ephemeral.has(profile.id)) {
        throw new BrowserDriverError(
          'script_refused',
          `Scripts run only in an ephemeral profile, which holds no sign-ins; page \`${pageId}\` is ` +
            `in profile \`${profile.id}\`, so nothing was run.`,
          { pageId, profileId: profile.id },
        );
      }
      const pageUrl = urlOrNothing(held.page.url()) ?? new URL('about:blank');
      if (gateAction(profile, pageUrl).verdict === 'ask') {
        throw scriptAsks(profile, pageUrl.origin);
      }
      let value: unknown;
      try {
        value = await withinDeadline(held.page.evaluate(expression), EVALUATE_TIMEOUT_MS);
      } catch (error) {
        throw new BrowserDriverError(
          'action_failed',
          `The script on page \`${pageId}\` did not complete: ${errorText(error)}`,
          { pageId },
        );
      }
      // A value JSON cannot carry — undefined, a function — stringifies to nothing.
      const json = (JSON.stringify(value) as string | undefined) ?? 'undefined';
      const cut = json.length > BROWSER_READ_DEFAULT_CHARS;
      return {
        pageId,
        url: pageAddress(held),
        value: cut ? json.slice(0, BROWSER_READ_DEFAULT_CHARS) : json,
        cut,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Ephemeral profiles
  // -------------------------------------------------------------------------

  /**
   * A profile for one run, in a directory the caller made and deletes,
   * reaching what the run's harness may reach; its id.
   */
  startEphemeral(owner: RunScope, userDataDir: string, reach: HarnessReach): string {
    return this.ephemeral.add(owner, userDataDir, reach).id;
  }

  /** Ends a run's ephemeral profile: its pages gone, its browser stopped and exited. */
  async endEphemeral(profileId: string): Promise<void> {
    if (!this.ephemeral.has(profileId)) return;
    // Forgotten first, so nothing opens in it while its browser stops.
    this.ephemeral.remove(profileId);
    await this.browsers.stopAndWait(profileId, EPHEMERAL_ENDED);
  }

  /** The machine profile a harness run asked for, refused as an open in it would be. */
  async harnessProfile(scope: RunScope, profileId: string): Promise<BrowserProfile> {
    const profile = this.profileFor(await this.deps.loadPolicy(), profileId, scope);
    this.browsers.refuseWhileShown(profile.id);
    return profile;
  }

  // -------------------------------------------------------------------------
  // The operator's window
  // -------------------------------------------------------------------------

  /** A run's page handed to the operator in the profile's window; see `OperatorWindows`. */
  async handoff(request: HandoffRequest): Promise<HandoffResult> {
    return await this.windows.handoff(request);
  }

  /** How long a hand-off of this page may wait, for the step's own deadline. */
  async handoffWaitLimitMs(owner: RunScope, pageId: string): Promise<number | undefined> {
    return await this.windows.waitLimitMs(owner, pageId);
  }

  /** The operator's sign-in sitting on one profile; see `OperatorWindows`. */
  async signIn(profileId: string, options?: SignInOptions): Promise<SignInResult> {
    return await this.windows.signIn(profileId, options);
  }

  // -------------------------------------------------------------------------
  // Lifetime
  // -------------------------------------------------------------------------

  /** Profiles whose browser is running now: the idle sweep's whole work. */
  runningProfileCount(): number {
    return this.browsers.runningCount();
  }

  /**
   * Close pages nothing has touched for their profile's idle limit, then stop
   * browsers that have had no page for as long — at most `limit` of the two
   * together, the rest left for the next sweep. A profile with an operation in
   * flight, or its window shown, is passed over, and so is a page with an ask
   * waiting on the operator, which keeps its browser running too.
   */
  async sweepIdle(limit: number): Promise<IdleSweep> {
    const now = this.now();
    let closedPages = 0;
    for (const held of this.pages.all()) {
      if (closedPages >= limit) break;
      const running = this.browsers.get(held.profileId);
      if (running === undefined || this.browsers.busy(held.profileId)) continue;
      if (now - held.lastUsedAt < running.state.profile.idleMinutes * MINUTE_MS) continue;
      if (await this.heldForAnswer(held, now)) continue;
      // An answer the sweep has just found counts as use.
      if (now - held.lastUsedAt < running.state.profile.idleMinutes * MINUTE_MS) continue;
      this.pages.forget(held);
      await closeWithinDeadline(held.page);
      running.state.lastActivityAt = Math.max(running.state.lastActivityAt, now);
      closedPages += 1;
    }
    let stoppedProfiles = 0;
    for (const [profileId, running] of this.browsers.runningEntries()) {
      if (closedPages + stoppedProfiles >= limit) break;
      if (this.browsers.busy(profileId) || this.pages.countForProfile(profileId) > 0) continue;
      if (now - running.state.lastActivityAt < running.state.profile.idleMinutes * MINUTE_MS) {
        continue;
      }
      this.browsers.stop(profileId);
      stoppedProfiles += 1;
    }
    return { closedPages, stoppedProfiles };
  }

  /**
   * Whether an ask parked on the page still waits for the operator. An ask
   * that lapsed unanswered is dropped; one answered since the last sweep is
   * dropped too, and the page counts as used now, so the dispatch the answer
   * brings finds it open.
   */
  private async heldForAnswer(held: HeldPage, now: number): Promise<boolean> {
    for (const [requestHash, ask] of held.pendingAsks) {
      if (now >= ask.standsUntil) {
        held.pendingAsks.delete(requestHash);
        continue;
      }
      const grant = await ask.store.grant(ask.owner, requestHash).catch(() => null);
      if (grantAnswersAsk(grant, ask.decidedBefore)) {
        held.pendingAsks.delete(requestHash);
        held.lastUsedAt = Math.max(held.lastUsedAt, now);
      }
    }
    return held.pendingAsks.size > 0;
  }

  /**
   * The machine's policy changed: browsers running or starting, and their
   * pages, follow it at once.
   */
  async policyChanged(policy: BrowserPolicy): Promise<void> {
    this.generation += 1;
    await applyPolicyChange(
      {
        pages: this.pages,
        browsers: this.browsers.liveStates(),
        stop: (id) => {
          this.browsers.stop(id);
        },
      },
      new Map([
        ...policy.browsers,
        ...this.ephemeral.all().map((profile) => [profile.id, profile] as const),
      ]),
    );
  }

  /** Stops every profile's browser and waits for each to exit, for a process about to end. */
  async stopAll(): Promise<void> {
    const ending = this.browsers.runningEntries().map(([profileId, running]) => {
      this.browsers.stop(profileId);
      return running.ended;
    });
    await Promise.all(ending);
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
    this.browsers.refuseWhileShown(held.profileId);
    this.browsers.acquire(held.profileId);
    try {
      const policy = await this.deps.loadPolicy();
      const profile = this.profileFor(policy, held.profileId, scope);
      held.activatedByPerson = scope.activatedByPerson === true;
      const running = this.runningFor(held);
      this.touch(held, running);
      return await operation({ held, running, profile });
    } finally {
      this.browsers.release(held.profileId);
    }
  }

  private runningFor(held: HeldPage): RunningProfile {
    const running = this.browsers.get(held.profileId);
    if (running !== undefined) return running;
    this.pages.forget(held);
    throw pageGoneError(held.pageId, 'its browser stopped', held);
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

  private async readNow(held: HeldPage): Promise<PageRead> {
    const snapshot = await this.read(held, async () => await held.page.snapshot());
    const title = await this.read(held, async () => await held.page.title());
    return { snapshot, title };
  }

  private view(
    held: HeldPage,
    running: RunningProfile,
    read: PageRead,
    settled: boolean,
    maxChars: number | undefined,
  ): PageView {
    held.lastSnapshot = read.snapshot;
    held.lastTitle = read.title;
    const url = pageAddress(held);
    this.touch(held, running);
    return {
      pageId: held.pageId,
      url,
      title: read.title,
      outline: buildOutline(read.snapshot, maxChars),
      settled,
    };
  }

  /** The page as it is this moment. */
  private async observe(
    held: HeldPage,
    running: RunningProfile,
    maxChars?: number,
  ): Promise<PageView> {
    return this.view(held, running, await this.readNow(held), false, maxChars);
  }

  /** The page once two reads a moment apart agree, or as it stands at the cap. */
  private async settledView(
    held: HeldPage,
    running: RunningProfile,
    maxChars?: number,
  ): Promise<PageView> {
    const quiet = await readWhenQuiet(
      async () => await this.readNow(held),
      (read) => `${held.page.url()}\n${read.title}\n${read.snapshot.text}`,
      this.clock,
    );
    return this.view(held, running, quiet.read, quiet.settled, maxChars);
  }

  /** The page as last read; its outline at the ceiling, so a change past the shown cut counts. */
  private lastSeen(held: HeldPage): { url: string; title: string; outline?: string } {
    return {
      url: held.page.url(),
      title: held.lastTitle,
      ...(held.lastSnapshot !== undefined
        ? { outline: buildOutline(held.lastSnapshot, BROWSER_OUTLINE_MAX_CHARS).text }
        : {}),
    };
  }

  /** Addresses compared whole: one differing only in a query value is a move the shown form hides. */
  private changes(
    before: { url: string; title: string; outline?: string },
    held: HeldPage,
  ): ChangeReceipt {
    const after = this.lastSeen(held);
    return {
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
      outlineChanged: before.outline !== after.outline,
    };
  }

  private staleRefError(
    held: HeldPage,
    ref: string,
    outline?: string,
    why = '',
  ): BrowserDriverError {
    return new BrowserDriverError(
      'stale_ref',
      `${why}Reference \`${ref}\` does not resolve on page \`${held.pageId}\` as it is now ` +
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

  /** The page as the operator is asked about it, password fields masked; nothing when it cannot be taken. */
  private async approvalScreenshot(
    held: HeldPage,
  ): Promise<{ data: string; mimeType: string } | undefined> {
    const taken = await screenshotWithinCeiling(held.page, { fullPage: false }).catch(
      () => undefined,
    );
    return taken === undefined
      ? undefined
      : { data: taken.bytes.toString('base64'), mimeType: taken.contentType };
  }

  private credentialRefusal(ref: string, name: string | undefined): BrowserDriverError {
    return new BrowserDriverError(
      'credential_field',
      `\`${ref}\`${name !== undefined ? ` (${JSON.stringify(name)})` : ''} is a password field. ` +
        'Credentials are entered by the operator, in the browser window, never by an agent; ' +
        'nothing was entered. The keys an agent may press there are ' +
        `${[...CREDENTIAL_FIELD_KEYS].join(', ')}, alone or with ${[...MODIFIERS].join(', ')} held.`,
      { ref },
    );
  }

  /** Whether a run of this profile may be at the address. Refuses nothing. */
  private mayGoTo(profile: BrowserProfile, address: string): boolean {
    const url = urlOrNothing(address);
    if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
    try {
      this.refuseBeforeConnecting(profile, url);
      assertNavigationAllowed(profile, url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Refuses an address the proxy would refuse by its name alone, before a
   * browser is started or touched for it. The proxy still decides every
   * connection, this one included.
   */
  private refuseBeforeConnecting(profile: BrowserProfile, url: URL): void {
    const reach = this.ephemeral.reach(profile.id);
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const decision = decideByName(
      egressHost(url.hostname),
      port,
      reach !== undefined
        ? { reach }
        : { localPorts: { opened: () => profile.localPorts, stackOwn: this.stackPorts } },
      this.deps.classifier ?? machineAddresses,
    );
    if (decision?.verdict !== 'refuse') return;
    const details = { origin: url.origin };
    throw decision.kind === 'reach'
      ? new BrowserDriverError(
          'origin_denied',
          reachRefusal(profile.id, decision.reason, 'asked'),
          details,
        )
      : new BrowserDriverError(
          'appliance_origin',
          localDestinationRefusal(profile.id, decision.reason, 'asked'),
          details,
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
    this.refuseBeforeConnecting(profile, landed);
    assertNavigationAllowed(profile, landed);
  }

  /** A run's own ephemeral profile, or the machine's profile as the run's space may use it. */
  private profileFor(policy: BrowserPolicy, profileId: string, scope: RunScope): BrowserProfile {
    return this.ephemeral.resolve(profileId, scope) ?? resolveProfile(policy, profileId, scope);
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
   * the policy now has it, refused as any open is if the run may no longer use
   * it or the address.
   */
  private async stillAllowed(
    generation: number,
    profile: BrowserProfile,
    request: OpenRequest,
    asked: URL,
  ): Promise<BrowserProfile> {
    if (generation === this.generation) return profile;
    const { policy } = await this.currentPolicy();
    const now = this.profileFor(policy, request.profileId, request);
    this.refuseBeforeConnecting(now, asked);
    assertNavigationAllowed(now, asked);
    return now;
  }
}

async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(Math.round(ms / 1000))} seconds`));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
