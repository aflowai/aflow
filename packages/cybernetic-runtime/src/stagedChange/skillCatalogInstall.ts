/**
 * Skill-catalog install core — the one authority the per-kind catalog route
 * and the unified store dispatch share: deep-clone + re-parse through
 * `SkillComposeBundleSchema`, slug-conflict probe, `applySkillComposeBundle`
 * with cloned origin + catalog provenance, synchronous projection rebuild.
 * Callers map the structured outcomes to their own HTTP contracts.
 */
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import { SkillComposeBundleSchema, type TenantId } from '@aflow/schemas';
import type { ApplyContext } from './applyRatifiedOps.js';
import { applySkillComposeBundle } from './skillComposeApply.js';
import { rebuildSkillProjection } from '../skillProjectionReconciler.js';

export interface SkillSlugConflict {
  /** ISO timestamp when the conflicting skill was archived; null while it is active. */
  archivedAt: string | null;
}

export async function probeSkillSlugConflict(
  ctx: ApplyContext,
  slug: string,
): Promise<SkillSlugConflict | null> {
  const repo = createMemoryDocRepository(ctx.db, createTenantContext(ctx.tenantId as TenantId), {
    inTransaction: ctx.inTransaction ?? false,
  });
  const existing = await repo.getByPath(`/workflows/${slug}/workflow.json`, ctx.spaceId, {
    includeDeleted: true,
  });
  if (!existing) return null;
  return { archivedAt: existing.deletedAt ? existing.deletedAt.toISOString() : null };
}

export type InstallSkillCatalogEntryResult =
  | { outcome: 'invalid_bundle'; error: string }
  | { outcome: 'slug_conflict'; slug: string; archivedAt: string | null }
  | {
      outcome: 'installed';
      skillId: string;
      activationStatus: string;
      missingCapabilities: string[];
    };

export async function installSkillCatalogEntry(
  ctx: ApplyContext,
  opts: {
    /** The raw catalog bundle; deep-cloned + re-parsed so installs never mutate the registry. */
    bundle: unknown;
    sourceCatalogId: string;
    sourceVersion: number;
    installAsSlug?: string;
  },
): Promise<InstallSkillCatalogEntryResult> {
  const parsed = SkillComposeBundleSchema.safeParse(JSON.parse(JSON.stringify(opts.bundle)));
  if (!parsed.success) {
    return {
      outcome: 'invalid_bundle',
      error: `Catalog bundle validation failed: ${parsed.error.message}`,
    };
  }
  const bundle = parsed.data;
  if (opts.installAsSlug !== undefined) {
    bundle.workflow.slug = opts.installAsSlug;
    bundle.manifest.skillId = opts.installAsSlug;
  }
  const slug = bundle.workflow.slug;

  const conflict = await probeSkillSlugConflict(ctx, slug);
  if (conflict) return { outcome: 'slug_conflict', slug, archivedAt: conflict.archivedAt };

  await applySkillComposeBundle(ctx, bundle, {
    origin: 'cloned',
    provenance: {
      sourceCatalogId: opts.sourceCatalogId,
      sourceVersion: opts.sourceVersion,
      installedAt: new Date().toISOString(),
    },
  });

  const rebuilt = await rebuildSkillProjection(ctx, slug);
  return {
    outcome: 'installed',
    skillId: slug,
    activationStatus: rebuilt?.projection.activationStatus ?? 'active',
    missingCapabilities: rebuilt?.projection.missingCapabilities ?? [],
  };
}
