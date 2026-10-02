/**
 * The operator's window, against the fake browser and a clock the tests
 * move: the restart that shows it and what other runs' pages are told, a
 * hand-off ending each of its three ways, every other run refused while the
 * operator has the window, and the sign-in sitting.
 */
import type { ExecutorContext } from '@aflow/executor-runtime';
import { getOperation } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { HANDOFF_QUIET_MS } from '../browser/operatorWindow.js';
import { browserFailure, createBrowserHandler } from '../handlers/browserHandler.js';
import {
  type FakePage,
  harness,
  type Harness,
  profile,
  refusal,
  RUN_A,
  RUN_B,
} from './fixtures/fakeBrowser.js';

const LOGIN = 'https://accounts.example.com/login';
const INBOX = 'https://mail.example.com/inbox';
const NEWS = 'https://news.example.org/';

const INBOX_PAGE = [
  '- main [ref=e1]:',
  '  - heading "Inbox" [level=1] [ref=e2]',
  '  - link "Invoice for March" [ref=e3]',
].join('\n');

function world(options: Parameters<typeof harness>[0] = {}): Harness {
  return harness({
    ...options,
    world: {
      sites: new Map([
        [INBOX, { title: 'Inbox', snapshot: INBOX_PAGE }],
        [NEWS, { title: 'News', snapshot: INBOX_PAGE }],
      ]),
    },
  });
}

async function open(h: Harness, run: typeof RUN_A, url: string): Promise<string> {
  return (await h.driver.open({ ...run, redelivered: false, profileId: 'default', url })).pageId;
}

/** The page the operator sees: the first one of the windowed browser. */
function windowPage(h: Harness): FakePage | undefined {
  return h.pagesByLaunch[1]?.[0];
}

describe('the windowed restart', () => {
  it('restarts the profile with a window and back, and tells another run its page went for it', async () => {
    const h = world({ waitForOperator: () => Promise.resolve('window_closed') });
    const mine = await open(h, RUN_A, LOGIN);
    const theirs = await open(h, RUN_B, NEWS);

    const result = await h.driver.handoff({
      ...RUN_A,
      pageId: mine,
      reason: 'sign_in',
      message: 'Sign in to the mail account.',
    });

    expect(h.launches.map((launch) => launch.profile.window)).toEqual([
      'hidden',
      'visible',
      'hidden',
    ]);
    // The same profile directory each time, behind a proxy of its own each time.
    expect(new Set(h.launches.map((launch) => launch.profile.id))).toEqual(new Set(['default']));
    expect(h.proxies).toHaveLength(3);
    expect(result.restarted).toBe(true);

    const gone = await refusal(h.driver.snapshot(RUN_B, theirs));
    expect(gone.kind).toBe('page_gone');
    expect(gone.message).toContain('restarted to show the operator a window');
    expect(gone.details['lastUrl']).toBe(NEWS);
  });

  it('does not restart a profile whose window is already visible', async () => {
    const h = world({
      browsers: [profile({ window: 'visible' })],
      waitForOperator: () => Promise.resolve('window_closed'),
    });
    const mine = await open(h, RUN_A, LOGIN);
    const theirs = await open(h, RUN_B, NEWS);

    const result = await h.driver.handoff({
      ...RUN_A,
      pageId: mine,
      reason: 'challenge',
      message: 'Pass the check on this page.',
    });

    expect(h.launches).toHaveLength(1);
    expect(result.restarted).toBe(false);
    expect(result.previousPageId).toBeUndefined();
    expect(result.view.pageId).toBe(mine);
    expect((await h.driver.snapshot(RUN_B, theirs)).url).toBe(NEWS);
  });
});

describe('a hand-off', () => {
  it('completes when the page leaves the site it was handed over on and goes quiet', async () => {
    const h = world();
    const mine = await open(h, RUN_A, LOGIN);
    let signedInAt: number | undefined;
    h.onSleep = (now) => {
      const page = windowPage(h);
      if (page === undefined || signedInAt !== undefined || page.url() !== LOGIN) return;
      page.load(INBOX);
      signedInAt = now;
    };

    const result = await h.driver.handoff({
      ...RUN_A,
      pageId: mine,
      reason: 'sign_in',
      message: 'Sign in to the mail account; the run then reads the inbox.',
    });

    expect(result.outcome).toBe('completed');
    expect(result.view.url).toBe(INBOX);
    expect(result.view.outline.text).toContain('[ref=e3]');
    expect(result.previousPageId).toBe(mine);
    expect(result.view.pageId).not.toBe(mine);
    expect(h.clock.now - (signedInAt ?? 0)).toBeGreaterThanOrEqual(HANDOFF_QUIET_MS);
    const old = await refusal(h.driver.snapshot(RUN_A, mine));
    expect(old.message).toContain(`the hand-off replaced it with \`${result.view.pageId}\``);
    expect((await h.driver.snapshot(RUN_A, result.view.pageId)).url).toBe(INBOX);
  });

  it('ends as window_closed when the operator closes the window, back where it began', async () => {
    const h = world();
    const mine = await open(h, RUN_A, LOGIN);
    h.onSleep = () => {
      const page = windowPage(h);
      if (page !== undefined) page.closed = true;
    };

    const result = await h.driver.handoff({
      ...RUN_A,
      pageId: mine,
      reason: 'confirm',
      message: 'Confirm the payment yourself.',
    });

    expect(result.outcome).toBe('window_closed');
    expect(result.view.url).toBe(LOGIN);
  });

  it('times out at the profile’s deadline, and the step is given room for it', async () => {
    const h = world({ browsers: [profile({ handoffMinutes: 2 })] });
    const mine = await open(h, RUN_A, LOGIN);
    let written: unknown;
    const ctx = {
      tenantId: RUN_A.tenantId,
      runId: RUN_A.runId,
      spaceId: RUN_A.spaceId,
      attempt: 1,
      operationId: 'browser.page.handoff',
      job: { inputRef: 'inline:input' },
      readPayload: () =>
        Promise.resolve({ pageId: mine, reason: 'sign_in', message: 'Sign in, please.' }),
      writePayload: (_kind: string, data: unknown) => {
        written = data;
        return Promise.resolve('inline:output');
      },
    } as unknown as ExecutorContext;
    const handler = createBrowserHandler(h.driver);

    expect(await handler.resolveTimeoutMs?.(ctx)).toBeGreaterThan(2 * 60_000);
    const result = await handler.execute(ctx);

    expect(result.status).toBe('SUCCEEDED');
    const output = getOperation('browser.page.handoff')?.outputZod?.parse(written) as {
      outcome: string;
      receipt: { waitedSeconds: number; restarted: boolean; settled: boolean };
    };
    expect(output.outcome).toBe('timed_out');
    expect(output.receipt.waitedSeconds).toBeGreaterThanOrEqual(120);
    expect(output.receipt.restarted).toBe(true);
  });

  it('is not refused by a read-only posture: the operator is the one acting', async () => {
    const h = world({
      browsers: [profile({ posture: 'read-only' })],
      waitForOperator: () => Promise.resolve('window_closed'),
    });
    const mine = await open(h, RUN_A, LOGIN);
    const result = await h.driver.handoff({
      ...RUN_A,
      pageId: mine,
      reason: 'sign_in',
      message: 'Sign in.',
    });
    expect(result.outcome).toBe('window_closed');
  });
});

describe('while the operator has the window', () => {
  it('refuses every other run’s operation on the profile, saying the operator is using it', async () => {
    const refusals: string[] = [];
    const meanwhile: { tryOthers?: () => Promise<void> } = {};
    const h = world({
      browsers: [profile({ window: 'visible' })],
      waitForOperator: async () => {
        await meanwhile.tryOthers?.();
        return 'window_closed';
      },
    });
    const mine = await open(h, RUN_A, LOGIN);
    const theirs = await open(h, RUN_B, NEWS);
    meanwhile.tryOthers = async () => {
      refusals.push((await refusal(h.driver.snapshot(RUN_B, theirs))).kind);
      refusals.push((await refusal(h.driver.readPage(RUN_B, theirs, { what: 'text' }))).kind);
      const opening = await refusal(
        h.driver.open({ ...RUN_B, redelivered: false, profileId: 'default', url: NEWS }),
      );
      refusals.push(opening.kind);
      refusals.push(opening.message);
      refusals.push(browserFailure(opening).code);
    };

    await h.driver.handoff({ ...RUN_A, pageId: mine, reason: 'sign_in', message: 'Sign in.' });

    expect(refusals.slice(0, 3)).toEqual(['window_shown', 'window_shown', 'window_shown']);
    expect(refusals[3]).toContain('The operator is using the browser window');
    expect(refusals[4]).toBe('BROWSER_WINDOW_IN_USE');
    // Handed back afterwards.
    expect((await h.driver.snapshot(RUN_B, theirs)).url).toBe(NEWS);
  });

  it('refuses a second hand-off on the same profile', async () => {
    const meanwhile: { second?: () => Promise<string> } = {};
    let second: string | undefined;
    const h = world({
      browsers: [profile({ window: 'visible' })],
      waitForOperator: async () => {
        second = await meanwhile.second?.();
        return 'window_closed';
      },
    });
    const mine = await open(h, RUN_A, LOGIN);
    const other = await open(h, RUN_A, NEWS);
    meanwhile.second = async () =>
      (
        await refusal(
          h.driver.handoff({ ...RUN_A, pageId: other, reason: 'sign_in', message: 'Again.' }),
        )
      ).kind;
    await h.driver.handoff({ ...RUN_A, pageId: mine, reason: 'sign_in', message: 'Sign in.' });
    expect(second).toBe('window_shown');
  });
});

describe('the sign-in sitting', () => {
  it('shows the window for any profile on the machine and reports the sites once it is closed', async () => {
    const h = world({ browsers: [profile({ spaces: ['another-space'] })] });
    h.cookieSites = ['accounts.example.com', 'mail.example.com'];
    h.onSleep = () => {
      for (const page of h.pagesByLaunch[0] ?? []) page.closed = true;
    };

    const result = await h.driver.signIn('default');

    expect(result).toEqual({
      outcome: 'window_closed',
      restarted: true,
      sites: ['accounts.example.com', 'mail.example.com'],
    });
    expect(h.launches.map((launch) => launch.profile.window)).toEqual(['visible', 'hidden']);
  });
});
