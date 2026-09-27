import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, sql } from 'drizzle-orm';
import { tenantMemberships, spaceMemberships, apiKeys } from '@aflow/database';
import type { TenantRole, SpaceRole } from './types.js';

// ============================================================================
// Types
// ============================================================================

/** A Drizzle Postgres transaction or database handle. */
export type DbOrTx = PostgresJsDatabase;

/** Callback returned by every mutation — caller must invoke after tx commits. */
export type PostCommitFn = () => Promise<void>;

/** Params shared by all tenant-level mutations. */
interface TenantMutationBase {
  tenantId: string;
  userId: string;
}

// ============================================================================
// Errors
// ============================================================================

export class MembershipInvariantError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 409) {
    super(message);
    this.name = 'MembershipInvariantError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ============================================================================
// Service
// ============================================================================

export interface MembershipServiceDeps {
  /** Called after each mutation's transaction commits to invalidate caches. */
  publishInvalidation: (userId: string, tenantId: string, spaceId?: string) => Promise<void>;
}

export function createMembershipService(deps: MembershipServiceDeps) {
  const { publishInvalidation } = deps;

  // --------------------------------------------------------------------------
  // Tenant membership
  // --------------------------------------------------------------------------

  /**
   * Add a user to a tenant with the given role.
   * If the user was previously removed/suspended, reactivates the existing row.
   * Rejects if the user already has an active membership.
   */
  async function addTenantMember(
    tx: DbOrTx,
    params: TenantMutationBase & { role: TenantRole },
  ): Promise<PostCommitFn> {
    const { tenantId, userId, role } = params;

    // Check for any existing membership row (any status)
    const existing = await tx
      .select({ id: tenantMemberships.id, status: tenantMemberships.status })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)))
      .limit(1);

    const row = existing[0];

    if (row) {
      if (row.status === 'active') {
        throw new MembershipInvariantError(
          'DUPLICATE_MEMBERSHIP',
          'User already has an active membership in this tenant.',
        );
      }

      // Reactivate previously removed/suspended membership
      await tx
        .update(tenantMemberships)
        .set({ role, status: 'active', joinedAt: new Date(), updatedAt: new Date() })
        .where(eq(tenantMemberships.id, row.id));
    } else {
      // First-time membership — insert new row
      await tx.insert(tenantMemberships).values({
        tenantId,
        userId,
        role,
        status: 'active',
        joinedAt: new Date(),
      });
    }

    return () => publishInvalidation(userId, tenantId);
  }

  /**
   * Change a user's tenant role.
   * Enforces: cannot change own role, cannot demote/remove owner unless actor is owner,
   * cannot promote to owner (use transferOwnership instead).
   */
  async function changeTenantRole(
    tx: DbOrTx,
    params: TenantMutationBase & { newRole: TenantRole; actorId: string; actorRole: TenantRole },
  ): Promise<PostCommitFn> {
    const { tenantId, userId, newRole, actorId, actorRole } = params;

    // Guard: cannot change own role
    if (userId === actorId) {
      throw new MembershipInvariantError(
        'SELF_ROLE_CHANGE',
        'Cannot change your own role. Use ownership transfer if you are the owner.',
        403,
      );
    }

    // Guard: cannot promote to owner (use transferOwnership)
    if (newRole === 'owner') {
      throw new MembershipInvariantError(
        'OWNER_PROMOTION_FORBIDDEN',
        'Cannot promote to owner. Use the ownership transfer endpoint.',
        403,
      );
    }

    // Look up the target's current role
    const targetRows = await tx
      .select({ role: tenantMemberships.role })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, userId),
          eq(tenantMemberships.status, 'active'),
        ),
      )
      .limit(1);

    const target = targetRows[0];
    if (!target) {
      throw new MembershipInvariantError(
        'MEMBER_NOT_FOUND',
        'Target user is not an active member of this tenant.',
        404,
      );
    }

    const targetCurrentRole = target.role as TenantRole;

    // Guard: only owner can modify admins or promote to admin
    if (targetCurrentRole === 'admin' || newRole === 'admin') {
      if (actorRole !== 'owner') {
        throw new MembershipInvariantError(
          'INSUFFICIENT_PRIVILEGE',
          'Only the tenant owner can promote to admin or modify admin roles.',
          403,
        );
      }
    }

    // Guard: cannot change the owner's role (use transferOwnership)
    if (targetCurrentRole === 'owner') {
      throw new MembershipInvariantError(
        'OWNER_ROLE_PROTECTED',
        "Cannot change the owner's role. Use the ownership transfer endpoint.",
        403,
      );
    }

    await tx
      .update(tenantMemberships)
      .set({ role: newRole, updatedAt: new Date() })
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, userId),
          eq(tenantMemberships.status, 'active'),
        ),
      );

    return () => publishInvalidation(userId, tenantId);
  }

  /**
   * Transfer tenant ownership from the current owner to another admin.
   * Atomic swap: target becomes owner, caller becomes admin.
   */
  async function transferOwnership(
    tx: DbOrTx,
    params: { tenantId: string; currentOwnerId: string; targetUserId: string },
  ): Promise<PostCommitFn> {
    const { tenantId, currentOwnerId, targetUserId } = params;

    if (currentOwnerId === targetUserId) {
      throw new MembershipInvariantError('SELF_TRANSFER', 'Cannot transfer ownership to yourself.');
    }

    // Verify the caller is actually the current owner
    const ownerRows = await tx
      .select({ role: tenantMemberships.role })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, currentOwnerId),
          eq(tenantMemberships.status, 'active'),
        ),
      )
      .limit(1);

    if (ownerRows[0]?.role !== 'owner') {
      throw new MembershipInvariantError(
        'NOT_OWNER',
        'Only the current tenant owner can transfer ownership.',
        403,
      );
    }

    // Verify target is an active admin
    const targetRows = await tx
      .select({ role: tenantMemberships.role })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, targetUserId),
          eq(tenantMemberships.status, 'active'),
        ),
      )
      .limit(1);

    if (targetRows[0]?.role !== 'admin') {
      throw new MembershipInvariantError(
        'TARGET_NOT_ADMIN',
        'Ownership can only be transferred to an active tenant admin.',
        422,
      );
    }

    // Atomic swap — demote current owner, then promote target.
    // Both UPDATEs include role guards and returning() checks so we
    // abort the transaction if either affects zero rows (no orphaned state).
    const now = new Date();

    const demoted = await tx
      .update(tenantMemberships)
      .set({ role: 'admin', updatedAt: now })
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, currentOwnerId),
          eq(tenantMemberships.role, 'owner'),
          eq(tenantMemberships.status, 'active'),
        ),
      )
      .returning({ id: tenantMemberships.id });

    if (demoted.length === 0) {
      throw new MembershipInvariantError(
        'OWNER_DEMOTE_FAILED',
        'Failed to demote current owner — row was modified concurrently.',
      );
    }

    const promoted = await tx
      .update(tenantMemberships)
      .set({ role: 'owner', updatedAt: now })
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, targetUserId),
          eq(tenantMemberships.role, 'admin'),
          eq(tenantMemberships.status, 'active'),
        ),
      )
      .returning({ id: tenantMemberships.id });

    if (promoted.length === 0) {
      // The first UPDATE already ran inside this transaction, so throwing
      // here triggers a rollback — no orphaned ownerless state.
      throw new MembershipInvariantError(
        'TARGET_PROMOTE_FAILED',
        'Failed to promote target to owner — row was modified concurrently.',
      );
    }

    return async () => {
      await publishInvalidation(currentOwnerId, tenantId);
      await publishInvalidation(targetUserId, tenantId);
    };
  }

  /**
   * Validate that a tenant member can be removed by the actor, without
   * mutating anything. Callers that must resolve the departing member's
   * owned spaces before deletion run this first so reconciliation never
   * happens for a removal that would then be rejected.
   */
  async function assertRemovableTenantMember(
    tx: DbOrTx,
    params: TenantMutationBase & { actorId: string; actorRole: TenantRole },
  ): Promise<void> {
    const { tenantId, userId, actorId, actorRole } = params;

    // Guard: cannot remove yourself
    if (userId === actorId) {
      throw new MembershipInvariantError(
        'SELF_REMOVAL',
        'Cannot remove yourself. Transfer ownership first if you are the owner.',
        403,
      );
    }

    // Look up the target's current role
    const targetRows = await tx
      .select({ role: tenantMemberships.role })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, userId),
          eq(tenantMemberships.status, 'active'),
        ),
      )
      .limit(1);

    const target = targetRows[0];
    if (!target) {
      throw new MembershipInvariantError(
        'MEMBER_NOT_FOUND',
        'Target user is not an active member of this tenant.',
        404,
      );
    }

    const targetRole = target.role as TenantRole;

    // Guard: cannot remove the owner
    if (targetRole === 'owner') {
      throw new MembershipInvariantError(
        'OWNER_REMOVAL_FORBIDDEN',
        'Cannot remove the tenant owner. Transfer ownership first.',
        403,
      );
    }

    // Guard: only owner can remove admins
    if (targetRole === 'admin' && actorRole !== 'owner') {
      throw new MembershipInvariantError(
        'INSUFFICIENT_PRIVILEGE',
        'Only the tenant owner can remove admins.',
        403,
      );
    }
  }

  /**
   * Remove a user from a tenant (soft-delete).
   * Cascades: hard-deletes space memberships, revokes API keys. Callers own
   * resolving the departing member's owned spaces (transfer-or-archive)
   * before this runs.
   */
  async function removeTenantMember(
    tx: DbOrTx,
    params: TenantMutationBase & { actorId: string; actorRole: TenantRole },
  ): Promise<PostCommitFn> {
    const { tenantId, userId } = params;

    await assertRemovableTenantMember(tx, params);

    // 1. Soft-delete tenant membership
    await tx
      .update(tenantMemberships)
      .set({ status: 'removed', updatedAt: new Date() })
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)));

    // 2. Hard-delete all space memberships (provenance preserved via audit).
    // Capture the space ids first — each deletion flips that space's
    // memberCount, so invalidation must be published per space or the
    // attrs cache serves the stale solo/shared state for its full TTL.
    const memberSpaceRows = await tx
      .select({ spaceId: spaceMemberships.spaceId })
      .from(spaceMemberships)
      .where(and(eq(spaceMemberships.tenantId, tenantId), eq(spaceMemberships.userId, userId)));
    await tx
      .delete(spaceMemberships)
      .where(and(eq(spaceMemberships.tenantId, tenantId), eq(spaceMemberships.userId, userId)));

    // 3. Revoke all API keys for this user in this tenant
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.tenantId, tenantId),
          eq(apiKeys.userId, userId),
          sql`${apiKeys.revokedAt} IS NULL`,
        ),
      );

    return async () => {
      await publishInvalidation(userId, tenantId);
      for (const row of memberSpaceRows) {
        await publishInvalidation(userId, tenantId, row.spaceId);
      }
    };
  }

  // --------------------------------------------------------------------------
  // Space membership
  // --------------------------------------------------------------------------

  /**
   * Add a user to a space.
   * Validates that the user is an active tenant member first (invariant #2).
   */
  async function addSpaceMember(
    tx: DbOrTx,
    params: { tenantId: string; spaceId: string; userId: string; role: SpaceRole },
  ): Promise<PostCommitFn> {
    const { tenantId, spaceId, userId, role } = params;

    // Invariant: user must be an active tenant member
    const memberRows = await tx
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, userId),
          eq(tenantMemberships.status, 'active'),
        ),
      )
      .limit(1);

    if (memberRows.length === 0) {
      throw new MembershipInvariantError(
        'NOT_TENANT_MEMBER',
        'User must be an active member of the tenant before being added to a space.',
        422,
      );
    }

    // Guard: no duplicate space memberships
    const existingSpace = await tx
      .select({ id: spaceMemberships.id })
      .from(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.tenantId, tenantId),
          eq(spaceMemberships.spaceId, spaceId),
          eq(spaceMemberships.userId, userId),
        ),
      )
      .limit(1);

    if (existingSpace.length > 0) {
      throw new MembershipInvariantError(
        'DUPLICATE_SPACE_MEMBERSHIP',
        'User is already a member of this space.',
      );
    }

    await tx.insert(spaceMemberships).values({
      tenantId,
      spaceId,
      userId,
      role,
    });

    return () => publishInvalidation(userId, tenantId, spaceId);
  }

  /**
   * Change a user's space role.
   * Enforces last-admin protection and the owner invariant (the owner's
   * membership can never drop below admin).
   */
  async function changeSpaceRole(
    tx: DbOrTx,
    params: {
      tenantId: string;
      spaceId: string;
      userId: string;
      newRole: SpaceRole;
      spaceOwnerId: string | null;
    },
  ): Promise<PostCommitFn> {
    const { tenantId, spaceId, userId, newRole } = params;

    if (params.spaceOwnerId !== null && userId === params.spaceOwnerId && newRole !== 'admin') {
      throw new MembershipInvariantError(
        'OWNER_MEMBERSHIP_PROTECTED',
        "The space owner's role cannot drop below admin. Transfer ownership first.",
        403,
      );
    }

    // Look up current role
    const currentRows = await tx
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

    const current = currentRows[0];
    if (!current) {
      throw new MembershipInvariantError(
        'SPACE_MEMBER_NOT_FOUND',
        'User is not a member of this space.',
        404,
      );
    }

    // Last-admin protection: if demoting from admin, check count
    if (current.role === 'admin' && newRole !== 'admin') {
      await assertNotLastSpaceAdmin(tx, tenantId, spaceId);
    }

    await tx
      .update(spaceMemberships)
      .set({ role: newRole, updatedAt: new Date() })
      .where(
        and(
          eq(spaceMemberships.tenantId, tenantId),
          eq(spaceMemberships.spaceId, spaceId),
          eq(spaceMemberships.userId, userId),
        ),
      );

    return () => publishInvalidation(userId, tenantId, spaceId);
  }

  /**
   * Remove a user from a space.
   * Enforces last-admin protection and the owner invariant (the owner's
   * membership cannot be removed — transfer ownership or archive instead).
   */
  async function removeSpaceMember(
    tx: DbOrTx,
    params: { tenantId: string; spaceId: string; userId: string; spaceOwnerId: string | null },
  ): Promise<PostCommitFn> {
    const { tenantId, spaceId, userId } = params;

    if (params.spaceOwnerId !== null && userId === params.spaceOwnerId) {
      throw new MembershipInvariantError(
        'OWNER_MEMBERSHIP_PROTECTED',
        "The space owner's membership cannot be removed. Transfer ownership or archive the space.",
        403,
      );
    }

    // Look up current role for last-admin check
    const currentRows = await tx
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

    const current = currentRows[0];
    if (!current) {
      throw new MembershipInvariantError(
        'SPACE_MEMBER_NOT_FOUND',
        'User is not a member of this space.',
        404,
      );
    }

    // Last-admin protection
    if (current.role === 'admin') {
      await assertNotLastSpaceAdmin(tx, tenantId, spaceId);
    }

    await tx
      .delete(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.tenantId, tenantId),
          eq(spaceMemberships.spaceId, spaceId),
          eq(spaceMemberships.userId, userId),
        ),
      );

    return () => publishInvalidation(userId, tenantId, spaceId);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Throws if the space has only one admin (last-admin protection). */
  async function assertNotLastSpaceAdmin(
    tx: DbOrTx,
    tenantId: string,
    spaceId: string,
  ): Promise<void> {
    const countResult = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.tenantId, tenantId),
          eq(spaceMemberships.spaceId, spaceId),
          eq(spaceMemberships.role, 'admin'),
        ),
      );

    const adminCount = countResult[0]?.count ?? 0;
    if (adminCount <= 1) {
      throw new MembershipInvariantError(
        'LAST_SPACE_ADMIN',
        'Cannot remove or demote the last admin of this space.',
      );
    }
  }

  return {
    addTenantMember,
    changeTenantRole,
    transferOwnership,
    assertRemovableTenantMember,
    removeTenantMember,
    addSpaceMember,
    changeSpaceRole,
    removeSpaceMember,
  };
}

export type MembershipService = ReturnType<typeof createMembershipService>;
