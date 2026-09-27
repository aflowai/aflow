/**
 * RBAC permission matrix.
 * Maps (tenantRole, resource, action) -> allowed.
 * This is the fast path -- checked before OpenFGA.
 */
import type {
  TenantRole,
  SpaceRole,
  AuthzResourceType,
  AuthzAction,
  SpaceAccessAttributes,
} from './types.js';

/**
 * Role hierarchy: owner > admin > member > viewer
 * Higher roles inherit all permissions of lower roles.
 */
const TENANT_ROLE_LEVEL: Record<TenantRole, number> = {
  owner: 100,
  admin: 80,
  member: 50,
  viewer: 20,
  billing: 10,
};

const SPACE_ROLE_LEVEL: Record<SpaceRole, number> = {
  admin: 100,
  editor: 50,
  viewer: 20,
};

/**
 * Check if a tenant role satisfies a permission requirement.
 * Owner and admin have god-mode within the tenant.
 */
export function checkTenantRbac(
  tenantRole: TenantRole,
  _resource: AuthzResourceType,
  action: AuthzAction,
): boolean {
  const level = TENANT_ROLE_LEVEL[tenantRole];

  // Owner-only actions: ownership transfer, tenant deletion, etc.
  // Only the tenant owner (level 100) can perform these.
  if (action === 'owner_admin') return level >= 100;

  // Owner and admin: allow everything else
  if (level >= 80) return true;

  // Viewer: read-only access across the tenant, plus self-service tenant writes
  if (tenantRole === 'viewer') {
    if (action === 'read') return true;
    if (_resource === 'tenant' && action === 'write') return true;
    return false;
  }

  // Billing: only billing-related (not resource access)
  if (tenantRole === 'billing') return false;

  // Member: needs space membership for space-scoped resources
  // This function only checks tenant-level RBAC
  // Space-level checks happen separately
  if (tenantRole === 'member') {
    // Members cannot write secrets or api_configs at tenant level
    if (_resource === 'secret' || (_resource === 'api_config' && action !== 'read')) {
      return false;
    }
    // Members can read/write their own credentials (user-scope enforced in handler)
    if (_resource === 'credential') {
      return action === 'read' || action === 'write';
    }
    // Members can write tenant-scoped self-service resources (e.g., own profile)
    // Handler enforces self-only semantics.
    if (_resource === 'tenant' && action === 'write') {
      return true;
    }
    // Members read the agent-model policy to pick a model; writing it is admin.
    if (_resource === 'tenant_agent_models' && action === 'read') {
      return true;
    }
    // Conservative: require space membership
    return false;
  }

  return false;
}

/**
 * Check if a space role satisfies a permission requirement.
 */
export function checkSpaceRbac(
  spaceRole: SpaceRole,
  resource: AuthzResourceType,
  action: AuthzAction,
): boolean {
  const level = SPACE_ROLE_LEVEL[spaceRole];

  // Space admin: everything within the space
  if (level >= 100) return true;

  // Space editor: read + write + execute + approve (but not delete or admin)
  if (level >= 50) {
    // Editors can't delete or admin
    if (action === 'delete' || action === 'admin') return false;
    // Editors can't write secrets
    if (resource === 'secret' && action === 'write') return false;
    if (action === 'read' || action === 'write' || action === 'execute' || action === 'approve') {
      return true;
    }
    return false;
  }

  // Space viewer: read only
  if (level >= 20) {
    return action === 'read';
  }

  return false;
}

/** Solo space: no explicit members beyond the owner. */
export function isSoloSpace(space: Pick<SpaceAccessAttributes, 'memberCount'>): boolean {
  return space.memberCount <= 1;
}

/**
 * A solo space owned by someone else. Tenant-level implicit grants on such a
 * space are capped at the management set (`checkManagementRbac`); content
 * access requires an explicit space membership.
 */
export function isForeignSoloSpace(space: SpaceAccessAttributes, userId: string): boolean {
  return isSoloSpace(space) && space.ownerId !== userId;
}

/**
 * Management authority over a space whose content is private to its members:
 * tenant administration (governance surfaces that reference a space, e.g.
 * capability assignment), the redacted metadata projection, space lifecycle
 * (archive/unarchive/purge and their previews), and — on non-solo spaces
 * only — member administration. Space config writes and all content
 * resources are excluded; on a solo space member administration is excluded
 * too, so a tenant admin can never add anyone (themselves included) to a
 * space its owner has not shared.
 */
export function checkManagementRbac(
  resource: AuthzResourceType,
  action: AuthzAction,
  space?: Pick<SpaceAccessAttributes, 'memberCount'> | null,
): boolean {
  if (resource === 'tenant') return true;
  if (resource === 'space_metadata') return action === 'read';
  if (resource === 'space_lifecycle') return true;
  if (resource === 'space_membership') {
    return (action === 'admin' || action === 'read') && space != null && !isSoloSpace(space);
  }
  return false;
}

/** Space-creation policy: every space starts solo, so any tenant member (or above) may create one. */
export function canCreateSpace(tenantRole: TenantRole): boolean {
  return TENANT_ROLE_LEVEL[tenantRole] >= TENANT_ROLE_LEVEL.member;
}

/**
 * Check if a member (tenant:member) has implicit access when NO spaceId is present.
 * Members get limited tenant-wide access for non-space-scoped operations.
 */
export function checkMemberUnscopedAccess(
  resource: AuthzResourceType,
  action: AuthzAction,
): boolean {
  // Every member can read their own shell state. This lives here rather than
  // in the tenant-role matrix on purpose: this branch only runs when no space
  // is in play, so it cannot widen a space-scoped decision.
  if (resource === 'tenant_self' && action === 'read') {
    return true;
  }
  // The agent-model policy, which onboarding reads before any space exists.
  if (resource === 'tenant_agent_models' && action === 'read') {
    return true;
  }
  // Members can create agents (which can then be assigned to a space)
  if (resource === 'agent' && (action === 'write' || action === 'read' || action === 'execute')) {
    return true;
  }
  // Members can reach the tenant-wide space surface (list / check-slug /
  // where-is / create). Handlers filter to memberships and gate creation via
  // canCreateSpace; reads on a specific space stay space-scoped.
  if (resource === 'space' && action === 'read') {
    return true;
  }
  // Members can read their own sessions
  if (resource === 'session' && (action === 'read' || action === 'write' || action === 'approve')) {
    return true;
  }
  // Members can read/write memory at tenant level
  if (resource === 'memory' && (action === 'read' || action === 'write')) {
    return true;
  }
  // Members can read API configs
  if (resource === 'api_config' && action === 'read') {
    return true;
  }
  // Members can read/write credentials (user-scope enforcement in handler)
  if (resource === 'credential' && (action === 'read' || action === 'write')) {
    return true;
  }
  return false;
}
