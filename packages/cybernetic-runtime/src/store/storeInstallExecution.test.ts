/**
 * executeStoreInstall tests: the install flow's version guard / advisory lock
 * / idempotency claim, per-kind dispatch incl. adopt-on-conflict, and the
 * provenance rows the install transaction persists — the per-kind backends
 * are stubbed at their module seams, the provenance service runs for real
 * against an in-memory SQL dispatcher.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getCatalogEntry } from '@aflow/platform-artifacts';
import type { ComposedLanes, StoreInstallResponse, TenantId } from '@aflow/schemas';

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
  artifacts: [] as Array<Record<string, string>>,
  claims: [] as Array<{ catalog_id: string; space_id: string; claimed_by: string }>,
  lockAcquired: true,
  apiBindingAuthJsonByBindingId: new Map<string, Record<string, unknown>>(),
  presentCredentialKeys: new Set<string>(),
  spaceDirectives: { purpose: 'test' } as Record<string, unknown> | null,
  shelf: {
    defaultAvailability: 'available' as 'available' | 'hidden',
    overrides: new Map<string, 'available' | 'hidden'>(),
  },
}));

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('pg_try_advisory_xact_lock')) {
    return [{ acquired: store.lockAcquired }];
  }
  if (text.includes('INSERT INTO store_installs')) {
    const [
      catalogId,
      spaceId,
      kind,
      version,
      hash,
      state,
      hostManifestJson,
      installedAt,
      installedBy,
      updatedAt,
      updatedBy,
    ] = params as [
      string,
      string,
      string,
      number,
      string,
      string,
      string | null,
      string,
      string,
      string,
      string,
    ];
    const hostManifest =
      hostManifestJson === null ? null : (JSON.parse(hostManifestJson) as unknown);
    const existing = store.installs.find(
      (row) => row.catalog_id === catalogId && row.space_id === spaceId,
    );
    if (existing) {
      if (text.includes('DO UPDATE')) {
        Object.assign(existing, {
          kind,
          installed_version: version,
          installed_content_hash: hash,
          skipped_version: null,
          state,
          host_manifest_json: hostManifest,
          updated_at: updatedAt,
          updated_by: updatedBy,
        });
      }
      return [];
    }
    store.installs.push({
      catalog_id: catalogId,
      space_id: spaceId,
      kind,
      installed_version: version,
      installed_content_hash: hash,
      skipped_version: null,
      state,
      host_manifest_json: hostManifest,
      installed_at: installedAt,
      installed_by: installedBy,
      updated_at: updatedAt,
      updated_by: updatedBy,
    });
    return [];
  }
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
  if (text.includes('INSERT INTO store_install_artifacts')) {
    const [catalogId, spaceId, artifactType, artifactKey, artifactId, hash, preservation] =
      params as string[];
    const existing = store.artifacts.find(
      (row) =>
        row['catalog_id'] === catalogId &&
        row['space_id'] === spaceId &&
        row['artifact_type'] === artifactType &&
        row['artifact_key'] === artifactKey,
    );
    if (existing) {
      if (text.includes('DO UPDATE')) {
        existing['artifact_id'] = artifactId as string;
        existing['installed_content_hash'] = hash as string;
        existing['preservation'] = preservation as string;
      }
      return [];
    }
    store.artifacts.push({
      catalog_id: catalogId as string,
      space_id: spaceId as string,
      artifact_type: artifactType as string,
      artifact_key: artifactKey as string,
      artifact_id: artifactId as string,
      installed_content_hash: hash as string,
      preservation: preservation as string,
    });
    return [];
  }
  if (text.includes('INSERT INTO store_install_claims')) {
    const [catalogId, spaceId, claimedBy] = params as [string, string, string];
    if (
      !store.claims.some(
        (row) =>
          row.catalog_id === catalogId && row.space_id === spaceId && row.claimed_by === claimedBy,
      )
    ) {
      store.claims.push({ catalog_id: catalogId, space_id: spaceId, claimed_by: claimedBy });
    }
    return [];
  }
  if (text.includes('SELECT auth_json FROM api_bindings')) {
    const [bindingId] = params as [string];
    const authJson = store.apiBindingAuthJsonByBindingId.get(bindingId);
    return authJson ? [{ auth_json: authJson }] : [];
  }
  if (text.includes('SELECT credential_key FROM api_credentials')) {
    return [...store.presentCredentialKeys].map((key) => ({ credential_key: key }));
  }
  throw new Error(`storeInstallExecution.test: unhandled SQL: ${text}`);
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
    getTenantStoreShelfPolicy: async () => ({
      defaultAvailability: store.shelf.defaultAvailability,
      overrides: new Map(store.shelf.overrides),
    }),
  };
});

const installSkillBundle = vi.hoisted(() => vi.fn());
const publishBundleInstallInvalidations = vi.hoisted(() => vi.fn());
const installApiConnectorEntry = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, unknown>> => ({
    outcome: 'installed',
    apiId: 'github',
    bindingId: 'github-default',
    status: 'needs_credentials',
    missingVariables: [] as string[],
    missingCredentialKeys: ['github-default-token'],
  })),
);
const installMcpConnectorEntry = vi.hoisted(() => vi.fn());

vi.mock('../stagedChange/skillBundleInstall.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, installSkillBundle, publishBundleInstallInvalidations };
});
vi.mock('./connectorInstall.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, installApiConnectorEntry, installMcpConnectorEntry };
});

const publishApiCatalogInvalidation = vi.hoisted(() => vi.fn());
const publishMcpCatalogInvalidation = vi.hoisted(() => vi.fn());
vi.mock('@aflow/redis', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, publishApiCatalogInvalidation, publishMcpCatalogInvalidation };
});

const { executeStoreInstall } = await import('./storeInstallExecution.js');

// ============================================================================
// Test harness
// ============================================================================

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TENANT_ID = 'tenant-1' as TenantId;
const IDEMPOTENCY_KEY_A = '10000000-0000-4000-8000-000000000001';
const IDEMPOTENCY_KEY_B = '10000000-0000-4000-8000-000000000002';

function createFakeRedis() {
  const data = new Map<string, string>();
  const sets: Array<{ key: string; value: string; ttlSeconds: number | null; nx: boolean }> = [];
  return {
    data,
    sets,
    async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
      const exIndex = args.indexOf('EX');
      sets.push({
        key,
        value,
        ttlSeconds: exIndex >= 0 ? (args[exIndex + 1] as number) : null,
        nx: args.includes('NX'),
      });
      if (args.includes('NX') && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    async get(key: string): Promise<string | null> {
      return data.get(key) ?? null;
    },
    async del(key: string): Promise<number> {
      return data.delete(key) ? 1 : 0;
    },
  };
}

type FakeRedis = ReturnType<typeof createFakeRedis>;

// Derive catalog versions rather than hardcoding them — connector/bundle
// versions bump over time (e.g. writeRiskTier curation), and a literal would
// silently rot the same-version / already-installed / catalog-changed cases.
const GITHUB_VERSION = getCatalogEntry('github')?.version ?? 1;

function install(over: Record<string, unknown> = {}, redis: FakeRedis | null = createFakeRedis()) {
  const catalogId = (over['catalogId'] as string | undefined) ?? 'github';
  return executeStoreInstall({
    db: {} as never,
    redis: redis as never,
    tenantId: TENANT_ID,
    spaceId: SPACE_ID,
    actorUserId: USER_ID,
    catalogId,
    // Default to the catalog's actual version so a plain install() matches;
    // a test overrides it explicitly to probe a version mismatch.
    expectedVersion: getCatalogEntry(catalogId)?.version ?? 1,
    idempotencyKey: IDEMPOTENCY_KEY_A,
    ...over,
  });
}

function installedRow(catalogId: string, version: number, kind = 'connector'): InstallRow {
  return {
    catalog_id: catalogId,
    space_id: SPACE_ID,
    kind,
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

beforeEach(() => {
  store.installs = [];
  store.artifacts = [];
  store.claims = [];
  store.lockAcquired = true;
  store.apiBindingAuthJsonByBindingId = new Map();
  store.presentCredentialKeys = new Set();
  store.spaceDirectives = { purpose: 'test' };
  store.shelf = { defaultAvailability: 'available', overrides: new Map() };
  vi.clearAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('executeStoreInstall', () => {
  it('fails with CATALOG_CHANGED on an expectedVersion mismatch', async () => {
    const result = await install({ expectedVersion: GITHUB_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({
      code: 'CATALOG_CHANGED',
      catalogId: 'github',
      expectedVersion: GITHUB_VERSION + 1,
      currentVersion: GITHUB_VERSION,
    });
    expect(installApiConnectorEntry).not.toHaveBeenCalled();
  });

  it('backend dispatched + provenance rows committed together, response recorded', async () => {
    const redis = createFakeRedis();
    const result = await install({}, redis);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.result).toMatchObject({
      kind: 'connector',
      sourceKind: 'api',
      integrationId: 'github',
      bindingId: 'github-default',
    });
    expect(result.response.install).toMatchObject({
      catalogId: 'github',
      spaceId: SPACE_ID,
      kind: 'connector',
      installedVersion: GITHUB_VERSION,
      state: 'installed',
      installedBy: USER_ID,
    });

    expect(installApiConnectorEntry).toHaveBeenCalledTimes(1);
    expect(store.installs).toMatchObject([
      { catalog_id: 'github', kind: 'connector', installed_version: GITHUB_VERSION },
    ]);
    expect(store.claims).toEqual([
      { catalog_id: 'github', space_id: SPACE_ID, claimed_by: 'direct' },
    ]);
    expect(store.artifacts.map((row) => row['artifact_type']).sort()).toEqual([
      'api_binding',
      'api_definition',
    ]);

    const recorded = [...redis.data.values()];
    expect(recorded.some((value) => value.includes('"bindingId":"github-default"'))).toBe(true);
  });

  it('replays the recorded response for a retried idempotency key without re-dispatching', async () => {
    const redis = createFakeRedis();
    const first = await install({}, redis);
    expect(first.ok).toBe(true);
    expect(installApiConnectorEntry).toHaveBeenCalledTimes(1);

    const retry = await install({}, redis);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) throw new Error('expected success');
    expect(retry.response).toEqual(first.response);
    expect(installApiConnectorEntry).toHaveBeenCalledTimes(1);
    expect(redis.data.size).toBe(1);
  });

  it('treats a same-version reinstall under a new idempotency key as a no-op', async () => {
    const first = await install({});
    expect(first.ok).toBe(true);

    const reinstall = await install({ idempotencyKey: IDEMPOTENCY_KEY_B });
    expect(reinstall.ok).toBe(true);
    if (!first.ok || !reinstall.ok) throw new Error('expected success');
    expect(installApiConnectorEntry).toHaveBeenCalledTimes(1);
    expect(reinstall.response.install.installedAt).toBe(first.response.install.installedAt);
    expect(store.installs).toHaveLength(1);
  });

  it('fails on lock contention and releases the idempotency claim', async () => {
    store.lockAcquired = false;
    const redis = createFakeRedis();
    const result = await install({}, redis);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe('STORE_MUTATION_IN_PROGRESS');
    expect(redis.data.size).toBe(0);
  });

  it('rejects a bundle install into a non-cybernetic space', async () => {
    store.spaceDirectives = null;
    const result = await install({ catalogId: 'test-two-skill-bundle' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(400);
    expect(installSkillBundle).not.toHaveBeenCalled();
  });

  it('installs a bundle: member install rows + bundle claims + post-commit invalidations', async () => {
    const bundleEntry = getCatalogEntry('test-two-skill-bundle');
    if (!bundleEntry) throw new Error('fixture bundle missing');
    const bundleResult = {
      bundleId: 'test-two-skill-bundle',
      installedSkillCatalogIds: ['_test-skill-a', '_test-skill-b'],
      skippedSkillCatalogIds: [],
      repairedProjectionSkillCatalogIds: [],
      installedApiDefinitionIds: [],
      skippedApiDefinitionIds: [],
      installedBindingIds: [],
      skippedBindingIds: [],
      installedMcpDefinitionIds: [],
      skippedMcpDefinitionIds: [],
      installedMcpBindingIds: [],
      skippedMcpBindingIds: [],
      installedMemoryDocPaths: [],
      skippedMemoryDocPaths: [],
      installedArtifactBindings: [],
      skippedArtifactBindings: [],
      postInstallManifest: [],
      helmsmanHints: [],
      warnings: ['a warning'],
      stateChanged: true,
    };
    installSkillBundle.mockResolvedValueOnce(bundleResult);

    const result = await install({ catalogId: 'test-two-skill-bundle' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.result.kind).toBe('bundle');
    expect((result.response.result as { warnings: string[] }).warnings).toEqual(['a warning']);

    expect(installSkillBundle).toHaveBeenCalledTimes(1);
    expect(store.installs.map((row) => row.catalog_id).sort()).toEqual([
      '_test-skill-a',
      '_test-skill-b',
      'test-two-skill-bundle',
    ]);
    expect(store.claims).toContainEqual({
      catalog_id: 'test-two-skill-bundle',
      space_id: SPACE_ID,
      claimed_by: 'direct',
    });
    expect(store.claims).toContainEqual({
      catalog_id: '_test-skill-a',
      space_id: SPACE_ID,
      claimed_by: 'bundle:test-two-skill-bundle',
    });
    expect(publishBundleInstallInvalidations).toHaveBeenCalledTimes(1);
  });

  it('installs an API connector and publishes catalog invalidations post-commit', async () => {
    const githubEntry = getCatalogEntry('github');
    if (!githubEntry) throw new Error('github connector missing');
    installApiConnectorEntry.mockResolvedValueOnce({
      outcome: 'installed',
      apiId: 'github',
      bindingId: 'github-default',
      status: 'needs_credentials',
      missingVariables: [],
      missingCredentialKeys: ['github-default-token'],
    });

    const result = await install({ catalogId: 'github', expectedVersion: githubEntry.version });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.result).toMatchObject({
      kind: 'connector',
      sourceKind: 'api',
      integrationId: 'github',
      bindingId: 'github-default',
      status: 'needs_credentials',
    });
    expect(result.response.setupChecklist).toMatchObject([
      { kind: 'fill_credentials', bindingId: 'github-default' },
    ]);
    expect(store.artifacts.map((row) => row['artifact_type']).sort()).toEqual([
      'api_binding',
      'api_definition',
    ]);
    expect(publishApiCatalogInvalidation).toHaveBeenCalledTimes(2);
  });

  it('fails an unknown catalog id with 404', async () => {
    const result = await install({ catalogId: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(404);
    expect(installApiConnectorEntry).not.toHaveBeenCalled();
    expect(installSkillBundle).not.toHaveBeenCalled();
  });

  it('does not adopt over an existing provenance row — ALREADY_INSTALLED still wins', async () => {
    // Installed version differs from the catalog version → ALREADY_INSTALLED
    // (an equal version would be a same-version no-op, not an adopt conflict).
    store.installs.push(installedRow('github', GITHUB_VERSION + 1));
    const result = await install({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe('ALREADY_INSTALLED');
    expect(installApiConnectorEntry).not.toHaveBeenCalled();
  });

  it('adopts a pre-store connector: matching conflict reports current state + provenance', async () => {
    const githubEntry = getCatalogEntry('github');
    if (!githubEntry) throw new Error('github connector missing');
    installApiConnectorEntry.mockResolvedValueOnce({
      outcome: 'conflict',
      conflictingApiId: 'github',
      error: "An API definition 'github' already exists in this space.",
    });
    store.apiBindingAuthJsonByBindingId.set('github-default', {
      type: 'bearer',
      credentialKey: 'github-default-token',
    });

    const result = await install({ catalogId: 'github', expectedVersion: githubEntry.version });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.result).toMatchObject({
      kind: 'connector',
      sourceKind: 'api',
      integrationId: 'github',
      bindingId: 'github-default',
      status: 'needs_credentials',
      missingCredentialKeys: ['github-default-token'],
    });
    expect(result.response.setupChecklist).toMatchObject([
      { kind: 'fill_credentials', bindingId: 'github-default' },
    ]);
    expect(result.response.install).toMatchObject({ catalogId: 'github', state: 'installed' });
    expect(store.installs).toMatchObject([{ catalog_id: 'github', kind: 'connector' }]);
    expect(store.artifacts.map((row) => row['artifact_type']).sort()).toEqual([
      'api_binding',
      'api_definition',
    ]);
    expect(publishApiCatalogInvalidation).not.toHaveBeenCalled();
  });

  it('fails a connector conflict whose apiId does not match the listing', async () => {
    const githubEntry = getCatalogEntry('github');
    if (!githubEntry) throw new Error('github connector missing');
    installApiConnectorEntry.mockResolvedValueOnce({
      outcome: 'conflict',
      conflictingApiId: 'github-enterprise',
      error: "An API definition 'github-enterprise' already exists in this space.",
    });
    const redis = createFakeRedis();
    const result = await install(
      { catalogId: 'github', expectedVersion: githubEntry.version },
      redis,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe('ARTIFACT_CONFLICT');
    expect(store.installs).toHaveLength(0);
    expect(redis.data.size).toBe(0);
  });

  it('reports ALREADY_INSTALLED with the installed version and the catalog version', async () => {
    store.installs.push(installedRow('github', GITHUB_VERSION + 1));
    const result = await install({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({
      code: 'ALREADY_INSTALLED',
      catalogId: 'github',
      currentVersion: GITHUB_VERSION + 1,
      catalogVersion: GITHUB_VERSION,
    });
  });

  it('scopes the idempotency claim by tenant and bounds the pending sentinel TTL', async () => {
    const redis = createFakeRedis();
    const result = await install({}, redis);
    expect(result.ok).toBe(true);
    const expectedKey = `aflow:idempotency:store_install:tenant-1:${SPACE_ID}:github:${IDEMPOTENCY_KEY_A}`;
    expect(redis.sets.map((entry) => entry.key)).toEqual([expectedKey, expectedKey]);
    expect(redis.sets[0]).toMatchObject({ value: 'pending', nx: true, ttlSeconds: 300 });
    expect(redis.sets[1]).toMatchObject({ nx: false, ttlSeconds: 24 * 60 * 60 });
  });

  it('a bundle install with a skipped member neither restamps its install row nor its artifact row', async () => {
    const seededAt = '2019-06-01T00:00:00.000Z';
    store.installs.push({
      ...installedRow('_test-skill-a', 1, 'skill'),
      installed_content_hash: 'pre-existing-hash',
      installed_at: seededAt,
      updated_at: seededAt,
    });
    store.artifacts.push({
      catalog_id: '_test-skill-a',
      space_id: SPACE_ID,
      artifact_type: 'skill',
      artifact_key: 'test-skill-a',
      artifact_id: 'test-skill-a',
      installed_content_hash: 'pre-existing-artifact-hash',
      preservation: 'replace_on_update',
    });
    installSkillBundle.mockResolvedValueOnce({
      bundleId: 'test-two-skill-bundle',
      installedSkillCatalogIds: ['_test-skill-b'],
      skippedSkillCatalogIds: ['_test-skill-a'],
      repairedProjectionSkillCatalogIds: [],
      installedApiDefinitionIds: [],
      skippedApiDefinitionIds: [],
      installedBindingIds: [],
      skippedBindingIds: [],
      installedMcpDefinitionIds: [],
      skippedMcpDefinitionIds: [],
      installedMcpBindingIds: [],
      skippedMcpBindingIds: [],
      installedMemoryDocPaths: [],
      skippedMemoryDocPaths: [],
      installedArtifactBindings: [],
      skippedArtifactBindings: [],
      postInstallManifest: [],
      helmsmanHints: [],
      warnings: [],
      stateChanged: true,
    });

    const result = await install({ catalogId: 'test-two-skill-bundle' });
    expect(result.ok).toBe(true);

    const skippedMemberRow = store.installs.find((row) => row.catalog_id === '_test-skill-a');
    expect(skippedMemberRow).toMatchObject({
      installed_version: 1,
      installed_content_hash: 'pre-existing-hash',
      updated_at: seededAt,
    });
    const skippedMemberArtifact = store.artifacts.find(
      (row) => row['catalog_id'] === '_test-skill-a' && row['artifact_key'] === 'test-skill-a',
    );
    expect(skippedMemberArtifact?.['installed_content_hash']).toBe('pre-existing-artifact-hash');

    const installedMemberRow = store.installs.find((row) => row.catalog_id === '_test-skill-b');
    expect(installedMemberRow?.installed_content_hash).toMatch(/^[0-9a-f]{64}$/);
    const installedMemberArtifact = store.artifacts.find(
      (row) => row['catalog_id'] === '_test-skill-b' && row['artifact_key'] === 'test-skill-b',
    );
    expect(installedMemberArtifact?.['installed_content_hash']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('executeStoreInstall — tenant shelf policy', () => {
  it('fails a hidden listing that is not installed with 404', async () => {
    store.shelf.overrides.set('github', 'hidden');
    const result = await install({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(404);
    expect(installApiConnectorEntry).not.toHaveBeenCalled();
  });

  it('a hidden uninstalled listing probed with a wrong expectedVersion fails 404 without disclosing the current version', async () => {
    store.shelf.overrides.set('github', 'hidden');
    const result = await install({ expectedVersion: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(404);
    expect(result.body).toEqual({ error: "Store listing 'github' not found" });
    expect(installApiConnectorEntry).not.toHaveBeenCalled();
  });

  it('an installed hidden listing with a wrong expectedVersion still reports CATALOG_CHANGED', async () => {
    store.shelf.overrides.set('github', 'hidden');
    store.installs.push(installedRow('github', GITHUB_VERSION));
    const result = await install({ expectedVersion: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ code: 'CATALOG_CHANGED', currentVersion: GITHUB_VERSION });
  });

  it('a same-version reinstall of an installed listing survives shelf hiding', async () => {
    store.shelf.overrides.set('github', 'hidden');
    store.installs.push(installedRow('github', GITHUB_VERSION));
    const result = await install({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const response: StoreInstallResponse = result.response;
    expect(response.install.catalogId).toBe('github');
  });
});

describe('executeStoreInstall — the edition’s composed lanes', () => {
  const HOSTED: ComposedLanes = {
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

  it('refuses a listing whose lane is absent before anything is read or written', async () => {
    const result = await install({ catalogId: 'local-code-review', lanes: HOSTED });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({
      code: 'LANE_NOT_COMPOSED',
      catalogId: 'local-code-review',
    });
    expect(result.body.error).toContain('host.harness.run');
    expect(installSkillBundle).not.toHaveBeenCalled();
    expect(store.installs).toEqual([]);
  });

  it('the lane answers ahead of the shelf, since it is a fact about the catalog, not the tenant', async () => {
    store.shelf.overrides.set('local-code-review', 'hidden');
    const result = await install({ catalogId: 'local-code-review', lanes: HOSTED });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({ code: 'LANE_NOT_COMPOSED' });
  });

  it('lets the same listing through once the lane is composed', async () => {
    installSkillBundle.mockResolvedValueOnce({
      bundleId: 'local-code-review',
      installedSkillCatalogIds: ['review-local-changes'],
      skippedSkillCatalogIds: [],
      repairedProjectionSkillCatalogIds: [],
      installedApiDefinitionIds: [],
      skippedApiDefinitionIds: [],
      installedBindingIds: [],
      skippedBindingIds: [],
      installedMcpDefinitionIds: [],
      skippedMcpDefinitionIds: [],
      installedMcpBindingIds: [],
      skippedMcpBindingIds: [],
      installedMemoryDocPaths: [],
      skippedMemoryDocPaths: [],
      installedArtifactBindings: [],
      skippedArtifactBindings: [],
      postInstallManifest: [],
      helmsmanHints: [],
      warnings: [],
      stateChanged: true,
    });
    const result = await install({ catalogId: 'local-code-review', lanes: LOCAL_WITH_MACHINE });
    expect(result.ok).toBe(true);
    expect(installSkillBundle).toHaveBeenCalled();
  });

  it('a listing naming only platform lanes installs under either edition', async () => {
    for (const lanes of [HOSTED, LOCAL_WITH_MACHINE]) {
      store.installs = [];
      vi.clearAllMocks();
      const result = await install({ lanes });
      expect(result.ok).toBe(true);
    }
  });
});
