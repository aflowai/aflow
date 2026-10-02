/**
 * Each profile's one Chrome: starting it behind its egress proxy, counting the
 * operations holding it, stopping it, and restarting it with a window.
 *
 * Chrome allows one process per profile directory, and a running Chrome cannot
 * change between headless and windowed. Showing the window is therefore a
 * restart on the same directory — the sign-ins are on disk and survive it; the
 * pages other runs held in memory do not, and are reported gone with the
 * reason.
 */
import type { BrowserProfile } from '@aflow/schemas';

import type { LocalAddressClassifier } from './addresses.js';
import type { ChromeLauncher, LaunchedChrome } from './chromeProcess.js';
import type { EgressProxy, StartEgressProxy } from './egressProxy.js';
import { BrowserDriverError, errorText } from './errors.js';
import type { PageTable } from './pageTable.js';
import { ruleRefusingHost } from './rules.js';
import type { BrowserEngine, EngineBrowser } from './types.js';

const CONNECT_TIMEOUT_MS = 15_000;

/** What another run's page is told when the window took its browser. */
export const WINDOW_SHOWN_PAGE_GONE =
  'its browser was restarted to show the operator a window — a sign-in or a hand-off — and ' +
  'the pages open in it then were closed';

/**
 * What changes as the profile is used; the proxy reads the profile from here on
 * every connection. Only the start and a policy change write `profile`.
 */
export interface ProfileState {
  profile: BrowserProfile;
  lastActivityAt: number;
  /** A policy change removed the profile while its browser was starting. */
  withdrawn: boolean;
}

export interface RunningProfile {
  readonly browser: EngineBrowser;
  readonly chrome: LaunchedChrome;
  readonly proxy: EgressProxy;
  readonly state: ProfileState;
  /** Whether this Chrome has a window, whatever the profile says. */
  readonly windowed: boolean;
  /** Settles once this Chrome has exited and its proxy has stopped. */
  readonly ended: Promise<void>;
}

/** A profile's browser from the moment its start begins; `state` is the one it will run with. */
interface Launch {
  readonly ready: Promise<RunningProfile>;
  readonly state: ProfileState;
}

export interface ProfileBrowsersDeps {
  readonly engine: BrowserEngine;
  readonly launcher: ChromeLauncher;
  readonly hostDir: string;
  readonly startProxy: StartEgressProxy;
  readonly classifier: LocalAddressClassifier;
  readonly pages: PageTable;
  readonly now: () => number;
}

export class ProfileBrowsers {
  private readonly starting = new Map<string, Launch>();
  private readonly running = new Map<string, RunningProfile>();
  private readonly everStarted = new Set<string>();
  /** Operations holding a profile's browser; the idle sweep leaves those profiles alone. */
  private readonly inFlight = new Map<string, number>();
  /** Profiles whose window the operator is using; every run's operation on them is refused. */
  private readonly shown = new Set<string>();

  constructor(private readonly deps: ProfileBrowsersDeps) {}

  get(profileId: string): RunningProfile | undefined {
    return this.running.get(profileId);
  }

  hasStarted(profileId: string): boolean {
    return this.everStarted.has(profileId);
  }

  runningCount(): number {
    return this.running.size;
  }

  runningEntries(): Array<[string, RunningProfile]> {
    return [...this.running];
  }

  /** Browsers running or still starting, by profile, for a policy change to follow. */
  liveStates(): Map<string, { state: ProfileState }> {
    const browsers = new Map<string, { state: ProfileState }>(this.starting);
    for (const [profileId, running] of this.running) browsers.set(profileId, running);
    return browsers;
  }

  /** Whether the operator has the profile's window: a sign-in sitting or a hand-off. */
  isShown(profileId: string): boolean {
    return this.shown.has(profileId);
  }

  refuseWhileShown(profileId: string): void {
    if (!this.shown.has(profileId)) return;
    throw new BrowserDriverError(
      'window_shown',
      `The operator is using the browser window for profile \`${profileId}\` — signing in or ` +
        'finishing a hand-off — so nothing was done in it. The profile is handed back when they ' +
        'close the window or its deadline passes; try again then.',
      { profileId },
    );
  }

  acquire(profileId: string): void {
    this.inFlight.set(profileId, (this.inFlight.get(profileId) ?? 0) + 1);
  }

  release(profileId: string): void {
    const count = (this.inFlight.get(profileId) ?? 0) - 1;
    if (count > 0) this.inFlight.set(profileId, count);
    else this.inFlight.delete(profileId);
  }

  busy(profileId: string): boolean {
    return (this.inFlight.get(profileId) ?? 0) > 0 || this.shown.has(profileId);
  }

  /** The profile's browser, counted as in use until the caller's `release`. */
  async ensureRunning(
    profile: BrowserProfile,
    executable: string,
    window: BrowserProfile['window'] = profile.window,
  ): Promise<RunningProfile> {
    let launch = this.starting.get(profile.id);
    if (launch === undefined) {
      const state: ProfileState = { profile, lastActivityAt: this.deps.now(), withdrawn: false };
      launch = { state, ready: this.start(profile.id, executable, state, window) };
      this.starting.set(profile.id, launch);
    }
    let running: RunningProfile;
    try {
      running = await launch.ready;
    } catch (error) {
      if (this.starting.get(profile.id) === launch) this.starting.delete(profile.id);
      throw error;
    }
    this.acquire(profile.id);
    return running;
  }

  stop(profileId: string): void {
    const running = this.running.get(profileId);
    const launch = this.starting.get(profileId);
    // Gone from both maps before it has exited, so the next open starts a
    // fresh browser rather than being handed this one.
    this.running.delete(profileId);
    this.starting.delete(profileId);
    if (running !== undefined) running.chrome.stop();
    else if (launch !== undefined) launch.state.withdrawn = true;
  }

  /** Stops the profile's browser, its pages reported gone for `why`, and waits for it to exit. */
  private async stopAndWait(profileId: string, why: string): Promise<void> {
    await this.starting.get(profileId)?.ready.catch(() => undefined);
    const running = this.running.get(profileId);
    this.deps.pages.dropProfile(profileId, why);
    this.stop(profileId);
    if (running !== undefined) await running.ended;
  }

  /**
   * The windowed restart: the profile's browser running with a window, and
   * whether it had to be restarted to get one. A profile whose window is
   * `visible` already has it. Counted in use, and every run's operation on the
   * profile refused, until `returnWindow`.
   */
  async showWindow(
    profile: BrowserProfile,
    executable: string,
  ): Promise<{ running: RunningProfile; restarted: boolean }> {
    this.refuseWhileShown(profile.id);
    this.shown.add(profile.id);
    try {
      if (profile.window === 'visible' || this.running.get(profile.id)?.windowed === true) {
        return { running: await this.ensureRunning(profile, executable), restarted: false };
      }
      await this.stopAndWait(profile.id, WINDOW_SHOWN_PAGE_GONE);
      return { running: await this.ensureRunning(profile, executable, 'visible'), restarted: true };
    } catch (error) {
      this.shown.delete(profile.id);
      throw error;
    }
  }

  /**
   * Hands the profile back to runs. A browser restarted for the window is
   * restarted headless again and returned, counted in use until the caller's
   * `release`.
   */
  async returnWindow(
    profile: BrowserProfile,
    executable: string,
    restarted: boolean,
  ): Promise<RunningProfile | undefined> {
    try {
      if (!restarted) return undefined;
      await this.stopAndWait(profile.id, WINDOW_SHOWN_PAGE_GONE);
      return await this.ensureRunning(profile, executable);
    } finally {
      this.shown.delete(profile.id);
      this.release(profile.id);
    }
  }

  private async start(
    profileId: string,
    executable: string,
    state: ProfileState,
    window: BrowserProfile['window'],
  ): Promise<RunningProfile> {
    // Before Chrome, so no request of Chrome's ever goes out unchecked.
    const proxy = await this.deps.startProxy({
      refuseHost: (host) => ruleRefusingHost(state.profile, host),
      classifier: this.deps.classifier,
      now: this.deps.now,
    });
    let chrome: LaunchedChrome;
    try {
      chrome = await this.deps.launcher.launch({
        executable,
        hostDir: this.deps.hostDir,
        profile: { ...state.profile, window },
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
      throw new BrowserDriverError(
        'launch_failed',
        `The browser for profile \`${profileId}\` was stopped as it started: the profile was ` +
          "removed from this machine's policy meanwhile.",
      );
    }
    // Whoever ends it — the idle sweep, withdrawal, shutdown, a crash, the
    // operator closing its window — its proxy and its pages go with it, and
    // the next open starts it again.
    const ended = chrome.exited.then(async () => {
      // A browser stopped on purpose is already out of both maps, and the
      // profile may be running again in a fresh one by now.
      if (this.running.get(profileId) === entry) {
        this.running.delete(profileId);
        this.starting.delete(profileId);
        this.deps.pages.dropProfile(profileId);
      }
      await browser.disconnect().catch(() => undefined);
      await proxy.stop().catch(() => undefined);
    });
    const entry: RunningProfile = {
      browser,
      chrome,
      proxy,
      state,
      windowed: window === 'visible',
      ended,
    };
    this.running.set(profileId, entry);
    this.everStarted.add(profileId);
    return entry;
  }
}
