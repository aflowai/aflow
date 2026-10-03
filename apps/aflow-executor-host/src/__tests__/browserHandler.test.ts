/**
 * The step handler between a job and the driver: every registered browser
 * operation is served, each output is what its schema says, and a later
 * attempt of an action is treated as a redelivery.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { getAllOperations, getOperation } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { createBrowserHandler, SERVED_BROWSER_OPERATIONS } from '../handlers/browserHandler.js';
import { harness, RUN_A, type Harness } from './fixtures/fakeBrowser.js';

interface Ran {
  result: StepResult;
  written: unknown;
}

async function run(
  h: Harness,
  operationId: string,
  input: unknown,
  attempt = 1,
  scope: { tenantId: string; runId: string; spaceId?: string } = RUN_A,
): Promise<Ran> {
  let written: unknown;
  const ctx = {
    ...scope,
    attempt,
    operationId,
    job: { inputRef: 'inline:input' },
    readPayload: () => Promise.resolve(input),
    writePayload: (_kind: string, data: unknown) => {
      written = data;
      return Promise.resolve('inline:output');
    },
  } as unknown as ExecutorContext;
  const result = await createBrowserHandler(h.driver).execute(ctx);
  return { result, written };
}

function parsedOutput(operationId: string, written: unknown): unknown {
  return getOperation(operationId)?.outputZod?.parse(written);
}

describe('the browser handler', () => {
  it('serves every registered browser operation, and no other', () => {
    const registered = [...getAllOperations().values()]
      .filter((op) => op.stepType === 'browser')
      .map((op) => op.operationId)
      .sort();
    expect([...SERVED_BROWSER_OPERATIONS].sort()).toEqual(registered);
  });

  it('returns outputs that parse against each operation’s schema', async () => {
    const h = harness();
    const opened = await run(h, 'browser.page.open', { url: 'https://example.com/' });
    expect(opened.result.status).toBe('SUCCEEDED');
    const { pageId } = parsedOutput('browser.page.open', opened.written) as { pageId: string };

    for (const [operationId, input] of [
      ['browser.page.snapshot', { pageId }],
      ['browser.page.read', { pageId, what: 'network' }],
      ['browser.page.act', { pageId, ref: 'e4', action: 'type', text: 'op@example.org' }],
      ['browser.page.navigate', { pageId, reload: true }],
      ['browser.page.list', {}],
      ['browser.profile.list', {}],
      ['browser.page.close', { pageId }],
      ['browser.page.close', { pageId }],
    ] as const) {
      const ran = await run(h, operationId, input);
      expect(ran.result.status, operationId).toBe('SUCCEEDED');
      expect(() => parsedOutput(operationId, ran.written), operationId).not.toThrow();
    }
  });

  it('treats a later attempt of an action as a redelivery, and does not act', async () => {
    const h = harness();
    const opened = await run(h, 'browser.page.open', { url: 'https://example.com/' });
    const { pageId } = parsedOutput('browser.page.open', opened.written) as { pageId: string };
    const again = await run(h, 'browser.page.act', { pageId, ref: 'e6', action: 'click' }, 2);
    expect(again.result.status).toBe('SUCCEEDED');
    expect(again.written).toMatchObject({ outcome: 'uncertain_outcome', pageId });
    expect(again.written).not.toHaveProperty('receipt');
    expect(h.pages[0]?.actions).toEqual([]);
  });

  it('answers a later attempt of an open with the page the earlier one opened, loading nothing again', async () => {
    const h = harness();
    const first = await run(h, 'browser.page.open', { url: 'https://example.com/a' });
    const { pageId } = parsedOutput('browser.page.open', first.written) as { pageId: string };
    expect(first.written).toMatchObject({ outcome: 'performed' });

    const again = await run(h, 'browser.page.open', { url: 'https://example.com/a' }, 2);
    expect(again.result.status).toBe('SUCCEEDED');
    expect(parsedOutput('browser.page.open', again.written)).toMatchObject({
      outcome: 'uncertain_outcome',
      pageId,
      url: 'https://example.com/a',
      outline: expect.stringContaining('[ref=e6]') as unknown,
    });
    expect(again.written).not.toHaveProperty('receipt');
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]?.navigations).toHaveLength(1);
  });

  it('fails a later attempt of an open that finds no page opened there, naming the run’s pages', async () => {
    const h = harness();
    const first = await run(h, 'browser.page.open', { url: 'https://example.com/a' });
    const { pageId } = parsedOutput('browser.page.open', first.written) as { pageId: string };

    const again = await run(h, 'browser.page.open', { url: 'https://example.com/b' }, 2);
    expect(again.result.status).toBe('FAILED');
    expect(again.written).toMatchObject({
      code: 'BROWSER_OPEN_UNCERTAIN',
      retryable: false,
      details: { url: 'https://example.com/b' },
    });
    const said = (again.written as { message: string }).message;
    expect(said).toContain('whether the earlier attempt loaded it is unknown');
    expect(said).toContain(`\`${pageId}\``);
    expect(h.pages).toHaveLength(1);

    const fresh = harness();
    const none = await run(fresh, 'browser.page.open', { url: 'https://example.com/a' }, 2);
    expect(none.written).toMatchObject({ code: 'BROWSER_OPEN_UNCERTAIN', retryable: false });
    expect((none.written as { message: string }).message).toContain("The run's open pages: none");
    expect(fresh.launches).toHaveLength(0);
  });

  it('fails a stale reference with the reference named and the outline in the details', async () => {
    const h = harness();
    const opened = await run(h, 'browser.page.open', { url: 'https://example.com/' });
    const { pageId } = parsedOutput('browser.page.open', opened.written) as { pageId: string };
    const stale = await run(h, 'browser.page.act', { pageId, ref: 'e404', action: 'click' });
    expect(stale.result.status).toBe('FAILED');
    expect(stale.written).toMatchObject({
      code: 'BROWSER_REF_STALE',
      retryable: false,
      details: { ref: 'e404' },
    });
    expect(JSON.stringify(stale.written)).toContain('[ref=e6]');
  });

  it('refuses input its schema refuses, teaching the fix', async () => {
    const h = harness();
    const both = await run(h, 'browser.page.navigate', {
      pageId: 'pg_x',
      back: true,
      reload: true,
    });
    expect(both.result.status).toBe('FAILED');
    expect(JSON.stringify(both.written)).toContain('exactly one of');
  });

  it('refuses a job that carries no space, and touches no browser', async () => {
    const h = harness();
    const { spaceId: _spaceId, ...spaceless } = RUN_A;
    for (const [operationId, input] of [
      ['browser.page.open', { url: 'https://example.com/' }],
      ['browser.page.list', {}],
      ['browser.profile.list', {}],
      ['browser.page.handoff', { pageId: 'pg_x', reason: 'sign_in', message: 'Sign in.' }],
    ] as const) {
      const ran = await run(h, operationId, input, 1, spaceless);
      expect(ran.result.status, operationId).toBe('FAILED');
      expect(ran.written, operationId).toMatchObject({
        code: 'BROWSER_JOB_HAS_NO_SPACE',
        retryable: false,
      });
      expect((ran.written as { message: string }).message).toContain('carrying no space');
    }
    expect(h.launches).toHaveLength(0);
  });
});
