import type { FastifyRequest } from 'fastify';
import type { ActorContext } from '@aflow/schemas';
import type { TenantContext } from '../plugins/tenant.js';
import type { SpaceContext } from '../plugins/space.js';

/**
 * Builds an ActorContext from the resolved auth, tenant, and space context
 * on a Fastify request. Returns undefined if the user is not authenticated.
 *
 * Must be called AFTER `requireTenant()` and `requireSpace()` have been
 * awaited on the request so that `request.tenant` and `request.space` are
 * populated.
 */
export function buildActorContext(
  request: FastifyRequest,
  tenant: TenantContext,
  space?: SpaceContext,
): ActorContext | undefined {
  const authUser = request.authUser;
  if (!authUser) return undefined;

  const base: ActorContext = {
    userId: authUser.userId,
    kind: authUser.isServicePrincipal ? 'service_principal' : 'human',
    authMethod: authUser.authMethod,
    tenantId: tenant.tenantId,
    tenantRole: tenant.tenantRole,
    ipAddress: request.ip,
    capturedAt: new Date().toISOString(),
  };

  // Space context (only present if requireSpace() was called)
  if (space) {
    base.spaceId = space.spaceId;
    base.spaceRole = space.spaceRole;
  }

  // Optional display fields — omit rather than setting undefined
  // (exactOptionalPropertyTypes)
  if (authUser.displayName) {
    base.displayName = authUser.displayName;
  }
  if (authUser.email) {
    base.email = authUser.email;
  }

  const userAgent = request.headers['user-agent'];
  if (userAgent) {
    base.userAgent = userAgent;
  }

  if (authUser.apiKeyPrefix) {
    base.apiKeyPrefix = authUser.apiKeyPrefix;
  }

  return base;
}
