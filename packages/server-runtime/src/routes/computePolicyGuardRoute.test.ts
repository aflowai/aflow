/**
 * The guard that keeps a compute policy from being switched on where nothing
 * could serve it, exercised through the route rather than through the
 * descriptor it reads.
 *
 * Descriptor coverage alone would pass with the guard deleted, or with a guard
 * that wrote the row and then answered 409 — which is the failure that matters,
 * since a stored `enabled: true` outlives the request and nothing revokes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { EditionDescriptor } from '@aflow/schemas';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  select: vi.fn(),
  hasAvailableExecutor: vi.fn(),
}));

vi.mock('@aflow/redis', () => ({ hasAvailableExecutor: mocks.hasAvailableExecutor }));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    // Hands the caller's own db through as the transaction, which is what the
    // real one does after setting the search path.
    withTenantSchema: async (db: unknown, _ctx: unknown, run: (tx: unknown) => Promise<unknown>) =>
      run(db),
  };
});

const { spacePolicyRoutes } = await import('./spacePolicyRoutes.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '6ea90857-1b35-4810-9700-9e6125a1f4ac';

const APPLIANCE: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: TENANT },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
};

const ENABLED_POLICY = {
  enabled: true,
  networkEgress: { mode: 'blocked' as const },
  maxConcurrentContainers: 2,
};

async function buildApp(
  edition: EditionDescriptor,
  redis: unknown = undefined,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  (app as unknown as { appContext: unknown }).appContext = {
    redis,
    db: {
      select: () => ({
        from: () => ({
          where: () => {
            mocks.select();
            return { limit: () => [{ computePolicy: null }] };
          },
        }),
      }),
      update: () => ({
        set: (value: unknown) => ({
          where: () => ({
            returning: () => {
              mocks.update(value);
              return [{ computePolicy: (value as { computePolicy: unknown }).computePolicy }];
            },
          }),
        }),
      }),
    },
  };
  app.decorate('edition', edition);
  app.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: unknown }).authUser = { userId: 'u1', roles: [] };
  });
  app.decorate('requirePermission', () => async () => {});
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const r = request as unknown as {
      requireTenant: () => Promise<{ tenantId: string }>;
      requireSpace: () => Promise<{ spaceId: string; isSpaceAdmin: boolean }>;
    };
    r.requireTenant = async () => ({ tenantId: TENANT });
    r.requireSpace = async () => ({ spaceId: SPACE, isSpaceAdmin: true });
  });

  await app.register(spacePolicyRoutes, { prefix: '/v1/spaces' });
  await app.ready();
  return app;
}

const put = (app: FastifyInstance, enabled: boolean) =>
  app.inject({
    method: 'PUT',
    url: `/v1/spaces/${SPACE}/compute-policy`,
    payload: { computePolicy: { ...ENABLED_POLICY, enabled } },
  });

describe('enabling compute where no runtime exists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses, and does not write the row it refused', async () => {
    const app = await buildApp(APPLIANCE);
    const res = await put(app, true);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toMatch(/compute runtime/i);
    expect(mocks.update).not.toHaveBeenCalled();
    await app.close();
  });

  /** Otherwise the guard could strand an instance that already had it on. */
  it('still lets it be switched off', async () => {
    const app = await buildApp(APPLIANCE);
    const res = await put(app, false);

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await app.close();
  });

  /**
   * Clearing the policy is not switching it off. The compute executor runs a
   * space carrying no policy at all, so `null` against an absent runtime is the
   * admissible-with-no-executor state the guard exists to prevent.
   */
  it('refuses a cleared policy too, which is not the same as a disabled one', async () => {
    const app = await buildApp(APPLIANCE);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/spaces/${SPACE}/compute-policy`,
      payload: { computePolicy: null },
    });

    expect(res.statusCode).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('permits clearing it once a runtime is present', async () => {
    const app = await buildApp({ ...APPLIANCE, computeRuntime: 'present' });
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/spaces/${SPACE}/compute-policy`,
      payload: { computePolicy: null },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('permits enabling once a runtime is present', async () => {
    const app = await buildApp({ ...APPLIANCE, computeRuntime: 'present' });
    const res = await put(app, true);

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

/**
 * The read carries what the deployment can currently do, beside the policy.
 *
 * A screen with only the stored decision shows a workspace configured for compute
 * while nothing is listening, which an operator has no other way to see.
 */
describe('the compute policy read', () => {
  /** Fresh per case: the availability read holds one reading per connection. */
  const redis = (): object => ({});

  const get = (app: FastifyInstance) =>
    app.inject({ method: 'GET', url: `/v1/spaces/${SPACE}/compute-policy` });

  const composed: EditionDescriptor = { ...APPLIANCE, computeRuntime: 'present' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports an executor that is answering', async () => {
    mocks.hasAvailableExecutor.mockResolvedValue(true);
    const app = await buildApp(composed, redis());

    expect(JSON.parse((await get(app)).body).computeAvailability).toEqual({
      composed: 'present',
      executor: 'up',
    });
    await app.close();
  });

  it('reports a composed runtime whose executor has stopped', async () => {
    mocks.hasAvailableExecutor.mockResolvedValue(false);
    const app = await buildApp(composed, redis());

    expect(JSON.parse((await get(app)).body).computeAvailability).toEqual({
      composed: 'present',
      executor: 'down',
    });
    await app.close();
  });

  /** The refusal rests on the claim, which cannot flap between two requests. */
  it('still accepts a policy while nothing is answering', async () => {
    mocks.hasAvailableExecutor.mockResolvedValue(false);
    const app = await buildApp(composed, redis());
    const res = await put(app, true);

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.body).computeAvailability.executor).toBe('down');
    await app.close();
  });

  it('answers without a Redis connection rather than failing the read', async () => {
    const app = await buildApp(composed);

    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).computeAvailability.executor).toBe('unknown');
    await app.close();
  });
});
