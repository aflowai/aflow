/**
 * A payload ref is a caller-supplied string. The store resolves whatever path
 * it is handed against one configured bucket, so the route — not the store —
 * has to prove the ref belongs to the authenticated tenant before `retrieve`,
 * `delete`, or `getSignedUrl` runs.
 *
 * Denials are 404 rather than 403 so probing cannot map another tenant's
 * objects by response code.
 *
 * The same route decides what a stored object is served as: the `contentType`
 * on create becomes the object's Content-Type, which a signed read URL then
 * hands to the browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const mocks = vi.hoisted(() => ({
  getSessionStateSafe: vi.fn(),
  retrieve: vi.fn(),
  del: vi.fn(),
  getSignedUrl: vi.fn(),
  store: vi.fn(),
}));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return { ...actual, getSessionStateSafe: (...a: unknown[]) => mocks.getSessionStateSafe(...a) };
});

const { payloadRoutes } = await import('./payloads.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const OTHER_TENANT = 'f0000000-0000-0000-0000-00000000000f';
const SESSION = '00000000-0000-4000-8000-0000000000cc';

const refFor = (tenantId: string) =>
  `gs://bucket/tenants/${tenantId}/runs/${SESSION}/steps/${SESSION}/attempt/0/output.json`;

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
      delete: mocks.del,
      getSignedUrl: mocks.getSignedUrl,
      // These cases are about what a signed URL carries, so the store that
      // backs them is one that can issue them.
      servesSignedUrls: true,
      store: mocks.store,
      buildRef: () => refFor(TENANT),
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

describe('payload ref tenant binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retrieve.mockResolvedValue({ secret: 'data' });
    mocks.del.mockResolvedValue(undefined);
    mocks.getSignedUrl.mockResolvedValue('https://signed.example/url');
    mocks.store.mockResolvedValue(refFor(TENANT));
    mocks.getSessionStateSafe.mockResolvedValue({ ok: true, state: {} });
  });

  it('serves a ref belonging to the authenticated tenant', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(refFor(TENANT))}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalled();
    await app.close();
  });

  it('refuses to read another tenant’s ref, and never reaches the store', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(refFor(OTHER_TENANT))}`,
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses to mint a signed URL for another tenant’s ref', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?forceUrl=true&ref=${encodeURIComponent(refFor(OTHER_TENANT))}`,
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses to delete another tenant’s ref', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/payloads?ref=${encodeURIComponent(refFor(OTHER_TENANT))}`,
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.del).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a non-canonical ref rather than passing it to the store', async () => {
    const app = await buildTestApp();
    for (const ref of [
      `gs://bucket/tenants/${TENANT}/../${OTHER_TENANT}/runs/${SESSION}/steps/${SESSION}/attempt/0/output.json`,
      `gs://bucket/tenants/${TENANT}%2F..%2F${OTHER_TENANT}/runs/${SESSION}/steps/${SESSION}/attempt/0/output.json`,
      'gs://bucket/some/other/object.json',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/payloads?ref=${encodeURIComponent(ref)}`,
      });
      expect(res.statusCode, ref).toBe(404);
    }

    expect(mocks.retrieve).not.toHaveBeenCalled();
    await app.close();
  });

  // This route authorizes by the run named in the ref. A content-addressed
  // object names none, so it has nothing to check — the surface that owns the
  // row referencing those bytes serves them under its own space check.
  it('refuses a content-addressed ref, including one in the authenticated tenant', async () => {
    const app = await buildTestApp();
    const contentRef = `gs://bucket/tenants/${TENANT}/content/${'a'.repeat(64)}/body.json`;

    const read = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(contentRef)}`,
    });
    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/payloads?ref=${encodeURIComponent(contentRef)}`,
    });

    expect(read.statusCode).toBe(404);
    expect(remove.statusCode).toBe(404);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    await app.close();
  });

  it('denies when the session cannot be resolved in this tenant', async () => {
    mocks.getSessionStateSafe.mockResolvedValue({ ok: false, kind: 'missing' });
    const app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(refFor(TENANT))}`,
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('stored content type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.mockResolvedValue(refFor(TENANT));
    mocks.getSessionStateSafe.mockResolvedValue({ ok: true, state: {} });
  });

  const createWith = async (app: FastifyInstance, contentType: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/payloads',
      payload: { runId: SESSION, kind: 'output', data: { a: 1 }, contentType },
    });

  it('refuses to label an object as a type the browser renders inline', async () => {
    const app = await buildTestApp();

    for (const contentType of [
      'image/svg+xml',
      'text/html',
      'application/xhtml+xml',
      'text/xml',
      'text/xsl',
    ]) {
      const res = await createWith(app, contentType);
      expect(res.statusCode, contentType).toBe(400);
    }

    expect(mocks.store).not.toHaveBeenCalled();
    await app.close();
  });

  // A label this route re-serves is matched whole, so nothing rides in behind
  // a parameter the route would otherwise have to parse.
  it('refuses a parameterized type rather than parsing it', async () => {
    const app = await buildTestApp();

    const res = await createWith(app, 'application/json; charset=utf-8');

    expect(res.statusCode).toBe(400);
    expect(mocks.store).not.toHaveBeenCalled();
    await app.close();
  });

  it('stores an inert type and passes it to the store', async () => {
    const app = await buildTestApp();

    const res = await createWith(app, 'application/json');

    expect(res.statusCode).toBe(201);
    expect(mocks.store).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'application/json' }),
    );
    await app.close();
  });
});

/**
 * The allowlist above is checked when the URL is minted, and the object is
 * labelled one hop later by whoever holds it. Unless the mint pins the type
 * into the signature, the upload is free to label the bytes anything — and a
 * signed read then serves them under that label.
 */
describe('signed upload content type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSignedUrl.mockResolvedValue('https://signed.example/upload');
    mocks.getSessionStateSafe.mockResolvedValue({ ok: true, state: {} });
  });

  const requestUploadUrl = async (app: FastifyInstance, contentType?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/payloads',
      payload: { runId: SESSION, kind: 'output', ...(contentType ? { contentType } : {}) },
    });

  it('pins the requested type into the upload signature', async () => {
    const app = await buildTestApp();

    const res = await requestUploadUrl(app, 'text/plain');

    expect(res.statusCode).toBe(201);
    expect(mocks.getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'write', contentType: 'text/plain' }),
    );
    expect(res.json()).toMatchObject({ uploadContentType: 'text/plain' });
    await app.close();
  });

  it('pins inert bytes when the caller declares no type', async () => {
    const app = await buildTestApp();

    const res = await requestUploadUrl(app);

    expect(res.statusCode).toBe(201);
    expect(mocks.getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'write', contentType: 'application/octet-stream' }),
    );
    expect(res.json()).toMatchObject({ uploadContentType: 'application/octet-stream' });
    await app.close();
  });

  it('refuses to sign for a type the browser renders inline', async () => {
    const app = await buildTestApp();

    for (const contentType of ['image/svg+xml', 'text/html', 'application/xhtml+xml']) {
      const res = await requestUploadUrl(app, contentType);
      expect(res.statusCode, contentType).toBe(400);
    }

    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    await app.close();
  });
});
