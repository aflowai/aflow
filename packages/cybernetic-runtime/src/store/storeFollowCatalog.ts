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
 * behind it reads its installs. A space that does not follow the catalog
 * keeps a hold marker in the same key, so its uses pay that one read too.
 */
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import { type Database, createTenantContext, withTenantSchema } from '@aflow/database';
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

function followRetryKey(tenantId: string, spaceId: string): string {
  return `aflow:store:follow_retry:${tenantId}:${spaceId}`;
}

/**
 * The marker a space that keeps its updates manual, or whose autonomy is not
 * `full`, holds in place of a catalog fingerprint. A write of the setting
 * clears it, and it expires, so a space switched to follow the catalog takes
 * the updates already pending on its next use.
 */
const FOLLOW_HOLD_MARKER = 'hold';
const FOLLOW_HOLD_TTL_SECONDS = 60 * 60;

/** Drop what the space recorded of the catalog it follows, after its setting changes. */
export async function forgetStoreFollowMarker(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<void> {
  await redis.del(followedCatalogKey(tenantId, spaceId));
}

/** The first wait after a failed update, doubled on each failure after it. */
export const STORE_FOLLOW_RETRY_BASE_MS = 60_000;
/** The longest wait between two tries of a failed update. */
export const STORE_FOLLOW_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

const FOLLOW_RETRY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Where a catalog could not be followed whole: how often it failed, when the
 * next try may run, and the failures already listed for the Helmsman, so a
 * failure that repeats is listed once.
 */
interface FollowRetry {
  fingerprint: string;
  attempts: number;
  notBeforeMs: number;
  listed: string[];
}

function parseRetry(raw: string | null, fingerprint: string): FollowRetry | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<FollowRetry>;
    if (value.fingerprint !== fingerprint) return undefined;
    return {
      fingerprint,
      attempts: typeof value.attempts === 'number' ? value.attempts : 0,
      notBeforeMs: typeof value.notBeforeMs === 'number' ? value.notBeforeMs : 0,
      listed: Array.isArray(value.listed) ? value.listed.filter((k) => typeof k === 'string') : [],
    };
  } catch {
    return undefined;
  }
}

/** The wait before the next try, after this many failures in a row. */
export function storeFollowRetryDelayMs(attempts: number): number {
  return Math.min(
    STORE_FOLLOW_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    STORE_FOLLOW_RETRY_MAX_MS,
  );
}

function failureKey(update: StoreFollowedUpdate): string {
  return `${update.catalogId}@${String(update.toVersion)}:${update.outcome}`;
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
  db: Database;
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
  const retryKey = followRetryKey(tenantId, spaceId);
  const [marker = null, rawRetry = null] = await redis.mget(markerKey, retryKey);
  if (marker === fingerprint || marker === FOLLOW_HOLD_MARKER) return [];

  const nowMs = (params.now ?? (() => new Date()))().getTime();
  const retry = parseRetry(rawRetry, fingerprint);
  if (retry && nowMs < retry.notBeforeMs) return [];

  const policy = await readSpaceAutonomyPolicy(db, tenantId, spaceId);
  if (policy.storeUpdates !== 'follow-catalog' || policy.autonomy !== 'full') {
    await redis.set(markerKey, FOLLOW_HOLD_MARKER, 'EX', FOLLOW_HOLD_TTL_SECONDS);
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

  const at = new Date(nowMs).toISOString();
  const followed: StoreFollowedUpdate[] = [];
  // An update another use of the space is applying under the same key is
  // neither listed nor retried here: that use records it.
  let inProgress = 0;
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
      } else if (result.body.code === 'STORE_MUTATION_IN_PROGRESS') {
        inProgress += 1;
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

  // A failure listed by an earlier try of this catalog is not listed again,
  // so a failure that repeats neither fills the list nor moves the space
  // context's generation.
  const alreadyListed = new Set(retry?.listed ?? []);
  const fresh = followed.filter(
    (update) => update.outcome !== 'failed' || !alreadyListed.has(failureKey(update)),
  );
  if (fresh.length > 0) {
    const listKey = followedUpdatesKey(tenantId, spaceId);
    await redis
      .multi()
      .lpush(listKey, ...fresh.map((update) => JSON.stringify(update)))
      .ltrim(listKey, 0, STORE_FOLLOWED_KEEP - 1)
      .expire(listKey, FOLLOWED_TTL_SECONDS)
      .exec();
    await bumpSpaceContextGen(redis, tenantId, spaceId);
    getCyberneticLogger().info(
      `[storeFollowCatalog] space ${spaceId} followed the catalog: ` +
        fresh.map((update) => `${update.catalogId} ${update.outcome}`).join(', '),
    );
  }
  // A failed update is tried again after a wait that doubles with each
  // failure. A customized one is the Helmsman's to decide, so it is not
  // offered again until the catalog moves.
  const failed = followed.filter((update) => update.outcome === 'failed');
  if (failed.length === 0) {
    if (inProgress > 0) return fresh;
    await redis.set(markerKey, fingerprint);
    if (retry) await redis.del(retryKey);
  } else {
    const attempts = (retry?.attempts ?? 0) + 1;
    const next: FollowRetry = {
      fingerprint,
      attempts,
      notBeforeMs: nowMs + storeFollowRetryDelayMs(attempts),
      listed: [...new Set([...alreadyListed, ...failed.map(failureKey)])],
    };
    await redis.set(retryKey, JSON.stringify(next), 'EX', FOLLOW_RETRY_TTL_SECONDS);
  }
  return fresh;
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
