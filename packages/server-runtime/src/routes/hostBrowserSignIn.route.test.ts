/**
 * Sign in to sites, from the workspace: the operator route asks the machine
 * named in its inventory for a profile's sign-in window, and it is the only
 * thing that can — the channel it publishes on is reached by no operation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { HOST_HARNESS_CONCURRENCY_DEFAULT } from '@aflow/schemas';

const mocks = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<string | null>>(),
  publish: vi.fn<(channel: string, message: string) => Promise<number>>(),
}));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return { ...actual, getRedisConnection: () => ({ get: mocks.get, publish: mocks.publish }) };
});

const { hostBrowserRequestChannel, hostInventoryKey } = await import('@aflow/redis');
const { hostPairingRoutes } = await import('./hostPairing.js');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {}, redis: {} };
  app.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: 'u1',
      roles: ['tenant_admin'],
    };
  });
  app.decorate('requirePermission', () => async () => {});
  await app.register(hostPairingRoutes, { prefix: '/host' });
  await app.ready();
  return app;
}

function inventory(windowOpen = false, hostname = 'laptop'): string {
  return JSON.stringify({
    hostname,
    observedAt: new Date().toISOString(),
    runtimes: [],
    harnesses: [],
    maxConcurrentHarnessRuns: HOST_HARNESS_CONCURRENCY_DEFAULT,
    folders: [],
    browsers: [
      {
        id: 'default',
        posture: 'autonomous',
        window: 'hidden',
        spaces: 'all',
        rules: [],
        idleMinutes: 30,
        running: false,
        windowOpen,
      },
    ],
  });
}

const signIn = (app: FastifyInstance, profileId: string, hostname = 'laptop') =>
  app.inject({
    method: 'POST',
    url: `/host/browsers/${profileId}/sign-in`,
    payload: { hostname },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((key) =>
    Promise.resolve(key === hostInventoryKey('laptop') ? inventory() : null),
  );
  mocks.publish.mockResolvedValue(1);
});

describe('asking a machine for a sign-in window', () => {
  it('publishes the machine and the profile on that machine’s request channel', async () => {
    const app = await buildApp();
    const response = await signIn(app, 'default');
    expect(response.statusCode).toBe(202);
    expect(mocks.publish).toHaveBeenCalledWith(
      hostBrowserRequestChannel('laptop'),
      JSON.stringify({ kind: 'sign_in', hostname: 'laptop', profileId: 'default' }),
    );
  });

  it('says no executor is listening when only another machine’s is', async () => {
    // The inventory outlives the executor by up to its lifetime, so the
    // target can still be listed while only the desktop's executor is up.
    mocks.get.mockImplementation((key) =>
      Promise.resolve(
        key === hostInventoryKey('laptop')
          ? inventory()
          : key === hostInventoryKey('desktop')
            ? inventory(false, 'desktop')
            : null,
      ),
    );
    const listening = new Set([hostBrowserRequestChannel('desktop')]);
    mocks.publish.mockImplementation((channel) => Promise.resolve(listening.has(channel) ? 1 : 0));
    const app = await buildApp();

    const toLaptop = await signIn(app, 'default', 'laptop');
    expect(toLaptop.statusCode).toBe(503);
    expect(toLaptop.json<{ error: string }>().error).toBe('HostNotListening');
    expect((await signIn(app, 'default', 'desktop')).statusCode).toBe(202);
  });

  it('refuses a machine that is not running, and a profile it does not have', async () => {
    const app = await buildApp();
    expect((await signIn(app, 'default', 'desktop')).statusCode).toBe(404);
    const missing = await signIn(app, 'work');
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ message: string }>().message).toContain('no browser profile `work`');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('refuses while the window is already open', async () => {
    mocks.get.mockResolvedValue(inventory(true));
    const app = await buildApp();
    expect((await signIn(app, 'default')).statusCode).toBe(409);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('says so when no executor on the machine is listening', async () => {
    mocks.publish.mockResolvedValue(0);
    const app = await buildApp();
    const response = await signIn(app, 'default');
    expect(response.statusCode).toBe(503);
    expect(response.json<{ message: string }>().message).toContain('No executor on laptop');
  });

  it('refuses a profile id that is not one', async () => {
    const app = await buildApp();
    expect((await signIn(app, '..%2Fescape')).statusCode).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.next', '__tests__'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the browser request channel', () => {
  it('is published by the operator routes alone and heard by the host executor alone', () => {
    const naming = ['apps', 'packages']
      .flatMap((root) => sources(join(REPO, root)))
      .filter((file) => readFileSync(file, 'utf8').includes('hostBrowserRequestChannel'))
      .map((file) => relative(REPO, file))
      .sort();
    expect(naming).toEqual([
      'apps/aflow-executor-host/src/index.ts',
      'packages/redis/src/hostInventory.ts',
      'packages/server-runtime/src/routes/hostBrowserSettings.ts',
      'packages/server-runtime/src/routes/hostPairing.ts',
    ]);
  });
});
