/**
 * GET /v1/sessions/:sessionId/grant — existence boundary.
 *
 * Regression: the grant route returned 200 `{ grant: null }`
 * for sessions that were never created, while the session GET 404s — the
 * events broker then surfaced a confusing `subscribe_denied`. The route must
 * 404 on unknown sessions, mirroring the session GET.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const mockGetSessionById = vi.fn();

vi.mock('../services/sessions.js', () => ({
  createSessionService: () => ({
    getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  }),
  buildInlineAgentDefinition: vi.fn(),
}));

vi.mock('./mcp-elicitations.js', () => ({
  registerMcpElicitationRoutes: vi.fn(),
}));

const mockGetRunAccessGrant = vi.fn();
const mockGetSessionStateSafe = vi.fn();
vi.mock('@aflow/redis', () => ({
  getRunAccessGrant: (...args: unknown[]) => mockGetRunAccessGrant(...args),
  getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
}));

const { runsRoutes } = await import('./runs.js');

const SESSION_ID = '00000000-0000-4000-8000-0000000000aa';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // db null ⇒ the space re-check can only see hot state, so each test decides
  // whether the session resolves; the space cap itself is covered in
  // sessionSpaceAccess.test.ts.
  (app as unknown as { appContext: unknown }).appContext = {
    db: null,
    redis: {} as never,
  };

  app.decorate('authenticate', async () => {
    /* authenticated */
  });

  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as unknown as { requireTenant: () => Promise<{ tenantId: string }> }).requireTenant =
      async () => ({ tenantId: '00000000-0000-4000-8000-000000000001' });
    (request as unknown as { requireSpace: () => Promise<{ spaceId: string }> }).requireSpace =
      async () => ({ spaceId: '00000000-0000-4000-8000-000000000002' });
  });

  await app.register(runsRoutes, { prefix: '/v1/sessions' });
  await app.ready();
  return app;
}

describe('GET /v1/sessions/:sessionId/grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionStateSafe.mockResolvedValue({ ok: false, kind: 'missing' });
  });

  it('returns 404 when the session does not exist', async () => {
    mockGetSessionById.mockResolvedValue(null);
    const app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/grant` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'NotFound' });
    expect(mockGetRunAccessGrant).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the grant (or null) for an existing session', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: {} });
    mockGetSessionById.mockResolvedValue({ sessionId: SESSION_ID, status: 'RUNNING' });
    mockGetRunAccessGrant.mockResolvedValue({ allowedCapabilities: ['workflow:read'] });
    const app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/grant` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ grant: { allowedCapabilities: ['workflow:read'] } });
    await app.close();
  });

  it('existing session with no grant snapshot still 200s with null', async () => {
    mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: {} });
    mockGetSessionById.mockResolvedValue({ sessionId: SESSION_ID, status: 'RUNNING' });
    mockGetRunAccessGrant.mockResolvedValue(null);
    const app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: `/v1/sessions/${SESSION_ID}/grant` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ grant: null });
    await app.close();
  });
});
