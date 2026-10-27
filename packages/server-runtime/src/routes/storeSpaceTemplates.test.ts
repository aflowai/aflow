/**
 * The Store's `space` routes (Plan 330 D1): the first-run offer's read, and the
 * install's scoping — tenant-scoped, held to the space-creation rules, the
 * space created inside the install and provisioned once it commits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { getCatalogEntry } from '@aflow/platform-artifacts';
import type { EditionDescriptor } from '@aflow/schemas';

const FIRST_SPACE = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'personal',
  name: 'Personal',
};
const NEW_SPACE_ID = '00000000-0000-4000-8000-000000000002';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const IDEMPOTENCY_KEY = '10000000-0000-4000-8000-000000000001';

const state = vi.hoisted(() => ({
  defaultSpaceId: null as string | null,
  liveSpaces: [] as Array<{ id: string; slug: string; name: string }>,
  holds: false,
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@aflow/database')>();
  const chain = (rows: () => unknown[]) => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () =>
          table === orig.tenants ? [{ defaultSpaceId: state.defaultSpaceId }] : rows(),
      }),
    }),
  });
  const tx = {
    select: () => chain(() => state.liveSpaces),
    execute: async () => [{ holds: state.holds }],
  };
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx),
    getTenantStoreShelfPolicy: async () => ({
      defaultAvailability: 'available',
      overrides: new Map(),
    }),
    __fakeDb: { select: () => chain(() => []) },
  };
});

const provisioning = vi.hoisted(() => ({
  validateSpaceCreation: vi.fn(),
  insertSpaceRecord: vi.fn(),
  provisionCreatedSpace: vi.fn(),
}));
vi.mock('../services/spaceProvisioning.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...provisioning,
}));

const executeSpaceTemplateInstall = vi.hoisted(() => vi.fn());
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeSpaceTemplateInstall,
}));

const database = (await import('@aflow/database')) as unknown as { __fakeDb: unknown };
const { storeSpaceTemplateRoutes } = await import('./storeSpaceTemplates.js');

const LOCAL: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'single' },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'present',
  browserLane: 'present',
} as EditionDescriptor;

async function buildApp(tenantRole = 'owner'): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: database.__fakeDb, redis: null };
  app.decorate('edition', LOCAL);
  const authenticate = async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: { userId: string } }).authUser = { userId: USER_ID };
  };
  app.decorate('authenticate', authenticate);
  app.addHook('onRequest', async (request) => {
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: 'tenant-1',
      tenantRole,
      isAdmin: tenantRole === 'owner',
    });
  });
  await app.register(storeSpaceTemplateRoutes, { prefix: '/v1/store' });
  await app.ready();
  return app;
}

const TEMPLATE_ID = 'local-review-quick-start';

beforeEach(() => {
  state.defaultSpaceId = FIRST_SPACE.id;
  state.liveSpaces = [FIRST_SPACE];
  state.holds = false;
  vi.clearAllMocks();
});

describe('GET /v1/store/quick-start-offer', () => {
  it('applies while the only space is the first one and it holds nothing', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/store/quick-start-offer' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      applies: true,
      emptySpace: FIRST_SPACE,
      templates: [expect.objectContaining({ catalogId: TEMPLATE_ID, spaceName: 'Code Review' })],
    });
    await app.close();
  });

  it('does not apply once the first space holds something', async () => {
    state.holds = true;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/store/quick-start-offer' });
    expect(res.json()).toMatchObject({ applies: false });
    expect(res.json()).not.toHaveProperty('emptySpace');
    await app.close();
  });

  it('does not apply once there is a second space', async () => {
    state.liveSpaces = [
      FIRST_SPACE,
      { id: NEW_SPACE_ID, slug: 'code-review', name: 'Code Review' },
    ];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/store/quick-start-offer' });
    expect(res.json()).toMatchObject({ applies: false });
    await app.close();
  });
});

describe('POST /v1/store/space-installs', () => {
  const body = {
    catalogId: TEMPLATE_ID,
    expectedVersion: getCatalogEntry(TEMPLATE_ID)?.version ?? 1,
    idempotencyKey: IDEMPOTENCY_KEY,
    name: 'Code Review',
    slug: 'code-review',
  };

  it('is refused by the space-creation rules before anything is installed', async () => {
    provisioning.validateSpaceCreation.mockResolvedValue({
      ok: false,
      status: 403,
      body: { error: 'Forbidden', message: 'Member access required' },
    });
    const app = await buildApp('viewer');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/store/space-installs',
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(executeSpaceTemplateInstall).not.toHaveBeenCalled();
    await app.close();
  });

  it('installs tenant-scoped into the space it creates, and provisions that space after commit', async () => {
    const directives = { version: 1, responsibility: 'Review.' };
    provisioning.validateSpaceCreation.mockResolvedValue({
      ok: true,
      directives,
      provisioning: { quotas: {} },
    });
    provisioning.insertSpaceRecord.mockResolvedValue({ id: NEW_SPACE_ID, slug: 'code-review' });
    provisioning.provisionCreatedSpace.mockResolvedValue({ helmsmanResolved: true });
    executeSpaceTemplateInstall.mockImplementation(
      async (params: {
        createSpace: (tx: unknown, d: unknown) => Promise<{ spaceId: string }>;
        afterCommit: (space: { spaceId: string; spaceSlug: string }) => Promise<void>;
      }) => {
        const space = await params.createSpace({}, directives);
        await params.afterCommit({ spaceId: space.spaceId, spaceSlug: 'code-review' });
        return { ok: false, statusCode: 404, body: { error: 'stop here' } };
      },
    );
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/v1/store/space-installs', payload: body });

    const [params] = executeSpaceTemplateInstall.mock.calls[0] as [Record<string, unknown>];
    expect(params).toMatchObject({ tenantId: 'tenant-1', catalogId: TEMPLATE_ID });
    expect(params).not.toHaveProperty('spaceId');
    expect(provisioning.validateSpaceCreation).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'code-review' }),
    );
    expect(provisioning.insertSpaceRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ name: 'Code Review', slug: 'code-review', directives }),
    );
    expect(provisioning.provisionCreatedSpace).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: NEW_SPACE_ID, directives }),
    );
    await app.close();
  });

  it('answers a taken slug with the space-creation refusal', async () => {
    provisioning.validateSpaceCreation.mockResolvedValue({
      ok: true,
      directives: { version: 1, responsibility: 'Review.' },
      provisioning: { quotas: {} },
    });
    provisioning.insertSpaceRecord.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "spaces_slug_key"'),
    );
    executeSpaceTemplateInstall.mockImplementation(
      async (params: { createSpace: (tx: unknown, d: unknown) => Promise<unknown> }) => {
        await params.createSpace({}, {});
        return { ok: true };
      },
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/store/space-installs',
      payload: body,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'Conflict' });
    await app.close();
  });
});
