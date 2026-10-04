/**
 * Asking before an action, against a real Chrome behind the real egress proxy:
 * an action on a profile set to `ask-to-act` parks, the operator's approval is
 * recorded in the approval store, and the dispatch after it performs the
 * action once. The page is a fixture served on loopback.
 *
 * Skipped where no Chrome starts or nothing can listen on loopback, its name
 * saying which.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { BrowserProfileSchema, WriteApprovalRequestPayloadSchema } from '@aflow/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LocalAddressClassifier } from '../browser/addresses.js';
import { discoverChrome } from '../browser/chromeDiscovery.js';
import { createChromeLauncher } from '../browser/chromeProcess.js';
import { BrowserDriver } from '../browser/driver.js';
import { createPlaywrightEngine } from '../browser/engine.js';
import { createBrowserHandler } from '../handlers/browserHandler.js';
import { memoryApprovals } from './fixtures/approvals.js';
import { LOOPBACK_LISTENER, requires } from './fixtures/capabilities.js';
import { probeChromeStart } from './fixtures/chromeCapability.js';

const CHROME_STARTS = LOOPBACK_LISTENER.available
  ? await probeChromeStart()
  : { name: 'a headless Chrome', available: false, refusal: 'not tried without a listener' };
const needed = requires(LOOPBACK_LISTENER, CHROME_STARTS);

const RUN = { tenantId: 't1', runId: 'run-chrome', spaceId: 'space-1' };

const CHECKOUT = [
  '<!doctype html>',
  '<title>Checkout</title>',
  '<main>',
  '  <h1>Checkout</h1>',
  "  <button onclick=\"fetch('/paid', { method: 'POST' })\">Pay now</button>",
  '</main>',
].join('\n');

/**
 * The fixture page is on loopback, which the proxy refuses as this machine for
 * every profile but an ephemeral one; standing in a classifier that finds no
 * address of this machine's lets it load through the real proxy as a site.
 */
const NO_LOCAL_ADDRESSES: LocalAddressClassifier = { classify: () => undefined };

describe.skipIf(needed.skip)(
  needed.title('asking before an action in a real Chrome'),
  { tags: ['listener'] },
  () => {
    let site: Server;
    let origin: string;
    let paid = 0;
    let hostDir: string;
    let driver: BrowserDriver;

    beforeAll(async () => {
      site = createServer((request, response) => {
        if (request.method === 'POST' && request.url === '/paid') paid += 1;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(CHECKOUT);
      });
      await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`;
      hostDir = await mkdtemp(join(tmpdir(), 'aflow-browser-ask-'));
      const policy = {
        browsers: new Map([
          ['default', BrowserProfileSchema.parse({ id: 'default', posture: 'ask-to-act' })],
        ]),
        invalidBrowsers: new Map<string, string>(),
        chrome: discoverChrome(),
      };
      driver = new BrowserDriver({
        engine: createPlaywrightEngine(),
        launcher: createChromeLauncher(),
        hostDir,
        loadPolicy: () => Promise.resolve(policy),
        classifier: NO_LOCAL_ADDRESSES,
      });
    });

    afterAll(async () => {
      await driver.stopAll();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(hostDir, { recursive: true, force: true });
    });

    it('parks the action, and performs it once after the operator approves', async () => {
      const approvals = memoryApprovals();
      const handler = createBrowserHandler(driver, approvals);
      let dispatches = 0;
      const dispatch = async (
        operationId: string,
        input: unknown,
      ): Promise<{ result: StepResult; written: Map<string, unknown> }> => {
        const written = new Map<string, unknown>();
        dispatches += 1;
        const ctx = {
          ...RUN,
          attempt: 1,
          stepExecutionId: `step-${String(dispatches)}`,
          operationId,
          job: { inputRef: 'inline:input' },
          readPayload: () => Promise.resolve(input),
          writePayload: (kind: string, data: unknown) => {
            written.set(kind, data);
            return Promise.resolve(`inline:${kind}`);
          },
        } as unknown as ExecutorContext;
        return { result: await handler.execute(ctx), written };
      };

      const opened = await dispatch('browser.page.open', { url: `${origin}/` });
      expect(opened.result.status).toBe('SUCCEEDED');
      const page = opened.written.get('output') as { pageId: string; outline: string };
      const ref = /button "Pay now" \[ref=(\w+)\]/.exec(page.outline)?.[1];
      expect(ref).toBeDefined();
      const pay = { pageId: page.pageId, ref, action: 'click' };

      const parked = await dispatch('browser.page.act', pay);
      expect(parked.result.status).toBe('PAUSED');
      const request = WriteApprovalRequestPayloadSchema.parse(parked.written.get('input_request'));
      expect(request).toMatchObject({ target: 'browser', pageOrigin: origin, action: 'click' });
      expect(paid).toBe(0);

      approvals.decide(RUN, request.requestHash, 'approved');
      const approved = await dispatch('browser.page.act', pay);
      expect(approved.result.status).toBe('SUCCEEDED');
      const deadline = Date.now() + 10_000;
      while (paid === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(paid).toBe(1);
      expect(approvals.spent.size).toBe(1);
    }, 60_000);
  },
);
