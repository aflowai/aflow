/**
 * Whether a space's workflow is a catalog skill as the store installed it — the
 * check a caller makes when only that skill may decide something, and a
 * workflow merely holding its slug must not.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import type { SkillCatalogEntry, TenantId } from '@aflow/schemas';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import { computeInstallDivergence } from './storeDivergence.js';

export type CatalogSkillProjectionCheck =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_in_catalog' | 'other_slug' | 'not_installed' | 'modified' | 'missing';
      message: string;
    };

export async function checkCatalogSkillProjection(
  db: PostgresJsDatabase,
  args: { tenantId: TenantId; spaceId: string; catalogId: string; slug: string },
  resolveEntry: (catalogId: string) => SkillCatalogEntry | null = getSkillCatalogEntry,
): Promise<CatalogSkillProjectionCheck> {
  const { catalogId, slug } = args;
  const entry = resolveEntry(catalogId);
  if (entry === null) {
    return {
      ok: false,
      reason: 'not_in_catalog',
      message: `"${catalogId}" names no skill in the platform catalog.`,
    };
  }
  const catalogSlug = entry.bundle.workflow.slug;
  if (catalogSlug !== slug) {
    return {
      ok: false,
      reason: 'other_slug',
      message: `The catalog skill "${catalogId}" installs as "${catalogSlug}", not "${slug}".`,
    };
  }

  const artifact = await withTenantSchema(db, createTenantContext(args.tenantId), async (tx) => {
    const divergence = await computeInstallDivergence(
      tx,
      { tenantId: args.tenantId, spaceId: args.spaceId },
      catalogId,
    );
    return divergence.artifacts.find(
      (candidate) => candidate.artifactType === 'skill' && candidate.artifactKey === slug,
    );
  });
  if (artifact === undefined) {
    return {
      ok: false,
      reason: 'not_installed',
      message: `"${slug}" in this space was not installed from the catalog skill "${catalogId}", so it is not that skill. Install "${catalogId}" from the Store.`,
    };
  }
  if (artifact.state === 'modified') {
    return {
      ok: false,
      reason: 'modified',
      message: `"${slug}" in this space has been edited since the Store installed it from "${catalogId}", so it is no longer that skill. Update it from the Store, replacing the edits.`,
    };
  }
  if (artifact.state === 'missing') {
    return {
      ok: false,
      reason: 'missing',
      message: `"${slug}" was installed from the catalog skill "${catalogId}" and is no longer in this space. Install "${catalogId}" from the Store.`,
    };
  }
  return { ok: true };
}
