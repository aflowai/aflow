import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { createTenantContext, spaceMemberships, spaces, withTenantSchema } from '@aflow/database';
import { bumpSpaceContextGen } from '@aflow/redis';
import {
  SpaceAutonomyPolicySchema,
  SpaceRoleSchema,
  nextSpaceAutonomyPolicy,
  type SpaceAutonomyPolicy,
  type SpaceRole,
  type SpaceAutonomySetting,
  type TenantId,
} from '@aflow/schemas';
import { forgetStoreFollowMarker } from './store/storeFollowCatalog.js';
import { readSpaceOwnerUserId } from './spaceAutonomy.js';

/**
 * The row write of a space's autonomy setting (Plan 345 D): the whole stored
 * value replaced, directive included. Only `space.autonomy.update` writes
 * through it, since only the op verifies a directive.
 */
export function updateSpaceAutonomyPolicyRow(
  tx: PostgresJsDatabase,
  spaceId: string,
  value: SpaceAutonomyPolicy | null,
): Promise<Array<{ autonomyPolicy: SpaceAutonomyPolicy | null }>> {
  return tx
    .update(spaces)
    .set({ autonomyPolicy: value, updatedAt: new Date() })
    .where(eq(spaces.id, spaceId))
    .returning({ autonomyPolicy: spaces.autonomyPolicy });
}

/**
 * The write `PUT /v1/spaces/:spaceId/autonomy` takes: `autonomy` and
 * `storeUpdates` replaced, the stored directive kept, and a change of
 * autonomy timed as the op times it (`nextSpaceAutonomyPolicy`). A raise
 * here stores no directive, so a lowering's time is what keeps an old
 * message from raising the space again.
 */
export async function updateSpaceAutonomySettingRow(
  tx: PostgresJsDatabase,
  spaceId: string,
  setting: SpaceAutonomySetting | null,
): Promise<Array<{ autonomyPolicy: SpaceAutonomyPolicy | null }>> {
  const rows = await tx
    .select({ autonomyPolicy: spaces.autonomyPolicy })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  const parsed = SpaceAutonomyPolicySchema.safeParse(rows[0]?.autonomyPolicy);
  const value = nextSpaceAutonomyPolicy({
    stored: parsed.success ? parsed.data : null,
    setting,
    at: new Date(),
  });
  return updateSpaceAutonomyPolicyRow(tx, spaceId, value);
}

/**
 * What a write of the setting moves in Redis. The space context carries the
 * setting, so its generation moves. A space that held its Store updates
 * follows the catalog on its next use once switched, so the hold marker goes.
 */
export async function settleSpaceAutonomyWrite(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<void> {
  await bumpSpaceContextGen(redis, tenantId, spaceId);
  await forgetStoreFollowMarker(redis, tenantId, spaceId);
}

/**
 * Write a space's autonomy setting on the route's path: the row, then what it
 * moves in Redis. Returns the stored value, or `undefined` where the space is
 * not found.
 */
export async function writeSpaceAutonomyPolicy(args: {
  db: PostgresJsDatabase;
  redis: Redis;
  tenantId: string;
  spaceId: string;
  policy: SpaceAutonomyPolicy | null;
}): Promise<{ autonomyPolicy: SpaceAutonomyPolicy | null } | undefined> {
  const rows = await withTenantSchema(
    args.db,
    createTenantContext(args.tenantId as TenantId),
    async (tx) => updateSpaceAutonomyPolicyRow(tx, args.spaceId, args.policy),
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  await settleSpaceAutonomyWrite(args.redis, args.tenantId, args.spaceId);
  return row;
}

/**
 * The setting as stored, with no default filled in: what a write that names
 * one field keeps of the other. A value that does not parse reads as none, as
 * every reader treats it.
 */
export async function readStoredSpaceAutonomyPolicy(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<SpaceAutonomyPolicy | null> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) =>
    tx
      .select({ autonomyPolicy: spaces.autonomyPolicy })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1),
  );
  const parsed = SpaceAutonomyPolicySchema.safeParse(rows[0]?.autonomyPolicy);
  return parsed.success ? parsed.data : null;
}

/**
 * A user's role in a space: their membership's, or `admin` for the space's
 * owner. Null for a user who is neither a member nor the owner.
 */
export async function readSpaceRole(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  userId: string,
): Promise<SpaceRole | null> {
  const rows = await db
    .select({ role: spaceMemberships.role })
    .from(spaceMemberships)
    .where(
      and(
        eq(spaceMemberships.tenantId, tenantId),
        eq(spaceMemberships.spaceId, spaceId),
        eq(spaceMemberships.userId, userId),
      ),
    )
    .limit(1);
  const role = SpaceRoleSchema.safeParse(rows[0]?.role);
  if (role.success && role.data === 'admin') return 'admin';
  if ((await readSpaceOwnerUserId(db, tenantId, spaceId)) === userId) return 'admin';
  return role.success ? role.data : null;
}

/**
 * Whether a user holds the authority the autonomy route asks for: `admin` of
 * the space, by membership or as its owner.
 */
export async function isSpaceAdmin(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  return (await readSpaceRole(db, tenantId, spaceId, userId)) === 'admin';
}

/**
 * Whether a user holds the authority the Store's install and update routes
 * ask for: space `write`, which `checkSpaceRbac` gives an admin and an
 * editor and refuses a viewer.
 */
export async function canWriteSpace(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  const role = await readSpaceRole(db, tenantId, spaceId, userId);
  return role === 'admin' || role === 'editor';
}
