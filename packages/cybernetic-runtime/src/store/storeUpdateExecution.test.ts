/**
 * executeStoreUpdate tests: the update flow's version guard / lock /
 * idempotency contract, keep-mode skippedVersion recording, the customized
 * refusal (STORE_CUSTOMIZED unless replace_customized), per-kind dispatch to
 * the UPDATE handlers (stubbed at their module seams), and the provenance
 * re-stamp — replace_on_update rows move to the new version's hashes while
 * user_data_keep rows keep their original stamps.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getCatalogEntry } from '@aflow/platform-artifacts';
import type { CatalogEntry, StoreInstallDivergence, TenantId } from '@aflow/schemas';

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
  memoryDocPaths: new Set<string>(),
  memoryDocPuts: [] as string[],
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
  if (text.includes('UPDATE store_installs SET') && text.includes('skipped_version')) {
    const [skippedVersion, updatedAt, updatedBy, catalogId, spaceId] = params as [
      number,
      string,
      string,
      string,
      string,
    ];
    const row = store.installs.find((r) => r.catalog_id === catalogId && r.space_id === spaceId);
    if (row) {
      row.skipped_version = skippedVersion;
      row.updated_at = updatedAt;
      row.updated_by = updatedBy;
    }
    return [];
  }
  if (text.includes('INSERT INTO store_installs')) {
    const [catalogId, spaceId, kind, version, hash, state, , , , updatedAt, updatedBy] = params as [
      string,
      string,
      string,
      number,
      string,
      string,
      ...unknown[],
    ] as [
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
      installed_at: updatedAt,
      installed_by: updatedBy,
      updated_at: updatedAt,
      updated_by: updatedBy,
    });
    return [];
  }
  if (text.includes('FROM store_installs')) {
    const [catalogId, spaceId] = params as [string, string];
    return store.installs.filter((row) => row.catalog_id === catalogId && row.space_id === spaceId);
  }
  if (text.includes('UPDATE store_install_artifacts SET')) {
    const [artifactId, hash, spaceId, artifactType, artifactKey] = params as [
      string,
      string,
      string,
      string,
      string,
    ];
    for (const row of store.artifacts) {
      if (
        row['space_id'] === spaceId &&
        row['artifact_type'] === artifactType &&
        row['artifact_key'] === artifactKey
      ) {
        row['artifact_id'] = artifactId;
        row['installed_content_hash'] = hash;
      }
    }
    return [];
  }
  if (text.includes('DELETE FROM store_install_artifacts')) {
    const [catalogId, spaceId, artifactType, artifactKey] = params as [
      string,
      string,
      string,
      string,
    ];
    store.artifacts = store.artifacts.filter(
      (row) =>
        !(
          row['catalog_id'] === catalogId &&
          row['space_id'] === spaceId &&
          row['artifact_type'] === artifactType &&
          row['artifact_key'] === artifactKey
        ),
    );
    return [];
  }
  if (text.includes('FROM store_install_artifacts') && !text.includes('INSERT INTO')) {
    if (text.includes('catalog_id =')) {
      const [catalogId, spaceId] = params as [string, string];
      return store.artifacts.filter(
        (row) => row['catalog_id'] === catalogId && row['space_id'] === spaceId,
      );
    }
    const [spaceId] = params as [string];
    return store.artifacts.filter((row) => row['space_id'] === spaceId);
  }
  if (text.includes('DELETE FROM store_install_claims')) {
    const [catalogId, spaceId, claimedBy] = params as [string, string, string];
    store.claims = store.claims.filter(
      (row) =>
        !(row.catalog_id === catalogId && row.space_id === spaceId && row.claimed_by === claimedBy),
    );
    return [];
  }
  if (text.includes('FROM store_install_claims') && text.includes('claimed_by =')) {
    const [claimedBy, spaceId] = params as [string, string];
    return store.claims.filter((row) => row.claimed_by === claimedBy && row.space_id === spaceId);
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
  throw new Error(`storeUpdateExecution.test: unhandled SQL: ${text}`);
}

const fakeTx = { execute: async (query: SQL) => applyExecute(query) };

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    createMemoryDocRepository: () => {
      const linkRepo = {
        replaceLinksForDoc: async () => {},
        getOutgoingLinks: async () => [] as Array<{ targetPath: string; resolved: boolean }>,
        countBacklinks: async () => 0,
      };
      const repo = {
        getByPath: async (path: string) => (store.memoryDocPaths.has(path) ? { path } : null),
        put: async (doc: { path: string; docType?: string }) => {
          store.memoryDocPaths.add(doc.path);
          store.memoryDocPuts.push(doc.path);
          // Minimal MemoryDoc shape; indexingMode 'disabled' short-circuits
          // chunk/embedding derivation so the link/property stubs suffice.
          return {
            ...doc,
            id: `doc:${doc.path}`,
            spaceId: 'space',
            docType: doc.docType ?? 'markdown',
            currentVersion: 1,
            indexingMode: 'disabled' as const,
            contentHash: null,
          };
        },
        updateDerivedFields: async () => {},
        withTransaction: async <T>(
          fn: (txRepo: unknown, txLinkRepo: unknown) => Promise<T>,
        ): Promise<T> => fn(repo, linkRepo),
      };
      return repo;
    },
    withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx),
    getTenantStoreShelfPolicy: async () => ({
      defaultAvailability: store.shelf.defaultAvailability,
      overrides: new Map(store.shelf.overrides),
    }),
  };
});

const computeInstallDivergence = vi.hoisted(() =>
  vi.fn(async (): Promise<StoreInstallDivergence> => ({ customized: false, artifacts: [] })),
);
vi.mock('./storeDivergence.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, computeInstallDivergence };
});

const updateSkillCatalogEntry = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, unknown>> => ({
    outcome: 'updated',
    skillId: 'test-skill-a',
    revision: 2,
    activationStatus: 'active',
    missingCapabilities: [] as string[],
  })),
);
vi.mock('../stagedChange/skillCatalogUpdate.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, updateSkillCatalogEntry };
});

const installSkillCatalogEntry = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, unknown>> => ({
    outcome: 'installed',
    skillId: 'test-skill-b',
    activationStatus: 'active',
    missingCapabilities: [] as string[],
  })),
);
vi.mock('../stagedChange/skillCatalogInstall.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, installSkillCatalogEntry };
});

const updateApiConnectorEntry = vi.hoisted(() => vi.fn());
const updateMcpConnectorEntry = vi.hoisted(() => vi.fn());
vi.mock('./connectorUpdate.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, updateApiConnectorEntry, updateMcpConnectorEntry };
});

const publishApiCatalogInvalidation = vi.hoisted(() => vi.fn());
const publishMcpCatalogInvalidation = vi.hoisted(() => vi.fn());
vi.mock('@aflow/redis', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, publishApiCatalogInvalidation, publishMcpCatalogInvalidation };
});

const { executeStoreUpdate } = await import('./storeUpdateExecution.js');
const { deriveInstalledState } = await import('./storeDerivations.js');
const { jsonContentHash } = await import('./artifactContent.js');

// ============================================================================
// Test harness
// ============================================================================

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TENANT_ID = 'tenant-1' as TenantId;
const IDEMPOTENCY_KEY_A = '10000000-0000-4000-8000-000000000001';

function entryAtVersion(catalogId: string, version: number): CatalogEntry {
  const entry = getCatalogEntry(catalogId);
  if (!entry) throw new Error(`fixture entry '${catalogId}' missing`);
  return { ...entry, version } as CatalogEntry;
}

function createFakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
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

function update(over: Record<string, unknown> = {}, redis: FakeRedis | null = createFakeRedis()) {
  return executeStoreUpdate({
    db: {} as never,
    redis: redis as never,
    tenantId: TENANT_ID,
    spaceId: SPACE_ID,
    actorUserId: USER_ID,
    catalogId: 'github',
    expectedVersion: 2,
    idempotencyKey: IDEMPOTENCY_KEY_A,
    mode: 'update',
    entryResolver: (catalogId) => entryAtVersion(catalogId, 2),
    ...over,
  });
}

function installedRow(catalogId: string, version: number, kind = 'skill'): InstallRow {
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
  store.memoryDocPaths = new Set();
  store.memoryDocPuts = [];
  store.shelf = { defaultAvailability: 'available', overrides: new Map() };
  vi.clearAllMocks();
  computeInstallDivergence.mockResolvedValue({ customized: false, artifacts: [] });
  installSkillCatalogEntry.mockResolvedValue({
    outcome: 'installed',
    skillId: 'test-skill-b',
    activationStatus: 'active',
    missingCapabilities: [],
  });
  updateApiConnectorEntry.mockResolvedValue({
    outcome: 'updated',
    apiId: 'github',
    bindingId: 'github-default',
    status: 'needs_credentials',
    missingVariables: [],
    missingCredentialKeys: [],
    credentialsReset: false,
    setupChecklist: [],
  });
});

// ============================================================================
// Tests
// ============================================================================

describe('executeStoreUpdate — guards', () => {
  it('fails with CATALOG_CHANGED on an expectedVersion mismatch', async () => {
    const result = await update({ expectedVersion: 3 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({
      code: 'CATALOG_CHANGED',
      expectedVersion: 3,
      currentVersion: 2,
    });
    expect(updateApiConnectorEntry).not.toHaveBeenCalled();
  });

  it('fails NOT_INSTALLED when the space has no install row', async () => {
    const result = await update({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(404);
    expect(result.body.code).toBe('NOT_INSTALLED');
  });

  it('fails ALREADY_CURRENT when the installed version matches the catalog', async () => {
    store.installs.push(installedRow('github', 2, 'connector'));
    const result = await update({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ code: 'ALREADY_CURRENT', currentVersion: 2 });
  });

  it('fails on lock contention and releases the idempotency claim', async () => {
    store.lockAcquired = false;
    store.installs.push(installedRow('github', 1, 'connector'));
    const redis = createFakeRedis();
    const result = await update({}, redis);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.body.code).toBe('STORE_MUTATION_IN_PROGRESS');
    expect(redis.data.size).toBe(0);
  });

  it('an off-shelf listing the space never installed fails 404 without disclosure', async () => {
    store.shelf.overrides.set('github', 'hidden');
    const result = await update({ expectedVersion: 9 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(404);
    expect(result.body).toEqual({ error: "Store listing 'github' not found" });
  });

  it('an installed off-shelf listing stays updatable', async () => {
    store.shelf.overrides.set('github', 'hidden');
    store.installs.push(installedRow('github', 1, 'connector'));
    const result = await update({});
    expect(result.ok).toBe(true);
  });
});

describe('executeStoreUpdate — keep mode', () => {
  it('records skippedVersion, touches no artifact, and suppresses the badge', async () => {
    store.installs.push(installedRow('github', 1, 'connector'));
    const result = await update({ mode: 'keep' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response).toMatchObject({
      mode: 'keep',
      fromVersion: 1,
      toVersion: 1,
      updatedArtifacts: [],
    });
    expect(result.response.install.skippedVersion).toBe(2);
    expect(updateApiConnectorEntry).not.toHaveBeenCalled();
    expect(computeInstallDivergence).not.toHaveBeenCalled();
    expect(store.installs[0]).toMatchObject({ installed_version: 1, skipped_version: 2 });

    expect(deriveInstalledState({ version: 2 }, result.response.install).updateAvailable).toBe(
      false,
    );
    expect(deriveInstalledState({ version: 3 }, result.response.install).updateAvailable).toBe(
      true,
    );
  });
});

describe('executeStoreUpdate — customized refusal', () => {
  const divergence: StoreInstallDivergence = {
    customized: true,
    artifacts: [{ artifactType: 'api_definition', artifactKey: 'github', state: 'modified' }],
  };

  it("refuses mode 'update' with STORE_CUSTOMIZED and the divergence detail", async () => {
    store.installs.push(installedRow('github', 1, 'connector'));
    computeInstallDivergence.mockResolvedValueOnce(divergence);
    const redis = createFakeRedis();
    const result = await update({}, redis);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ code: 'STORE_CUSTOMIZED', divergence });
    expect(updateApiConnectorEntry).not.toHaveBeenCalled();
    expect(redis.data.size).toBe(0);
  });

  it("proceeds under mode 'replace_customized'", async () => {
    store.installs.push(installedRow('github', 1, 'connector'));
    computeInstallDivergence.mockResolvedValueOnce(divergence);
    const result = await update({ mode: 'replace_customized' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.mode).toBe('replace_customized');
    expect(updateApiConnectorEntry).toHaveBeenCalledTimes(1);
  });
});

describe('executeStoreUpdate — dispatch + provenance re-stamp', () => {
  it('runs the connector update handler and re-stamps the install + artifact rows', async () => {
    store.installs.push({ ...installedRow('github', 1, 'connector'), skipped_version: 2 });
    store.artifacts.push({
      catalog_id: 'github',
      space_id: SPACE_ID,
      artifact_type: 'api_definition',
      artifact_key: 'github',
      artifact_id: 'github',
      installed_content_hash: 'old-hash',
      preservation: 'replace_on_update',
    });

    const result = await update({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response).toMatchObject({
      mode: 'update',
      fromVersion: 1,
      toVersion: 2,
      updatedArtifacts: [
        { artifactType: 'api_definition', artifactKey: 'github', action: 'replaced' },
      ],
      credentialsReset: false,
    });
    expect(updateApiConnectorEntry).toHaveBeenCalledTimes(1);

    expect(store.installs[0]).toMatchObject({
      installed_version: 2,
      skipped_version: null,
    });
    expect(result.response.install.installedAt).toBe('2020-01-01T00:00:00.000Z');
    const artifact = store.artifacts[0];
    expect(artifact?.['installed_content_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact?.['installed_content_hash']).not.toBe('old-hash');
  });

  it('replays the recorded response for a retried idempotency key without re-dispatching', async () => {
    store.installs.push(installedRow('github', 1, 'connector'));
    const redis = createFakeRedis();
    const first = await update({}, redis);
    expect(first.ok).toBe(true);
    const retry = await update({}, redis);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) throw new Error('expected success');
    expect(retry.response).toEqual(first.response);
    expect(updateApiConnectorEntry).toHaveBeenCalledTimes(1);
  });
});

describe('executeStoreUpdate — connector dispatch preserves user binding stamps', () => {
  it('re-stamps the definition artifact but never the user_data_keep binding row', async () => {
    const github = getCatalogEntry('github');
    if (!github) throw new Error('github connector missing');
    store.installs.push(installedRow('github', github.version, 'connector'));
    store.artifacts.push(
      {
        catalog_id: 'github',
        space_id: SPACE_ID,
        artifact_type: 'api_definition',
        artifact_key: 'github',
        artifact_id: 'github',
        installed_content_hash: 'old-definition-hash',
        preservation: 'replace_on_update',
      },
      {
        catalog_id: 'github',
        space_id: SPACE_ID,
        artifact_type: 'api_binding',
        artifact_key: 'github-default',
        artifact_id: 'github-default',
        installed_content_hash: 'user-binding-stamp',
        preservation: 'user_data_keep',
      },
    );
    updateApiConnectorEntry.mockResolvedValueOnce({
      outcome: 'updated',
      apiId: 'github',
      bindingId: 'github-default',
      status: 'needs_credentials',
      missingVariables: ['github-base-url'],
      missingCredentialKeys: ['github-default-token'],
      credentialsReset: true,
      setupChecklist: [
        {
          kind: 'fill_credentials',
          bindingId: 'github-default',
          slots: [],
          description: 'Add credentials for the GitHub integration.',
          required: true,
        },
      ],
    });

    const result = await update({
      catalogId: 'github',
      expectedVersion: github.version + 1,
      entryResolver: () => entryAtVersion('github', github.version + 1),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.credentialsReset).toBe(true);
    expect(result.response.missingVariables).toEqual(['github-base-url']);
    expect(result.response.setupChecklist).toHaveLength(1);
    expect(result.response.keptUserDataArtifacts).toEqual([
      { artifactType: 'api_binding', artifactKey: 'github-default' },
    ]);

    const definitionRow = store.artifacts.find((row) => row['artifact_type'] === 'api_definition');
    expect(definitionRow?.['installed_content_hash']).toMatch(/^[0-9a-f]{64}$/);
    const bindingRow = store.artifacts.find((row) => row['artifact_type'] === 'api_binding');
    expect(bindingRow?.['installed_content_hash']).toBe('user-binding-stamp');
    expect(publishApiCatalogInvalidation).toHaveBeenCalled();
  });
});

describe('executeStoreUpdate — bundle member-wise dispatch', () => {
  it('updates store-owned members and install-routes a new one, re-stamping member rows', async () => {
    store.installs.push(installedRow('test-two-skill-bundle', 1, 'bundle'));
    store.installs.push(installedRow('_test-skill-a', 1));
    updateSkillCatalogEntry.mockResolvedValueOnce({
      outcome: 'updated',
      skillId: 'test-skill-a',
      revision: 2,
      activationStatus: 'active',
      missingCapabilities: [],
    });

    const result = await update({
      catalogId: 'test-two-skill-bundle',
      entryResolver: (catalogId) =>
        catalogId === 'test-two-skill-bundle'
          ? entryAtVersion(catalogId, 2)
          : getCatalogEntry(catalogId),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(updateSkillCatalogEntry).toHaveBeenCalledTimes(1);
    expect(installSkillCatalogEntry).toHaveBeenCalledTimes(1);
    expect(result.response.updatedArtifacts).toEqual([
      { artifactType: 'skill', artifactKey: 'test-skill-a', action: 'replaced' },
      { artifactType: 'skill', artifactKey: 'test-skill-b', action: 'installed' },
    ]);

    expect(store.installs.map((row) => row.catalog_id).sort()).toEqual([
      '_test-skill-a',
      '_test-skill-b',
      'test-two-skill-bundle',
    ]);
    expect(store.claims).toContainEqual({
      catalog_id: '_test-skill-a',
      space_id: SPACE_ID,
      claimed_by: 'bundle:test-two-skill-bundle',
    });
    const bundleRow = store.installs.find((row) => row.catalog_id === 'test-two-skill-bundle');
    expect(bundleRow?.installed_version).toBe(2);
  });

  it('refuses to overwrite a user-authored same-slug skill the store never installed', async () => {
    store.installs.push(installedRow('test-two-skill-bundle', 1, 'bundle'));
    store.installs.push(installedRow('_test-skill-a', 1));
    updateSkillCatalogEntry.mockResolvedValueOnce({
      outcome: 'updated',
      skillId: 'test-skill-a',
      revision: 2,
      activationStatus: 'active',
      missingCapabilities: [],
    });
    installSkillCatalogEntry.mockResolvedValueOnce({
      outcome: 'slug_conflict',
      slug: 'test-skill-b',
      archivedAt: null,
    });

    const result = await update({
      catalogId: 'test-two-skill-bundle',
      entryResolver: (catalogId) =>
        catalogId === 'test-two-skill-bundle'
          ? entryAtVersion(catalogId, 2)
          : getCatalogEntry(catalogId),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({
      code: 'ARTIFACT_CONFLICT',
      conflictingKey: 'test-skill-b',
    });
    expect(updateSkillCatalogEntry).toHaveBeenCalledTimes(1);
  });

  it('installs a new-in-version memory seed and keeps an existing one untouched', async () => {
    const base = getCatalogEntry('test-two-skill-bundle');
    if (base?.kind !== 'bundle') throw new Error('bundle fixture missing');
    const entry = {
      ...base,
      version: 2,
      payload: {
        ...base.payload,
        memorySeed: [
          { path: '/notes/present.md', docType: 'markdown', content: '# present' },
          { path: '/notes/new.md', docType: 'markdown', content: '# new' },
        ],
      },
    } as CatalogEntry;
    store.installs.push(installedRow('test-two-skill-bundle', 1, 'bundle'));
    store.installs.push(installedRow('_test-skill-a', 1));
    store.installs.push(installedRow('_test-skill-b', 1));
    store.memoryDocPaths.add('/notes/present.md');

    const result = await update({
      catalogId: 'test-two-skill-bundle',
      entryResolver: (catalogId) =>
        catalogId === 'test-two-skill-bundle' ? entry : getCatalogEntry(catalogId),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(store.memoryDocPuts).toEqual(['/notes/new.md']);
    expect(result.response.updatedArtifacts).toContainEqual({
      artifactType: 'memory_doc',
      artifactKey: '/notes/new.md',
      action: 'installed',
    });
    expect(result.response.keptUserDataArtifacts).toEqual([
      { artifactType: 'memory_doc', artifactKey: '/notes/present.md' },
    ]);

    const newSeedRow = store.artifacts.find(
      (row) => row['artifact_type'] === 'memory_doc' && row['artifact_key'] === '/notes/new.md',
    );
    expect(newSeedRow?.['installed_content_hash']).toBe(jsonContentHash('# new'));
  });

  it('a member dropped by the new version releases its claim and provenance, artifact untouched', async () => {
    const base = getCatalogEntry('test-two-skill-bundle');
    if (base?.kind !== 'bundle') throw new Error('bundle fixture missing');
    const entry = {
      ...base,
      version: 2,
      payload: { ...base.payload, skillCatalogIds: ['_test-skill-a'] },
    } as CatalogEntry;
    store.installs.push(installedRow('test-two-skill-bundle', 1, 'bundle'));
    store.installs.push(installedRow('_test-skill-a', 1));
    store.installs.push(installedRow('_test-skill-b', 1));
    store.claims.push(
      {
        catalog_id: '_test-skill-a',
        space_id: SPACE_ID,
        claimed_by: 'bundle:test-two-skill-bundle',
      },
      {
        catalog_id: '_test-skill-b',
        space_id: SPACE_ID,
        claimed_by: 'bundle:test-two-skill-bundle',
      },
    );
    store.artifacts.push(
      {
        catalog_id: 'test-two-skill-bundle',
        space_id: SPACE_ID,
        artifact_type: 'skill',
        artifact_key: 'test-skill-a',
        artifact_id: 'test-skill-a',
        installed_content_hash: 'old-hash',
        preservation: 'replace_on_update',
      },
      {
        catalog_id: 'test-two-skill-bundle',
        space_id: SPACE_ID,
        artifact_type: 'skill',
        artifact_key: 'test-skill-b',
        artifact_id: 'test-skill-b',
        installed_content_hash: 'old-hash',
        preservation: 'replace_on_update',
      },
      {
        catalog_id: '_test-skill-b',
        space_id: SPACE_ID,
        artifact_type: 'skill',
        artifact_key: 'test-skill-b',
        artifact_id: 'test-skill-b',
        installed_content_hash: 'old-hash',
        preservation: 'replace_on_update',
      },
    );

    const result = await update({
      catalogId: 'test-two-skill-bundle',
      entryResolver: (catalogId) =>
        catalogId === 'test-two-skill-bundle' ? entry : getCatalogEntry(catalogId),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.response.orphanedArtifacts).toEqual([
      { artifactType: 'skill', artifactKey: 'test-skill-b' },
    ]);
    expect(store.claims).not.toContainEqual({
      catalog_id: '_test-skill-b',
      space_id: SPACE_ID,
      claimed_by: 'bundle:test-two-skill-bundle',
    });
    expect(
      store.artifacts.some(
        (row) =>
          row['catalog_id'] === 'test-two-skill-bundle' && row['artifact_key'] === 'test-skill-b',
      ),
    ).toBe(false);
    // The dropped member's own provenance and space artifact stay.
    expect(
      store.artifacts.some(
        (row) => row['catalog_id'] === '_test-skill-b' && row['artifact_key'] === 'test-skill-b',
      ),
    ).toBe(true);
    expect(updateSkillCatalogEntry).toHaveBeenCalledTimes(1);
  });
});

describe('executeStoreUpdate — cross-claimant re-stamp', () => {
  it('a bundle update re-stamps every row sharing a member artifact key', async () => {
    store.installs.push(installedRow('test-two-skill-bundle', 1, 'bundle'));
    store.installs.push(installedRow('_test-skill-a', 1));
    store.installs.push(installedRow('_test-skill-b', 1));
    store.artifacts.push(
      {
        catalog_id: '_test-skill-a',
        space_id: SPACE_ID,
        artifact_type: 'skill',
        artifact_key: 'test-skill-a',
        artifact_id: 'test-skill-a',
        installed_content_hash: 'old-hash',
        preservation: 'replace_on_update',
      },
      {
        catalog_id: 'test-two-skill-bundle',
        space_id: SPACE_ID,
        artifact_type: 'skill',
        artifact_key: 'test-skill-a',
        artifact_id: 'test-skill-a',
        installed_content_hash: 'old-hash',
        preservation: 'replace_on_update',
      },
    );

    const result = await update({
      catalogId: 'test-two-skill-bundle',
      entryResolver: (catalogId) => entryAtVersion(catalogId, 2),
    });
    expect(result.ok).toBe(true);
    const memberRows = store.artifacts.filter((row) => row['artifact_key'] === 'test-skill-a');
    const hashes = memberRows.map((row) => row['installed_content_hash']);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[1]).toBe(hashes[0]);
  });
});
