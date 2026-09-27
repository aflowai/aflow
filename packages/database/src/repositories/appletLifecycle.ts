/**
 * Live-instance protection for artifact removal flows. Both helpers run
 * inside the caller's tenant-schema transaction so a removal composes them
 * atomically with its own writes: count to refuse, or archive to proceed.
 *
 * Hard removal of a version row is additionally blocked at the database —
 * `applet_instances.artifact_version_id` references `ui_artifact_versions(id)`
 * with no cascade, so a version any instance pins cannot be deleted out from
 * under it.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { appletInstances, uiArtifactVersions } from '../schema/tenant.js';

export interface ArchivedAppletInstanceRef {
  instanceId: string;
  /** For per-space cache invalidation (attention generation) after commit. */
  spaceId: string;
}

function artifactVersionIdsOf(tx: PostgresJsDatabase, artifactId: string) {
  return tx
    .select({ id: uiArtifactVersions.id })
    .from(uiArtifactVersions)
    .where(eq(uiArtifactVersions.artifactId, artifactId));
}

/** Active instances pinned to any version of this artifact — the removal blocker count. */
export async function countActiveAppletInstancesForArtifact(
  tx: PostgresJsDatabase,
  artifactId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(appletInstances)
    .where(
      and(
        eq(appletInstances.status, 'active'),
        inArray(appletInstances.artifactVersionId, artifactVersionIdsOf(tx, artifactId)),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Archive every active instance pinned to any version of this artifact —
 * the "or archived" arm of uninstall protection. Archived instances stay
 * readable; the command gateway refuses actions on them and attention lists
 * active instances only. Ended instances are already terminal and untouched.
 */
export async function archiveActiveAppletInstancesForArtifact(
  tx: PostgresJsDatabase,
  artifactId: string,
): Promise<ArchivedAppletInstanceRef[]> {
  const rows = await tx
    .update(appletInstances)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(
      and(
        eq(appletInstances.status, 'active'),
        inArray(appletInstances.artifactVersionId, artifactVersionIdsOf(tx, artifactId)),
      ),
    )
    .returning({ instanceId: appletInstances.id, spaceId: appletInstances.spaceId });
  return rows;
}
