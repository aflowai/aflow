import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { and, desc, eq, like } from 'drizzle-orm';
import {
  createTenantContext,
  planNodeLinks,
  spaceMemberships,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import { bumpSpaceContextGen } from '@aflow/redis';
import {
  SPACE_AUTONOMY_RAISE_DIRECTIVE_LABEL_PREFIX,
  SpaceAutonomyPolicySchema,
  parseSpaceAutonomyRaiseDirectiveLabel,
  type SpaceAutonomyDirective,
  type SpaceAutonomyPolicy,
  type TenantId,
} from '@aflow/schemas';
import { forgetStoreFollowMarker } from './store/storeFollowCatalog.js';
import { readSpaceOwnerUserId } from './spaceAutonomy.js';

/**
 * The row write of a space's autonomy setting (Plan 345 D): the whole stored
 * value replaced, as `PUT /v1/spaces/:spaceId/autonomy` replaces it. The
 * route and `space.autonomy.update` both write through it.
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
 * Whether a user holds the authority the autonomy route asks for: `admin` of
 * the space, by membership or as its owner.
 */
export async function isSpaceAdmin(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  userId: string,
): Promise<boolean> {
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
  if (rows[0]?.role === 'admin') return true;
  return (await readSpaceOwnerUserId(db, tenantId, spaceId)) === userId;
}

/** How many directive links of one space a raise reads, newest first. */
const RAISE_DIRECTIVE_LINKS_READ = 20;

/**
 * The operator's directive to raise a space to `full` (Plan 345 D), as the
 * space's plan records it: a `document` link on a plan node of the space
 * whose label is {@link spaceAutonomyRaiseDirectiveLabel} with the day the
 * operator gave it. The newest such link wins. `undefined` where the plan
 * holds none, so the raise is refused.
 */
export async function findSpaceAutonomyRaiseDirective(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  now: Date = new Date(),
): Promise<SpaceAutonomyDirective | undefined> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) =>
    tx
      .select({ nodeId: planNodeLinks.nodeId, ref: planNodeLinks.ref, label: planNodeLinks.label })
      .from(planNodeLinks)
      .where(
        and(
          eq(planNodeLinks.spaceId, spaceId),
          eq(planNodeLinks.kind, 'document'),
          like(planNodeLinks.label, `${SPACE_AUTONOMY_RAISE_DIRECTIVE_LABEL_PREFIX}%`),
        ),
      )
      .orderBy(desc(planNodeLinks.createdAt))
      .limit(RAISE_DIRECTIVE_LINKS_READ),
  );
  const today = now.toISOString().slice(0, 10);
  for (const row of rows) {
    const givenOn = parseSpaceAutonomyRaiseDirectiveLabel(row.label, today);
    if (givenOn === undefined || row.label === null) continue;
    return { nodeId: row.nodeId, documentRef: row.ref, label: row.label, givenOn };
  }
  return undefined;
}
