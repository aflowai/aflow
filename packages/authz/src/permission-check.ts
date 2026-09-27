/**
 * Unified permission checker.
 * Implements the permission resolution flow:
 * 1. RBAC tenant role check (fast, cached)
 * 2. RBAC space role check (if spaceId provided)
 */
import type { Redis } from 'ioredis';
import type {
  PermissionCheck,
  AuthzDecision,
  AuthzConfig,
  TenantRole,
  SpaceRole,
  SpaceAccessAttributes,
} from './types.js';
import {
  checkTenantRbac,
  checkSpaceRbac,
  checkMemberUnscopedAccess,
  checkManagementRbac,
} from './rbac.js';

import { getCachedSpaceRole, setCachedSpaceRole } from './cache.js';

export interface PermissionCheckContext {
  userId: string;
  tenantId: string;
  tenantRole: TenantRole;
  redis: Redis;
  config: AuthzConfig;
  /** Function to look up space role from DB */
  loadSpaceRole: (userId: string, tenantId: string, spaceId: string) => Promise<SpaceRole | null>;
  /** Function to look up space type/owner from DB (null when the space does not exist) */
  loadSpaceAttributes: (spaceId: string) => Promise<SpaceAccessAttributes | null>;
}

/**
 * Check if the actor has permission to perform the given action.
 * Returns an AuthzDecision with the mechanism that granted/denied access.
 */
export async function checkPermission(
  ctx: PermissionCheckContext,
  check: PermissionCheck,
): Promise<AuthzDecision> {
  const { userId, tenantId, tenantRole, redis, config } = ctx;

  let spaceAttrsLoaded = false;
  let spaceAttrs: SpaceAccessAttributes | null = null;
  const loadAttrs = async (): Promise<SpaceAccessAttributes | null> => {
    if (!spaceAttrsLoaded) {
      spaceAttrs = check.spaceId ? await ctx.loadSpaceAttributes(check.spaceId) : null;
      spaceAttrsLoaded = true;
    }
    return spaceAttrs;
  };

  // Step 1: Tenant RBAC check. Space-scoped tenant grants are capped at the
  // management set on a foreign solo space — content access falls through to
  // the explicit space-membership check below. The management set itself is
  // admin authority: lower tenant roles never ride it.
  if (checkTenantRbac(tenantRole, check.resource, check.action)) {
    if (!check.spaceId) {
      return { allowed: true, mechanism: 'rbac_tenant', tenantRole, cached: false };
    }
    const attrs = await loadAttrs();
    const isTenantAdminRole = tenantRole === 'owner' || tenantRole === 'admin';
    if (isTenantAdminRole && checkManagementRbac(check.resource, check.action, attrs)) {
      return { allowed: true, mechanism: 'rbac_tenant', tenantRole, cached: false };
    }
    // A space that cannot be resolved never blocks the tenant grant — the
    // handler owns the 404.
    if (attrs === null) {
      return { allowed: true, mechanism: 'rbac_tenant', tenantRole, cached: false };
    }
    // Space content and config require an explicit membership row for
    // everyone — fall through to the space-membership check.
  }

  // Step 2: Space RBAC check (if spaceId provided)
  if (check.spaceId) {
    // Try cache first
    let spaceRole: SpaceRole | null = null;
    const cached = await getCachedSpaceRole(redis, userId, tenantId, check.spaceId);

    if (cached) {
      spaceRole = cached as SpaceRole;
    } else {
      spaceRole = await ctx.loadSpaceRole(userId, tenantId, check.spaceId);
      if (spaceRole) {
        await setCachedSpaceRole(
          redis,
          userId,
          tenantId,
          check.spaceId,
          spaceRole,
          config.rbacCacheTtlSeconds,
        );
      }
    }

    if (spaceRole && checkSpaceRbac(spaceRole, check.resource, check.action)) {
      return { allowed: true, mechanism: 'rbac_space', tenantRole, spaceRole, cached: !!cached };
    }

    // Owner shortcut — the owner invariant guarantees an admin membership
    // row, so this only matters if that row is missing; it must never lock
    // an owner out of their own space.
    const attrs = await loadAttrs();
    if (attrs !== null && attrs.ownerId === userId) {
      return {
        allowed: true,
        mechanism: 'rbac_space',
        tenantRole,
        spaceRole: 'admin',
        cached: false,
      };
    }
  }

  // Step 2b: Member unscoped access (no spaceId, tenant:member)
  if (!check.spaceId && tenantRole === 'member') {
    if (checkMemberUnscopedAccess(check.resource, check.action)) {
      return { allowed: true, mechanism: 'rbac_tenant', tenantRole, cached: false };
    }
  }

  // Denied
  return { allowed: false, mechanism: 'denied', tenantRole, cached: false };
}
