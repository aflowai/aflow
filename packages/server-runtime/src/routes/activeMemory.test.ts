/**
 * Active-memory routes: the trust-boundary behaviour that is the route's own —
 * authenticated-user requirement on promote, the single-owner gate, and the
 * candidate→active promotion mapping. The register logic itself is unit-tested
 * in @aflow/schemas; here the DB layer is mocked so only the route is under
 * test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ActiveMemorySpaceState } from '@aflow/database';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: tenantId }),
    loadActiveMemorySpaceState: mocks.load,
    mutateActiveMemoryRegister: mocks.mutate,
  };
});

const { activeMemoryRoutes } = await import('./activeMemory.js');

function candidateState(overrides: Partial<ActiveMemorySpaceState> = {}): ActiveMemorySpaceState {
  return {
    singleOwner: true,
    registerValid: true,
    register: {
      version: 1,
      revision: 3,
      entries: [
        {
          id: 'cand-1',
          kind: 'fact',
          statement: 'the data lives at /data/x',
          status: 'candidate',
          sourceClass: 'agent_inference',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

async function buildApp(opts: { withUser?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {} };
  app.addHook('onRequest', async (request) => {
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: TENANT_ID,
    });
    (request as unknown as { authUser: unknown }).authUser =
      opts.withUser === false ? undefined : { userId: USER_ID };
  });
  await app.register(activeMemoryRoutes, { prefix: '/v1/spaces' });
  await app.ready();
  return app;
}

// Route the admit callback through the real register logic against a fixed state.
function fakeMutate(state: ActiveMemorySpaceState) {
  return async (
    _db: unknown,
    _ctx: unknown,
    _spaceId: string,
    admit: (s: ActiveMemorySpaceState) => unknown,
  ) => {
    const r = admit(state) as
      | { ok: false; error: string }
      | { ok: true; register: unknown; entry?: unknown; noop: boolean };
    if (!r.ok) return { outcome: 'rejected', error: r.error };
    if (r.noop) return { outcome: 'noop', state, entry: r.entry };
    return { outcome: 'saved', register: r.register, entry: r.entry };
  };
}

beforeEach(() => {
  mocks.load.mockReset();
  mocks.mutate.mockReset();
});

describe('POST promote — the trust boundary', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const app = await buildApp({ withUser: false });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/active-memory/cand-1/promote`,
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.mutate).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects promotion when the space is not single-owner (409)', async () => {
    mocks.mutate.mockImplementation(fakeMutate(candidateState({ singleOwner: false })));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/active-memory/cand-1/promote`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('no other members');
    await app.close();
  });

  it('promotes a candidate, stamping the authenticated user', async () => {
    mocks.mutate.mockImplementation(fakeMutate(candidateState()));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/active-memory/cand-1/promote`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    expect(body.sourceClass).toBe('user_asserted');
    expect(body.assertedByUserId).toBe(USER_ID);
    await app.close();
  });
});

describe('GET list', () => {
  it('returns the register with derived expired flags', async () => {
    mocks.load.mockResolvedValue(candidateState());
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/active-memory` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eligible).toBe(true);
    expect(body.entries[0].expired).toBe(false);
    await app.close();
  });
});
