/**
 * A page's own address leaves the driver as a request's does: no userinfo, no
 * fragment, and every query value replaced, the parameter names kept.
 */
import { describe, expect, it } from 'vitest';

import { harness, refusal, RUN_A } from './fixtures/fakeBrowser.js';

const HOME = 'https://example.com/';
const START = 'https://example.com/start';
const LANDING = 'https://example.com/welcome?code=abc&state=xyz#ref=1';
const SHOWN = 'https://example.com/welcome?code=redacted&state=redacted';
const PAGE = '- main [ref=e1]:\n  - button "Continue" [ref=e2]';

function landing() {
  return harness({
    world: {
      sites: new Map([
        [HOME, { title: 'Home', snapshot: PAGE }],
        [START, { title: 'Start', snapshot: PAGE }],
        [LANDING, { title: 'Welcome', snapshot: PAGE }],
      ]),
      redirects: new Map([[START, LANDING]]),
      onAct: (page, ref) => {
        if (ref === 'e2') page.load(LANDING);
      },
    },
  });
}

async function openAt(h: ReturnType<typeof landing>, url: string) {
  return await h.driver.open({ ...RUN_A, redelivered: false, profileId: 'default', url });
}

describe('the address a page is at, as it leaves the driver', () => {
  it('open: a redirect onto a landing page with a code', async () => {
    const opened = await openAt(landing(), START);
    expect(opened.url).toBe(SHOWN);
    expect(opened.redirected).toBe(true);
  });

  it('navigate, and a move that changes only a query value still counts as a move', async () => {
    const h = landing();
    const { pageId } = await openAt(h, LANDING);
    const moved = await h.driver.navigate({
      ...RUN_A,
      pageId,
      to: { kind: 'url', url: 'https://example.com/welcome?code=def&state=xyz' },
      redelivered: false,
    });
    expect(moved.view.url).toBe(SHOWN);
    expect(moved.outcome === 'performed' && moved.changed.urlChanged).toBe(true);
  });

  it('act', async () => {
    const h = landing();
    const { pageId } = await openAt(h, HOME);
    const acted = await h.driver.act({
      ...RUN_A,
      pageId,
      ref: 'e2',
      action: { kind: 'click' },
      redelivered: false,
    });
    expect(acted.view.url).toBe(SHOWN);
  });

  it('snapshot, read and list', async () => {
    const h = landing();
    const { pageId } = await openAt(h, START);
    expect((await h.driver.snapshot(RUN_A, pageId)).url).toBe(SHOWN);
    expect((await h.driver.readPage(RUN_A, pageId, 'text')).url).toBe(SHOWN);
    expect((await h.driver.list(RUN_A))[0]?.url).toBe(SHOWN);
  });

  it('page_gone, after a close and after the browser stopped', async () => {
    const h = landing();
    const closed = await openAt(h, START);
    await h.driver.close(RUN_A, closed.pageId);
    const gone = await refusal(h.driver.snapshot(RUN_A, closed.pageId));
    expect(gone.kind).toBe('page_gone');
    expect(gone.details['lastUrl']).toBe(SHOWN);
    expect(gone.message).toContain(SHOWN);
    expect(gone.message).not.toContain('abc');

    const stopped = await openAt(h, START);
    await h.endBrowser();
    const lost = await refusal(h.driver.snapshot(RUN_A, stopped.pageId));
    expect(lost.kind).toBe('page_gone');
    expect(lost.details['lastUrl']).toBe(SHOWN);
    expect(lost.message).not.toContain('#ref');
  });
});
