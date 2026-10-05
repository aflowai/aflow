/**
 * A profile's local ports in a real Chrome behind the real egress proxy.
 * Chrome sends loopback straight past a proxy unless told otherwise, and the
 * profile's launch flags tell it otherwise (`--proxy-bypass-list=<-loopback>`):
 * this is where that is seen to hold, not assumed. A page on a declared port
 * loads and its connection is the proxy's; one on a port not declared is
 * refused, and the server listening there is never reached.
 *
 * Skipped where no Chrome starts or nothing can listen on loopback, its name
 * saying which.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stackOwnPorts } from '@aflow/lib';
import { BrowserProfileSchema } from '@aflow/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverChrome } from '../browser/chromeDiscovery.js';
import { createChromeLauncher } from '../browser/chromeProcess.js';
import { BrowserDriver } from '../browser/driver.js';
import { type EgressProxy, startEgressProxy } from '../browser/egressProxy.js';
import { createPlaywrightEngine } from '../browser/engine.js';
import { BrowserDriverError } from '../browser/errors.js';
import { LOOPBACK_LISTENER, requires } from './fixtures/capabilities.js';
import { probeChromeStart } from './fixtures/chromeCapability.js';

const CHROME_STARTS = LOOPBACK_LISTENER.available
  ? await probeChromeStart()
  : { name: 'a headless Chrome', available: false, refusal: 'not tried without a listener' };
const needed = requires(LOOPBACK_LISTENER, CHROME_STARTS);

const RUN = { tenantId: 't1', runId: 'run-local-ports', spaceId: 'space-1' };

async function serve(reached: string[], body: () => string): Promise<Server> {
  const server = createServer((request, response) => {
    reached.push(`${request.headers.host ?? ''}${request.url ?? ''}`);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Local</title>${body()}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

describe.skipIf(needed.skip)(
  needed.title('a profile’s local ports in a real Chrome'),
  { tags: ['listener'] },
  () => {
    const devReached: string[] = [];
    const otherReached: string[] = [];
    /** Every connection the proxy made, by port: what Chrome sent through it. */
    const proxied: number[] = [];
    const proxies: EgressProxy[] = [];
    let dev: Server;
    let other: Server;
    let hostDir: string;
    let driver: BrowserDriver;

    beforeAll(async () => {
      other = await serve(otherReached, () => '<h1>Not opened</h1>');
      // The page asks for the undeclared port itself, as a script or an image
      // would: only Chrome decides where that request goes.
      dev = await serve(
        devReached,
        () =>
          '<h1>The dev server</h1>' +
          `<img src="http://127.0.0.1:${String(portOf(other))}/pixel" alt="">`,
      );
      hostDir = await mkdtemp(join(tmpdir(), 'aflow-browser-local-'));
      const policy = {
        browsers: new Map([
          ['default', BrowserProfileSchema.parse({ id: 'default', localPorts: [portOf(dev)] })],
        ]),
        invalidBrowsers: new Map<string, string>(),
        chrome: discoverChrome(),
      };
      driver = new BrowserDriver({
        engine: createPlaywrightEngine(),
        launcher: createChromeLauncher(),
        hostDir,
        loadPolicy: () => Promise.resolve(policy),
        stackPorts: stackOwnPorts({}),
        startProxy: async (options) => {
          const proxy = await startEgressProxy({
            ...options,
            connect: (address, port) => {
              proxied.push(port);
              return netConnect({ host: address, port });
            },
          });
          proxies.push(proxy);
          return proxy;
        },
      });
    });

    afterAll(async () => {
      await driver.stopAll();
      await new Promise<void>((resolve) => dev.close(() => resolve()));
      await new Promise<void>((resolve) => other.close(() => resolve()));
      await rm(hostDir, { recursive: true, force: true });
    });

    it('loads a page on the declared port through the proxy, and refuses one on another port before it reaches the server', async () => {
      const declared = `http://localhost:${String(portOf(dev))}/`;
      const opened = await driver.open({
        ...RUN,
        profileId: 'default',
        redelivered: false,
        url: declared,
      });
      expect(opened.url).toBe(declared);
      expect(devReached).toContain(`localhost:${String(portOf(dev))}/`);
      expect(proxied).toContain(portOf(dev));

      for (const host of ['localhost', '127.0.0.1']) {
        const undeclared = `http://${host}:${String(portOf(other))}/`;
        const refused = await driver
          .open({ ...RUN, profileId: 'default', redelivered: false, url: undeclared })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(refused, undeclared).toBeInstanceOf(BrowserDriverError);
      }
      expect(otherReached).toEqual([]);
      expect(proxied).not.toContain(portOf(other));
    }, 60_000);

    it('sends the page’s own request for an undeclared loopback port through the proxy, which refuses it', async () => {
      const deadline = Date.now() + 10_000;
      const refusedThere = (): boolean =>
        proxies.some((proxy) =>
          proxy
            .refusalsSince(0)
            .some((refusal) => refusal.host === '127.0.0.1' && refusal.port === portOf(other)),
        );
      while (!refusedThere() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(refusedThere()).toBe(true);
      expect(otherReached).toEqual([]);
    }, 30_000);
  },
);
