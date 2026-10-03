/**
 * The operator at the profile's window: a run's page handed over, and the
 * sign-in sitting with no run involved.
 *
 * A hand-off is over when the page has left the site it was handed over on
 * and stopped changing — a sign-in that worked redirects away from the
 * sign-in page — when the operator presses Done on its Action Center item,
 * when they close the window, or at the profile's deadline. The sitting is
 * over when the window is closed.
 */
import {
  type BrowserHandoffOutcome,
  type BrowserHandoffReason,
  type BrowserProfile,
} from '@aflow/schemas';

import type {
  HandoffRequest,
  HandoffResult,
  PageView,
  RunScope,
  SignInOptions,
  SignInResult,
} from './driverTypes.js';
import { BrowserDriverError, errorText } from './errors.js';
import { type HandoffBoard, registrableSite } from './handoffBoard.js';
import { PageObservations } from './observations.js';
import { closeWithinDeadline, type HeldPage, pageAddress, type PageTable } from './pageTable.js';
import type { ProfileBrowsers, RunningProfile } from './profileBrowsers.js';
import { type BrowserPolicy, chromeExecutable, resolveProfile } from './profiles.js';
import { navigationFailure, urlOrNothing } from './refusalAttribution.js';
import type { SettleClock } from './settle.js';
import type { EnginePage } from './types.js';

const MINUTE_MS = 60_000;

/** How often the window is looked at while the operator has it. */
export const WINDOW_POLL_MS = 500;
/** How long a page that left the hand-off's site must stay unchanged to count as done. */
export const HANDOFF_QUIET_MS = 2_000;
/** The longest a sign-in sitting keeps the window before handing the profile back to runs. */
export const SIGN_IN_SITTING_MAX_MS = 60 * MINUTE_MS;

export interface OperatorWindow {
  /** The page the operator was handed. */
  readonly page: EnginePage;
  /** True once the operator has closed the window, or its browser has ended. */
  closed(): boolean;
}

export interface HandoffWait {
  readonly window: OperatorWindow;
  readonly reason: BrowserHandoffReason;
  /** The run's words for the operator. */
  readonly message: string;
  /** The origin the page was on when the hand-off began. */
  readonly startOrigin: string;
  readonly deadlineAt: number;
  readonly clock: SettleClock;
  /** Settles when the operator presses Done on the hand-off's Action Center item. */
  readonly operatorDone: Promise<void>;
}

export type WaitForOperator = (wait: HandoffWait) => Promise<BrowserHandoffOutcome>;

export function originOf(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return address;
  }
}

export const waitInWindow: WaitForOperator = async ({
  window,
  startOrigin,
  deadlineAt,
  clock,
  operatorDone,
}) => {
  const operator = { done: false };
  void operatorDone.then(() => {
    operator.done = true;
  });
  let lastSeen: string | undefined;
  let unchangedSince = 0;
  for (;;) {
    if (operator.done) return 'completed';
    if (window.closed()) return 'window_closed';
    if (clock.now() >= deadlineAt) return 'timed_out';
    const url = window.page.url();
    if (originOf(url) === startOrigin) {
      lastSeen = undefined;
    } else {
      const snapshot = await window.page.snapshot().catch(() => undefined);
      const seen = `${url}\n${snapshot?.text ?? ''}`;
      if (seen !== lastSeen) {
        lastSeen = seen;
        unchangedSince = clock.now();
      } else if (snapshot !== undefined && clock.now() - unchangedSince >= HANDOFF_QUIET_MS) {
        return 'completed';
      }
    }
    await Promise.race([clock.sleep(WINDOW_POLL_MS), operatorDone]);
  }
};

async function waitForWindowClosed(
  closed: () => boolean,
  deadlineAt: number,
  clock: SettleClock,
): Promise<'window_closed' | 'timed_out'> {
  for (;;) {
    if (closed()) return 'window_closed';
    if (clock.now() >= deadlineAt) return 'timed_out';
    await clock.sleep(WINDOW_POLL_MS);
  }
}

/** What the window operations need of the driver that owns the pages and the policy. */
export interface WindowHost {
  readonly pages: PageTable;
  readonly browsers: ProfileBrowsers;
  readonly clock: SettleClock;
  readonly waitForOperator: WaitForOperator;
  /** Where a waiting hand-off is shown to the operator, and Done heard from. */
  readonly handoffs: HandoffBoard;
  loadPolicy(): Promise<BrowserPolicy>;
  /** Whether a run of this profile may be at the address; refuses nothing. */
  mayGoTo(profile: BrowserProfile, address: string): boolean;
  settledView(held: HeldPage, running: RunningProfile, maxChars?: number): Promise<PageView>;
  runningFor(held: HeldPage): RunningProfile;
}

export class OperatorWindows {
  constructor(private readonly host: WindowHost) {}

  /** How long a hand-off of this page may wait for the operator, when the page is the run's. */
  async waitLimitMs(owner: RunScope, pageId: string): Promise<number | undefined> {
    const held = this.host.pages.find(owner, pageId);
    if (held === undefined) return undefined;
    const profile = (await this.host.loadPolicy()).browsers.get(held.profileId);
    return profile === undefined ? undefined : profile.handoffMinutes * MINUTE_MS;
  }

  /**
   * Hands a run's page to the operator in the profile's window, waits for them,
   * and gives the run the page back — a new one when the browser had to be
   * restarted to show the window. The profile's posture does not refuse it: the
   * operator is the one acting.
   */
  async handoff(request: HandoffRequest): Promise<HandoffResult> {
    const { pages, browsers, clock } = this.host;
    const held = pages.get(request, request.pageId);
    const policy = await this.host.loadPolicy();
    const profile = resolveProfile(policy, held.profileId, request.spaceId);
    const executable = chromeExecutable(policy);
    // The page's own address, not the one shown to the run: the operator needs
    // the page exactly as it is, and it never leaves the machine.
    const address = held.page.url();
    const site = registrableSite(address);
    if (site === undefined) {
      throw new BrowserDriverError(
        'no_site',
        `Page \`${held.pageId}\` is not on a site — an about:, data:, file: or javascript: ` +
          'page has none — and the operator cannot sign in to a page that has no site, so it ' +
          'was not handed over. Go to the site’s own page first, then hand that over.',
        { pageId: held.pageId },
      );
    }
    const startedAt = clock.now();
    const shown = await browsers.showWindow(profile, executable);
    let outcome: BrowserHandoffOutcome;
    let page: EnginePage = held.page;
    try {
      if (shown.restarted) {
        page = await shown.running.browser.firstPage(new PageObservations(clock.now).events());
        await page.navigate({ kind: 'url', url: address });
      }
      const waiting = page;
      const deadlineAt = startedAt + profile.handoffMinutes * MINUTE_MS;
      const posting = await this.host.handoffs.post({
        tenantId: request.tenantId,
        ...(request.spaceId !== undefined ? { spaceId: request.spaceId } : {}),
        runId: request.runId,
        stepExecutionId: request.stepExecutionId,
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        profileId: profile.id,
        site,
        reason: request.reason,
        message: request.message,
        waitMs: deadlineAt - clock.now(),
      });
      try {
        outcome = await this.host.waitForOperator({
          window: {
            page: waiting,
            closed: () => waiting.isClosed() || browsers.get(profile.id) !== shown.running,
          },
          reason: request.reason,
          message: request.message,
          startOrigin: originOf(address),
          deadlineAt,
          clock,
          operatorDone: posting.done,
        });
      } finally {
        await posting.close();
      }
    } catch (error) {
      await this.handBack(profile, executable, shown.restarted);
      throw new BrowserDriverError(
        'window_failed',
        `The window for profile \`${profile.id}\` could not be shown at ${pageAddress(held)}: ` +
          `${errorText(error)}. The profile is back in use by runs.`,
        { pageId: held.pageId },
      );
    }
    const landedAt = page.url();
    const headless = await browsers.returnWindow(profile, executable, shown.restarted);
    if (!shown.restarted && !held.page.isClosed()) {
      return {
        outcome,
        view: await this.host.settledView(held, this.host.runningFor(held), request.maxChars),
        restarted: false,
        waitedMs: clock.now() - startedAt,
      };
    }
    const running = headless ?? (await browsers.ensureRunning(profile, executable));
    try {
      const at = this.host.mayGoTo(profile, landedAt) ? landedAt : address;
      const view = await this.reopen(request, profile, running, at, request.maxChars);
      pages.forget(held, `the hand-off replaced it with \`${view.pageId}\``);
      return {
        outcome,
        view,
        previousPageId: held.pageId,
        restarted: shown.restarted,
        waitedMs: clock.now() - startedAt,
      };
    } finally {
      browsers.release(profile.id);
    }
  }

  /**
   * The operator's sign-in sitting: the profile's window, open until they close
   * it, then the sites the profile holds a session for. Any profile on the
   * machine; no run is involved.
   */
  async signIn(profileId: string, options: SignInOptions = {}): Promise<SignInResult> {
    const { browsers, clock } = this.host;
    const maxMs = options.maxMs ?? SIGN_IN_SITTING_MAX_MS;
    const policy = await this.host.loadPolicy();
    const profile = resolveProfile(policy, profileId, undefined, true);
    const executable = chromeExecutable(policy);
    const shown = await browsers.showWindow(profile, executable);
    options.onShown?.();
    let outcome: SignInResult['outcome'];
    try {
      const events = new PageObservations(clock.now).events();
      // A browser already windowed belongs to runs too: the operator gets a tab
      // of their own, and closing it ends the sitting.
      const page = shown.restarted
        ? await shown.running.browser.firstPage(events)
        : await shown.running.browser.newPage(events);
      const ended = (): boolean => browsers.get(profile.id) !== shown.running;
      outcome = await waitForWindowClosed(
        shown.restarted
          ? () => ended() || shown.running.browser.openPageCount() === 0
          : () => ended() || page.isClosed(),
        clock.now() + maxMs,
        clock,
      );
    } catch (error) {
      await this.handBack(profile, executable, shown.restarted);
      throw error;
    }
    const headless = await browsers.returnWindow(profile, executable, shown.restarted);
    const running = headless ?? (await browsers.ensureRunning(profile, executable));
    try {
      return { outcome, restarted: shown.restarted, sites: await running.browser.cookieSites() };
    } finally {
      browsers.release(profile.id);
    }
  }

  /** Gives the profile back to runs after the window failed, whatever that takes. */
  private async handBack(
    profile: BrowserProfile,
    executable: string,
    restarted: boolean,
  ): Promise<void> {
    const headless = await this.host.browsers
      .returnWindow(profile, executable, restarted)
      .catch(() => undefined);
    if (headless !== undefined) this.host.browsers.release(profile.id);
  }

  /** The run's page again, in the browser the window handed back. */
  private async reopen(
    owner: RunScope,
    profile: BrowserProfile,
    running: RunningProfile,
    address: string,
    maxChars: number | undefined,
  ): Promise<PageView> {
    const { pages, clock } = this.host;
    const observations = new PageObservations(clock.now);
    const page = await running.browser.newPage(observations.events());
    const startedAt = clock.now();
    try {
      await page.navigate({ kind: 'url', url: address });
    } catch (error) {
      await closeWithinDeadline(page);
      throw navigationFailure(
        running.proxy,
        profile,
        urlOrNothing(address),
        startedAt,
        `${address} did not load after the hand-off`,
        error,
      );
    }
    const held = pages.add(owner, profile.id, address, page, observations, clock.now());
    return await this.host.settledView(held, running, maxChars);
  }
}
