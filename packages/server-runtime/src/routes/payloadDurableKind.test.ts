/**
 * A durable kind is stored without a TTL, so the public upload route refuses
 * one outright: what a client stores always carries the store's default TTL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const mocks = vi.hoisted(() => ({
  getSessionStateSafe: vi.fn(),
  retrieve: vi.fn(),
  getSignedUrl: vi.fn(),
  store: vi.fn(),
}));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return { ...actual, getSessionStateSafe: (...a: unknown[]) => mocks.getSessionStateSafe(...a) };
});

const { payloadRoutes } = await import('./payloads.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-4000-8000-0000000000cc';
const REF = `gs://file-store/tenants/${TENANT}/runs/${SESSION}/steps/${SESSION}/attempt/0/output.json`;

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  (app as unknown as { appContext: unknown }).appContext = {
    isMock: true,
    db: null,
    redis: {},
    payloadStore: {
      exists: async () => true,
      retrieve: mocks.retrieve,
      delete: vi.fn(),
      getSignedUrl: mocks.getSignedUrl,
      servesSignedUrls: true,
      store: mocks.store,
      buildRef: () => REF,
      shouldStore: () => false,
    },
  };

  app.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: unknown }).authUser = { userId: 'u1', roles: [] };
  });
  app.decorate('requirePermission', () => async () => {});

  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as unknown as { requireTenant: () => Promise<{ tenantId: string }> }).requireTenant =
      async () => ({ tenantId: TENANT });
  });

  await app.register(payloadRoutes, { prefix: '/v1/payloads' });
  await app.ready();
  return app;
}

describe('POST /v1/payloads with a durable kind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.mockResolvedValue(REF);
    mocks.getSessionStateSafe.mockResolvedValue({ ok: true, state: {} });
  });

  it.each(['state', 'history'])('refuses an upload that names %s, saying why', async (kind) => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payloads',
      payload: { runId: SESSION, kind, data: { turns: [] } },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain(
      `'${kind}' is a durable kind the platform writes itself`,
    );
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a durable kind for a signed upload too', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payloads',
      payload: { runId: SESSION, kind: 'state', contentType: 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('stores any other kind with the default TTL', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payloads',
      payload: { runId: SESSION, kind: 'output', data: { ok: true } },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.store).toHaveBeenCalledTimes(1);
    expect(mocks.store.mock.calls[0]?.[0]).not.toHaveProperty('persist');
    await app.close();
  });
});
