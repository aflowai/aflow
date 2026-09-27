/**
 * Session-content routes without a spaceId in their authz config re-check
 * against the session's space after loading it — a tenant admin without a
 * membership must not reach content in a foreign personal space.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { checkPermission } from '@aflow/authz';
import type { AuthzAction, AuthzResourceType, SpaceRole } from '@aflow/authz';
import type { Redis } from 'ioredis';

const mocks = vi.hoisted(() => ({
  getSessionStateSafe: vi.fn(),
}));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return {
    ...actual,
    getSessionStateSafe: (...args: unknown[]) => mocks.getSessionStateSafe(...args),
  };
});

const { runsRoutes } = await import('./runs.js');
const { payloadRoutes } = await import('./payloads.js');

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const OWNER_ID = '00000000-0000-4000-8000-0000000000bb';
const SESSION_ID = '00000000-0000-4000-8000-0000000000cc';
const SPACE_ID = '00000000-0000-4000-8000-0000000000dd';
const CHAT_REF = `gs://bucket/tenants/${TENANT_ID}/runs/${SESSION_ID}/steps/step-1/attempt/0/history.json`;

const world: { membership: SpaceRole | null } = { membership: null };

function fakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
  } as unknown as Redis;
}

function hotState() {
  return {
    ok: true,
    state: {
      spaceId: SPACE_ID,
      runtimeState: {
        variables: {
          'ai.agent.chatHistory.step-1': { ref: { kind: 'ref', payloadRef: CHAT_REF } },
        },
      },
    },
  };
}

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
      retrieve: async () => ({ modelMessages: [] }),
      delete: async () => undefined,
      getSignedUrl: async () => 'https://signed.example/url',
      // The subject here is the hosted server, so the store behind it is one
      // that can sign. Without this the route takes the appliance branch and
      // these cases would be answered by code they are not about.
      servesSignedUrls: true,
    },
  };

  app.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: USER_ID,
      authMethod: 'test',
      isServicePrincipal: false,
    };
  });

  app.decorate(
    'requirePermission',
    (opts: {
      resource: AuthzResourceType;
      action: AuthzAction;
      getSpaceId?: (request: FastifyRequest) => string | undefined;
    }) => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const spaceId = opts.getSpaceId?.(request);
        const decision = await checkPermission(
          {
            userId: USER_ID,
            tenantId: TENANT_ID,
            tenantRole: 'admin',
            redis: fakeRedis(),
            config: { rbacCacheTtlSeconds: 60 },
            loadSpaceRole: async () => world.membership,
            loadSpaceAttributes: async () => ({ ownerId: OWNER_ID, memberCount: 1 }),
          },
          {
            resource: opts.resource,
            action: opts.action,
            ...(spaceId ? { spaceId } : {}),
          },
        );
        if (!decision.allowed) {
          reply
            .status(403)
            .send({ error: 'Forbidden', message: `Permission denied: ${opts.resource}` });
        }
      };
    },
  );

  app.addHook('onRequest', async (request) => {
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: TENANT_ID,
      tenantRole: 'admin',
      isAdmin: true,
    });
  });

  await app.register(runsRoutes, { prefix: '/v1/sessions' });
  await app.register(payloadRoutes, { prefix: '/v1/payloads' });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  world.membership = null;
  mocks.getSessionStateSafe.mockResolvedValue(hotState());
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
});

describe('chat-history space cap', () => {
  it('403s a tenant admin without a membership on a foreign personal session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${SESSION_ID}/chat-history`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('serves an explicitly invited member', async () => {
    world.membership = 'viewer';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${SESSION_ID}/chat-history`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ messages: [] });
  });
});

describe('payload fetch space cap', () => {
  it('403s a tenant admin fetching a payload from a foreign personal session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(CHAT_REF)}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('serves an explicitly invited member', async () => {
    world.membership = 'viewer';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent(CHAT_REF)}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('skips the session check for refs that encode no session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payloads?ref=${encodeURIComponent('inline:eyJhIjoxfQ==')}`,
    });
    expect(res.statusCode).toBe(200);
  });
});
