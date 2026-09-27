/**
 * Every `/v1` route is explicitly classified, and the build proves it.
 *
 * The central preHandler skips a route with no `config.authz`, so an
 * unclassified route is not "authorized by default" — it is unauthorized and
 * silent. Coverage was previously advisory (a warning behind an opt-in env
 * flag), which meant the contract could not demonstrate the property it
 * exists for. Booting the real app under strict mode is that demonstration:
 * an unclassified route fails registration.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import fp from 'fastify-plugin';
import { authzPlugin } from '../../plugins/authz.js';

/** `authzPlugin` declares plugin dependencies; satisfy them cheaply. */
const stub = (name: string) => fp((_app, _opts, done: () => void) => done(), { name });

/** Boots authz with `routes` queued, and reports how registration went. */
async function bootWith(routes: RouteOptions[]): Promise<{ error?: Error }> {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(stub('edition-plugin'));
  await app.register(stub('auth-plugin'));
  await app.register(stub('tenant-plugin'));
  await app.register(authzPlugin);

  try {
    for (const route of routes) app.route(route);
    await app.ready();
    return {};
  } catch (err) {
    return { error: err as Error };
  } finally {
    await app.close();
  }
}

const handler = () => ({ ok: true });

describe('route authz coverage', () => {
  const previousMockContext = process.env['USE_MOCK_CONTEXT'];

  beforeAll(() => {
    process.env['USE_MOCK_CONTEXT'] = 'true';
  });

  afterAll(() => {
    if (previousMockContext === undefined) delete process.env['USE_MOCK_CONTEXT'];
    else process.env['USE_MOCK_CONTEXT'] = previousMockContext;
  });

  // Registers the whole route tree, so it is slower than the default budget
  // allows once the suite runs in parallel.
  it('registers every core route with an explicit classification', async () => {
    const { coreComposition } = await import('../../compose/coreSurfaces.js');
    const { buildApp } = await import('../../app.js');
    const app = await buildApp(coreComposition, { logger: false });

    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  }, 60_000);

  it('refuses an unclassified /v1 route', async () => {
    const { error } = await bootWith([{ method: 'GET', url: '/v1/unclassified', handler }]);
    expect(error?.message).toMatch(/not classified/);
  });

  it('accepts each of the three classifications', async () => {
    const { error } = await bootWith([
      { method: 'GET', url: '/v1/is-public', config: { public: true }, handler },
      {
        method: 'GET',
        url: '/v1/is-authorized',
        config: { authz: { resource: 'session', action: 'read' } },
        handler,
      },
      {
        method: 'GET',
        url: '/v1/is-exempt',
        config: { authzExempt: { reason: 'handshake authorizes itself' } },
        handler,
      },
    ]);
    expect(error).toBeUndefined();
  });

  // The reason is the only thing a reviewer sees, so a blank one is silence.
  for (const [label, reason] of [
    ['empty', ''],
    ['whitespace-only', '   '],
    ['newline-only', '\n\t'],
  ] as const) {
    it(`does not accept a ${label} exemption reason`, async () => {
      const { error } = await bootWith([
        {
          method: 'GET',
          url: '/v1/blank-reason',
          config: { authzExempt: { reason } },
          handler,
        },
      ]);
      expect(error?.message).toMatch(/not classified/);
    });
  }

  it('leaves non-/v1 routes alone', async () => {
    const { error } = await bootWith([{ method: 'GET', url: '/healthz', handler }]);
    expect(error).toBeUndefined();
  });
});
