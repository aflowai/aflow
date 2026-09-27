/**
 * Per-kind store backend for `applet` listings. Install and update are the
 * same idempotent write bundles use for artifact seeds (`applyArtifactSeeds`:
 * unchanged content short-circuits, changed content becomes a new version on
 * the same head — instances stay pinned and upgrade only through the
 * lifecycle surface). Teardown is archive-first: live instances are archived
 * via the Phase 5 lifecycle helpers before the head is soft-deleted.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { archiveActiveAppletInstancesForArtifact } from '@aflow/database';
import type { ArchivedAppletInstanceRef } from '@aflow/database';
import type {
  BundleArtifactSeed,
  CatalogAppletEntry,
  SkillBundleId,
  TenantId,
} from '@aflow/schemas';
import { applyArtifactSeeds, renderContractContent } from '../stagedChange/applyArtifactSeeds.js';
import type { InstallDispatchOutcome } from './storeInstallExecution.js';
import type { UpdateDispatchOutcome } from './storeUpdateExecution.js';
import { appletSeedForEntry } from './appletArtifact.js';
import type { PayloadStore } from '@aflow/payload-store';

interface AppletDispatchIds {
  tenantId: TenantId;
  spaceId: string;
  payloadStore?: PayloadStore | undefined;
}

async function applyAppletSeed(
  tx: PostgresJsDatabase,
  entry: CatalogAppletEntry,
  ids: AppletDispatchIds,
) {
  const seed = appletSeedForEntry(entry);
  const result = await applyArtifactSeeds({
    payloadStore: ids.payloadStore,
    bundle: { bundleId: entry.catalogId as SkillBundleId, artifactSeed: [seed] },
    tenantId: ids.tenantId as string,
    spaceId: ids.spaceId,
    tx,
  });
  const applied = result.entries[0];
  if (!applied) {
    throw new Error(`Applet install of '${entry.catalogId}' produced no artifact entry`);
  }
  return applied;
}

/** Also the no-op reinstall path — unchanged content short-circuits inside the seed apply. */
export async function dispatchAppletInstall(
  tx: PostgresJsDatabase,
  entry: CatalogAppletEntry,
  ids: AppletDispatchIds,
): Promise<InstallDispatchOutcome> {
  const applied = await applyAppletSeed(tx, entry, ids);
  return {
    result: {
      kind: 'applet',
      artifactId: applied.artifactId,
      artifactVersion: applied.version,
      bundleArtifactKey: applied.bundleArtifactKey,
      outcome: applied.outcome,
    },
    setupChecklist: [],
    invalidations: null,
  };
}

export async function dispatchAppletUpdate(
  tx: PostgresJsDatabase,
  entry: CatalogAppletEntry,
  ids: AppletDispatchIds,
): Promise<UpdateDispatchOutcome> {
  const applied = await applyAppletSeed(tx, entry, ids);
  return {
    updatedArtifacts:
      applied.outcome === 'skipped_unchanged'
        ? []
        : [
            {
              artifactType: 'ui_artifact',
              artifactKey: applied.bundleArtifactKey,
              action: applied.outcome === 'inserted_new' ? 'installed' : 'replaced',
            },
          ],
    keptUserDataArtifacts: [],
    credentialsReset: false,
    missingVariables: [],
    setupChecklist: [],
    installedUserDataKeys: new Set(),
    pendingEmbedJobs: [],
  };
}

// ============================================================================
// Head reads (divergence + uninstall plan)
// ============================================================================

export interface AppletArtifactHead {
  artifactRowId: string;
  currentVersion: number;
  contentHash: string | null;
}

export async function readAppletArtifactHead(
  tx: PostgresJsDatabase,
  spaceId: string,
  bundleArtifactKey: string,
): Promise<AppletArtifactHead | null> {
  const rows = await tx.execute<{
    id: string;
    current_version: number;
    content_hash: string | null;
  }>(sql`
    SELECT a.id AS id, a.current_version AS current_version, v.content_hash AS content_hash
    FROM ui_artifacts a
    LEFT JOIN ui_artifact_versions v
      ON v.artifact_id = a.id AND v.version = a.current_version
    WHERE a.space_id = ${spaceId}::uuid
      AND a.bundle_artifact_key = ${bundleArtifactKey}
      AND a.deleted_at IS NULL
    LIMIT 1
  `);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    artifactRowId: row.id,
    currentVersion: row.current_version,
    contentHash: row.content_hash,
  };
}

function decodeInlineSource(sourceRef: string): string | null {
  if (!sourceRef.startsWith('inline:')) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(sourceRef.slice('inline:'.length), 'base64').toString('utf8'),
    );
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * The CURRENT render contract of the applet's installed artifact. The hash is
 * the stored version hash — the store's own writes stamp `renderContractHash`
 * there, and any space-authored version stamps something else, so inequality
 * against the provenance stamp is exactly "modified". The content payload is
 * reconstructed in the same shape the hash covers, for the Mine-vs-Store diff.
 */
export async function currentAppletArtifactState(
  tx: PostgresJsDatabase,
  spaceId: string,
  bundleArtifactKey: string,
  payloadStore?: PayloadStore,
): Promise<{ hash: string | null; content?: unknown }> {
  const rows = await tx.execute<{
    kind: string;
    catalog_id: string;
    catalog_version: string;
    catalog_hash: string;
    content_hash: string;
    source_ref: string;
    data_schema: unknown;
    sample_data: unknown;
    applet_definition: unknown;
  }>(sql`
    SELECT a.kind AS kind, a.catalog_id AS catalog_id, a.catalog_version AS catalog_version,
           a.catalog_hash AS catalog_hash, v.content_hash AS content_hash,
           v.source_ref AS source_ref, v.data_schema AS data_schema,
           v.sample_data AS sample_data, v.applet_definition AS applet_definition
    FROM ui_artifacts a
    JOIN ui_artifact_versions v
      ON v.artifact_id = a.id AND v.version = a.current_version
    WHERE a.space_id = ${spaceId}::uuid
      AND a.bundle_artifact_key = ${bundleArtifactKey}
      AND a.deleted_at IS NULL
    LIMIT 1
  `);
  const row = rows[0];
  if (row === undefined) return { hash: null };
  let source = decodeInlineSource(row.source_ref);
  if (source === null && payloadStore !== undefined && !row.source_ref.startsWith('inline:')) {
    // A source past the inline cap lives in the payload store; without it the
    // diff falls back to the hash alone, which detects divergence and shows
    // nothing.
    try {
      const stored = await payloadStore.retrieve(row.source_ref);
      source = typeof stored === 'string' ? stored : null;
    } catch {
      source = null;
    }
  }
  if (source === null) return { hash: row.content_hash };
  return {
    hash: row.content_hash,
    content: renderContractContent({
      source,
      kind: row.kind as BundleArtifactSeed['kind'],
      dataSchema: (row.data_schema ?? {}) as Record<string, unknown>,
      sampleData: (row.sample_data ?? {}) as Record<string, unknown>,
      catalogPin: {
        catalogId: row.catalog_id,
        catalogVersion: row.catalog_version,
        catalogHash: row.catalog_hash,
      },
      ...(row.applet_definition !== null && row.applet_definition !== undefined
        ? { appletDefinition: row.applet_definition as BundleArtifactSeed['appletDefinition'] }
        : {}),
    }),
  };
}

// ============================================================================
// Teardown (uninstall)
// ============================================================================

export interface AppletTeardownTarget {
  artifactRowId: string;
  /** artifact_bindings.binding_id — the listing's catalogId by construction. */
  bindingId: string;
  artifactKey: string;
}

/**
 * Archive-first removal: every active instance pinned to any version of this
 * artifact flips to 'archived' (readable, no further actions), then the head
 * is soft-deleted and its binding row dropped. Version rows stay — archived
 * instances still resolve their pinned definition through them.
 */
export async function removeAppletArtifact(
  tx: PostgresJsDatabase,
  spaceId: string,
  target: AppletTeardownTarget,
): Promise<ArchivedAppletInstanceRef[]> {
  const archived = await archiveActiveAppletInstancesForArtifact(tx, target.artifactRowId);
  await tx.execute(sql`
    UPDATE ui_artifacts SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = ${target.artifactRowId}::uuid AND space_id = ${spaceId}::uuid
  `);
  await tx.execute(sql`
    DELETE FROM artifact_bindings
    WHERE binding_id = ${target.bindingId} AND space_id = ${spaceId}::uuid
  `);
  return archived;
}
