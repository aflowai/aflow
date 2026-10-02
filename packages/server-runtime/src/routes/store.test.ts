/**
 * Store route tests: the auth boundary (mirrors skillBundleCatalog.test.ts),
 * the listing read surface (shelf policy, install-state annotation), the
 * install preview, and the install route as a thin adapter over the shared
 * `executeStoreInstall` core (whose behavior is covered in
 * `@aflow/cybernetic-runtime`'s own suite) — here only the argument
 * plumbing and status-code mapping are pinned.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getCatalogEntry } from '@aflow/platform-artifacts';
import type { ComposedLanes, EditionDescriptor } from '@aflow/schemas';

interface InstallRow {
  catalog_id: string;
  space_id: string;
  kind: string;
  installed_version: number;
  installed_content_hash: string;
  skipped_version: number | null;
  state: string;
  host_manifest_json?: unknown;
  installed_at: string;
  installed_by: string;
  updated_at: string;
  updated_by: string;
}

const store = vi.hoisted(() => ({
  installs: [] as InstallRow[],
  apiDefinitionIds: new Set<string>(),
  apiBindingIds: new Set<string>(),
  spaceDirectives: { purpose: 'test' } as Record<string, unknown> | null,
  memoryDocByPath: new Map<string, { deletedAt: Date | null }>(),
  shelf: {
    defaultAvailability: 'available' as 'available' | 'hidden',
    overrides: new Map<string, 'available' | 'hidden'>(),
  },
}));

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('FROM store_installs')) {
    if (text.includes('catalog_id =')) {
      const [catalogId, spaceId] = params as [string, string];
      return store.installs.filter(
        (row) => row.catalog_id === catalogId && row.space_id === spaceId,
      );
    }
    const [spaceId] = params as [string];
    return store.installs.filter((row) => row.space_id === spaceId);
  }
  if (text.includes('SELECT api_id FROM api_definitions')) {
    const [apiId] = params as [string];
    return store.apiDefinitionIds.has(apiId) ? [{ api_id: apiId }] : [];
  }
  if (text.includes('SELECT binding_id FROM api_bindings')) {
    const [bindingId] = params as [string];
    return store.apiBindingIds.has(bindingId) ? [{ binding_id: bindingId }] : [];
  }
  if (text.includes('SELECT server_id FROM mcp_server_definitions')) {
    return [];
  }
  if (text.includes('SELECT binding_id FROM mcp_server_bindings')) {
    return [];
  }
  throw new Error(`store.test: unhandled SQL: ${text}`);
}

const fakeTx = {
  execute: async (query: SQL) => applyExecute(query),
  select: () => ({
    from: () => ({
      where: () =>
        Promise.resolve(store.spaceDirectives ? [{ directives: store.spaceDirectives }] : []),
    }),
  }),
};

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx),
    createMemoryDocRepository: () => ({
      getByPath: async (path: string) => store.memoryDocByPath.get(path) ?? null,
    }),
    getTenantStoreShelfPolicy: async () => ({
      defaultAvailability: store.shelf.defaultAvailability,
      overrides: new Map(store.shelf.overrides),
    }),
  };
});

const executeStoreInstall = vi.hoisted(() => vi.fn());
const executeStoreUpdate = vi.hoisted(() => vi.fn());
const executeStoreUpdatePreview = vi.hoisted(() => vi.fn());
const executeStoreUninstall = vi.hoisted(() => vi.fn());
const executeStoreUninstallPreview = vi.hoisted(() => vi.fn());
const checkMissingCapabilities = vi.hoisted(() => vi.fn(async () => [] as string[]));

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    executeStoreInstall,
    executeStoreUpdate,
    executeStoreUpdatePreview,
    executeStoreUninstall,
    executeStoreUninstallPreview,
    checkMissingCapabilities,
  };
});

const catalogOverlay = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock('@aflow/platform-artifacts', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown> & {
    listCatalog: (filter?: unknown) => readonly unknown[];
  };
  return {
    ...orig,
    listCatalog: (filter?: unknown) => [...orig.listCatalog(filter), ...catalogOverlay.entries],
  };
});

const { storeListingRoutes, storeInstallRoutes } = await import('./store.js');

// ============================================================================
// Test harness
// ============================================================================

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const IDEMPOTENCY_KEY_A = '10000000-0000-4000-8000-000000000001';

interface TestUser {
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

const FAKE_REDIS = { set: vi.fn(), get: vi.fn(), del: vi.fn() };

const EVERY_LANE: ComposedLanes = {
  edition: 'enterprise',
  codeLane: 'present',
  hostLane: 'present',
  browserLane: 'present',
};

function editionWithLanes(lanes: ComposedLanes): EditionDescriptor {
  return {
    edition: lanes.edition,
    authProvider: lanes.edition === 'enterprise' ? 'auth0' : 'local-instance',
    tenancy: { mode: 'multi' },
    exposure: { bind: 'any', requireTls: false },
    computeRuntime: 'present',
    codeLane: lanes.codeLane,
    hostLane: lanes.hostLane,
    browserLane: lanes.browserLane,
  };
}

async function buildTestApp(
  opts: { user?: TestUser; lanes?: ComposedLanes } = {},
): Promise<{ app: FastifyInstance }> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  (app as unknown as { appContext: unknown }).appContext = { db: {} as never, redis: FAKE_REDIS };
  app.decorate('edition', editionWithLanes(opts.lanes ?? EVERY_LANE));

  const stubAuthenticate = async (request: FastifyRequest): Promise<void> => {
    if (opts.user) {
      (request as unknown as { authUser: { userId: string } }).authUser = {
        userId: opts.user.userId,
      };
    }
  };
  app.decorate('authenticate', stubAuthenticate);
  app.addHook('preHandler', stubAuthenticate);

  app.addHook('preHandler', async (request: FastifyRequest, reply): Promise<void> => {
    const cfg = request.routeOptions.config as { authz?: { resource: string; action: string } };
    if (!cfg?.authz) return;
    const authUser = (request as unknown as { authUser?: { userId: string } }).authUser;
    if (!authUser) {
      await reply.code(401).send({ error: 'Unauthenticated' });
      return;
    }
    const role = opts.user?.role;
    if (cfg.authz.action === 'write' && role !== 'owner' && role !== 'admin') {
      await reply.code(403).send({
        error: 'Forbidden',
        message: `Permission denied: ${cfg.authz.resource}.${cfg.authz.action}`,
      });
      return;
    }
  });

  app.addHook('onRequest', async (request) => {
    (request as unknown as { requireTenant: () => Promise<{ tenantId: string }> }).requireTenant =
      async () => ({ tenantId: 'tenant-1' });
    (request as unknown as { requireSpace: () => Promise<{ spaceId: string }> }).requireSpace =
      async () => ({ spaceId: SPACE_ID });
  });

  await app.register(storeListingRoutes, { prefix: '/v1/store' });
  await app.register(storeInstallRoutes, { prefix: '/v1/spaces' });
  await app.ready();
  return { app };
}

function installBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalogId: 'github',
    expectedVersion: 1,
    idempotencyKey: IDEMPOTENCY_KEY_A,
    ...over,
  };
}

function installedRow(catalogId: string, version: number): InstallRow {
  return {
    catalog_id: catalogId,
    space_id: SPACE_ID,
    kind: 'connector',
    installed_version: version,
    installed_content_hash: 'hash',
    skipped_version: null,
    state: 'installed',
    installed_at: '2020-01-01T00:00:00.000Z',
    installed_by: USER_ID,
    updated_at: '2020-01-01T00:00:00.000Z',
    updated_by: USER_ID,
  };
}

function successResponse() {
  return {
    ok: true as const,
    response: {
      result: {
        kind: 'connector' as const,
        sourceKind: 'api' as const,
        integrationId: 'github',
        bindingId: 'github-default',
        status: 'needs_credentials' as const,
        missingVariables: [] as string[],
        missingCredentialKeys: ['github-default-token'],
      },
      setupChecklist: [],
      install: {
        spaceId: SPACE_ID,
        catalogId: 'github',
        kind: 'connector' as const,
        installedVersion: 1,
        installedContentHash: 'hash',
        state: 'installed' as const,
        installedAt: '2020-01-01T00:00:00.000Z',
        installedBy: USER_ID,
        updatedAt: '2020-01-01T00:00:00.000Z',
        updatedBy: USER_ID,
      },
    },
  };
}

beforeEach(() => {
  store.installs = [];
  store.apiDefinitionIds = new Set();
  store.apiBindingIds = new Set();
  store.spaceDirectives = { purpose: 'test' };
  store.memoryDocByPath = new Map();
  store.shelf = { defaultAvailability: 'available', overrides: new Map() };
  catalogOverlay.entries = [];
  vi.clearAllMocks();
  executeStoreInstall.mockResolvedValue(successResponse());
});

// ============================================================================
// Auth boundary
// ============================================================================

describe('store install auth boundary', () => {
  it('rejects unauthenticated install with 401', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install`,
      payload: installBody(),
    });
    expect(res.statusCode).toBe(401);
    expect(executeStoreInstall).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects non-operator install with 403', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install`,
      payload: installBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/space\.write/);
    expect(executeStoreInstall).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects non-operator install-preview with 403', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'viewer' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install-preview`,
      payload: { catalogId: 'github' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// ============================================================================
// Listings
// ============================================================================

describe('GET /v1/store/listings', () => {
  it('lists published entries without payloads, annotated with install state + requirements', async () => {
    store.installs.push(installedRow('github', 1));
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });
    const res = await app.inject({ method: 'GET', url: '/v1/store/listings' });
    expect(res.statusCode).toBe(200);
    const { listings } = res.json() as {
      listings: Array<Record<string, unknown>>;
    };
    const ids = listings.map((listing) => listing['catalogId']);
    expect(ids).toContain('github');
    expect(ids).not.toContain('_test-skill-a');
    const github = listings.find((listing) => listing['catalogId'] === 'github');
    expect(github?.['payload']).toBeUndefined();
    expect(github?.['installedState']).toMatchObject({ installed: true, installedVersion: 1 });
    expect(github?.['requirements']).toMatchObject({
      credentialKeys: ['github-default-token'],
    });
    await app.close();
  });

  it('resolves an unlisted entry by direct id', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/store/listings/test-two-skill-bundle',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entry: { catalogId: string }; installedState: unknown };
    expect(body.entry.catalogId).toBe('test-two-skill-bundle');
    expect(body.installedState).toEqual({ installed: false, updateAvailable: false });
    await app.close();
  });

  it('404s an unknown listing id', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });
    const res = await app.inject({ method: 'GET', url: '/v1/store/listings/nope' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('search surfaces a deprecated listing only for spaces that installed it', async () => {
    const jira = getCatalogEntry('jira-cloud');
    if (!jira) throw new Error('jira-cloud connector missing');
    catalogOverlay.entries = [{ ...jira, catalogId: 'jira-legacy', status: 'deprecated' }];

    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });
    const before = await app.inject({ method: 'GET', url: '/v1/store/listings?q=jira' });
    expect(before.statusCode).toBe(200);
    const beforeIds = (before.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(beforeIds).not.toContain('jira-legacy');

    store.installs.push(installedRow('jira-legacy', jira.version));
    const after = await app.inject({ method: 'GET', url: '/v1/store/listings?q=jira' });
    const afterIds = (after.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(afterIds).toContain('jira-legacy');
    await app.close();
  });
});

// ============================================================================
// Tenant shelf policy (read surface)
// ============================================================================

describe('tenant shelf policy', () => {
  it('browse omits a listing overridden hidden unless the space installed it', async () => {
    store.shelf.overrides.set('github', 'hidden');
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });

    const hidden = await app.inject({ method: 'GET', url: '/v1/store/listings' });
    const hiddenIds = (hidden.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(hiddenIds).not.toContain('github');

    store.installs.push(installedRow('github', 1));
    const after = await app.inject({ method: 'GET', url: '/v1/store/listings' });
    const afterIds = (after.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(afterIds).toContain('github');
    await app.close();
  });

  it('a hidden default empties browse; an available override re-shelves one listing', async () => {
    store.shelf.defaultAvailability = 'hidden';
    store.shelf.overrides.set('github', 'available');
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });
    const res = await app.inject({ method: 'GET', url: '/v1/store/listings' });
    const ids = (res.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(ids).toEqual(['github']);
    await app.close();
  });

  it('direct GET 404s a hidden listing, resolves it again once installed', async () => {
    store.shelf.overrides.set('github', 'hidden');
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });

    const hidden = await app.inject({ method: 'GET', url: '/v1/store/listings/github' });
    expect(hidden.statusCode).toBe(404);

    store.installs.push(installedRow('github', 1));
    const installed = await app.inject({ method: 'GET', url: '/v1/store/listings/github' });
    expect(installed.statusCode).toBe(200);
    await app.close();
  });

  it('search does not surface hidden unlisted entries', async () => {
    store.shelf.defaultAvailability = 'hidden';
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'member' } });
    const res = await app.inject({ method: 'GET', url: '/v1/store/listings?q=test-two-skill' });
    const ids = (res.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(ids).not.toContain('test-two-skill-bundle');
    await app.close();
  });

  it('install-preview 404s a hidden listing that is not installed', async () => {
    store.shelf.overrides.set('github', 'hidden');
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install-preview`,
      payload: { catalogId: 'github' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ============================================================================
// Composed lanes
// ============================================================================

const HOSTED_LANES: ComposedLanes = {
  edition: 'enterprise',
  codeLane: 'present',
  hostLane: 'absent',
  browserLane: 'absent',
};

const LOCAL_WITH_MACHINE: ComposedLanes = {
  edition: 'community-local',
  codeLane: 'absent',
  hostLane: 'present',
  browserLane: 'present',
};

describe('the edition’s composed lanes', () => {
  it('browse omits a host-lane listing where no host lane is composed', async () => {
    const withheld = await buildTestApp({
      user: { userId: USER_ID, role: 'member' },
      lanes: HOSTED_LANES,
    });
    const hosted = await withheld.app.inject({ method: 'GET', url: '/v1/store/listings' });
    const hostedIds = (hosted.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(hostedIds).not.toContain('local-code-review');
    await withheld.app.close();

    const composed = await buildTestApp({
      user: { userId: USER_ID, role: 'member' },
      lanes: LOCAL_WITH_MACHINE,
    });
    const local = await composed.app.inject({ method: 'GET', url: '/v1/store/listings' });
    const localIds = (local.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(localIds).toContain('local-code-review');
    await composed.app.close();
  });

  it('search omits a host-lane listing asked for by name', async () => {
    const { app } = await buildTestApp({
      user: { userId: USER_ID, role: 'member' },
      lanes: HOSTED_LANES,
    });
    const res = await app.inject({ method: 'GET', url: '/v1/store/listings?q=local-code-review' });
    const ids = (res.json() as { listings: Array<{ catalogId: string }> }).listings.map(
      (listing) => listing.catalogId,
    );
    expect(ids).not.toContain('local-code-review');
    await app.close();
  });

  it('install-preview refuses an uncomposed listing with the lane reason', async () => {
    const { app } = await buildTestApp({
      user: { userId: USER_ID, role: 'admin' },
      lanes: HOSTED_LANES,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install-preview`,
      payload: { catalogId: 'local-code-review' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('lane_not_composed');
    await app.close();
  });

  it('install hands the edition’s lanes to the execution core, which holds the refusal', async () => {
    const { app } = await buildTestApp({
      user: { userId: USER_ID, role: 'admin' },
      lanes: HOSTED_LANES,
    });
    executeStoreInstall.mockResolvedValueOnce({
      ok: false,
      statusCode: 400,
      body: {
        error: 'lane_not_composed: "host.harness.run" needs the host lane',
        code: 'LANE_NOT_COMPOSED',
        catalogId: 'local-code-review',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install`,
      payload: installBody({ catalogId: 'local-code-review', expectedVersion: 3 }),
    });
    expect(executeStoreInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'local-code-review',
        lanes: expect.objectContaining(HOSTED_LANES),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'LANE_NOT_COMPOSED', catalogId: 'local-code-review' });
    await app.close();
  });

  it('leaves a listing naming only platform lanes installable everywhere', async () => {
    const { app } = await buildTestApp({
      user: { userId: USER_ID, role: 'admin' },
      lanes: HOSTED_LANES,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install`,
      payload: installBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(executeStoreInstall).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ============================================================================
// Install preview
// ============================================================================

describe('POST /v1/spaces/:spaceId/store/install-preview', () => {
  it('previews a clean bundle install', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install-preview`,
      payload: { catalogId: 'test-two-skill-bundle' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      catalogId: 'test-two-skill-bundle',
      catalogVersion: 1,
      creates: [
        { artifactType: 'skill', artifactKey: 'test-skill-a' },
        { artifactType: 'skill', artifactKey: 'test-skill-b' },
      ],
      conflicts: [],
      missingCapabilities: [],
    });
    await app.close();
  });

  it('reports existing definition/binding ids for a connector', async () => {
    store.apiDefinitionIds.add('github');
    store.apiBindingIds.add('github-default');
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install-preview`,
      payload: { catalogId: 'github' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conflicts: Array<{ artifactType: string; artifactKey: string }> };
    expect(body.conflicts).toMatchObject([
      { artifactType: 'api_definition', artifactKey: 'github' },
      { artifactType: 'api_binding', artifactKey: 'github-default' },
    ]);
    await app.close();
  });

  it('404s an unknown catalog id', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install-preview`,
      payload: { catalogId: 'nope' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400s a bundle preview in a non-cybernetic space', async () => {
    store.spaceDirectives = null;
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install-preview`,
      payload: { catalogId: 'test-two-skill-bundle' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ============================================================================
// Install — thin adapter over executeStoreInstall
// ============================================================================

describe('POST /v1/spaces/:spaceId/store/install', () => {
  it('passes the request through to executeStoreInstall and returns its response', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install`,
      payload: installBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(successResponse().response);

    expect(executeStoreInstall).toHaveBeenCalledTimes(1);
    expect(executeStoreInstall).toHaveBeenCalledWith({
      db: expect.anything(),
      redis: FAKE_REDIS,
      tenantId: 'tenant-1',
      spaceId: SPACE_ID,
      actorUserId: USER_ID,
      catalogId: 'github',
      expectedVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY_A,
      lanes: expect.objectContaining(EVERY_LANE),
    });
    await app.close();
  });

  it('maps a CATALOG_CHANGED failure onto 409 with the body verbatim', async () => {
    executeStoreInstall.mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      body: {
        error: "Listing '_test-skill-a' changed since preview",
        code: 'CATALOG_CHANGED',
        catalogId: '_test-skill-a',
        expectedVersion: 2,
        currentVersion: 1,
      },
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install`,
      payload: installBody({ expectedVersion: 2 }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'CATALOG_CHANGED',
      catalogId: '_test-skill-a',
      expectedVersion: 2,
      currentVersion: 1,
    });
    await app.close();
  });

  it('maps a 404 failure onto 404', async () => {
    executeStoreInstall.mockResolvedValueOnce({
      ok: false,
      statusCode: 404,
      body: { error: "Store listing 'nope' not found" },
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install`,
      payload: installBody({ catalogId: 'nope' }),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('maps a bundle validation failure onto 422 with the diagnostics', async () => {
    executeStoreInstall.mockResolvedValueOnce({
      ok: false,
      statusCode: 422,
      body: {
        error: 'Bundle validation failed',
        code: 'BUNDLE_INSTALL_VALIDATION_FAILED',
        bundleId: 'test-two-skill-bundle',
        errors: ['member skill missing'],
      },
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/install`,
      payload: installBody({ catalogId: 'test-two-skill-bundle' }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'BUNDLE_INSTALL_VALIDATION_FAILED',
      bundleId: 'test-two-skill-bundle',
      errors: ['member skill missing'],
    });
    await app.close();
  });
});

// ============================================================================
// Update routes — thin adapters over the shared execution core
// ============================================================================

function updatePreviewResponse() {
  return {
    catalogId: '_test-skill-a',
    currentVersion: 1,
    catalogVersion: 2,
    updateAvailable: true,
    divergence: {
      customized: true,
      artifacts: [
        {
          artifactType: 'skill' as const,
          artifactKey: 'test-skill-a',
          state: 'modified' as const,
          contents: { mine: '{\n  "a": 1\n}', store: '{\n  "a": 2\n}' },
        },
      ],
    },
  };
}

function updateResponse() {
  return {
    catalogId: '_test-skill-a',
    mode: 'update' as const,
    fromVersion: 1,
    toVersion: 2,
    updatedArtifacts: [
      { artifactType: 'skill' as const, artifactKey: 'test-skill-a', action: 'replaced' as const },
    ],
    keptUserDataArtifacts: [],
    orphanedArtifacts: [],
    credentialsReset: false,
    missingVariables: [] as string[],
    setupChecklist: [],
    install: successResponse().response.install,
  };
}

describe('POST /v1/spaces/:spaceId/store/update', () => {
  it('rejects non-operator update with 403', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'viewer' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/update`,
      payload: installBody({ expectedVersion: 2, mode: 'update' }),
    });
    expect(res.statusCode).toBe(403);
    expect(executeStoreUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes the request through to executeStoreUpdate and returns its response', async () => {
    executeStoreUpdate.mockResolvedValueOnce({ ok: true, response: updateResponse() });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/update`,
      payload: installBody({ expectedVersion: 2, mode: 'update' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(updateResponse());
    expect(executeStoreUpdate).toHaveBeenCalledWith({
      db: expect.anything(),
      redis: FAKE_REDIS,
      tenantId: 'tenant-1',
      spaceId: SPACE_ID,
      actorUserId: USER_ID,
      catalogId: 'github',
      expectedVersion: 2,
      idempotencyKey: IDEMPOTENCY_KEY_A,
      mode: 'update',
    });
    await app.close();
  });

  it('maps a NOT_INSTALLED failure onto 404 with the body verbatim', async () => {
    executeStoreUpdate.mockResolvedValueOnce({
      ok: false,
      statusCode: 404,
      body: {
        error: "'_test-skill-a' is not installed in this space.",
        code: 'NOT_INSTALLED',
        catalogId: '_test-skill-a',
      },
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/update`,
      payload: installBody({ expectedVersion: 2, mode: 'update' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_INSTALLED', catalogId: '_test-skill-a' });
    await app.close();
  });

  it('maps a STORE_CUSTOMIZED failure onto 409 with the divergence verbatim', async () => {
    executeStoreUpdate.mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      body: {
        error: "'_test-skill-a' has been customized in this space.",
        code: 'STORE_CUSTOMIZED',
        catalogId: '_test-skill-a',
        divergence: updatePreviewResponse().divergence,
      },
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/update`,
      payload: installBody({ expectedVersion: 2, mode: 'update' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'STORE_CUSTOMIZED',
      divergence: updatePreviewResponse().divergence,
    });
    await app.close();
  });
});

describe('POST /v1/spaces/:spaceId/store/update-preview', () => {
  it('rejects non-operator preview with 403', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'viewer' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/update-preview`,
      payload: { catalogId: '_test-skill-a' },
    });
    expect(res.statusCode).toBe(403);
    expect(executeStoreUpdatePreview).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the divergence preview with per-artifact contents', async () => {
    executeStoreUpdatePreview.mockResolvedValueOnce({
      ok: true,
      response: updatePreviewResponse(),
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/update-preview`,
      payload: { catalogId: '_test-skill-a' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(updatePreviewResponse());
    expect(executeStoreUpdatePreview).toHaveBeenCalledWith({
      db: expect.anything(),
      tenantId: 'tenant-1',
      spaceId: SPACE_ID,
      catalogId: '_test-skill-a',
    });
    await app.close();
  });

  it('maps NOT_INSTALLED onto 404', async () => {
    executeStoreUpdatePreview.mockResolvedValueOnce({
      ok: false,
      statusCode: 404,
      body: {
        error: "'_test-skill-a' is not installed in this space.",
        code: 'NOT_INSTALLED',
        catalogId: '_test-skill-a',
      },
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/update-preview`,
      payload: { catalogId: '_test-skill-a' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_INSTALLED' });
    await app.close();
  });
});

// ============================================================================
// Uninstall routes — thin adapters over the shared execution core
// ============================================================================

function uninstallPlanResponse() {
  return {
    catalogId: '_test-skill-a',
    kind: 'skill' as const,
    installedVersion: 1,
    action: 'remove' as const,
    remainingClaims: [] as string[],
    members: [],
    artifacts: [
      {
        artifactType: 'skill' as const,
        artifactKey: 'test-skill-a',
        action: 'archive' as const,
        activeRunCount: 0,
      },
    ],
  };
}

describe('POST /v1/spaces/:spaceId/store/uninstall', () => {
  it('rejects unauthenticated uninstall with 401', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/uninstall`,
      payload: { catalogId: '_test-skill-a', idempotencyKey: IDEMPOTENCY_KEY_A },
    });
    expect(res.statusCode).toBe(401);
    expect(executeStoreUninstall).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects non-operator uninstall with 403', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'viewer' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/uninstall`,
      payload: { catalogId: '_test-skill-a', idempotencyKey: IDEMPOTENCY_KEY_A },
    });
    expect(res.statusCode).toBe(403);
    expect(executeStoreUninstall).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes the request through and returns the executed plan', async () => {
    executeStoreUninstall.mockResolvedValueOnce({ ok: true, response: uninstallPlanResponse() });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/uninstall`,
      payload: {
        catalogId: '_test-skill-a',
        idempotencyKey: IDEMPOTENCY_KEY_A,
        keepUserData: ['/notes/seeded.md'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(uninstallPlanResponse());
    expect(executeStoreUninstall).toHaveBeenCalledWith({
      db: expect.anything(),
      redis: FAKE_REDIS,
      tenantId: 'tenant-1',
      spaceId: SPACE_ID,
      actorUserId: USER_ID,
      catalogId: '_test-skill-a',
      idempotencyKey: IDEMPOTENCY_KEY_A,
      keepUserData: ['/notes/seeded.md'],
    });
    await app.close();
  });

  it('maps a SKILL_HAS_ACTIVE_RUNS failure onto 409 with the body verbatim', async () => {
    executeStoreUninstall.mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      body: {
        error: "Skill 'test-skill-a' has 1 active run(s).",
        code: 'SKILL_HAS_ACTIVE_RUNS',
        skillId: 'test-skill-a',
        runIds: ['run-1'],
      },
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/uninstall`,
      payload: { catalogId: '_test-skill-a', idempotencyKey: IDEMPOTENCY_KEY_A },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'SKILL_HAS_ACTIVE_RUNS',
      skillId: 'test-skill-a',
      runIds: ['run-1'],
    });
    await app.close();
  });
});

describe('POST /v1/spaces/:spaceId/store/uninstall-preview', () => {
  it('rejects non-operator preview with 403', async () => {
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'viewer' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/uninstall-preview`,
      payload: { catalogId: '_test-skill-a' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns the blast-radius plan', async () => {
    executeStoreUninstallPreview.mockResolvedValueOnce({
      ok: true,
      response: uninstallPlanResponse(),
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/uninstall-preview`,
      payload: { catalogId: '_test-skill-a' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(uninstallPlanResponse());
    await app.close();
  });

  it('maps NOT_INSTALLED onto 404', async () => {
    executeStoreUninstallPreview.mockResolvedValueOnce({
      ok: false,
      statusCode: 404,
      body: { error: "'_test-skill-a' is not installed in this space.", code: 'NOT_INSTALLED' },
    });
    const { app } = await buildTestApp({ user: { userId: USER_ID, role: 'admin' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/store/uninstall-preview`,
      payload: { catalogId: '_test-skill-a' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_INSTALLED' });
    await app.close();
  });
});
