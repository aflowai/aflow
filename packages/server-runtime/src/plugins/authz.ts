import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply, RouteOptions } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { eq, and, sql } from 'drizzle-orm';
import { spaceMemberships, spaces, createTenantContext, withTenantSchema } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { CURRENT_TERMS_VERSION } from '@aflow/schemas';
import { hasAcceptedCurrentTerms, isHumanAccount } from '../services/termsAcceptance.js';
import {
  checkPermission,
  checkManagementRbac,
  checkSpaceRbac,
  PermissionDeniedError,
  getCachedSpaceAttributes,
  setCachedSpaceAttributes,
} from '@aflow/authz';
import type {
  PermissionCheckContext,
  AuthzResourceType,
  AuthzAction,
  AuthzConfig,
  SpaceRole,
  SpaceAccessAttributes,
  TenantRole as AuthzTenantRole,
} from '@aflow/authz';
import { termsApply } from '../lib/termsApplicability.js';

// ============================================================================

/**
 * Authz configuration declared per-route in `config.authz`.
 * Drives the automatic preHandler permission check.
 */
export interface RouteAuthzMetadata {
  /** Resource type being authorized */
  resource: AuthzResourceType;
  /** Action being performed */
  action: AuthzAction;
  /**
   * Where to obtain the spaceId for this check.
   * - 'requireSpace': Call request.requireSpace() and use its spaceId
   * - 'param': Extract from route params (looks for :spaceId)
   * - 'body': Extract from request body.spaceId
   * - 'none': No space context needed
   * - unset: a `:spaceId` route param scopes the check when present —
   *   space-scoped routes cannot silently escape the space-level policy
   *   (personal-space privacy) by omitting the declaration
   */
  spaceIdFrom?: 'requireSpace' | 'param' | 'body' | 'none';
  /**
   * Where to obtain the resourceId for OpenFGA sharing checks.
   * - 'param': Extract from first route param (e.g., :flowId, :runId)
   * - 'body': Extract from request body (looks for matching ${resource}Id field)
   */
  resourceIdFrom?: 'param' | 'body';
  /** Specific param name for resourceId extraction (default: inferred from resource type) */
  resourceIdParam?: string;
}

/**
 * Route authz config — either declares authz requirements or is explicitly public.
 */
export type RouteAuthzConfig =
  { public: true; authz?: never } | { public?: never; authz: RouteAuthzMetadata };

// ============================================================================
// Fastify Type Augmentation
// ============================================================================

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission: (opts: {
      resource: AuthzResourceType;
      action: AuthzAction;
      getResourceId?: (request: FastifyRequest) => string | undefined;
      getSpaceId?: (request: FastifyRequest) => string | undefined;
    }) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyContextConfig {
    authz?: RouteAuthzMetadata;
    /** Mark route as explicitly public (no auth required) */
    public?: boolean;
    /**
     * The route authorizes itself instead of through `config.authz`, because
     * the central preHandler cannot express its check — a WebSocket handshake,
     * or a resource with no `AuthzResourceType` yet.
     *
     * This is a declared debt, not a category: it keeps the route out of the
     * "silently uncovered" set so the coverage contract stays provable, and
     * `reason` is what a reviewer reads. Prefer `authz` whenever the resource
     * can be named.
     */
    authzExempt?: { reason: string };
    /**
     * Serve this route even when the user has not accepted the current Terms.
     * Only the routes that let a gated client discover and clear the gate may
     * set it — anything else would be a hole in the gate.
     */
    allowUnacceptedTerms?: boolean;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Build AuthzConfig from environment variables. */
function buildAuthzConfig(): AuthzConfig {
  return {
    rbacCacheTtlSeconds: Number(process.env['RBAC_CACHE_TTL_SECONDS'] ?? '120'),
  };
}

/** Create the loadSpaceRole callback using a Drizzle database instance. */
function makeLoadSpaceRole(
  db: PostgresJsDatabase,
): (userId: string, tenantId: string, sid: string) => Promise<SpaceRole | null> {
  return async (userId: string, tenantId: string, sid: string): Promise<SpaceRole | null> => {
    const rows = await db
      .select({ role: spaceMemberships.role })
      .from(spaceMemberships)
      .where(
        and(
          eq(spaceMemberships.userId, userId),
          eq(spaceMemberships.tenantId, tenantId),
          eq(spaceMemberships.spaceId, sid),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return row.role as SpaceRole;
  };
}

async function loadSpaceAttributesFromDb(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<SpaceAccessAttributes | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const result = await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
    return (tx as PostgresJsDatabase)
      .select({ ownerId: spaces.ownerId })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);
  });
  const row = (result as Array<{ ownerId: string | null }>)[0];
  if (!row) return null;
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.tenantId, tenantId), eq(spaceMemberships.spaceId, spaceId)));
  return {
    ownerId: row.ownerId,
    memberCount: countRows[0]?.count ?? 0,
  };
}

/**
 * Create the loadSpaceAttributes callback. Reuses the space row already
 * resolved by `requireSpace` when present on the request; otherwise a
 * Redis-cached tenant-schema lookup.
 */
function makeLoadSpaceAttributes(
  db: PostgresJsDatabase,
  redis: Redis,
  tenantId: string,
  request: FastifyRequest,
): (spaceId: string) => Promise<SpaceAccessAttributes | null> {
  return async (spaceId: string): Promise<SpaceAccessAttributes | null> => {
    const resolved = request.space;
    if (resolved?.spaceId === spaceId) {
      return { ownerId: resolved.ownerId, memberCount: resolved.memberCount };
    }

    const cached = await getCachedSpaceAttributes(redis, tenantId, spaceId).catch(() => null);
    if (cached) return cached;

    const attrs = await loadSpaceAttributesFromDb(db, tenantId, spaceId);
    if (attrs) {
      setCachedSpaceAttributes(redis, tenantId, spaceId, attrs).catch(() => {});
    }
    return attrs;
  };
}

/**
 * Degraded decision when Redis is absent: owner/admin only, and the same
 * membership-for-content rule as `checkPermission` for space-scoped checks —
 * the fallback must not become a third authority that bypasses it.
 */
export async function degradedNoRedisDecision(args: {
  tenantRole: string;
  userId: string;
  resource: AuthzResourceType;
  action: AuthzAction;
  spaceId: string | undefined;
  loadSpaceAttributes: (spaceId: string) => Promise<SpaceAccessAttributes | null>;
  loadSpaceRole?: (userId: string, tenantId: string, spaceId: string) => Promise<SpaceRole | null>;
  tenantId?: string;
}): Promise<boolean> {
  if (args.tenantRole !== 'owner' && args.tenantRole !== 'admin') return false;
  if (!args.spaceId) return true;
  const attrs = await args.loadSpaceAttributes(args.spaceId);
  if (checkManagementRbac(args.resource, args.action, attrs)) return true;
  if (attrs === null) return true;
  if (attrs.ownerId === args.userId) return true;
  if (args.loadSpaceRole && args.tenantId) {
    const role = await args.loadSpaceRole(args.userId, args.tenantId, args.spaceId);
    if (role) return checkSpaceRbac(role, args.resource, args.action);
  }
  return false;
}

/** Record an authz denial in the audit log. */
function recordDenial(
  fastify: FastifyInstance,
  request: FastifyRequest,
  resource: AuthzResourceType,
  action: AuthzAction,
  tenantId: string,
  tenantRole: string,
  resourceId?: string,
): void {
  if (!fastify.audit) return;

  const target: { resourceType: string; tenantId: string; resourceId?: string } = {
    resourceType: resource,
    tenantId,
  };
  if (resourceId !== undefined) {
    target.resourceId = resourceId;
  }

  const requestMeta: {
    method: string;
    path: string;
    ipAddress?: string;
    userAgent?: string;
  } = {
    method: request.method,
    path: request.url,
    ipAddress: request.ip,
  };
  const ua = request.headers['user-agent'];
  if (ua) {
    requestMeta.userAgent = ua;
  }

  fastify.audit.record({
    actor: {
      userId: request.authUser!.userId,
      kind: request.authUser!.isServicePrincipal ? 'service_principal' : 'human',
      authMethod: request.authUser!.authMethod,
      tenantId,
      tenantRole,
    },
    category: 'authz',
    action: `${resource}.${action}`,
    outcome: 'denied',
    target,
    request: requestMeta,
  });
}

/** Default param name for resourceId based on resource type. */
const RESOURCE_ID_PARAM_MAP: Record<string, string> = {
  flow: 'flowId',
  run: 'runId',
  space: 'spaceId',
  space_metadata: 'spaceId',
  space_lifecycle: 'spaceId',
  space_membership: 'spaceId',
  memory: 'docId',
  api_config: 'configId',
  secret: 'secretId',
};

/** Extract spaceId from request based on config. */
async function resolveSpaceId(
  request: FastifyRequest,
  authzConfig: RouteAuthzMetadata,
): Promise<string | undefined> {
  switch (authzConfig.spaceIdFrom) {
    case 'requireSpace': {
      const space = await request.requireSpace();
      return space.spaceId;
    }
    case 'param':
      return (request.params as Record<string, string>)['spaceId'];
    case 'body':
      return (request.body as Record<string, string> | null)?.['spaceId'];
    case 'none':
      return undefined;
    case undefined:
      return (request.params as Record<string, string> | undefined)?.['spaceId'];
  }
}

/** Extract resourceId from request based on config. */
function resolveResourceId(
  request: FastifyRequest,
  authzConfig: RouteAuthzMetadata,
): string | undefined {
  if (!authzConfig.resourceIdFrom) return undefined;
  const paramName = authzConfig.resourceIdParam ?? RESOURCE_ID_PARAM_MAP[authzConfig.resource];
  if (!paramName) return undefined;

  switch (authzConfig.resourceIdFrom) {
    case 'param':
      return (request.params as Record<string, string>)[paramName];
    case 'body':
      return (request.body as Record<string, string> | null)?.[paramName];
    default:
      return undefined;
  }
}

// ============================================================================
// Plugin
// ============================================================================

export const authzPlugin = fp(
  async (fastify: FastifyInstance) => {
    const authzConfig = buildAuthzConfig();
    // Strict by default: an uncovered route gets no central check at all, so
    // "warn" means the contract cannot prove what it exists to prove. The
    // escape hatch is opt-out and cannot silently apply to production.
    const strictMode =
      process.env['AUTHZ_STRICT_ROUTE_VALIDATION'] !== 'false' ||
      process.env['NODE_ENV'] === 'production';

    // ------------------------------------------------------------------
    const uncoveredRoutes: string[] = [];

    fastify.addHook('onRoute', (routeOptions: RouteOptions) => {
      const url = routeOptions.url;
      if (!url) return;

      // Only validate /v1/ routes
      if (!url.startsWith('/v1/')) return;

      // Skip HEAD routes (auto-generated by Fastify for GET routes)
      if (routeOptions.method === 'HEAD') return;

      const cfg = routeOptions.config;
      // A blank reason is not a classification — the reason is the only thing a
      // reviewer sees, so an exemption without one is indistinguishable from
      // the silence this check exists to remove.
      const isClassified =
        Boolean(cfg?.authz) || cfg?.public === true || Boolean(cfg?.authzExempt?.reason.trim());

      if (!isClassified) {
        const methods = Array.isArray(routeOptions.method)
          ? routeOptions.method.join(',')
          : routeOptions.method;
        const label = `${methods} ${url}`;
        uncoveredRoutes.push(label);

        if (strictMode) {
          throw new Error(
            `Route ${label} is not classified. Add config.authz, config.public=true, or ` +
              `config.authzExempt={reason}. (AUTHZ_STRICT_ROUTE_VALIDATION=false to downgrade to a warning)`,
          );
        }
      }
    });

    // Log uncovered routes on ready
    fastify.addHook('onReady', async () => {
      if (uncoveredRoutes.length > 0) {
        console.warn(
          `[authz] ${uncoveredRoutes.length} /v1/ routes missing authz config:\n` +
            uncoveredRoutes.map((r) => `  - ${r}`).join('\n') +
            '\nAdd config.authz or config.public=true to each route.',
        );
      }
    });

    // ------------------------------------------------------------------
    // requirePermission decorator (programmatic API)
    // ------------------------------------------------------------------
    fastify.decorate(
      'requirePermission',
      (opts: {
        resource: AuthzResourceType;
        action: AuthzAction;
        getResourceId?: (request: FastifyRequest) => string | undefined;
        getSpaceId?: (request: FastifyRequest) => string | undefined;
      }) => {
        return async (request: FastifyRequest, reply: FastifyReply) => {
          if (!request.authUser) {
            throw fastify.httpErrors.unauthorized('Authentication required');
          }
          const tenant = await request.requireTenant();
          const appCtx = fastify.appContext;

          const resourceId = opts.getResourceId?.(request);
          const spaceId = opts.getSpaceId?.(request);
          const db = appCtx.db as PostgresJsDatabase;

          if (!appCtx.redis) {
            const allowed = await degradedNoRedisDecision({
              tenantRole: tenant.tenantRole,
              userId: request.authUser.userId,
              resource: opts.resource,
              action: opts.action,
              spaceId,
              loadSpaceAttributes: (sid) =>
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mock context has no db
                db ? loadSpaceAttributesFromDb(db, tenant.tenantId, sid) : Promise.resolve(null),
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mock context has no db
              ...(db ? { loadSpaceRole: makeLoadSpaceRole(db) } : {}),
              tenantId: tenant.tenantId,
            });
            if (allowed) return;
            reply.status(403).send({
              error: 'Forbidden',
              message: `Permission denied: ${opts.resource}.${opts.action} (authz requires Redis)`,
            });
            return;
          }

          const ctx: PermissionCheckContext = {
            userId: request.authUser.userId,
            tenantId: tenant.tenantId,
            tenantRole: tenant.tenantRole as AuthzTenantRole,
            redis: appCtx.redis,
            config: authzConfig,
            loadSpaceRole: makeLoadSpaceRole(db),
            loadSpaceAttributes: makeLoadSpaceAttributes(
              db,
              appCtx.redis,
              tenant.tenantId,
              request,
            ),
          };

          const check = {
            resource: opts.resource,
            action: opts.action,
            ...(resourceId !== undefined ? { resourceId } : {}),
            ...(spaceId !== undefined ? { spaceId } : {}),
          };

          try {
            const decision = await checkPermission(ctx, check);
            if (!decision.allowed) {
              recordDenial(
                fastify,
                request,
                opts.resource,
                opts.action,
                tenant.tenantId,
                tenant.tenantRole,
                resourceId,
              );
              reply.status(403).send({
                error: 'Forbidden',
                message: `Permission denied: ${opts.resource}.${opts.action}`,
              });
            }
          } catch (err: unknown) {
            if (err instanceof PermissionDeniedError) {
              reply.status(403).send({ error: 'Forbidden', message: err.message });
              return;
            }
            throw err;
          }
        };
      },
    );

    // ------------------------------------------------------------------
    fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      const cfg = request.routeOptions.config;
      if (!cfg?.authz) return; // No authz config — skip (legacy or public route)

      const routeAuthz = cfg.authz;

      // Root-scope hooks run before route-scope ones, so the route's own
      // `authenticate` preHandler has not fired yet — authenticate here, or a
      // declared authz config is silently never enforced.
      if (!request.authUser) {
        await fastify.authenticate(request, reply);
        if (reply.sent) return;
        if (!request.authUser) return;
      }

      // Terms gate. It sits here rather than at account creation because JIT
      // provisioning mints the user (and, for the default tenant, the
      // membership) inside `authenticate` — the row exists before any screen is
      // shown, so agreement can only be enforced as a condition of *use*.
      // Every authenticated human path runs through this hook, so no entry
      // route can bypass it.
      //
      // `termsApply` is shared with the status `/users/me` reports, because the
      // client renders its consent card from that status alone.
      if (
        termsApply(fastify.edition) &&
        !cfg.allowUnacceptedTerms &&
        !request.authUser.isServicePrincipal
      ) {
        const db = fastify.appContext.db as PostgresJsDatabase | undefined;
        if (db && request.authUser.authMethod !== 'api_key') {
          const accepted = await hasAcceptedCurrentTerms(db, request.authUser.userId);
          if (!accepted && (await isHumanAccount(db, request.authUser.userId))) {
            reply.status(403).send({
              error: 'Forbidden',
              code: 'TERMS_ACCEPTANCE_REQUIRED',
              message: 'The current Terms of Service must be accepted before using the platform.',
              currentVersion: CURRENT_TERMS_VERSION,
            });
            return;
          }
        }
      }

      const tenant = await request.requireTenant();
      const appCtx = fastify.appContext;

      const spaceId = await resolveSpaceId(request, routeAuthz);
      const resourceId = resolveResourceId(request, routeAuthz);
      const db = appCtx.db as PostgresJsDatabase;

      if (!appCtx.redis) {
        const allowed = await degradedNoRedisDecision({
          tenantRole: tenant.tenantRole,
          userId: request.authUser.userId,
          resource: routeAuthz.resource,
          action: routeAuthz.action,
          spaceId,
          loadSpaceAttributes: (sid) =>
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mock context has no db
            db ? loadSpaceAttributesFromDb(db, tenant.tenantId, sid) : Promise.resolve(null),
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mock context has no db
          ...(db ? { loadSpaceRole: makeLoadSpaceRole(db) } : {}),
          tenantId: tenant.tenantId,
        });
        if (allowed) return;
        reply.status(403).send({
          error: 'Forbidden',
          message: `Permission denied: ${routeAuthz.resource}.${routeAuthz.action}`,
        });
        return;
      }

      const ctx: PermissionCheckContext = {
        userId: request.authUser.userId,
        tenantId: tenant.tenantId,
        tenantRole: tenant.tenantRole as AuthzTenantRole,
        redis: appCtx.redis,
        config: authzConfig,
        loadSpaceRole: makeLoadSpaceRole(db),
        loadSpaceAttributes: makeLoadSpaceAttributes(db, appCtx.redis, tenant.tenantId, request),
      };

      const check = {
        resource: routeAuthz.resource,
        action: routeAuthz.action,
        ...(resourceId !== undefined ? { resourceId } : {}),
        ...(spaceId !== undefined ? { spaceId } : {}),
      };

      try {
        const decision = await checkPermission(ctx, check);
        if (!decision.allowed) {
          recordDenial(
            fastify,
            request,
            routeAuthz.resource,
            routeAuthz.action,
            tenant.tenantId,
            tenant.tenantRole,
            resourceId,
          );
          reply.status(403).send({
            error: 'Forbidden',
            message: `Permission denied: ${routeAuthz.resource}.${routeAuthz.action}`,
          });
        }
      } catch (err: unknown) {
        if (err instanceof PermissionDeniedError) {
          reply.status(403).send({ error: 'Forbidden', message: err.message });
          return;
        }
        throw err;
      }
    });
  },
  { name: 'authz-plugin', dependencies: ['edition-plugin', 'auth-plugin', 'tenant-plugin'] },
);
