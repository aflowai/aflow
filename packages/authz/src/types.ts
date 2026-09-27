/**
 * Authorization types for the Phoenix authz package.
 */

/** Resource types that can be authorized */
export type AuthzResourceType =
  | 'tenant'
  /**
   * The bare facts a signed-in person needs to render the app at all: who
   * they are, which tenant they are in, and whether they still owe an
   * agreement.
   *
   * Held apart from `tenant` because that resource has accumulated many
   * meanings — governance policy, egress requests, host allowlists — and a
   * grant wide enough to boot the shell would carry all of them with it.
   */
  | 'tenant_self'
  /**
   * The tenant's agent-model policy: which models a space may assign to a
   * cybernetic role. Read-only for members, written by admins.
   *
   * Held apart from `tenant` for the same reason `tenant_self` is — every
   * member choosing a model has to read this, including during onboarding
   * where no space exists yet, and a grant wide enough for that must not also
   * carry egress requests and host allowlists.
   */
  | 'tenant_agent_models'
  | 'space'
  | 'space_metadata'
  | 'space_lifecycle'
  | 'space_membership'
  | 'agent'
  | 'session'
  | 'memory'
  | 'api_config'
  | 'secret'
  | 'credential';

/** Actions that can be performed on resources */
export type AuthzAction =
  'read' | 'write' | 'delete' | 'execute' | 'approve' | 'admin' | 'owner_admin';

/** Tenant roles (RBAC) */
export type TenantRole = 'owner' | 'admin' | 'member' | 'viewer' | 'billing';

/** Space roles (RBAC) */
export type SpaceRole = 'admin' | 'editor' | 'viewer';

/** Space attributes needed to scope tenant-level implicit grants. */
export interface SpaceAccessAttributes {
  ownerId: string | null;
  /** Count of explicit space_memberships rows. Solo (≤1) means owner-only. */
  memberCount: number;
}

/** Permission check request */
export interface PermissionCheck {
  resource: AuthzResourceType;
  action: AuthzAction;
  resourceId?: string;
  spaceId?: string;
}

/** Permission check result */
export interface AuthzDecision {
  allowed: boolean;
  mechanism: 'rbac_tenant' | 'rbac_space' | 'denied';
  tenantRole?: TenantRole;
  spaceRole?: SpaceRole;
  cached: boolean;
}

/** Cached role entry */
export interface CachedRole {
  role: string;
  expiresAt: number;
}

/** Configuration for the authz module. */
export interface AuthzConfig {
  /** Redis cache TTL for RBAC lookups (seconds) */
  rbacCacheTtlSeconds: number;
}
