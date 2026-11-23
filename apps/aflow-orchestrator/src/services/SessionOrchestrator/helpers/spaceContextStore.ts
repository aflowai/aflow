import type { Redis } from 'ioredis';
import type { SpaceContextStoreSection, StoreFollowedUpdate, TenantId } from '@aflow/schemas';
import { type Database, createTenantContext, withTenantSchema } from '@aflow/database';
import { getCatalogEntry } from '@aflow/platform-artifacts';
import {
  deriveInstalledState,
  listStoreFollowedUpdates,
  listStoreInstalls,
} from '@aflow/cybernetic-runtime';

export const STORE_GUIDANCE =
  '`updatesAvailable` lists installed Store listings the catalog has moved past. ' +
  '`followed` lists the updates the space took on its own, newest first. Each one ' +
  'names the skills to reconcile with the schedules and campaigns that run them.';

/** How many available updates the section lists. */
const STORE_UPDATES_LISTED = 10;

export function composeStoreSection(
  available: SpaceContextStoreSection['updatesAvailable'],
  followed: StoreFollowedUpdate[],
): SpaceContextStoreSection | undefined {
  if (available.length === 0 && followed.length === 0) return undefined;
  const truncated = available.length > STORE_UPDATES_LISTED;
  return {
    updatesAvailable: available.slice(0, STORE_UPDATES_LISTED),
    followed,
    ...(truncated ? { truncated: true } : {}),
    guidance: STORE_GUIDANCE,
  };
}

/**
 * What the Helmsman learns of the Store in its space (Plan 345 B2): every
 * update available, from the installs and the catalog as they stand, and
 * every update the platform followed on the space's behalf.
 */
export async function buildSpaceContextStoreSection(
  db: Database,
  tenantId: string,
  spaceId: string,
  redis?: Redis,
): Promise<SpaceContextStoreSection | undefined> {
  const installs = await withTenantSchema(db, createTenantContext(tenantId as TenantId), (tx) =>
    listStoreInstalls(tx, spaceId),
  );
  const available = installs.flatMap((install) => {
    const entry = getCatalogEntry(install.catalogId);
    if (!entry || !deriveInstalledState(entry, install).updateAvailable) return [];
    return [
      {
        catalogId: entry.catalogId,
        name: entry.name,
        installedVersion: install.installedVersion,
        catalogVersion: entry.version,
      },
    ];
  });
  const followed = redis ? await listStoreFollowedUpdates(redis, tenantId, spaceId) : [];
  return composeStoreSection(available, followed);
}
