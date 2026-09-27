/**
 * Space-grant redemption — the admission-side half of share-by-email.
 * Grants are keyed by (tenant, space, lowercased email) and redeem against
 * the VERIFIED authenticated email once the user holds tenant membership;
 * the invite bearer token is never proof of space access. Archived spaces
 * defer redemption (the grant stays pending for unarchive), purged spaces
 * void it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  spaceGrants,
  spaceMemberships,
  tenantMemberships,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { publishRbacInvalidation, invalidateSpaceAttributesCache } from '@aflow/authz';

export const MAX_PENDING_GRANTS_PER_SPACE = Number(
  process.env['MAX_PENDING_GRANTS_PER_SPACE'] ?? '50',
);

export interface GrantRedemptionResult {
  redeemedSpaceIds: string[];
  deferredSpaceIds: string[];
  voidedGrantIds: string[];
}

export async function redeemSpaceGrantsForUser(opts: {
  db: PostgresJsDatabase;
  redis: Redis | null | undefined;
  tenantId: string;
  userId: string;
  email: string;
  log?: FastifyBaseLogger;
}): Promise<GrantRedemptionResult> {
  const { db, redis, tenantId, userId, log } = opts;
  const email = opts.email.toLowerCase();
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const result: GrantRedemptionResult = {
    redeemedSpaceIds: [],
    deferredSpaceIds: [],
    voidedGrantIds: [],
  };

  const pending = await db
    .select({
      id: spaceGrants.id,
      spaceId: spaceGrants.spaceId,
      spaceRole: spaceGrants.spaceRole,
    })
    .from(spaceGrants)
    .where(
      and(
        eq(spaceGrants.tenantId, tenantId),
        eq(spaceGrants.email, email),
        eq(spaceGrants.status, 'pending'),
      ),
    );
  if (pending.length === 0) return result;

  for (const grant of pending) {
    const spaceRows = (await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
      return (tx as PostgresJsDatabase)
        .select({ id: spaces.id, archivedAt: spaces.archivedAt })
        .from(spaces)
        .where(eq(spaces.id, grant.spaceId))
        .limit(1);
    })) as Array<{ id: string; archivedAt: Date | null }>;
    const space = spaceRows[0];

    if (!space) {
      await db.update(spaceGrants).set({ status: 'void' }).where(eq(spaceGrants.id, grant.id));
      result.voidedGrantIds.push(grant.id);
      continue;
    }
    if (space.archivedAt) {
      result.deferredSpaceIds.push(grant.spaceId);
      continue;
    }

    // Claim the grant first, then mint — atomically. A revoke that lands
    // mid-redemption wins the claim race cleanly instead of leaving a
    // minted membership behind a revoked grant.
    const claimed = await db.transaction(async (tx) => {
      const claimedRows = await tx
        .update(spaceGrants)
        .set({ status: 'redeemed', redeemedAt: new Date(), redeemedByUserId: userId })
        .where(and(eq(spaceGrants.id, grant.id), eq(spaceGrants.status, 'pending')))
        .returning({ id: spaceGrants.id });
      if (!claimedRows[0]) return false;

      const existing = await tx
        .select({ id: spaceMemberships.id })
        .from(spaceMemberships)
        .where(
          and(
            eq(spaceMemberships.tenantId, tenantId),
            eq(spaceMemberships.spaceId, grant.spaceId),
            eq(spaceMemberships.userId, userId),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        await tx
          .insert(spaceMemberships)
          .values({ tenantId, spaceId: grant.spaceId, userId, role: grant.spaceRole })
          .onConflictDoNothing();
      }
      return true;
    });
    if (!claimed) continue;
    result.redeemedSpaceIds.push(grant.spaceId);

    if (redis) {
      await publishRbacInvalidation(redis, userId, tenantId, grant.spaceId).catch(() => {});
      await invalidateSpaceAttributesCache(redis, tenantId, grant.spaceId).catch(() => {});
    }
  }

  if (log && result.redeemedSpaceIds.length > 0) {
    log.info(
      { userId, tenantId, spaceIds: result.redeemedSpaceIds },
      'Redeemed space grants at admission',
    );
  }
  return result;
}

/**
 * Redeem what an address unlocks the moment the platform learns it is that
 * user's, in every tenant they already belong to.
 *
 * Admission is the usual moment to redeem, but it is not the only one an
 * address can arrive at: a user who joined while their address was unknown
 * passes no admission path again, so grants written for that address would
 * wait forever on an event that has already happened. Active tenant
 * membership is the same precondition admission satisfies, checked here
 * directly rather than assumed from the caller.
 */
export async function redeemSpaceGrantsForVerifiedEmail(opts: {
  db: PostgresJsDatabase;
  redis: Redis | null | undefined;
  userId: string;
  email: string;
  log?: FastifyBaseLogger;
}): Promise<void> {
  const { db, redis, userId, email, log } = opts;

  const memberships = await db
    .select({ tenantId: tenantMemberships.tenantId })
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, 'active')));

  for (const membership of memberships) {
    await redeemSpaceGrantsForUser({
      db,
      redis,
      tenantId: membership.tenantId,
      userId,
      email,
      ...(log ? { log } : {}),
    });
  }
}
