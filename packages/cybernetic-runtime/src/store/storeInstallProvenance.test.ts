/**
 * Provenance writes run for real against an in-memory SQL dispatcher
 * (PgDialect.sqlToQuery) so the tests pin the persisted rows and the
 * conflict semantics: 'replace' owns the row but preserves first-install
 * identity, 'keep' never overwrites, claims accumulate without duplicates.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { StoreInstall, StoreInstallArtifact, StoreInstallClaim } from '@aflow/schemas';
import {
  getStoreInstall,
  listStoreInstalls,
  listStoreInstallArtifacts,
  listStoreInstallClaims,
  upsertStoreInstall,
  upsertStoreInstallArtifact,
  upsertStoreInstallClaim,
} from './storeInstallProvenance.js';
import {
  storeMutationLockKey,
  tryAcquireStoreMutationLock,
} from '../stagedChange/storeMutationLock.js';

interface InstallRow {
  catalog_id: string;
  space_id: string;
  kind: string;
  installed_version: number;
  installed_content_hash: string;
  skipped_version: number | null;
  state: string;
  host_manifest_json: unknown;
  installed_at: string;
  installed_by: string;
  updated_at: string;
  updated_by: string;
}

interface ArtifactRow {
  catalog_id: string;
  space_id: string;
  artifact_type: string;
  artifact_key: string;
  artifact_id: string;
  installed_content_hash: string;
  preservation: string;
}

interface ClaimRow {
  catalog_id: string;
  space_id: string;
  claimed_by: string;
}

const store = {
  installs: [] as InstallRow[],
  artifacts: [] as ArtifactRow[],
  claims: [] as ClaimRow[],
  lockAcquired: true,
  lockKeys: [] as string[],
};

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('pg_try_advisory_xact_lock')) {
    store.lockKeys.push(params[0] as string);
    return [{ acquired: store.lockAcquired }];
  }
  if (text.includes('INSERT INTO store_installs')) {
    const [
      catalogId,
      spaceId,
      kind,
      installedVersion,
      installedContentHash,
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
        existing.kind = kind;
        existing.installed_version = installedVersion;
        existing.installed_content_hash = installedContentHash;
        existing.skipped_version = null;
        existing.state = state;
        existing.host_manifest_json = hostManifest;
        existing.updated_at = updatedAt;
        existing.updated_by = updatedBy;
      }
      return [];
    }
    store.installs.push({
      catalog_id: catalogId,
      space_id: spaceId,
      kind,
      installed_version: installedVersion,
      installed_content_hash: installedContentHash,
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
  if (text.includes('JOIN store_installs')) {
    const spaceId = params[0] as string;
    const refPairs: Array<[string, string]> = [];
    for (let i = 1; i + 1 <= params.length; i += 2) {
      refPairs.push([params[i] as string, params[i + 1] as string]);
    }
    const integrationTypes = ['api_definition', 'api_binding', 'mcp_definition', 'mcp_binding'];
    return store.artifacts
      .filter((artifact) => artifact.space_id === spaceId)
      .filter((artifact) =>
        refPairs.length === 0
          ? integrationTypes.includes(artifact.artifact_type)
          : refPairs.some(
              ([type, key]) => artifact.artifact_type === type && artifact.artifact_key === key,
            ),
      )
      .flatMap((artifact) => {
        const owner = store.installs.find(
          (row) => row.catalog_id === artifact.catalog_id && row.space_id === artifact.space_id,
        );
        if (!owner || owner.host_manifest_json === null) return [];
        return [
          {
            artifact_type: artifact.artifact_type,
            artifact_key: artifact.artifact_key,
            host_manifest_json: owner.host_manifest_json,
          },
        ];
      });
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
      params as [string, string, string, string, string, string, string];
    const existing = store.artifacts.find(
      (row) =>
        row.catalog_id === catalogId &&
        row.space_id === spaceId &&
        row.artifact_type === artifactType &&
        row.artifact_key === artifactKey,
    );
    if (existing) {
      if (text.includes('DO UPDATE')) {
        existing.artifact_id = artifactId;
        existing.installed_content_hash = hash;
        existing.preservation = preservation;
      }
      return [];
    }
    store.artifacts.push({
      catalog_id: catalogId,
      space_id: spaceId,
      artifact_type: artifactType,
      artifact_key: artifactKey,
      artifact_id: artifactId,
      installed_content_hash: hash,
      preservation,
    });
    return [];
  }
  if (text.includes('FROM store_install_artifacts')) {
    const [catalogId, spaceId] = params as [string, string];
    return store.artifacts.filter(
      (row) => row.catalog_id === catalogId && row.space_id === spaceId,
    );
  }
  if (text.includes('INSERT INTO store_install_claims')) {
    const [catalogId, spaceId, claimedBy] = params as [string, string, string];
    const exists = store.claims.some(
      (row) =>
        row.catalog_id === catalogId && row.space_id === spaceId && row.claimed_by === claimedBy,
    );
    if (!exists) {
      store.claims.push({ catalog_id: catalogId, space_id: spaceId, claimed_by: claimedBy });
    }
    return [];
  }
  if (text.includes('FROM store_install_claims')) {
    const [catalogId, spaceId] = params as [string, string];
    return store.claims.filter((row) => row.catalog_id === catalogId && row.space_id === spaceId);
  }
  throw new Error(`storeInstallProvenance.test: unhandled SQL: ${text}`);
}

const fakeTx = {
  execute: async (query: SQL) => applyExecute(query),
} as unknown as PostgresJsDatabase;

const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const USER_A = '00000000-0000-4000-8000-0000000000aa';
const USER_B = '00000000-0000-4000-8000-0000000000bb';

function install(over: Partial<StoreInstall> = {}): StoreInstall {
  return {
    spaceId: SPACE_ID,
    catalogId: 'test-listing',
    kind: 'skill',
    installedVersion: 1,
    installedContentHash: 'hash-v1',
    state: 'installed',
    installedAt: '2020-01-01T00:00:00.000Z',
    installedBy: USER_A,
    updatedAt: '2020-01-01T00:00:00.000Z',
    updatedBy: USER_A,
    ...over,
  };
}

beforeEach(() => {
  store.installs = [];
  store.artifacts = [];
  store.claims = [];
  store.lockAcquired = true;
  store.lockKeys = [];
});

describe('upsertStoreInstall', () => {
  it('inserts a fresh row and reads it back with camelCase ISO fields', async () => {
    await upsertStoreInstall(fakeTx, install(), { onConflict: 'replace' });
    const row = await getStoreInstall(fakeTx, SPACE_ID, 'test-listing');
    expect(row).toEqual(install());
  });

  it("'replace' moves version/hash/updatedBy but preserves first-install identity", async () => {
    await upsertStoreInstall(fakeTx, install(), { onConflict: 'replace' });
    await upsertStoreInstall(
      fakeTx,
      install({
        installedVersion: 2,
        installedContentHash: 'hash-v2',
        installedAt: '2021-01-01T00:00:00.000Z',
        installedBy: USER_B,
        updatedAt: '2021-01-01T00:00:00.000Z',
        updatedBy: USER_B,
      }),
      { onConflict: 'replace' },
    );
    const row = await getStoreInstall(fakeTx, SPACE_ID, 'test-listing');
    expect(row?.installedVersion).toBe(2);
    expect(row?.installedContentHash).toBe('hash-v2');
    expect(row?.updatedBy).toBe(USER_B);
    expect(row?.installedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(row?.installedBy).toBe(USER_A);
    expect(row?.skippedVersion).toBeUndefined();
  });

  it("'keep' never overwrites an existing row", async () => {
    await upsertStoreInstall(fakeTx, install(), { onConflict: 'replace' });
    await upsertStoreInstall(fakeTx, install({ installedVersion: 9 }), { onConflict: 'keep' });
    const row = await getStoreInstall(fakeTx, SPACE_ID, 'test-listing');
    expect(row?.installedVersion).toBe(1);
  });

  it('listStoreInstalls returns every row for the space', async () => {
    await upsertStoreInstall(fakeTx, install(), { onConflict: 'replace' });
    await upsertStoreInstall(fakeTx, install({ catalogId: 'other-listing', kind: 'bundle' }), {
      onConflict: 'replace',
    });
    const rows = await listStoreInstalls(fakeTx, SPACE_ID);
    expect(rows.map((row) => row.catalogId).sort()).toEqual(['other-listing', 'test-listing']);
  });
});

describe('upsertStoreInstallArtifact', () => {
  const artifact: StoreInstallArtifact = {
    spaceId: SPACE_ID,
    catalogId: 'test-listing',
    artifactType: 'skill',
    artifactKey: 'test-skill',
    artifactId: 'test-skill',
    installedContentHash: 'hash-v1',
    preservation: 'replace_on_update',
  };

  it("'replace' inserts and updates on the composite key", async () => {
    await upsertStoreInstallArtifact(fakeTx, artifact, { onConflict: 'replace' });
    await upsertStoreInstallArtifact(
      fakeTx,
      { ...artifact, installedContentHash: 'hash-v2' },
      { onConflict: 'replace' },
    );
    const rows = await listStoreInstallArtifacts(fakeTx, SPACE_ID, 'test-listing');
    expect(rows).toEqual([{ ...artifact, installedContentHash: 'hash-v2' }]);
  });

  it("'keep' inserts if absent but never overwrites an existing stamp", async () => {
    await upsertStoreInstallArtifact(fakeTx, artifact, { onConflict: 'keep' });
    await upsertStoreInstallArtifact(
      fakeTx,
      { ...artifact, installedContentHash: 'hash-v2' },
      { onConflict: 'keep' },
    );
    const rows = await listStoreInstallArtifacts(fakeTx, SPACE_ID, 'test-listing');
    expect(rows).toEqual([artifact]);
  });
});

describe('upsertStoreInstallClaim', () => {
  it('accumulates distinct claimants without duplicates', async () => {
    const direct: StoreInstallClaim = {
      spaceId: SPACE_ID,
      catalogId: 'test-listing',
      claimedBy: 'direct',
    };
    const viaBundle: StoreInstallClaim = {
      spaceId: SPACE_ID,
      catalogId: 'test-listing',
      claimedBy: 'bundle:test-bundle',
    };
    await upsertStoreInstallClaim(fakeTx, direct);
    await upsertStoreInstallClaim(fakeTx, direct);
    await upsertStoreInstallClaim(fakeTx, viaBundle);
    const rows = await listStoreInstallClaims(fakeTx, SPACE_ID, 'test-listing');
    expect(rows.map((row) => row.claimedBy).sort()).toEqual(['bundle:test-bundle', 'direct']);
  });
});

describe('captured host manifest', () => {
  const MANIFEST = {
    apiHosts: ['api.github.com'],
    oauthHosts: ['github.com'],
    mcpHosts: [],
    redirectHosts: ['objects.githubusercontent.com'],
  };

  async function installGithubConnector(): Promise<void> {
    await upsertStoreInstall(
      fakeTx,
      install({ catalogId: 'github', kind: 'connector', hostManifest: MANIFEST }),
      { onConflict: 'replace' },
    );
    await upsertStoreInstallArtifact(
      fakeTx,
      {
        spaceId: SPACE_ID,
        catalogId: 'github',
        artifactType: 'api_definition',
        artifactKey: 'github',
        artifactId: 'github',
        installedContentHash: 'hash',
        preservation: 'replace_on_update',
      },
      { onConflict: 'replace' },
    );
    await upsertStoreInstallArtifact(
      fakeTx,
      {
        spaceId: SPACE_ID,
        catalogId: 'github',
        artifactType: 'api_binding',
        artifactKey: 'github-default',
        artifactId: 'github-default',
        installedContentHash: 'hash',
        preservation: 'user_data_keep',
      },
      { onConflict: 'replace' },
    );
  }

  it('captures the host manifest at install and reads it back', async () => {
    await installGithubConnector();
    const row = await getStoreInstall(fakeTx, SPACE_ID, 'github');
    expect(row?.hostManifest).toEqual(MANIFEST);
  });

  it('reads back a row that captured no manifest without one', async () => {
    await upsertStoreInstall(fakeTx, install({ catalogId: 'legacy', kind: 'connector' }), {
      onConflict: 'replace',
    });
    const row = await getStoreInstall(fakeTx, SPACE_ID, 'legacy');
    expect(row?.hostManifest).toBeUndefined();
  });
});

describe('tryAcquireStoreMutationLock', () => {
  it('acquires on the shared store-mutation key for the space', async () => {
    await expect(tryAcquireStoreMutationLock(fakeTx, SPACE_ID)).resolves.toBe(true);
    expect(store.lockKeys).toEqual([storeMutationLockKey(SPACE_ID)]);
    expect(storeMutationLockKey(SPACE_ID)).toBe(`store-mutation:${SPACE_ID}`);
  });

  it('reports contention without throwing', async () => {
    store.lockAcquired = false;
    await expect(tryAcquireStoreMutationLock(fakeTx, SPACE_ID)).resolves.toBe(false);
  });
});
