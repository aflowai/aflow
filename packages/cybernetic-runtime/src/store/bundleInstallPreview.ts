/**
 * The install preview of one bundle against one space: what stands in the
 * install's way, and which capabilities its skills need that the space lacks.
 * The space-scoped Store preview reads it for a bundle listing, and a quick
 * start's preview reads it for each bundle the template applies (Plan 330 D1).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import type { CatalogBundleEntry, StoreInstallConflict, TenantId } from '@aflow/schemas';
import { getSkillBundleEntry, getSkillCatalogEntry } from '@aflow/platform-artifacts';
import { checkMissingCapabilities } from '../skillProjectionReconciler.js';
import { validateBundleInstallPreconditions } from '../stagedChange/bundleInstallValidator.js';
import { deriveRequiredCapabilities } from '../stagedChange/skillComposeApply.js';

export interface BundleInstallPreview {
  conflicts: StoreInstallConflict[];
  missingCapabilities: string[];
}

export async function previewBundleInstall(
  tx: PostgresJsDatabase,
  entry: CatalogBundleEntry,
  ids: { tenantId: TenantId; spaceId: string },
  opts: { prerequisitesInstalledFirst?: ReadonlySet<string> } = {},
): Promise<BundleInstallPreview> {
  const repo = createMemoryDocRepository(tx, createTenantContext(ids.tenantId), {
    inTransaction: true,
  });
  const validation = await validateBundleInstallPreconditions({
    bundle: entry.payload,
    spaceId: ids.spaceId,
    tx,
    resolveBundle: (bundleId) => getSkillBundleEntry(bundleId) ?? null,
    checkSkillInstalled: async (skillCatalogId) => {
      const member = getSkillCatalogEntry(skillCatalogId);
      if (!member) return false;
      const doc = await repo.getByPath(
        `/workflows/${member.bundle.workflow.slug}/workflow.json`,
        ids.spaceId,
      );
      return doc !== null;
    },
    ...(opts.prerequisitesInstalledFirst
      ? { prerequisitesInstalledFirst: opts.prerequisitesInstalledFirst }
      : {}),
  });
  const conflicts: StoreInstallConflict[] = validation.ok
    ? []
    : validation.errors.map((reason) => ({
        artifactType: 'skill',
        artifactKey: entry.catalogId,
        reason: reason.slice(0, 500),
      }));
  const requiredCapabilities = new Set<string>();
  for (const memberId of entry.payload.skillCatalogIds) {
    const member = getSkillCatalogEntry(memberId);
    if (!member) continue;
    for (const capability of deriveRequiredCapabilities(member.bundle)) {
      requiredCapabilities.add(capability);
    }
  }
  const missingCapabilities = await checkMissingCapabilities(
    { db: tx, tenantId: ids.tenantId, spaceId: ids.spaceId, inTransaction: true },
    [...requiredCapabilities],
  );
  return { conflicts, missingCapabilities };
}
