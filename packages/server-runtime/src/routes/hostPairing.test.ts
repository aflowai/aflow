/**
 * Pairing provisions the credential it hands out.
 *
 * On the appliance the `aclfile` creates the `hostexec` identity when Redis
 * starts, so the pairing route never had to. Attached to a Redis with no ACL
 * file — every development stack — it returned a password for an identity that
 * was never created: the operator saw `Paired.`, and the daemon then died on
 * `WRONGPASS` with nothing between the two naming the cause.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return { ...actual, getRedisConnection: () => ({ call: mocks.call }) };
});

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    withTenantSchema: async (_db: unknown, _ctx: unknown, run: (tx: unknown) => Promise<unknown>) =>
      run({ select: () => ({ from: () => [] }) }),
  };
});

const { hostPairingRoutes } = await import('./hostPairing.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {}, redis: { call: mocks.call } };
  app.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: 'u1',
      roles: ['tenant_admin'],
    };
  });
  app.decorate('requirePermission', () => async () => {});
  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as unknown as { requireTenant: () => Promise<{ tenantId: string }> }).requireTenant =
      async () => ({ tenantId: TENANT });
  });
  await app.register(hostPairingRoutes, { prefix: '/host' });
  await app.ready();
  return app;
}

const pair = (app: FastifyInstance) => app.inject({ method: 'POST', url: '/host/pair' });

beforeEach(() => {
  vi.clearAllMocks();
  process.env['PHOENIX_HOST_REDIS_PASSWORD'] = 'host-password';
  mocks.call.mockResolvedValue('OK');
});

describe('pairing a machine', () => {
  it('creates the identity on this instance’s Redis', async () => {
    await pair(await buildApp());

    const setuser = mocks.call.mock.calls.find(
      (call) => call[0] === 'ACL' && call[1] === 'SETUSER',
    );
    expect(setuser, 'pairing ran no ACL SETUSER').toBeDefined();
    expect(setuser?.slice(2)).toContain('hostexec');
    expect(setuser?.join(' ')).toContain('>host-password');
  });

  it('hands back the credential it just provisioned', async () => {
    const body = JSON.parse((await pair(await buildApp())).body) as {
      redisUsername: string;
      redisPassword: string;
    };
    expect(body.redisUsername).toBe('hostexec');
    expect(body.redisPassword).toBe('host-password');
  });

  /**
   * The failure this replaces: a password for an identity that does not exist
   * authenticates nowhere, and reporting success sends the operator to a daemon
   * log to find out.
   */
  it('pairs nothing when the identity cannot be created', async () => {
    mocks.call.mockImplementation((command: string) =>
      command === 'ACL' ? Promise.reject(new Error('NOPERM')) : Promise.resolve('OK'),
    );
    const response = await pair(await buildApp());

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).message).toMatch(/would not authenticate/i);
  });

  it('refuses before that when the instance has no host credential', async () => {
    delete process.env['PHOENIX_HOST_REDIS_PASSWORD'];
    const response = await pair(await buildApp());

    expect(response.statusCode).toBe(503);
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
