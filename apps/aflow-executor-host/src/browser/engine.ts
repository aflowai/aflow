/**
 * The one module that speaks to `playwright-core`.
 *
 * It attaches to a Chrome this executor already started; it never launches
 * one. A browser the library launched would sit outside the process table that
 * withdrawal, shutdown and the next boot's orphan sweep read.
 */
import { chromium } from 'playwright-core';

import type { BrowserEngine, EngineBrowser, EnginePage, PageSnapshot } from './types.js';

interface PwLocator {
  evaluate<R>(fn: (element: unknown) => R): Promise<R>;
}

interface PwPage {
  goto(url: string, options: { timeout: number; waitUntil: 'load' }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  ariaSnapshot(options: { mode: 'ai' }): Promise<string>;
  locator(selector: string): PwLocator;
  close(): Promise<void>;
  isClosed(): boolean;
}

interface PwContext {
  newPage(): Promise<PwPage>;
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

function wrapPage(page: PwPage): EnginePage {
  return {
    goto: async (url, timeoutMs) => {
      await page.goto(url, { timeout: timeoutMs, waitUntil: 'load' });
    },
    url: () => page.url(),
    title: async () => await page.title(),
    snapshot: async (): Promise<PageSnapshot> => {
      const text = await page.ariaSnapshot({ mode: 'ai' });
      return { text, maskedRefs: await maskedRefs(page, text) };
    },
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
        newPage: async () => wrapPage(await context.newPage()),
        disconnect: async () => {
          await browser.close();
        },
      };
    },
  };
}
