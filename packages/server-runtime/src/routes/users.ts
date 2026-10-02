/**
 * User management endpoints.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { users, tenantMemberships } from '@aflow/database';
import {
  CURRENT_TERMS_VERSION,
  EditionSummarySchema,
  OAuthConnectionListResponseSchema,
  OAuthConsentIntegrationKindSchema,
  TermsAcceptanceRequestSchema,
  TermsAcceptanceStatusSchema,
} from '@aflow/schemas';
import { listUserOAuthConnections, disconnectUserOAuthConnection } from './oauthConnections.js';
import { getTermsAcceptanceStatus, recordTermsAcceptance } from '../services/termsAcceptance.js';
import { termsApply } from '../lib/termsApplicability.js';

const UserProfileSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

const TenantMembershipSummarySchema = z.object({
  tenantId: z.string(),
  role: z.string(),
  status: z.string(),
  joinedAt: z.string().nullable(),
});

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

export const usersRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  // GET /v1/users/me
  app.get(
    '/me',
    {
      // The gated client learns it is gated from this response, so it must be
      // reachable while gated.
      config: { authz: { resource: 'tenant_self', action: 'read' }, allowUnacceptedTerms: true },
      schema: {
        tags: ['Users'],
        summary: 'Get current user profile',
        response: {
          200: z.object({
            user: UserProfileSchema,
            tenants: z.array(TenantMembershipSummarySchema),
            termsAcceptance: TermsAcceptanceStatusSchema,
            edition: EditionSummarySchema,
          }),
          401: ErrorSchema,
          404: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      if (!db) {
        return reply
          .status(503)
          .send({ error: 'ServiceUnavailable', message: 'Database not available' });
      }

      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, request.authUser.userId))
        .limit(1);
      const user = userRows[0];
      if (!user) {
        return reply.status(404).send({ error: 'NotFound', message: 'User not found' });
      }

      const memberships = await db
        .select()
        .from(tenantMemberships)
        .where(eq(tenantMemberships.userId, request.authUser.userId));

      // Reported as not-required where the terms do not govern, because the
      // client's gate reads this and nothing else — a status saying `required`
      // would wall off an edition the server no longer enforces against.
      const termsAcceptance = termsApply(fastify.edition)
        ? await getTermsAcceptanceStatus(db, request.authUser.userId)
        : {
            required: false,
            currentVersion: CURRENT_TERMS_VERSION,
            acceptedVersion: null,
            acceptedAt: null,
          };

      reply.send({
        user: {
          userId: user.id,
          displayName: user.displayName,
          email: user.email ?? null,
          avatarUrl: user.avatarUrl ?? null,
          kind: user.kind,
          status: user.status,
          createdAt: user.createdAt.toISOString(),
        },
        tenants: memberships.map((m) => ({
          tenantId: m.tenantId,
          role: m.role,
          status: m.status,
          joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
        })),
        termsAcceptance,
        // Carried here rather than on an endpoint of its own: this is the call
        // every client already makes before it renders anything.
        edition: {
          id: fastify.edition.edition,
          surfaces: fastify.enabledSurfaces,
          lanes: {
            codeLane: fastify.edition.codeLane,
            hostLane: fastify.edition.hostLane,
            browserLane: fastify.edition.browserLane,
          },
        },
      });
    },
  );

  // POST /v1/users/me/terms-acceptance — record agreement to the current Terms.
  app.post(
    '/me/terms-acceptance',
    {
      // Clearing the gate must be reachable while gated.
      config: { authz: { resource: 'tenant_self', action: 'read' }, allowUnacceptedTerms: true },
      schema: {
        tags: ['Users'],
        summary: 'Accept the current Terms of Service',
        body: TermsAcceptanceRequestSchema,
        response: {
          200: TermsAcceptanceStatusSchema,
          401: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      if (!db) {
        return reply
          .status(503)
          .send({ error: 'ServiceUnavailable', message: 'Database not available' });
      }

      // A stale tab would otherwise record agreement to a version its user was
      // never shown.
      if (request.body.version !== CURRENT_TERMS_VERSION) {
        return reply.status(409).send({
          error: 'Conflict',
          message:
            `The Terms have changed since this page was loaded ` +
            `(showing ${request.body.version}, current is ${CURRENT_TERMS_VERSION}). ` +
            `Reload and read the current version.`,
        });
      }

      await recordTermsAcceptance(
        db,
        request.authUser.userId,
        CURRENT_TERMS_VERSION,
        request.ip || null,
      );
      reply.send(await getTermsAcceptanceStatus(db, request.authUser.userId));
    },
  );

  app.patch(
    '/me',
    {
      config: { authz: { resource: 'tenant', action: 'write' } },
      schema: {
        tags: ['Users'],
        summary: 'Update own profile',
        description: 'Allows any authenticated user to update their own display name.',
        body: z.object({
          displayName: z.string().min(1).max(255),
        }),
        response: {
          200: z.object({ message: z.string() }),
          401: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { displayName } = request.body;

      await db
        .update(users)
        .set({ displayName, updatedAt: new Date() })
        .where(eq(users.id, request.authUser.userId));

      reply.send({ message: 'Profile updated' });
    },
  );

  // GET /v1/users/me/oauth-connections — the signed-in user's OAuth connections.
  // Tenant-wide (connect-once across spaces), per-user, never exposes tokens.
  app.get(
    '/me/oauth-connections',
    {
      config: { authz: { resource: 'tenant_self', action: 'read' } },
      schema: {
        tags: ['Users'],
        summary: "List the current user's OAuth connections",
        description:
          'Returns one entry per provider the user has connected (owner_scope=user). ' +
          'Connect-once: a single entry per resource regardless of how many bindings/spaces ' +
          'replay it. Token material is never returned — only granted scopes, expiry, and status.',
        response: {
          200: OAuthConnectionListResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!request.authUser || request.authUser.isServicePrincipal) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'OAuth connections are per-human; service principals have none.',
        });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      if (!db) {
        return reply
          .status(503)
          .send({ error: 'ServiceUnavailable', message: 'Database not available' });
      }

      const connections = await listUserOAuthConnections(
        db,
        tenant.tenantId,
        request.authUser.userId,
      );
      reply.send({ connections });
    },
  );

  // DELETE /v1/users/me/oauth-connections/:integrationKind/:resourceKey —
  // disconnect: delete the user's token row so the next call re-pauses for consent.
  app.delete(
    '/me/oauth-connections/:integrationKind/:resourceKey',
    {
      config: { authz: { resource: 'tenant_self', action: 'read' } },
      schema: {
        tags: ['Users'],
        summary: "Disconnect one of the current user's OAuth connections",
        params: z.object({
          integrationKind: OAuthConsentIntegrationKindSchema,
          resourceKey: z.string().min(1).max(256),
        }),
        response: {
          200: z.object({ deleted: z.boolean() }),
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!request.authUser || request.authUser.isServicePrincipal) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'OAuth connections are per-human; service principals have none.',
        });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      if (!db) {
        return reply
          .status(503)
          .send({ error: 'ServiceUnavailable', message: 'Database not available' });
      }

      const { integrationKind, resourceKey } = request.params;
      const removed = await disconnectUserOAuthConnection(
        db,
        tenant.tenantId,
        request.authUser.userId,
        integrationKind,
        resourceKey,
      );
      if (removed === 0) {
        return reply.status(404).send({
          error: 'NotFound',
          message: `No connected account for ${integrationKind} resource "${resourceKey}".`,
        });
      }
      reply.send({ deleted: true });
    },
  );

  // GET /v1/users — list users in tenant (admin only)
  app.get(
    '/',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Users'],
        summary: 'List tenant users',
        description: 'List all users in the current tenant (admin only)',
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(100).default(20),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            users: z.array(UserProfileSchema.extend({ tenantRole: z.string() })),
          }),
          403: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!tenant.isAdmin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      if (!db) {
        return reply.send({ users: [] });
      }

      const { limit } = request.query;
      const rows = await db
        .select({
          userId: users.id,
          displayName: users.displayName,
          email: users.email,
          avatarUrl: users.avatarUrl,
          kind: users.kind,
          status: users.status,
          createdAt: users.createdAt,
          tenantRole: tenantMemberships.role,
        })
        .from(tenantMemberships)
        .innerJoin(users, eq(users.id, tenantMemberships.userId))
        .where(
          and(
            eq(tenantMemberships.tenantId, tenant.tenantId),
            eq(tenantMemberships.status, 'active'),
          ),
        )
        .limit(limit);

      reply.send({
        users: rows.map((r) => ({
          userId: r.userId,
          displayName: r.displayName,
          email: r.email ?? null,
          avatarUrl: r.avatarUrl ?? null,
          kind: r.kind,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          tenantRole: r.tenantRole,
        })),
      });
    },
  );

  // PATCH /v1/users/:userId — update user (admin only)
  app.patch(
    '/:userId',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Users'],
        summary: 'Update user',
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({
          displayName: z.string().min(1).max(255).optional(),
          status: z.enum(['active', 'suspended', 'deactivated']).optional(),
        }),
        response: {
          200: z.object({ message: z.string() }),
          403: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!tenant.isAdmin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { userId } = request.params;
      const body = request.body;

      const updates: Record<string, unknown> = {};
      if (body.displayName !== undefined) updates['displayName'] = body.displayName;
      if (body.status !== undefined) updates['status'] = body.status;
      updates['updatedAt'] = new Date();

      if (Object.keys(updates).length > 1) {
        await db.update(users).set(updates).where(eq(users.id, userId));
      }

      if (fastify.audit) {
        fastify.audit.record({
          actor: {
            userId: request.authUser!.userId,
            kind: request.authUser!.isServicePrincipal ? 'service_principal' : 'human',
            authMethod: request.authUser!.authMethod,
            tenantId: tenant.tenantId,
            tenantRole: tenant.tenantRole,
          },
          category: 'admin',
          action: 'user.update',
          outcome: 'success',
          target: { resourceType: 'user', resourceId: userId, tenantId: tenant.tenantId },
          request: { method: request.method, path: request.url, ipAddress: request.ip },
        });
      }

      reply.send({ message: 'User updated' });
    },
  );
};
