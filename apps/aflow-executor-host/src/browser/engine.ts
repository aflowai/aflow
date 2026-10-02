/**
 * The one module that speaks to `playwright-core`.
 *
 * It attaches to a Chrome this executor already started; it never launches
 * one. A browser the library launched would sit outside the process table that
 * withdrawal, shutdown and the next boot's orphan sweep read.
 */
import { chromium } from 'playwright-core';

import { entersValue } from './credentialFields.js';
import { errorText } from './errors.js';
import {
  type BrowserEngine,
  type EngineAction,
  type EngineBrowser,
  EngineCredentialField,
  EngineFieldUnchecked,
  type EngineNavigation,
  EngineNavigationFailed,
  type EnginePage,
  EngineRefNotFound,
  type PageEvents,
  type PageSnapshot,
} from './types.js';

/** How long a navigation may take to reach DOMContentLoaded before it fails. */
const DOM_CONTENT_LOADED_TIMEOUT_MS = 30_000;
/**
 * How long to wait past DOMContentLoaded for the load event. A page that keeps
 * a connection open or loads forever never fires it, and is read as it stands.
 */
const LOAD_EVENT_GRACE_MS = 5_000;
/** How long an action waits for its element to become actionable. */
const ACTION_TIMEOUT_MS = 10_000;

interface PwFrame {
  url(): string;
  parentFrame(): PwFrame | null;
}

interface PwElementHandle {
  ownerFrame(): Promise<PwFrame | null>;
  dispose(): Promise<void>;
}

interface PwLocator {
  evaluate<R>(fn: (element: unknown) => R): Promise<R>;
  count(): Promise<number>;
  elementHandle(options: { timeout: number }): Promise<PwElementHandle>;
  click(options: { timeout: number }): Promise<void>;
  hover(options: { timeout: number }): Promise<void>;
  fill(text: string, options: { timeout: number }): Promise<void>;
  press(key: string, options: { timeout: number }): Promise<void>;
  selectOption(values: string[], options: { timeout: number }): Promise<string[]>;
  innerText(options: { timeout: number }): Promise<string>;
}

interface PwRequest {
  method(): string;
  url(): string;
  resourceType(): string;
  failure(): { errorText: string } | null;
  isNavigationRequest(): boolean;
  frame(): PwFrame;
  redirectedFrom(): PwRequest | null;
}

interface PwResponse {
  status(): number;
  request(): PwRequest;
}

interface PwConsoleMessage {
  type(): string;
  text(): string;
}

interface WaitUntil {
  timeout: number;
  waitUntil: 'domcontentloaded';
}

interface PwPage {
  goto(url: string, options: WaitUntil): Promise<unknown>;
  goBack(options: WaitUntil): Promise<unknown>;
  goForward(options: WaitUntil): Promise<unknown>;
  reload(options: WaitUntil): Promise<unknown>;
  waitForLoadState(state: 'load', options: { timeout: number }): Promise<void>;
  url(): string;
  mainFrame(): PwFrame;
  title(): Promise<string>;
  ariaSnapshot(options: { mode: 'ai' }): Promise<string>;
  locator(selector: string): PwLocator;
  on(event: 'console', listener: (message: PwConsoleMessage) => void): void;
  on(event: 'response', listener: (response: PwResponse) => void): void;
  on(event: 'request' | 'requestfailed', listener: (request: PwRequest) => void): void;
  off(event: 'request', listener: (request: PwRequest) => void): void;
  close(): Promise<void>;
  isClosed(): boolean;
}

interface PwContext {
  newPage(): Promise<PwPage>;
  cookies(): Promise<Array<{ domain: string }>>;
}

interface PwBrowser {
  contexts(): PwContext[];
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
}

interface PwChromium {
  connectOverCDP(endpoint: string, options: { timeout: number }): Promise<PwBrowser>;
}

/** Beyond this many text fields a page's remaining ones are masked unchecked. */
const MAX_TEXTBOXES_CHECKED = 200;

const TEXTBOX_REF = /^\s*- '?textbox\b[^\n]*?\[ref=([^\]\s]+)\]/gm;

function isPasswordInput(element: unknown): boolean {
  const candidate = element as { tagName?: unknown; type?: unknown };
  return candidate.tagName === 'INPUT' && candidate.type === 'password';
}

async function maskedRefs(page: PwPage, text: string): Promise<Set<string>> {
  const masked = new Set<string>();
  const refs = [...text.matchAll(TEXTBOX_REF)].map((match) => match[1] ?? '');
  for (const [index, ref] of refs.entries()) {
    if (ref === '') continue;
    if (index >= MAX_TEXTBOXES_CHECKED) {
      masked.add(ref);
      continue;
    }
    try {
      if (await page.locator(`aria-ref=${ref}`).evaluate(isPasswordInput)) masked.add(ref);
    } catch {
      // A field that could not be inspected is treated as the one it might be.
      masked.add(ref);
    }
  }
  return masked;
}

async function settle(page: PwPage): Promise<void> {
  await page.waitForLoadState('load', { timeout: LOAD_EVENT_GRACE_MS }).catch(() => undefined);
}

async function navigate(page: PwPage, to: EngineNavigation): Promise<boolean> {
  const options: WaitUntil = {
    timeout: DOM_CONTENT_LOADED_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  };
  let moved = true;
  switch (to.kind) {
    case 'url':
      await page.goto(to.url, options);
      break;
    case 'back':
      moved = (await page.goBack(options)) !== null;
      break;
    case 'forward':
      moved = (await page.goForward(options)) !== null;
      break;
    case 'reload':
      await page.reload(options);
      break;
  }
  await settle(page);
  return moved;
}

function isMainFrameNavigation(page: PwPage, request: PwRequest): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame() === page.mainFrame();
  } catch {
    // Playwright throws for a navigation issued before its frame exists: a popup's, never this page's.
    return false;
  }
}

/**
 * The chain is followed by `redirectedFrom`, so a navigation the page starts
 * on its own while this one is under way is not mistaken for part of it.
 */
async function navigateReportingChain(page: PwPage, to: EngineNavigation): Promise<boolean> {
  const chain: PwRequest[] = [];
  const onRequest = (request: PwRequest): void => {
    if (!isMainFrameNavigation(page, request)) return;
    const tail = chain.at(-1);
    if (tail === undefined || request.redirectedFrom() === tail) chain.push(request);
  };
  page.on('request', onRequest);
  try {
    return await navigate(page, to);
  } catch (error) {
    throw new EngineNavigationFailed(
      error instanceof Error ? error.message : String(error),
      chain.map((request) => request.url()),
    );
  } finally {
    page.off('request', onRequest);
  }
}

async function act(page: PwPage, ref: string, action: EngineAction): Promise<void> {
  const element = page.locator(`aria-ref=${ref}`);
  if ((await element.count()) === 0) throw new EngineRefNotFound(ref);
  const timeout = ACTION_TIMEOUT_MS;
  // Checked on the element itself, at the moment of the action: the outline
  // the agent read may be older than the field now under that reference.
  if (entersValue(action)) {
    let password: boolean;
    try {
      password = await element.evaluate(isPasswordInput);
    } catch (error) {
      throw new EngineFieldUnchecked(ref, errorText(error));
    }
    if (password) throw new EngineCredentialField(ref);
  }
  switch (action.kind) {
    case 'click':
      await element.click({ timeout });
      break;
    case 'hover':
      await element.hover({ timeout });
      break;
    case 'type':
      await element.fill(action.text, { timeout });
      if (action.submit) await element.press('Enter', { timeout });
      break;
    case 'select':
      await element.selectOption([...action.values], { timeout });
      break;
    case 'press':
      await element.press(action.key, { timeout });
      break;
  }
  await settle(page);
}

const HAS_ITS_OWN_ORIGIN = /^https?:/;

/**
 * Read from Playwright's frame tree rather than from the page's own script,
 * which the page controls.
 */
async function frameUrl(page: PwPage, ref: string): Promise<string> {
  const element = page.locator(`aria-ref=${ref}`);
  if ((await element.count()) === 0) throw new EngineRefNotFound(ref);
  const handle = await element.elementHandle({ timeout: ACTION_TIMEOUT_MS });
  try {
    let frame = await handle.ownerFrame();
    while (frame !== null && !HAS_ITS_OWN_ORIGIN.test(frame.url())) frame = frame.parentFrame();
    return frame?.url() ?? page.url();
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

function wrapPage(page: PwPage, events: PageEvents): EnginePage {
  page.on('console', (message) => {
    events.console(message.type(), message.text());
  });
  page.on('response', (response) => {
    const request = response.request();
    events.request({
      method: request.method(),
      url: request.url(),
      status: response.status(),
      resourceType: request.resourceType(),
    });
  });
  page.on('requestfailed', (request) => {
    events.request({
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText ?? 'failed',
      resourceType: request.resourceType(),
    });
  });
  return {
    navigate: async (to) => await navigateReportingChain(page, to),
    act: async (ref, action) => {
      await act(page, ref, action);
    },
    frameUrl: async (ref) => await frameUrl(page, ref),
    url: () => page.url(),
    title: async () => await page.title(),
    snapshot: async (): Promise<PageSnapshot> => {
      const text = await page.ariaSnapshot({ mode: 'ai' });
      return { text, maskedRefs: await maskedRefs(page, text) };
    },
    text: async () => await page.locator('body').innerText({ timeout: ACTION_TIMEOUT_MS }),
    close: async () => {
      await page.close();
    },
    isClosed: () => page.isClosed(),
  };
}

export function createPlaywrightEngine(): BrowserEngine {
  const cdp = chromium as PwChromium;
  return {
    connect: async (endpoint, timeoutMs): Promise<EngineBrowser> => {
      const browser = await cdp.connectOverCDP(endpoint, { timeout: timeoutMs });
      // The default context is the profile's own, which is where its sign-ins are.
      const context = browser.contexts()[0] ?? (await browser.newContext());
      return {
        newPage: async (events) => wrapPage(await context.newPage(), events),
        cookieSites: async () => {
          const domains = (await context.cookies()).map((cookie) =>
            cookie.domain.replace(/^\./, '').toLowerCase(),
          );
          return [...new Set(domains)].sort();
        },
        disconnect: async () => {
          await browser.close();
        },
      };
    },
  };
}
