/**
 * A space whose `storeUpdates` is `follow-catalog` takes each Store update
 * itself when the catalog moves (Plan 345 B3). The catalog is code, so it
 * moves when the platform does: the first time a space is used after that —
 * a workflow run starting, or its Helmsman's context being built — the
 * installs behind the catalog are updated through `executeStoreUpdate`, the
 * one path the Store page and `store.listing.update` take, and recorded as
 * any update is. What each update changed, and which skills to reconcile, is
 * kept for the Helmsman's context.
 *
 * Candidate-driven (Plan 180): one Redis read per use compares the catalog
 * this space last followed with the catalog as it stands, and only a space
 * behind it reads its installs.
 */
import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import { bumpSpaceContextGen } from '@aflow/redis';
import { getCatalogEntry, listCatalog } from '@aflow/platform-artifacts';
import type {
  CatalogEntry,
  StoreFollowedUpdate,
  StoreUpdateResponse,
  TenantId,
} from '@aflow/schemas';
import { StoreFollowedUpdateSchema } from '@aflow/schemas';
import { readSpaceAutonomyPolicy, readSpaceOwnerUserId } from '../spaceAutonomy.js';
import { getCyberneticLogger } from '../logger.js';
import { listStoreInstalls } from './storeInstallProvenance.js';
import { deriveInstalledState } from './storeDerivations.js';
import { executeStoreUpdate } from './storeUpdateExecution.js';

/** How many followed updates a space keeps for its Helmsman, newest first. */
export const STORE_FOLLOWED_KEEP = 20;

const FOLLOWED_TTL_SECONDS = 30 * 24 * 60 * 60;

function followedCatalogKey(tenantId: string, spaceId: string): string {
  return `aflow:store:followed_catalog:${tenantId}:${spaceId}`;
}

function followedUpdatesKey(tenantId: string, spaceId: string): string {
  return `aflow:store:followed_updates:${tenantId}:${spaceId}`;
}

/** The catalog as it stands: every listing's id and version, hashed. */
export function storeCatalogFingerprint(
  entries: ReadonlyArray<Pick<CatalogEntry, 'catalogId' | 'version'>> = listCatalog(),
): string {
  const lines = entries.map((entry) => `${entry.catalogId}@${String(entry.version)}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** One update's replay key: the same space, listing and version replays the recorded update. */
function followIdempotencyKey(spaceId: string, catalogId: string, version: number): string {
  const hex = createHash('sha256')
    .update(`follow-catalog:${spaceId}:${catalogId}:${String(version)}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The skills an update replaced or stopped managing. A schedule or a campaign
 * running one of them may now run a changed definition, or none: the Helmsman
 * is told to reconcile them, and nothing is held back for it.
 */
export function skillsToReconcile(response: StoreUpdateResponse): string[] {
  const keys = [
    ...response.updatedArtifacts.filter((artifact) => artifact.action === 'replaced'),
    ...response.orphanedArtifacts,
  ]
    .filter((artifact) => artifact.artifactType === 'skill')
    .map((artifact) => artifact.artifactKey);
  return [...new Set(keys)].sort();
}

export interface FollowCatalogParams {
  db: PostgresJsDatabase;
  redis: Redis;
  tenantId: string;
  spaceId: string;
  payloadStore?: PayloadStore | undefined;
  /** Override for tests; defaults to the platform catalog registry. */
  entryResolver?: (catalogId: string) => CatalogEntry | null | undefined;
  /** Override for tests; defaults to the platform catalog's fingerprint. */
  fingerprint?: string;
  now?: () => Date;
}

/**
 * Apply every update the catalog offers the space, where the space follows
 * the catalog. Returns what was followed on this call, and nothing where the
 * space already followed this catalog or keeps its updates manual.
 */
export async function followStoreCatalog(
  params: FollowCatalogParams,
): Promise<StoreFollowedUpdate[]> {
  const { db, redis, tenantId, spaceId } = params;
  const fingerprint = params.fingerprint ?? storeCatalogFingerprint();
  const markerKey = followedCatalogKey(tenantId, spaceId);
  if ((await redis.get(markerKey)) === fingerprint) return [];

  const policy = await readSpaceAutonomyPolicy(db, tenantId, spaceId);
  if (policy.storeUpdates !== 'follow-catalog') {
    await redis.set(markerKey, fingerprint);
    return [];
  }

  const resolveEntry = params.entryResolver ?? getCatalogEntry;
  const installs = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
    listStoreInstalls(tx, spaceId),
  );
  const behind = installs.flatMap((install) => {
    const entry = resolveEntry(install.catalogId);
    return entry && deriveInstalledState(entry, install).updateAvailable
      ? [{ entry, install }]
      : [];
  });

  const at = (params.now ?? (() => new Date()))().toISOString();
  const followed: StoreFollowedUpdate[] = [];
  if (behind.length > 0) {
    const actorUserId = await readSpaceOwnerUserId(db, tenantId, spaceId);
    for (const { entry, install } of behind) {
      const base = {
        catalogId: entry.catalogId,
        name: entry.name,
        fromVersion: install.installedVersion,
        toVersion: entry.version,
        at,
      };
      if (actorUserId === null) {
        followed.push({
          ...base,
          outcome: 'failed',
          detail: 'The space has no owner to record the update under.',
          reconcile: [],
        });
        continue;
      }
      const result = await executeStoreUpdate({
        db,
        redis,
        tenantId: tenantId as TenantId,
        spaceId,
        actorUserId,
        catalogId: entry.catalogId,
        expectedVersion: entry.version,
        idempotencyKey: followIdempotencyKey(spaceId, entry.catalogId, entry.version),
        mode: 'update',
        payloadStore: params.payloadStore,
        entryResolver: resolveEntry,
      });
      if (result.ok) {
        followed.push({
          ...base,
          outcome: 'applied',
          reconcile: skillsToReconcile(result.response),
          ...(result.response.setupChecklist.length > 0
            ? { setupChecklist: result.response.setupChecklist }
            : {}),
        });
      } else {
        followed.push({
          ...base,
          outcome: result.body.code === 'STORE_CUSTOMIZED' ? 'customized' : 'failed',
          detail: result.body.error,
          reconcile: [],
        });
      }
    }
  }

  if (followed.length > 0) {
    const listKey = followedUpdatesKey(tenantId, spaceId);
    await redis
      .multi()
      .lpush(listKey, ...followed.map((update) => JSON.stringify(update)))
      .ltrim(listKey, 0, STORE_FOLLOWED_KEEP - 1)
      .expire(listKey, FOLLOWED_TTL_SECONDS)
      .exec();
    await bumpSpaceContextGen(redis, tenantId, spaceId);
    getCyberneticLogger().info(
      `[storeFollowCatalog] space ${spaceId} followed the catalog: ` +
        followed.map((update) => `${update.catalogId} ${update.outcome}`).join(', '),
    );
  }
  // A failed update is tried again on the next use; a customized one is the
  // Helmsman's to decide, so it is not offered again until the catalog moves.
  if (!followed.some((update) => update.outcome === 'failed')) {
    await redis.set(markerKey, fingerprint);
  }
  return followed;
}

/** The updates the space followed, newest first, as its Helmsman's context lists them. */
export async function listStoreFollowedUpdates(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<StoreFollowedUpdate[]> {
  const raw = await redis.lrange(followedUpdatesKey(tenantId, spaceId), 0, STORE_FOLLOWED_KEEP - 1);
  return raw.flatMap((line) => {
    try {
      const parsed = StoreFollowedUpdateSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}
