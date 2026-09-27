import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import {
  artifactBindings,
  uiArtifacts,
  uiArtifactVersions,
  withTenantSchema,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { createTenantContext } from '@aflow/database';

export interface ArtifactBindingResolution {
  /** The UUID of the published artifact row in `ui_artifacts`. */
  artifactId: string;
  /** Bundle-shipped stable key (e.g. `alpaca:portfolio-review-card`).
   *  Surfaced for observability — operator UIs render it. */
  bundleArtifactKey: string;
  /** `ui_artifacts.current_version` — the version `ui.artifact.render`
   *  reads when called with just `artifactId`. */
  currentVersion: number;
  /** Whether the binding is enabled. Disabled bindings still resolve
   *  but the caller should refuse to render (operator off-switch). */
  enabled: boolean;
}

export interface ResolveArtifactBindingArgs {
  tenantId: string;
  spaceId: string;
  bundleId: string;
  bindingId: string;
}

/**
 * Per-process binding cache, keyed by `tenantId:spaceId:bundleId:bindingId`.
 *
 * TTL: 60s. Bundle reinstalls update the row; operator-driven
 * `ui.artifact.publish` against the same `artifactId` only changes
 * `current_version` on the underlying `ui_artifacts` row, which the
 * resolver re-reads on every cache miss. 60s is short enough that
 * operator iteration is fluid; long enough that bursty skill
 * activations don't hammer the DB.
 */
const CACHE_TTL_MS = 60 * 1000;
interface CacheEntry {
  value: ArtifactBindingResolution | null;
  expiresAtMs: number;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(args: ResolveArtifactBindingArgs): string {
  return `${args.tenantId}:${args.spaceId}:${args.bundleId}:${args.bindingId}`;
}

/**
 * Resolve a `(spaceId, bundleId, bindingId)` to its current artifact
 * identity. Returns `null` when no binding exists for the triple —
 * callers should surface this as a configuration error (bundle was
 * never installed, or the skill manifest references an unknown
 * binding).
 *
 * Read-through cached. Failure to hit the DB (connection drop, etc.)
 * is propagated to the caller; cached entries are only populated on
 * successful reads.
 */
export async function resolveArtifactBinding(
  db: PostgresJsDatabase,
  args: ResolveArtifactBindingArgs,
): Promise<ArtifactBindingResolution | null> {
  const key = cacheKey(args);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > now) {
    return hit.value;
  }

  const tenantCtx = createTenantContext(args.tenantId as TenantId);
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        artifactId: artifactBindings.artifactId,
        bundleArtifactKey: artifactBindings.bundleArtifactKey,
        enabled: artifactBindings.enabled,
        currentVersion: uiArtifacts.currentVersion,
      })
      .from(artifactBindings)
      .innerJoin(uiArtifacts, eq(artifactBindings.artifactId, uiArtifacts.id))
      .where(
        and(
          eq(artifactBindings.spaceId, args.spaceId),
          eq(artifactBindings.bundleId, args.bundleId),
          eq(artifactBindings.bindingId, args.bindingId),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  const resolution: ArtifactBindingResolution | null = row
    ? {
        artifactId: row.artifactId,
        bundleArtifactKey: row.bundleArtifactKey,
        currentVersion: row.currentVersion,
        enabled: row.enabled,
      }
    : null;

  cache.set(key, { value: resolution, expiresAtMs: now + CACHE_TTL_MS });
  return resolution;
}

/**
 * Clear the cache. Called by bundle-install and artifact-publish paths
 * after writing, so the next resolver call sees fresh state without
 * waiting for TTL.
 *
 * Without args: clears everything (e.g. on test teardown).
 * With args: clears one entry — used by the install path.
 */
export function invalidateArtifactBindingCache(args?: ResolveArtifactBindingArgs): void {
  if (!args) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey(args));
}

/**
 * Test-only: read cache state without populating. Used by the resolver
 * test to assert TTL and hit/miss behaviour.
 */
export function _getCacheEntryForTest(args: ResolveArtifactBindingArgs): CacheEntry | undefined {
  return cache.get(cacheKey(args));
}

// ============================================================================

export interface ArtifactBundleProvenance {
  bundleId: string;
  bindingId: string;
  /** The bundle seed's `content_hash` at the last install. */
  installedContentHash: string | null;
  /** The artifact's current published version's `content_hash`. */
  currentContentHash: string;
  divergedFromBundle: boolean | null;
}

/**
 * Look up bundle-provenance info for an artifact — its installed-vs-current
 * `content_hash` comparison, plus the bundle/binding identity.
 *
 * Returns `null` for artifacts that were never bundle-installed (i.e.
 * have no `artifact_bindings` row); the artifact is operator-owned and
 * divergence doesn't apply.
 *
 * Operator-UI hot path — not cached. Bursts of inspector loads against
 * the same artifact are infrequent enough that a 2-row join per call
 * is cheaper than maintaining a separate cache invalidation surface
 * (every publish would have to drop it, mirroring the binding cache).
 */
export async function getArtifactBundleProvenance(
  db: PostgresJsDatabase,
  args: {
    tenantId: string;
    spaceId: string;
    artifactId: string;
  },
): Promise<ArtifactBundleProvenance | null> {
  const tenantCtx = createTenantContext(args.tenantId as TenantId);
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        bundleId: artifactBindings.bundleId,
        bindingId: artifactBindings.bindingId,
        installedContentHash: artifactBindings.installedContentHash,
        currentVersion: uiArtifacts.currentVersion,
      })
      .from(artifactBindings)
      .innerJoin(uiArtifacts, eq(artifactBindings.artifactId, uiArtifacts.id))
      .where(
        and(
          eq(artifactBindings.spaceId, args.spaceId),
          eq(artifactBindings.artifactId, args.artifactId),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;

  // Look up the current version's content_hash. Separate query rather
  // than a 3-way join because `ui_artifact_versions` is keyed by
  // `(artifact_id, version)` and the join condition is awkward; one
  // extra SELECT is cheap.
  const versionRows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ contentHash: uiArtifactVersions.contentHash })
      .from(uiArtifactVersions)
      .where(
        and(
          eq(uiArtifactVersions.artifactId, args.artifactId),
          eq(uiArtifactVersions.version, row.currentVersion),
        ),
      )
      .limit(1),
  );
  const currentContentHash = versionRows[0]?.contentHash;
  if (!currentContentHash) {
    // Should not happen — `current_version` is meant to point at an
    // existing version row. Surface as null divergence rather than
    // throwing; the operator UI will degrade gracefully.
    return {
      bundleId: row.bundleId,
      bindingId: row.bindingId,
      installedContentHash: row.installedContentHash,
      currentContentHash: '',
      divergedFromBundle: null,
    };
  }

  const divergedFromBundle =
    row.installedContentHash === null ? null : row.installedContentHash !== currentContentHash;

  return {
    bundleId: row.bundleId,
    bindingId: row.bindingId,
    installedContentHash: row.installedContentHash,
    currentContentHash,
    divergedFromBundle,
  };
}
