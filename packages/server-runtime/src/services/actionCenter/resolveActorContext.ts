import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import { isForeignSoloSpace } from '@aflow/authz';
import { createTenantContext, spaceMemberships, spaces, withTenantSchema } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { ActionCenterAuthzError } from './authz.js';
import type { ActionCenterContext } from './types.js';

/**
 * The fields the resolver needs from the caller. REST passes `userId`
 * from `request.authUser`, `isTenantAdmin` from `request.requireTenant()`,
 * and `authMethod` from `request.authUser`. WS passes the same fields
 * from its `RealtimeConnection` after running the same tenant-membership
 * lookup that `requireTenant` runs.
 */
export interface ActionCenterActor {
  userId: string;
  /** `true` when the user has an `active` `tenant_memberships` row with
   *  role `owner` or `admin` for this tenant. */
  isTenantAdmin: boolean;
  /** `'dev_bypass'` enables the NODE_ENV != 'production' admin shortcut.
   *  Set from `authUser.authMethod` on REST and from the connection
   *  token's auth method on WS. */
  authMethod?: string;
}

export async function resolveActionCenterActorContext(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  actor: ActionCenterActor,
): Promise<ActionCenterContext> {
  const base = {
    tenantId,
    spaceId,
    actorUserId: actor.userId,
    actorIsTenantAdmin: actor.isTenantAdmin,
    ...(actor.authMethod !== undefined ? { actorAuthMethod: actor.authMethod } : {}),
  };

  // 1. Space attributes — lives in the per-tenant schema. Feeds the owner
  //    grant and the solo-space cap on the implicit grants below.
  const tenantCtx = createTenantContext(tenantId);
  let spaceAttrs: { ownerId: string | null; memberCount: number } | null = null;
  try {
    const spaceRows = await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
      return (tx as PostgresJsDatabase)
        .select({ ownerId: spaces.ownerId })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1);
    });
    const row = (spaceRows as Array<{ ownerId: string | null }>)[0];
    if (row) {
      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(spaceMemberships)
        .where(and(eq(spaceMemberships.tenantId, tenantId), eq(spaceMemberships.spaceId, spaceId)));
      spaceAttrs = { ownerId: row.ownerId, memberCount: countRows[0]?.count ?? 0 };
    }
  } catch {
    // Lookup failure shouldn't crash the request — fall through to the
    // membership check below.
  }
  if (spaceAttrs?.ownerId && spaceAttrs.ownerId === actor.userId) {
    return { ...base, actorSpaceRole: 'admin' };
  }

  // Space content requires ownership or an explicit membership row —
  // tenant admins hold management authority elsewhere, never implicit
  // content access here. Dev bypass keeps its dev-only shortcut, still
  // capped on a foreign solo space.
  const foreignSolo = spaceAttrs !== null && isForeignSoloSpace(spaceAttrs, actor.userId);

  // 2. Dev bypass.
  if (
    process.env['NODE_ENV'] !== 'production' &&
    actor.authMethod === 'dev_bypass' &&
    !foreignSolo
  ) {
    return { ...base, actorSpaceRole: 'admin' };
  }

  // 3. Explicit membership row.
  const memberRows = await db
    .select({ role: spaceMemberships.role })
    .from(spaceMemberships)
    .where(
      and(
        eq(spaceMemberships.userId, actor.userId),
        eq(spaceMemberships.spaceId, spaceId),
        eq(spaceMemberships.tenantId, tenantId),
      ),
    )
    .limit(1);
  const membershipRole = memberRows[0]?.role;
  if (membershipRole === 'admin' || membershipRole === 'editor' || membershipRole === 'viewer') {
    return { ...base, actorSpaceRole: membershipRole };
  }

  // 5. No resolvable role.
  throw new ActionCenterAuthzError(
    `User ${actor.userId} has no resolvable role for space ${spaceId}.`,
  );
}
