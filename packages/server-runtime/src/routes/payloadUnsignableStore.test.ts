/**
 * A payload backend with no object host in front of it — the appliance's
 * filesystem store — cannot hand a client a URL. Every place this route would
 * have redirected therefore has to deliver the bytes instead, because the
 * alternative is not a slower answer but no answer: `getSignedUrl` rejects, and
 * the caller sees an internal error where a payload should have been.
 *
 * The size cap is the case that matters. It exists to divert a large response
 * to storage, and a store with nowhere to divert to would apply it as a refusal
 * to serve anything large at all — which is how generated media becomes
 * unreadable on a self-hosted instance.
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
      servesSignedUrls: false,
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

describe('payload route against a store that cannot sign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSignedUrl.mockRejectedValue(new Error('no object host to sign against'));
    mocks.store.mockResolvedValue(REF);
    mocks.getSessionStateSafe.mockResolvedValue({ ok: true, state: {} });
  });

  it('serves a payload past the size cap rather than diverting it nowhere', async () => {
    mocks.retrieve.mockResolvedValue({ blob: 'x'.repeat(11 * 1024 * 1024) });
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(REF)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty('blob');
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('serves the payload to a caller that asked for a URL', async () => {
    mocks.retrieve.mockResolvedValue({ secret: 'data' });
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(REF)}&forceUrl=true`,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ secret: 'data' });
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The retrieval failure is the answer. Reaching for a URL here would replace a
   * reported cause with a second failure from the store that already failed.
   */
  it('reports a retrieval failure instead of papering over it', async () => {
    mocks.retrieve.mockRejectedValue(new Error('disk read failed'));
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(REF)}`,
    });

    expect(res.statusCode).toBe(500);
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('names the limitation when asked for an upload URL', async () => {
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payloads',
      payload: { runId: SESSION, kind: 'artifact_source', contentType: 'text/plain' },
    });

    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).message).toContain('upload URL');
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });
});
