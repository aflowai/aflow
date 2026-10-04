/**
 * Asking before a browser action (D7): an action on a profile that asks parks
 * its step on the write approval's pause, runs on the fresh dispatch after an
 * approval and spends it, is refused with the operator's reason after a
 * denial, and is not performed on a page that changed while the operator
 * decided. Against the fake browser, through the step handler a job reaches.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  type AflowError,
  type BrowserProfile,
  type BrowserWriteApprovalRequestPayload,
  WriteApprovalRequestPayloadSchema,
} from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import {
  type ActionAsk,
  browserActionRequestHash,
  summarizeValue,
} from '../browser/actionApproval.js';
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

  it('asks on a page an `ask` rule names, saying which rule asked', async () => {
    const { h, approvals, pageId } = await shopFor(profile());
    h.setProfiles([profile({ rules: [{ origin: 'https://shop.example.com', effect: 'ask' }] })]);
    const request = asked(await dispatch(h, approvals, 'browser.page.act', pay(pageId)));
    expect(request.askedBy).toEqual({ kind: 'rule', rule: 'https://shop.example.com' });
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
    expect(summary).toEqual({ kind: 'credential', length: typed.length, submit: true });
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
    expect(request.value?.excerpt?.length).toBeLessThan(note.length);
    expect(note.startsWith(request.value?.excerpt?.slice(0, -1) ?? '-')).toBe(true);
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
    pageOrigin: 'https://shop.example.com',
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

  it('differs with the profile, page, origin, element, action or value', () => {
    const base = browserActionRequestHash(ask);
    for (const changed of [
      { ...ask, profileId: 'work' },
      { ...ask, pageId: 'pg_2' },
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
