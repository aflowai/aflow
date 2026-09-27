import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { InstalledAppletDefinitionRow } from '@aflow/schemas';
import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import { appletInstances, uiArtifacts, uiArtifactVersions } from '../schema/tenant.js';

/**
 * Installed applet definitions in a space: every non-deleted artifact head
 * whose CURRENT version carries an applet definition, with the count of
 * active instances pinned to any version of that artifact. Most recently
 * updated first.
 */
export async function listInstalledAppletDefinitions(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
  spaceId: string,
): Promise<InstalledAppletDefinitionRow[]> {
  return withTenantSchema(db, tenantContext, async (tx) => {
    const [headRows, countRows] = await Promise.all([
      tx
        .select({
          artifactId: uiArtifacts.id,
          headName: uiArtifacts.name,
          // Summary fields only — the full definition jsonb can be large and
          // this runs at turn assembly on every cache miss.
          appletKey: sql<string | null>`${uiArtifactVersions.appletDefinition}->>'appletKey'`,
          name: sql<string | null>`${uiArtifactVersions.appletDefinition}->>'name'`,
          description: sql<string | null>`${uiArtifactVersions.appletDefinition}->>'description'`,
          semanticDescription: sql<
            string | null
          >`${uiArtifactVersions.appletDefinition}->>'semanticDescription'`,
        })
        .from(uiArtifacts)
        .innerJoin(
          uiArtifactVersions,
          and(
            eq(uiArtifactVersions.artifactId, uiArtifacts.id),
            eq(uiArtifactVersions.version, uiArtifacts.currentVersion),
          ),
        )
        .where(
          and(
            eq(uiArtifacts.spaceId, spaceId),
            isNull(uiArtifacts.deletedAt),
            isNotNull(uiArtifactVersions.appletDefinition),
          ),
        )
        .orderBy(desc(uiArtifacts.updatedAt), desc(uiArtifacts.id))
        // Bounded well above the context cap (10) — a space with hundreds of
        // applet artifacts must not pay for them all at turn assembly.
        .limit(50),
      tx
        .select({
          artifactId: uiArtifactVersions.artifactId,
          liveInstances: sql<number>`count(*)::int`,
        })
        .from(appletInstances)
        .innerJoin(uiArtifactVersions, eq(appletInstances.artifactVersionId, uiArtifactVersions.id))
        .where(and(eq(appletInstances.spaceId, spaceId), eq(appletInstances.status, 'active')))
        .groupBy(uiArtifactVersions.artifactId),
    ]);
    const counts = new Map(countRows.map((row) => [row.artifactId, row.liveInstances]));
    return headRows.map((row) => ({
      artifactId: row.artifactId,
      headName: row.headName,
      appletKey: row.appletKey,
      name: row.name,
      description: row.description,
      semanticDescription: row.semanticDescription,
      liveInstances: counts.get(row.artifactId) ?? 0,
    }));
  });
}
