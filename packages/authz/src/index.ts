export type {
  AuthzResourceType,
  AuthzAction,
  TenantRole,
  SpaceRole,
  PermissionCheck,
  AuthzDecision,
  CachedRole,
  AuthzConfig,
  SpaceAccessAttributes,
} from './types.js';

export {
  checkTenantRbac,
  checkSpaceRbac,
  checkMemberUnscopedAccess,
  checkManagementRbac,
  isSoloSpace,
  isForeignSoloSpace,
  canCreateSpace,
} from './rbac.js';

export {
  getCachedTenantRole,
  setCachedTenantRole,
  getCachedSpaceRole,
  setCachedSpaceRole,
  getCachedSpaceAttributes,
  setCachedSpaceAttributes,
  invalidateSpaceAttributesCache,
  invalidateRbacCache,
  publishRbacInvalidation,
  parseRbacInvalidationMessage,
  rbacKeysForInvalidation,
  RBAC_TENANT_CACHE_PREFIX,
  RBAC_SPACE_CACHE_PREFIX,
  RBAC_SPACE_ATTRS_CACHE_PREFIX,
  RBAC_INVALIDATE_CHANNEL,
  RBAC_CACHE_TTL,
  type RbacInvalidationMessage,
} from './cache.js';

export { checkPermission, type PermissionCheckContext } from './permission-check.js';

export { PermissionDeniedError } from './errors.js';

export {
  createMembershipService,
  MembershipInvariantError,
  type MembershipService,
  type MembershipServiceDeps,
  type DbOrTx,
  type PostCommitFn,
} from './membership-service.js';

export { compileRunAccessGrant, type CompileGrantContext } from './policy-compiler.js';
export { resolveSpaceRole } from './space-role.js';
