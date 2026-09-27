/**
 * Store install provenance — the per-space record of what a catalog install
 * created; the one authority the Store's installed/update badges and later
 * update/uninstall read. Raw tenant-schema SQL, matching the bundle-install
 * write helpers; every call runs inside a `withTenantSchema` transaction.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  HostManifestSchema,
  type StoreInstall,
  type StoreInstallArtifact,
  type StoreInstallClaim,
} from '@aflow/schemas';

interface StoreInstallRow {
  catalog_id: string;
  space_id: string;
  kind: string;
  installed_version: number;
  installed_content_hash: string;
  skipped_version: number | null;
  state: string;
  host_manifest_json: unknown;
  installed_at: string | Date;
  installed_by: string;
  updated_at: string | Date;
  updated_by: string;
}

interface StoreInstallArtifactRow {
  catalog_id: string;
  space_id: string;
  artifact_type: string;
  artifact_key: string;
  artifact_id: string;
  installed_content_hash: string;
  preservation: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapInstallRow(row: StoreInstallRow): StoreInstall {
  const parsedManifest =
    row.host_manifest_json === null || row.host_manifest_json === undefined
      ? null
      : HostManifestSchema.safeParse(row.host_manifest_json);
  const hostManifest = parsedManifest?.success === true ? parsedManifest.data : undefined;
  return {
    spaceId: row.space_id,
    catalogId: row.catalog_id,
    kind: row.kind as StoreInstall['kind'],
    installedVersion: row.installed_version,
    installedContentHash: row.installed_content_hash,
    ...(row.skipped_version !== null ? { skippedVersion: row.skipped_version } : {}),
    state: row.state as StoreInstall['state'],
    ...(hostManifest !== undefined ? { hostManifest } : {}),
    installedAt: toIso(row.installed_at),
    installedBy: row.installed_by,
    updatedAt: toIso(row.updated_at),
    updatedBy: row.updated_by,
  };
}

function mapArtifactRow(row: StoreInstallArtifactRow): StoreInstallArtifact {
  return {
    spaceId: row.space_id,
    catalogId: row.catalog_id,
    artifactType: row.artifact_type as StoreInstallArtifact['artifactType'],
    artifactKey: row.artifact_key,
    artifactId: row.artifact_id,
    installedContentHash: row.installed_content_hash,
    preservation: row.preservation as StoreInstallArtifact['preservation'],
  };
}

/**
 * - `replace` — a fresh install (or reinstall) owns the row: version, hash,
 *   state, and updated-by move; `skipped_version` resets (a new install
 *   supersedes a prior "Keep mine"); `installed_at`/`installed_by` keep the
 *   first install's values.
 * - `keep` — record provenance only if none exists (bundle members that were
 *   already present keep whatever their row says).
 */
export async function upsertStoreInstall(
  tx: PostgresJsDatabase,
  install: StoreInstall,
  opts: { onConflict: 'replace' | 'keep' },
): Promise<void> {
  const conflictClause =
    opts.onConflict === 'replace'
      ? sql`ON CONFLICT (catalog_id, space_id) DO UPDATE SET
          kind = EXCLUDED.kind,
          installed_version = EXCLUDED.installed_version,
          installed_content_hash = EXCLUDED.installed_content_hash,
          skipped_version = NULL,
          state = EXCLUDED.state,
          host_manifest_json = EXCLUDED.host_manifest_json,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by`
      : sql`ON CONFLICT (catalog_id, space_id) DO NOTHING`;
  const hostManifestJson =
    install.hostManifest === undefined ? null : JSON.stringify(install.hostManifest);
  await tx.execute(sql`
    INSERT INTO store_installs (
      catalog_id, space_id, kind, installed_version, installed_content_hash,
      state, host_manifest_json, installed_at, installed_by, updated_at, updated_by
    ) VALUES (
      ${install.catalogId}, ${install.spaceId}::uuid, ${install.kind},
      ${install.installedVersion}, ${install.installedContentHash},
      ${install.state}, ${hostManifestJson}::jsonb,
      ${install.installedAt}::timestamptz, ${install.installedBy}::uuid,
      ${install.updatedAt}::timestamptz, ${install.updatedBy}::uuid
    )
    ${conflictClause}
  `);
}

/** "Keep mine": suppress the update badge until the catalog moves past `skippedVersion`. */
export async function setStoreInstallSkippedVersion(
  tx: PostgresJsDatabase,
  spaceId: string,
  catalogId: string,
  skippedVersion: number,
  actor: { updatedAt: string; updatedBy: string },
): Promise<void> {
  await tx.execute(sql`
    UPDATE store_installs SET
      skipped_version = ${skippedVersion},
      updated_at = ${actor.updatedAt}::timestamptz,
      updated_by = ${actor.updatedBy}::uuid
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid
  `);
}

export async function getStoreInstall(
  tx: PostgresJsDatabase,
  spaceId: string,
  catalogId: string,
): Promise<StoreInstall | null> {
  const rows = (await tx.execute(sql`
    SELECT catalog_id, space_id, kind, installed_version, installed_content_hash,
           skipped_version, state, host_manifest_json, installed_at, installed_by,
           updated_at, updated_by
    FROM store_installs
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid
    LIMIT 1
  `)) as unknown as StoreInstallRow[];
  const row = rows[0];
  return row === undefined ? null : mapInstallRow(row);
}

export async function listStoreInstalls(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<StoreInstall[]> {
  const rows = (await tx.execute(sql`
    SELECT catalog_id, space_id, kind, installed_version, installed_content_hash,
           skipped_version, state, host_manifest_json, installed_at, installed_by,
           updated_at, updated_by
    FROM store_installs
    WHERE space_id = ${spaceId}::uuid
  `)) as unknown as StoreInstallRow[];
  return rows.map(mapInstallRow);
}

/**
 * - `replace` — the install actually wrote this artifact: re-stamp id, hash,
 *   and preservation.
 * - `keep` — the backend skipped this artifact (already present): record
 *   provenance only if none exists, never overwrite what an earlier install
 *   stamped.
 */
export async function upsertStoreInstallArtifact(
  tx: PostgresJsDatabase,
  artifact: StoreInstallArtifact,
  opts: { onConflict: 'replace' | 'keep' },
): Promise<void> {
  const conflictClause =
    opts.onConflict === 'replace'
      ? sql`ON CONFLICT (catalog_id, space_id, artifact_type, artifact_key) DO UPDATE SET
          artifact_id = EXCLUDED.artifact_id,
          installed_content_hash = EXCLUDED.installed_content_hash,
          preservation = EXCLUDED.preservation`
      : sql`ON CONFLICT (catalog_id, space_id, artifact_type, artifact_key) DO NOTHING`;
  await tx.execute(sql`
    INSERT INTO store_install_artifacts (
      catalog_id, space_id, artifact_type, artifact_key, artifact_id,
      installed_content_hash, preservation
    ) VALUES (
      ${artifact.catalogId}, ${artifact.spaceId}::uuid, ${artifact.artifactType},
      ${artifact.artifactKey}, ${artifact.artifactId},
      ${artifact.installedContentHash}, ${artifact.preservation}
    )
    ${conflictClause}
  `);
}

export async function listStoreInstallArtifacts(
  tx: PostgresJsDatabase,
  spaceId: string,
  catalogId: string,
): Promise<StoreInstallArtifact[]> {
  const rows = (await tx.execute(sql`
    SELECT catalog_id, space_id, artifact_type, artifact_key, artifact_id,
           installed_content_hash, preservation
    FROM store_install_artifacts
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid
  `)) as unknown as StoreInstallArtifactRow[];
  return rows.map(mapArtifactRow);
}

export async function listStoreInstallArtifactsBySpace(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<StoreInstallArtifact[]> {
  const rows = (await tx.execute(sql`
    SELECT catalog_id, space_id, artifact_type, artifact_key, artifact_id,
           installed_content_hash, preservation
    FROM store_install_artifacts
    WHERE space_id = ${spaceId}::uuid
  `)) as unknown as StoreInstallArtifactRow[];
  return rows.map(mapArtifactRow);
}

/**
 * After a replace_on_update artifact write, every claimant's row sharing
 * (space, type, key) moves to the new stamp — a shared member updated under
 * one listing must not read as "Changed by you" under another.
 */
export async function restampStoreInstallArtifactHash(
  tx: PostgresJsDatabase,
  spaceId: string,
  artifact: Pick<
    StoreInstallArtifact,
    'artifactType' | 'artifactKey' | 'artifactId' | 'installedContentHash'
  >,
): Promise<void> {
  await tx.execute(sql`
    UPDATE store_install_artifacts SET
      artifact_id = ${artifact.artifactId},
      installed_content_hash = ${artifact.installedContentHash}
    WHERE space_id = ${spaceId}::uuid
      AND artifact_type = ${artifact.artifactType}
      AND artifact_key = ${artifact.artifactKey}
  `);
}

export async function deleteStoreInstallArtifact(
  tx: PostgresJsDatabase,
  spaceId: string,
  catalogId: string,
  artifactType: string,
  artifactKey: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM store_install_artifacts
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid
      AND artifact_type = ${artifactType} AND artifact_key = ${artifactKey}
  `);
}

export async function upsertStoreInstallClaim(
  tx: PostgresJsDatabase,
  claim: StoreInstallClaim,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO store_install_claims (catalog_id, space_id, claimed_by)
    VALUES (${claim.catalogId}, ${claim.spaceId}::uuid, ${claim.claimedBy})
    ON CONFLICT (catalog_id, space_id, claimed_by) DO NOTHING
  `);
}

export async function listStoreInstallClaims(
  tx: PostgresJsDatabase,
  spaceId: string,
  catalogId: string,
): Promise<StoreInstallClaim[]> {
  const rows = (await tx.execute(sql`
    SELECT catalog_id, space_id, claimed_by
    FROM store_install_claims
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid
  `)) as unknown as Array<{ catalog_id: string; space_id: string; claimed_by: string }>;
  return rows.map((row) => ({
    spaceId: row.space_id,
    catalogId: row.catalog_id,
    claimedBy: row.claimed_by,
  }));
}

/** Every entry a claimant holds a claim on — bundle uninstall's member enumeration. */
export async function listStoreInstallClaimsByClaimant(
  tx: PostgresJsDatabase,
  spaceId: string,
  claimedBy: string,
): Promise<StoreInstallClaim[]> {
  const rows = (await tx.execute(sql`
    SELECT catalog_id, space_id, claimed_by
    FROM store_install_claims
    WHERE claimed_by = ${claimedBy} AND space_id = ${spaceId}::uuid
  `)) as unknown as Array<{ catalog_id: string; space_id: string; claimed_by: string }>;
  return rows.map((row) => ({
    spaceId: row.space_id,
    catalogId: row.catalog_id,
    claimedBy: row.claimed_by,
  }));
}

export async function deleteStoreInstallClaim(
  tx: PostgresJsDatabase,
  spaceId: string,
  catalogId: string,
  claimedBy: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM store_install_claims
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid AND claimed_by = ${claimedBy}
  `);
}

/** Remove an installation's full provenance — the last claim takes the rows with it. */
export async function deleteStoreInstallRecords(
  tx: PostgresJsDatabase,
  spaceId: string,
  catalogId: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM store_install_claims
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid
  `);
  await tx.execute(sql`
    DELETE FROM store_install_artifacts
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid
  `);
  await tx.execute(sql`
    DELETE FROM store_installs
    WHERE catalog_id = ${catalogId} AND space_id = ${spaceId}::uuid
  `);
}
