/**
 * Asking before a browser action (D7): an action on a profile that asks parks
 * its step on the write approval's pause, runs on the fresh dispatch after an
 * approval and spends it, is refused with the operator's reason after a
 * denial, and is not performed on a page that changed while the operator
 * decided. The page it waits on is held open for the answer. Against the fake
 * browser, through the step handler a job reaches.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  type AflowError,
  BROWSER_APPROVAL_EXCERPT_MAX_UNITS,
  type BrowserProfile,
  type BrowserWriteApprovalRequestPayload,
  WRITE_APPROVAL_GRANT_TTL_SECONDS,
  writeApprovalLifetimeWords,
  WriteApprovalRequestPayloadSchema,
} from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import {
  type ActionAsk,
  BrowserApprovalRequired,
  browserActionRequestHash,
  summarizeValue,
} from '../browser/actionApproval.js';
import type { BrowserDriver } from '../browser/driver.js';
import { askUnanswerable, scriptAsks } from '../browser/rules.js';
import { createBrowserHandler } from '../handlers/browserHandler.js';
import { memoryApprovals, type MemoryApprovals } from './fixtures/approvals.js';
import { harness, profile, refusal, RUN_A, type Harness } from './fixtures/fakeBrowser.js';

const SHOP = 'https://shop.example.com/';

const FORM = [
  '- main [ref=e1]:',
  '  - heading "Checkout" [level=1] [ref=e2]',
  '  - textbox "Note" [ref=e3]',
  '  - button "Pay now" [ref=e6]',
].join('\n');

interface Written {
  readonly kind: string;
  readonly data: unknown;
}

interface Dispatch {
  readonly result: StepResult;
  readonly writes: Written[];
}

/** One dispatch of a job, as the browser lane delivers it: a fresh step each time. */
async function dispatch(
  h: Harness,
  approvals: MemoryApprovals,
  operationId: string,
  input: unknown,
): Promise<Dispatch> {
  const writes: Written[] = [];
  const ctx = {
    ...RUN_A,
    attempt: 1,
    stepExecutionId: `step-${String(Math.random())}`,
    operationId,
    job: { inputRef: 'inline:input' },
    readPayload: () => Promise.resolve(input),
    writePayload: (kind: string, data: unknown) => {
      writes.push({ kind, data });
      return Promise.resolve(`inline:${kind}-${String(writes.length)}`);
    },
  } as unknown as ExecutorContext;
  const result = await createBrowserHandler(h.driver, approvals).execute(ctx);
  return { result, writes };
}

function asked(ran: Dispatch): BrowserWriteApprovalRequestPayload {
  expect(ran.result.status).toBe('PAUSED');
  const request = ran.writes.find((write) => write.kind === 'input_request')?.data;
  const parsed = WriteApprovalRequestPayloadSchema.parse(request);
  if (parsed.target !== 'browser') throw new Error('expected the browser variant');
  return parsed;
}

function failure(ran: Dispatch): AflowError {
  expect(ran.result.status).toBe('FAILED');
  return ran.writes.find((write) => write.kind === 'error')?.data as AflowError;
}

async function shopFor(browser: BrowserProfile) {
  const h = harness({
    browsers: [browser],
    world: { sites: new Map([[SHOP, { title: 'Checkout', snapshot: FORM }]]) },
  });
  const approvals = memoryApprovals();
  const opened = await dispatch(h, approvals, 'browser.page.open', { url: SHOP });
  const pageId = (opened.writes.at(-1)?.data as { pageId: string }).pageId;
  return { h, approvals, pageId };
}

const pay = (pageId: string) => ({ pageId, ref: 'e6', action: 'click' });

describe('an action on a profile that asks', () => {
  it('parks as an approval pause carrying the browser variant, and does nothing', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const ran = await dispatch(h, approvals, 'browser.page.act', pay(pageId));

    const request = asked(ran);
    expect(request).toMatchObject({
      kind: 'write_approval',
      target: 'browser',
      profileId: 'default',
      pageOrigin: 'https://shop.example.com',
      pageTitle: 'Checkout',
      action: 'click',
      element: { ref: 'e6', role: 'button', name: 'Pay now' },
      askedBy: { kind: 'posture' },
    });
    expect(request.value).toBeUndefined();
    // The page as the operator judges it, stored before the pause.
    expect(ran.writes[0]?.kind).toBe('screenshot');
    expect(request.screenshotRef).toBe('inline:screenshot-1');
    expect(h.pages[0]?.actions).toEqual([]);
  });

  it('opens and reads a page an `ask` rule names, through the proxy, and asks before acting there', async () => {
    const { h, approvals, pageId } = await shopFor(
      profile({ rules: [{ origin: 'https://shop.example.com', effect: 'ask' }] }),
    );
    expect(h.proxies[0]?.refusals).toEqual([]);
    const read = await dispatch(h, approvals, 'browser.page.read', { pageId, what: 'text' });
    expect(read.result.status).toBe('SUCCEEDED');

    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    expect(request.askedBy).toEqual({ kind: 'rule', rule: 'https://shop.example.com' });
    expect(h.pages[0]?.actions).toEqual([]);
  });

  it('runs once on the dispatch after an approval, and the approval is spent', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    approvals.decide(RUN_A, request.requestHash, 'approved');

    const approved = await dispatch(h, approvals, 'browser.page.act', pay(pageId));
    expect(approved.result.status).toBe('SUCCEEDED');
    expect(h.pages[0]?.actions).toEqual([{ ref: 'e6', action: { kind: 'click' } }]);
    expect(approvals.spent.size).toBe(1);

    // The same call again is a new request to the operator, not a second ride on the first.
    const again = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    expect(again.requestHash).toBe(request.requestHash);
    // It names the spent approval, so neither side reads that one as its answer.
    expect(request.decidedBefore).toBeUndefined();
    expect(again.decidedBefore).toBe(approvals.grants.values().next().value?.decidedAt);
    expect(h.pages[0]?.actions).toHaveLength(1);
  });

  it('after a denial, refuses the same request with the reason and asks nobody', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    approvals.decide(RUN_A, request.requestHash, 'denied', 'Not this card.');

    const repeated = await dispatch(h, approvals, 'browser.page.act', pay(pageId));
    const error = failure(repeated);
    expect(error).toMatchObject({
      code: 'BROWSER_ACTION_DENIED',
      classification: 'permission',
      retryable: false,
    });
    expect(error.message).toContain('Not this card.');
    expect(error.message).toContain(
      `stays denied on this page for as long as the request stands, ${writeApprovalLifetimeWords()} from the decision`,
    );
    expect(error.message).not.toContain('final');
    expect(repeated.writes.some((write) => write.kind === 'input_request')).toBe(false);
    expect(h.pages[0]?.actions).toEqual([]);
  });

  it('does not act on a page that changed while the operator decided, and spends the approval', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    h.world.sites.set(SHOP, {
      title: 'Checkout',
      snapshot: FORM.replace('button "Pay now"', 'button "Delete account"'),
    });
    approvals.decide(RUN_A, request.requestHash, 'approved');

    const after = await dispatch(h, approvals, 'browser.page.act', pay(pageId));
    const error = failure(after);
    expect(error.code).toBe('BROWSER_REF_STALE');
    expect(error.message).toContain('the page has changed since');
    expect(error.details?.['outline']).toContain('Delete account');
    expect(h.pages[0]?.actions).toEqual([]);
    expect(approvals.spent.size).toBe(1);

    // The next try asks about the page as it is now.
    const next = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    expect(next.element.name).toBe('Delete account');
    expect(next.requestHash).not.toBe(request.requestHash);
  });

  it('does not act when the element moved into a frame from another origin', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    h.world.sites.set(SHOP, {
      title: 'Checkout',
      snapshot: FORM,
      frames: { e6: 'https://pay.example.net/widget' },
    });
    approvals.decide(RUN_A, request.requestHash, 'approved');

    expect(failure(await dispatch(h, approvals, 'browser.page.act', pay(pageId))).code).toBe(
      'BROWSER_REF_STALE',
    );
    expect(h.pages[0]?.actions).toEqual([]);
    expect(approvals.spent.size).toBe(1);
  });

  it('does not act when the frame the element is in moved to another path on its origin', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    h.world.sites.set(SHOP, {
      title: 'Checkout',
      snapshot: FORM,
      frames: { e6: 'https://shop.example.com/widgets/order-1' },
    });
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    expect(request.pagePath).toBe('/widgets/order-1');
    h.world.sites.set(SHOP, {
      title: 'Checkout',
      snapshot: FORM,
      frames: { e6: 'https://shop.example.com/widgets/order-2' },
    });
    approvals.decide(RUN_A, request.requestHash, 'approved');

    expect(failure(await dispatch(h, approvals, 'browser.page.act', pay(pageId))).code).toBe(
      'BROWSER_REF_STALE',
    );
    expect(h.pages[0]?.actions).toEqual([]);
    expect(approvals.spent.size).toBe(1);
  });

  it('does not act when the element is gone, and spends the approval', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    h.world.sites.set(SHOP, {
      title: 'Checkout',
      snapshot: FORM.split('\n').slice(0, 3).join('\n'),
    });
    // The step's own look at the page has the element; only the page itself lost it.
    approvals.decide(RUN_A, request.requestHash, 'approved');

    expect(failure(await dispatch(h, approvals, 'browser.page.act', pay(pageId))).code).toBe(
      'BROWSER_REF_STALE',
    );
    expect(h.pages[0]?.actions).toEqual([]);
    expect(approvals.spent.size).toBe(1);
  });

  it('never carries a credential field’s value, and refuses entering one before asking', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const typed = 'correct horse battery staple';
    h.world.sites.set(SHOP, {
      title: 'Checkout',
      snapshot: `${FORM}\n  - textbox "Card PIN" [ref=e9]`,
      fields: { e9: { type: 'password' } },
    });
    await dispatch(h, approvals, 'browser.page.snapshot', { pageId });

    const ran = await dispatch(h, approvals, 'browser.page.act', {
      pageId,
      ref: 'e9',
      action: 'type',
      text: typed,
    });
    expect(failure(ran).code).toBe('BROWSER_CREDENTIAL_FIELD');
    expect(JSON.stringify(ran.writes)).not.toContain(typed);
    expect(ran.writes.some((write) => write.kind === 'input_request')).toBe(false);

    const summary = summarizeValue({ kind: 'type', text: typed, submit: true }, true);
    expect(summary).toEqual({
      kind: 'credential',
      length: typed.length,
      truncated: false,
      submit: true,
    });
    expect(JSON.stringify(summary)).not.toContain('horse');
  });

  it('shows a bounded excerpt of an ordinary value, and its length', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const note = 'Leave it at the door. '.repeat(20);
    const request = asked(
      await dispatch(h, approvals, 'browser.page.act', {
        pageId,
        ref: 'e3',
        action: 'type',
        text: note,
        submit: true,
      }),
    );
    expect(request.value).toMatchObject({ kind: 'text', length: note.length, submit: true });
    expect(request.value?.truncated).toBe(true);
    expect(request.value?.excerpt?.length).toBeLessThan(note.length);
    expect(note.startsWith(request.value?.excerpt ?? '-')).toBe(true);

    const short = summarizeValue(
      { kind: 'type', text: 'Leave it at the door.', submit: false },
      false,
    );
    expect(short).toMatchObject({ excerpt: 'Leave it at the door.', truncated: false });
  });

  it('cuts a value of many-unit graphemes between graphemes, within the schema’s bound', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    // A family of four is eleven UTF-16 units, so two hundred of them pass the old bound of
    // 400; a letter under a hundred marks is one grapheme of 101, which the bound itself cuts.
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
    const marked = `a${'\u0301'.repeat(100)}`;
    for (const text of [family.repeat(400), marked.repeat(300)]) {
      const ran = await dispatch(h, approvals, 'browser.page.act', {
        pageId,
        ref: 'e3',
        action: 'type',
        text,
      });
      const request = asked(ran);
      expect(request.value?.truncated).toBe(true);
      const excerpt = request.value?.excerpt ?? '';
      expect(excerpt.length).toBeGreaterThan(0);
      expect(excerpt.length).toBeLessThanOrEqual(BROWSER_APPROVAL_EXCERPT_MAX_UNITS);
      expect(text.startsWith(excerpt)).toBe(true);
      // Ends on a grapheme boundary: what follows starts a whole grapheme.
      const unit = excerpt.endsWith(family) ? family : marked;
      expect(excerpt.length % unit.length).toBe(0);
    }
  });

  it('is refused, not asked, when the call comes from a coding harness', async () => {
    const { h, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const refused = await refusal(
      h.driver.act({ ...RUN_A, pageId, ref: 'e6', action: { kind: 'click' }, redelivered: false }),
    );
    expect(refused.kind).toBe('ask_unanswerable');
    expect(h.pages[0]?.actions).toEqual([]);
  });
});

describe('an approval bound to the address the operator saw', () => {
  const RECORD = `${SHOP}records/1?tab=details#notes`;
  const DELETE = FORM.replace('button "Pay now"', 'button "Delete"');

  /**
   * A single-page application keeps its elements across routes: the same
   * button, with the same reference, role and name, at every address it routes to.
   */
  async function recordPage() {
    const shop = await shopFor(profile({ posture: 'ask-to-act' }));
    for (const url of [
      RECORD,
      `${SHOP}records/2?tab=details#notes`,
      `${SHOP}records/1?tab=history#notes`,
      `${SHOP}records/1?tab=details#delete`,
    ]) {
      shop.h.world.sites.set(url, { title: 'Record', snapshot: DELETE });
    }
    routeTo(shop.h, RECORD);
    return shop;
  }

  function routeTo(h: Harness, url: string): void {
    const page = h.pages[0];
    if (page === undefined) throw new Error('expected an open page');
    page.pushState(url);
  }

  const remove = (pageId: string) => ({ pageId, ref: 'e6', action: 'click' });

  it('shows the path beside the site, and neither the query nor the fragment', async () => {
    const { h, approvals, pageId } = await recordPage();
    const ran = await dispatch(h, approvals, 'browser.page.act', remove(pageId));
    const request = asked(ran);
    expect(request).toMatchObject({
      pageOrigin: 'https://shop.example.com',
      pagePath: '/records/1',
    });
    const written = JSON.stringify(ran.writes);
    expect(written).not.toContain('tab=details');
    expect(written).not.toContain('#notes');
  });

  for (const [what, elsewhere] of [
    ['another path', `${SHOP}records/2?tab=details#notes`],
    ['another query', `${SHOP}records/1?tab=history#notes`],
    ['another fragment', `${SHOP}records/1?tab=details#delete`],
  ] as const) {
    it(`does not act once the page routed to ${what} on the same origin, and spends the approval`, async () => {
      const { h, approvals, pageId } = await recordPage();
      const request = asked(await dispatch(h, approvals, 'browser.page.act', remove(pageId)));
      routeTo(h, elsewhere);
      approvals.decide(RUN_A, request.requestHash, 'approved');

      const after = await dispatch(h, approvals, 'browser.page.act', remove(pageId));
      const error = failure(after);
      expect(error.code).toBe('BROWSER_REF_STALE');
      expect(error.message).toContain('the page has changed since');
      expect(error.details?.['outline']).toContain('Delete');
      expect(h.pages[0]?.actions).toEqual([]);
      expect(approvals.spent.size).toBe(1);

      // The approval is gone: the same call asks again, about the address the page is at now.
      const next = asked(await dispatch(h, approvals, 'browser.page.act', remove(pageId)));
      expect(next.requestHash).not.toBe(request.requestHash);
      expect(h.pages[0]?.actions).toEqual([]);
    });
  }

  it('acts once at an unchanged address', async () => {
    const { h, approvals, pageId } = await recordPage();
    const request = asked(await dispatch(h, approvals, 'browser.page.act', remove(pageId)));
    approvals.decide(RUN_A, request.requestHash, 'approved');

    const approved = await dispatch(h, approvals, 'browser.page.act', remove(pageId));
    expect(approved.result.status).toBe('SUCCEEDED');
    expect(h.pages[0]?.actions).toEqual([{ ref: 'e6', action: { kind: 'click' } }]);
    expect(approvals.spent.size).toBe(1);
    asked(await dispatch(h, approvals, 'browser.page.act', remove(pageId)));
    expect(h.pages[0]?.actions).toHaveLength(1);
  });
});

describe('a page waiting on the operator’s answer', () => {
  const MINUTE = 60_000;

  it('stays open, its browser running, past the idle limit; an approval after 31 minutes runs', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const parkedAt = h.clock.now;
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    expect(Date.parse(request.standsUntil)).toBe(
      parkedAt + WRITE_APPROVAL_GRANT_TTL_SECONDS * 1000,
    );

    h.clock.now += 31 * MINUTE;
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 0, stoppedProfiles: 0 });
    expect(h.pages[0]?.closed).toBe(false);
    expect(h.stops).toEqual([]);

    approvals.decide(RUN_A, request.requestHash, 'approved');
    // A sweep between the answer and the dispatch it brings leaves the page for that dispatch.
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 0, stoppedProfiles: 0 });
    const approved = await dispatch(h, approvals, 'browser.page.act', pay(pageId));
    expect(approved.result.status).toBe('SUCCEEDED');
    expect(h.pages[0]?.actions).toEqual([{ ref: 'e6', action: { kind: 'click' } }]);
  });

  it('is swept as any idle page once the request lapses unanswered', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));

    h.clock.now += 31 * MINUTE;
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 0, stoppedProfiles: 0 });
    h.clock.now += WRITE_APPROVAL_GRANT_TTL_SECONDS * 1000 - 31 * MINUTE;
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 1, stoppedProfiles: 0 });
    expect(h.pages[0]?.closed).toBe(true);
    h.clock.now += 31 * MINUTE;
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 0, stoppedProfiles: 1 });
  });

  it('is swept after the idle limit once a denial is on record', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    h.clock.now += 31 * MINUTE;
    approvals.decide(RUN_A, request.requestHash, 'denied');
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 0, stoppedProfiles: 0 });
    h.clock.now += 31 * MINUTE;
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 1, stoppedProfiles: 0 });
  });

  it('reads an earlier approval, already spent, as no answer to the request asked again', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'ask-to-act' }));
    const first = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    approvals.decide(RUN_A, first.requestHash, 'approved');
    await dispatch(h, approvals, 'browser.page.act', pay(pageId));
    asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));

    h.clock.now += 31 * MINUTE;
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 0, stoppedProfiles: 0 });
    h.clock.now += 20 * MINUTE;
    expect(await h.driver.sweepIdle(20)).toEqual({ closedPages: 0, stoppedProfiles: 0 });
  });
});

describe('an approval request the schema refuses', () => {
  it('fails the step with an internal error naming the schema, and parks nothing', async () => {
    const request: BrowserWriteApprovalRequestPayload = {
      kind: 'write_approval',
      target: 'browser',
      profileId: 'default',
      pageOrigin: 'https://shop.example.com',
      pagePath: '/',
      pageTitle: 'Checkout',
      action: 'type',
      element: { ref: 'e3', role: 'textbox', name: 'Note' },
      value: {
        kind: 'text',
        length: 1,
        excerpt: 'x'.repeat(BROWSER_APPROVAL_EXCERPT_MAX_UNITS + 1),
        truncated: true,
      },
      askedBy: { kind: 'posture' },
      standsUntil: '2026-10-04T13:00:00.000Z',
      requestHash: 'hash-1',
    };
    const driver = {
      act: () => Promise.reject(new BrowserApprovalRequired(request)),
    } as unknown as BrowserDriver;
    const writes: Written[] = [];
    const ctx = {
      ...RUN_A,
      attempt: 1,
      stepExecutionId: 'step-1',
      operationId: 'browser.page.act',
      job: { inputRef: 'inline:input' },
      readPayload: () => Promise.resolve({ pageId: 'pg_1', ref: 'e3', action: 'type', text: 'x' }),
      writePayload: (kind: string, data: unknown) => {
        writes.push({ kind, data });
        return Promise.resolve(`inline:${kind}`);
      },
    } as unknown as ExecutorContext;

    const result = await createBrowserHandler(driver, memoryApprovals()).execute(ctx);
    expect(result.status).toBe('FAILED');
    expect(writes.some((write) => write.kind === 'input_request')).toBe(false);
    const error = writes.find((write) => write.kind === 'error')?.data as AflowError;
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', classification: 'internal' });
    expect(error.message).toContain('WriteApprovalRequestPayloadSchema');
  });
});

describe('what a refusal to ask says', () => {
  const asking = profile({ posture: 'ask-to-act' });

  it('names the coding harness only where a harness could not wait', () => {
    expect(askUnanswerable(asking, 'https://shop.example.com').message).toContain(
      'a coding harness cannot wait for an answer',
    );
  });

  it('refuses a script as something that cannot be shown as one action, whoever asked', () => {
    const refused = scriptAsks(asking, 'https://shop.example.com');
    expect(refused.kind).toBe('script_refused');
    expect(refused.message).toContain('a script cannot be shown to them as one action to approve');
    expect(refused.message).not.toContain('harness');
  });
});

describe('profiles that do not ask', () => {
  it('autonomous: acts at once and records nothing for an approval', async () => {
    const { h, approvals, pageId } = await shopFor(profile());
    const ran = await dispatch(h, approvals, 'browser.page.act', pay(pageId));
    expect(ran.result.status).toBe('SUCCEEDED');
    expect(h.pages[0]?.actions).toHaveLength(1);
    expect(approvals.grants.size).toBe(0);
    expect(approvals.spent.size).toBe(0);
  });

  it('read-only: refuses as before, and asks nobody', async () => {
    const { h, approvals, pageId } = await shopFor(profile({ posture: 'read-only' }));
    const ran = await dispatch(h, approvals, 'browser.page.act', pay(pageId));
    expect(failure(ran).code).toBe('BROWSER_POSTURE_REFUSED');
    expect(ran.writes.some((write) => write.kind === 'input_request')).toBe(false);
  });
});

describe('the request hash', () => {
  const ask: ActionAsk = {
    profileId: 'default',
    pageId: 'pg_1',
    pageUrl: 'https://shop.example.com/orders/1?tab=items#note',
    frameUrl: 'https://shop.example.com/orders/1?tab=items#note',
    pageOrigin: 'https://shop.example.com',
    pagePath: '/orders/1',
    pageTitle: 'Checkout',
    ref: 'e3',
    element: { role: 'textbox', name: 'Note' },
    action: { kind: 'type', text: 'leave at the door', submit: false },
    credentialField: false,
    askedBy: { kind: 'posture' },
  };

  it('is the same for the same request, whatever the title or what asked', () => {
    expect(browserActionRequestHash({ ...ask })).toBe(browserActionRequestHash(ask));
    expect(
      browserActionRequestHash({
        ...ask,
        pageTitle: 'Other',
        askedBy: { kind: 'rule', rule: 'x' },
      }),
    ).toBe(browserActionRequestHash(ask));
  });

  it('differs with the profile, page, address, origin, element, action or value', () => {
    const base = browserActionRequestHash(ask);
    for (const changed of [
      { ...ask, profileId: 'work' },
      { ...ask, pageId: 'pg_2' },
      { ...ask, pageUrl: 'https://shop.example.com/orders/2?tab=items#note' },
      { ...ask, pageUrl: 'https://shop.example.com/orders/1?tab=refunds#note' },
      { ...ask, pageUrl: 'https://shop.example.com/orders/1?tab=items#delete' },
      { ...ask, frameUrl: 'https://shop.example.com/orders/2?tab=items#note' },
      { ...ask, pageOrigin: 'https://pay.example.net' },
      { ...ask, ref: 'e4' },
      { ...ask, element: { role: 'textbox', name: 'Gift message' } },
      { ...ask, action: { kind: 'press', key: 'Enter' } as const },
      { ...ask, action: { kind: 'type', text: 'leave with a neighbour', submit: false } as const },
      { ...ask, action: { kind: 'type', text: 'leave at the door', submit: true } as const },
    ]) {
      expect(browserActionRequestHash(changed)).not.toBe(base);
    }
  });
});
