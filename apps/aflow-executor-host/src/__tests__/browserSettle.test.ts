/**
 * After an action the page is read once it has stopped changing, on evidence,
 * never on a navigation that may not come. A single-page application that
 * routes by script changes its address through history and re-renders a
 * moment later; the result must be the new page, and the wait must end at the
 * settle cap however busy the page is.
 */
import { describe, expect, it } from 'vitest';

import { OUTLINE_QUIET_INTERVAL_MS, OUTLINE_SETTLE_CAP_MS } from '../browser/settle.js';
import { harness, RUN_A } from './fixtures/fakeBrowser.js';

const HOME = [
  '- main [ref=e1]:',
  '  - heading "Welcome" [level=1] [ref=e2]',
  '  - link "Pricing" [ref=e3]:',
  '    - /url: /pricing',
  '  - button "Menu" [ref=e4]',
].join('\n');

const PRICING = [
  '- main [ref=e1]:',
  '  - heading "Pricing" [level=1] [ref=e9]',
  '  - button "Start a trial" [ref=e10]',
].join('\n');

function app(home: { neverQuiet?: boolean } = {}) {
  return harness({
    world: {
      sites: new Map([
        ['https://app.example.com/', { title: 'App', snapshot: HOME, ...home }],
        ['https://app.example.com/pricing', { title: 'App', snapshot: PRICING }],
      ]),
    },
  });
}

async function openApp(h: ReturnType<typeof app>): Promise<string> {
  return (
    await h.driver.open({
      ...RUN_A,
      redelivered: false,
      profileId: 'default',
      url: 'https://app.example.com/',
    })
  ).pageId;
}

describe('the read after an action', () => {
  it('returns the new outline when the page moved through history without a navigation', async () => {
    const h = app();
    const pageId = await openApp(h);
    const page = h.pages[0];
    if (page === undefined) throw new Error('no page');
    // The script routes after the click returns: the first read still sees the old page.
    let routed = false;
    h.onSleep = () => {
      if (routed) return;
      routed = true;
      page.pushState('https://app.example.com/pricing');
    };
    const startedAt = h.clock.now;

    const result = await h.driver.act({
      ...RUN_A,
      pageId,
      ref: 'e3',
      action: { kind: 'click' },
      redelivered: false,
    });

    expect(result.outcome).toBe('performed');
    if (result.outcome !== 'performed') return;
    expect(result.view.url).toBe('https://app.example.com/pricing');
    expect(result.view.outline.text).toContain('- heading "Pricing" [level=1] [ref=e9]');
    expect(result.view.outline.text).not.toContain('[ref=e3]');
    expect(result.changed).toEqual({ urlChanged: true, titleChanged: false, outlineChanged: true });
    expect(result.view.settled).toBe(true);
    expect(page.navigations).toHaveLength(1);
    expect(h.clock.now - startedAt).toBeLessThanOrEqual(OUTLINE_SETTLE_CAP_MS);
  });

  it('returns promptly, saying nothing changed, when the action changed nothing', async () => {
    const h = app();
    const pageId = await openApp(h);
    const startedAt = h.clock.now;

    const result = await h.driver.act({
      ...RUN_A,
      pageId,
      ref: 'e4',
      action: { kind: 'hover' },
      redelivered: false,
    });

    expect(result.outcome).toBe('performed');
    if (result.outcome !== 'performed') return;
    expect(result.changed.outlineChanged).toBe(false);
    expect(result.view.settled).toBe(true);
    expect(h.clock.now - startedAt).toBe(OUTLINE_QUIET_INTERVAL_MS);
  });

  it('returns at the cap, unsettled, from a page that never goes quiet', async () => {
    const h = app({ neverQuiet: true });
    const opened = await h.driver.open({
      ...RUN_A,
      redelivered: false,
      profileId: 'default',
      url: 'https://app.example.com/',
    });
    expect(opened.settled).toBe(false);
    const startedAt = h.clock.now;

    const result = await h.driver.act({
      ...RUN_A,
      pageId: opened.pageId,
      ref: 'e4',
      action: { kind: 'hover' },
      redelivered: false,
    });

    expect(result.outcome).toBe('performed');
    if (result.outcome !== 'performed') return;
    expect(result.view.settled).toBe(false);
    expect(h.clock.now - startedAt).toBeLessThanOrEqual(OUTLINE_SETTLE_CAP_MS);
    expect(h.clock.now - startedAt).toBeGreaterThan(
      OUTLINE_SETTLE_CAP_MS - OUTLINE_QUIET_INTERVAL_MS,
    );
  });

  it('settles a navigation the same way', async () => {
    const h = app();
    const pageId = await openApp(h);
    const moved = await h.driver.navigate({
      ...RUN_A,
      pageId,
      to: { kind: 'url', url: 'https://app.example.com/pricing' },
      redelivered: false,
    });
    expect(moved.outcome === 'performed' && moved.view.settled).toBe(true);
  });
});
