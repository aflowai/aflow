/**
 * The redeem endpoint, exercised as a request rather than as a function.
 *
 * This is the one call the whole connect flow begins with, and it is public —
 * the token is the entire authentication. Everything it decides, it decides
 * from a body a stranger could have sent, so the refusals are what is worth
 * asserting: an unknown code, a spent one, and a code that is valid but whose
 * binding is not.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantId } from '@aflow/schemas';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = '11111111-1111-4111-8111-111111111111';

const store = new Map<string, string>();
vi.mock('@aflow/redis', () => ({
  getRedisConnection: () => ({
    setex: (k: string, _ttl: number, v: string) => (store.set(k, v), Promise.resolve('OK')),
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    del: (k: string) => Promise.resolve(store.delete(k) ? 1 : 0),
    zadd: () => Promise.resolve(1),
    zrem: () => Promise.resolve(1),
    zrange: () => Promise.resolve([]),
    zremrangebyscore: () => Promise.resolve(0),
    call: () => Promise.resolve('OK'),
  }),
  HOST_INVENTORY_TTL_MS: 120_000,
  HOST_MACHINES_KEY: 'aflow:host-machines',
  hostInventoryKey: (n: string) => `aflow:host-inventory:${n}`,
}));

/** What the route inserts, so the recorded binding is assertable. */
const inserted: Array<Record<string, unknown>> = [];
vi.mock('@aflow/database', () => ({
  createTenantContext: () => ({}),
  withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          onConflictDoUpdate: () => {
            inserted.push(v);
            return Promise.resolve(undefined);
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ slug: 'my-space' }]) }),
          then: (resolve: (rows: unknown[]) => unknown) =>
            resolve(
              inserted.map((row) => ({
                hostBindingId: row['hostBindingId'],
                label: row['label'],
                root: row['root'],
                writable: row['writable'],
                allowsExecution: row['allowsExecution'],
                branchPrefix: row['branchPrefix'],
              })),
            ),
        }),
      }),
    }),
  hostBindings: { spaceId: {}, hostBindingId: {} },
  spaces: { id: {}, slug: {} },
}));
vi.mock('drizzle-orm', () => ({ eq: () => ({}), and: () => ({}) }));

const { mintConnectToken } = await import('./hostConnectToken.js');

async function buildApp(): Promise<FastifyInstance> {
  const { hostPairingRoutes } = await import('./hostPairing.js');
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {} };
  await app.register(hostPairingRoutes, { prefix: '/host' });
  await app.ready();
  return app;
}

const binding = {
  hostBindingId: 'hb_thing',
  label: 'thing',
  root: '/Users/someone/code/thing',
  writable: true,
  allowsExecution: true,
};

beforeEach(() => {
  store.clear();
  inserted.length = 0;
  process.env['PHOENIX_HOST_REDIS_PASSWORD'] = 'host-pw';
});

describe('POST /host/connect', () => {
  it('records the binding and hands back what the machine needs', async () => {
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // One call leaves the machine able to do the work, not merely permitted to.
    expect(body['redisUsername']).toBe('hostexec');
    expect(body['redisPassword']).toBe('host-pw');
    expect(body['spaceId']).toBe(SPACE);
    expect(body['spaceSlug']).toBe('my-space');
    expect(inserted[0]).toMatchObject({ hostBindingId: 'hb_thing', spaceId: SPACE });
    await app.close();
  });

  it('answers without a session, because the token is the authentication', async () => {
    // The reason the flow costs a code rather than the instance secret. If this
    // route ever required a session, the operator would be back to carrying a
    // credential that authenticates as the owner for every call this API has.
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });

  it('refuses a code that was never minted', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code: 'AAAAA-AAAAA', binding },
    });
    expect(res.statusCode).toBe(401);
    expect(inserted).toEqual([]);
    await app.close();
  });

  it('refuses the second use of a code, having honoured the first', async () => {
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    expect(
      (await app.inject({ method: 'POST', url: '/host/connect', payload: { code, binding } }))
        .statusCode,
    ).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding },
    });
    expect(second.statusCode).toBe(401);
    expect(inserted).toHaveLength(1);
    await app.close();
  });

  it('refuses a binding id that is not one, before spending the code', async () => {
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding: { ...binding, hostBindingId: '../../etc/passwd' } },
    });
    expect(bad.statusCode).toBe(400);
    // Schema validation runs before the handler, so a rejected body must leave
    // the code usable — otherwise a typo costs the operator a trip to the UI.
    const good = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding },
    });
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('says it cannot pair when the instance has no host credential', async () => {
    delete process.env['PHOENIX_HOST_REDIS_PASSWORD'];
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('which branches a connected folder may be pushed to', () => {
  it('records the prefix and hands it back to the machine', async () => {
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding: { ...binding, branchPrefix: 'aflow/' } },
    });

    expect(res.statusCode).toBe(200);
    expect(inserted[0]).toMatchObject({ branchPrefix: 'aflow/' });
    const body = res.json() as { bindings: Array<Record<string, unknown>> };
    expect(body.bindings[0]?.['branchPrefix']).toBe('aflow/');
    await app.close();
  });

  it('says nothing about pushes for a folder connected without a prefix', async () => {
    // Absent is the default and means none, so the machine is told nothing
    // rather than told an empty prefix it would have to interpret.
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding },
    });
    expect(inserted[0]).toMatchObject({ branchPrefix: null });
    const body = res.json() as { bindings: Array<Record<string, unknown>> };
    expect(body.bindings[0]).not.toHaveProperty('branchPrefix');
    await app.close();
  });

  it('refuses a prefix on a folder that runs no commands, before spending the code', async () => {
    // A push is a command. Recording the prefix anyway would publish an
    // authority the machine refuses at the moment it is used.
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: {
        code,
        binding: { ...binding, allowsExecution: false, branchPrefix: 'aflow/' },
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'BranchPrefixNeedsExecution' });
    expect(inserted).toEqual([]);
    // The code survives a refusal, so the correction costs one command.
    const good = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: { code, binding },
    });
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a prefix that is not a name', async () => {
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    for (const branchPrefix of ['-oops', 'has space', 'up/../out']) {
      const res = await app.inject({
        method: 'POST',
        url: '/host/connect',
        payload: { code, binding: { ...binding, branchPrefix } },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(inserted).toEqual([]);
    await app.close();
  });
});

describe('the name a folder is recorded under', () => {
  async function connect(
    namesInUse?: Array<{ hostBindingId: string; root: string; spaceId?: string }>,
  ): Promise<{ recorded: string; status: number }> {
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: {
        code,
        binding: { ...binding, ...(namesInUse === undefined ? {} : { namesInUse }) },
      },
    });
    await app.close();
    const body = res.json() as { binding?: { hostBindingId: string } };
    return { recorded: body.binding?.hostBindingId ?? '', status: res.statusCode };
  }

  it('records the name the machine asked for when nothing else holds it', async () => {
    const { status, recorded } = await connect([]);
    expect(status).toBe(200);
    expect(recorded).toBe('hb_thing');
    expect(inserted[0]).toMatchObject({ hostBindingId: 'hb_thing' });
  });

  it('names the folder after this space when another already holds the name', async () => {
    // The machine keys folders by name alone, so recording the name it asked for
    // would leave a row here that nothing on that machine answers for.
    const { recorded } = await connect([
      { hostBindingId: 'hb_thing', root: binding.root, spaceId: 'another-space' },
    ]);
    expect(recorded).toBe('hb_thing-my-space');
    expect(inserted[0]).toMatchObject({ hostBindingId: 'hb_thing-my-space' });
  });

  it('counts on from there when the space name is taken too', async () => {
    const { recorded } = await connect([
      { hostBindingId: 'hb_thing', root: binding.root, spaceId: 'another-space' },
      { hostBindingId: 'hb_thing-my-space', root: binding.root, spaceId: 'a-third-space' },
    ]);
    expect(recorded).toBe('hb_thing-my-space-2');
  });

  it('keeps the name when the same folder is being reconnected', async () => {
    // Same name, same folder, same space is the machine describing what this
    // call is about to replace. Renaming it would connect the folder twice.
    const { recorded } = await connect([
      { hostBindingId: 'hb_thing', root: binding.root, spaceId: SPACE },
    ]);
    expect(recorded).toBe('hb_thing');
  });

  it('names the folder apart when the machine holds that name for another folder', async () => {
    // The workspace has no claim on which folder a machine's name points at, so
    // a name pointing elsewhere is taken whatever space recorded it.
    const { recorded } = await connect([
      { hostBindingId: 'hb_thing', root: '/Users/someone/code/other' },
    ]);
    expect(recorded).toBe('hb_thing-my-space');
  });

  it('records the name as sent when the machine reports no names at all', async () => {
    // What an explicit `--id` sends: an answer the operator gave, which this
    // records rather than rewrites.
    const { status, recorded } = await connect();
    expect(status).toBe(200);
    expect(recorded).toBe('hb_thing');
  });

  it('refuses a reported name that is not one', async () => {
    const app = await buildApp();
    const { code } = await mintConnectToken({
      tenantId: TENANT,
      spaceId: SPACE,
      spaceSlug: 'my-space',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/host/connect',
      payload: {
        code,
        binding: {
          ...binding,
          namesInUse: [{ hostBindingId: '../../etc/passwd', root: '/etc' }],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(inserted).toEqual([]);
    await app.close();
  });
});
