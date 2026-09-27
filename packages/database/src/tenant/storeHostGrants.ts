/**
 * Captured-at-install host grants: the one SQL authority joining
 * store_install_artifacts to store_installs.host_manifest_json. Callers run it
 * inside a `withTenantSchema` transaction (raw tenant-schema SQL, matching the
 * store provenance service).
 */
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { HostManifestSchema, type HostManifest } from '@aflow/schemas';

export type CatalogGrantArtifactType =
  'api_definition' | 'api_binding' | 'mcp_definition' | 'mcp_binding';

export interface CatalogGrantArtifactRef {
  artifactType: CatalogGrantArtifactType;
  artifactKey: string;
}

export interface CatalogHostGrant extends CatalogGrantArtifactRef {
  hostManifest: HostManifest;
}

interface GrantRow {
  artifact_type: string;
  artifact_key: string;
  host_manifest_json: unknown;
}

function parseGrantRows(rows: GrantRow[]): CatalogHostGrant[] {
  const grants: CatalogHostGrant[] = [];
  for (const row of rows) {
    const parsed = HostManifestSchema.safeParse(row.host_manifest_json);
    if (!parsed.success) continue;
    grants.push({
      artifactType: row.artifact_type as CatalogGrantArtifactType,
      artifactKey: row.artifact_key,
      hostManifest: parsed.data,
    });
  }
  return grants;
}

export async function listCatalogHostGrants(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<CatalogHostGrant[]> {
  const rows = (await tx.execute(sql`
    SELECT sia.artifact_type, sia.artifact_key, si.host_manifest_json
    FROM store_install_artifacts sia
    JOIN store_installs si
      ON si.catalog_id = sia.catalog_id AND si.space_id = sia.space_id
    WHERE sia.space_id = ${spaceId}::uuid
      AND sia.artifact_type IN ('api_definition', 'api_binding', 'mcp_definition', 'mcp_binding')
      AND si.host_manifest_json IS NOT NULL
  `)) as unknown as GrantRow[];
  return parseGrantRows(rows);
}

export async function getCatalogHostGrants(
  tx: PostgresJsDatabase,
  spaceId: string,
  refs: readonly CatalogGrantArtifactRef[],
): Promise<CatalogHostGrant[]> {
  if (refs.length === 0) return [];
  const conditions = refs.map(
    (ref) =>
      sql`(sia.artifact_type = ${ref.artifactType} AND sia.artifact_key = ${ref.artifactKey})`,
  );
  const rows = (await tx.execute(sql`
    SELECT sia.artifact_type, sia.artifact_key, si.host_manifest_json
    FROM store_install_artifacts sia
    JOIN store_installs si
      ON si.catalog_id = sia.catalog_id AND si.space_id = sia.space_id
    WHERE sia.space_id = ${spaceId}::uuid
      AND si.host_manifest_json IS NOT NULL
      AND (${sql.join(conditions, sql` OR `)})
  `)) as unknown as GrantRow[];
  return parseGrantRows(rows);
}
