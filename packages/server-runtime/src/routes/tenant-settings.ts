import { recordAdminAudit } from '../lib/adminAudit.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, inArray } from 'drizzle-orm';
import { publishActionCenterWake } from '@aflow/redis';
import {
  tenants,
  egressApprovalRequests,
  oauthClients,
  encryptCredentialEnvelope,
  createTenantContext,
  withTenantSchema,
  type OauthClientRow,
} from '@aflow/database';
import {
  EgressApprovalRequestSchema,
  OAuthClientCreateInputSchema,
  OAuthClientCreateResponseSchema,
  OAuthClientDeleteResponseSchema,
  OAuthClientGetResponseSchema,
  OAuthClientListResponseSchema,
  OAuthClientRotateSecretInputSchema,
  OAuthClientRotateSecretResponseSchema,
  TenantAgentModelAllowlistSchema,
  TenantComputeDefaultsSchema,
  TenantOAuthPolicyResponseSchema,
  TenantOAuthPolicyUpdateInputSchema,
  TenantQuotasSchema,
  getOAuthIssuer,
  parseTenantQuotas,
  type TenantOAuthPolicy,
} from '@aflow/schemas';
import { classifyDbError } from '../lib/databaseErrors.js';
import { mapOAuthClientRow } from './integrations/oauth-clients.js';
import {
  allowedModelIds,
  canonicalModelId,
  isAssignableAgentModel,
} from '../lib/agentModelPolicy.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

/**
 * Which models a space may assign to a cybernetic role.
 *
 * A read every edition needs — every member picking a model makes it, and
 * onboarding makes it before any space exists — so it lives with instance
 * settings rather than with the governance surface that writes it. Its own
 * authz resource, because `tenant/read` is denied to a member and the path
 * that needs the policy most would 403.
 */
const AgentModelPolicyResponseSchema = z.object({
  modelIds: z.array(z.string()),
  source: z.enum(['tenant', 'platform']),
});

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const tenantSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/agent-models',
    {
      config: { authz: { resource: 'tenant_agent_models', action: 'read' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Models this tenant allows a space to assign to a cybernetic role',
        response: { 200: AgentModelPolicyResponseSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const rows = await db
        .select({ allowlist: tenants.agentModelAllowlist })
        .from(tenants)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .limit(1);
      const raw = rows[0]?.allowlist;
      const stored = Array.isArray(raw) ? (raw as string[]) : null;
      reply.send({
        modelIds: [...allowedModelIds(stored)],
        source: stored ? ('tenant' as const) : ('platform' as const),
      });
    },
  );
  app.put(
    '/agent-models',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Set the models a space may assign to a cybernetic role',
        description:
          'Every ref must resolve to a chat-capable catalog model. Send null to follow the platform recommendations.',
        body: z.object({ modelIds: TenantAgentModelAllowlistSchema.nullable() }),
        response: { 200: AgentModelPolicyResponseSchema, 400: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!tenant.isAdmin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;

      const requested = request.body.modelIds;
      let canonical: string[] | null = null;

      if (requested) {
        // A ref that resolves to nothing, or to a model that cannot hold a
        // conversation, would be saved as an option the picker offers and every
        // run then fails on.
        const unusable = requested.filter((ref) => !isAssignableAgentModel(ref));
        if (unusable.length > 0) {
          return reply.status(400).send({
            error: 'UNKNOWN_AGENT_MODEL',
            message:
              `Not a live chat-capable model: ${unusable.join(', ')}. ` +
              `Every entry must name a catalog model that is not deprecated.`,
          });
        }
        // Stored as catalog ids, never as the alias the admin happened to type:
        // the gates compare ids, so `luna` would enable a model the picker then
        // writes back as `gpt-5.6-luna` and the space write path refuses.
        canonical = [...new Set(requested.map((ref) => canonicalModelId(ref) ?? ref))];
      }

      const previousRows = await db
        .select({ allowlist: tenants.agentModelAllowlist })
        .from(tenants)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .limit(1);
      const previousRaw = previousRows[0]?.allowlist;
      const previous = Array.isArray(previousRaw) ? (previousRaw as string[]) : null;

      await db
        .update(tenants)
        .set({ agentModelAllowlist: canonical, updatedAt: new Date() })
        .where(eq(tenants.tenantId, tenant.tenantId));

      recordAdminAudit(
        fastify,
        request,
        tenant,
        'tenant.agent_models.update',
        { resourceType: 'tenant', resourceId: tenant.tenantId },
        { from: previous, to: canonical },
      );

      return reply.send({
        modelIds: [...allowedModelIds(canonical)],
        source: canonical ? ('tenant' as const) : ('platform' as const),
      });
    },
  );

  app.addHook('preHandler', app.authenticate);

  // GET /v1/tenant — current tenant info including defaults
  app.get(
    '/',
    {
      // Only the tenant's display name — what the shell needs to render, and
      // nothing a member should not see. Kept off `tenant/read`, which also
      // covers governance and egress surfaces.
      config: { authz: { resource: 'tenant_self', action: 'read' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Get current tenant settings',
        response: {
          200: z.object({
            tenantId: z.string(),
            name: z.string(),
            defaultSpaceId: z.string().uuid().nullable(),
            quotas: TenantQuotasSchema,
          }),
          403: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;

      const rows = await db
        .select({
          tenantId: tenants.tenantId,
          name: tenants.name,
          defaultSpaceId: tenants.defaultSpaceId,
          quotas: tenants.quotas,
        })
        .from(tenants)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .limit(1);

      const row = rows[0];
      if (!row) {
        return reply.status(403).send({ error: 'NotFound', message: 'Tenant not found' });
      }

      reply.send({
        tenantId: row.tenantId,
        name: row.name,
        defaultSpaceId: row.defaultSpaceId ?? null,
        quotas: parseTenantQuotas(row.quotas),
      });
    },
  );

  // PATCH /v1/tenant — update tenant defaults (admin only)
  app.patch(
    '/',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Update tenant settings',
        body: z.object({
          defaultSpaceId: z.string().uuid().nullable().optional(),
          quotas: TenantQuotasSchema.nullable().optional(),
        }),
        response: {
          200: z.object({
            tenantId: z.string(),
            name: z.string(),
            defaultSpaceId: z.string().uuid().nullable(),
            quotas: TenantQuotasSchema,
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

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (request.body.defaultSpaceId !== undefined) {
        updates['defaultSpaceId'] = request.body.defaultSpaceId;
      }
      if (request.body.quotas !== undefined) {
        updates['quotas'] = request.body.quotas;
      }

      const result = await db
        .update(tenants)
        .set(updates)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .returning({
          tenantId: tenants.tenantId,
          name: tenants.name,
          defaultSpaceId: tenants.defaultSpaceId,
          quotas: tenants.quotas,
        });

      const row = result[0];
      if (!row) {
        return reply.status(403).send({ error: 'NotFound', message: 'Tenant not found' });
      }

      reply.send({
        tenantId: row.tenantId,
        name: row.name,
        defaultSpaceId: row.defaultSpaceId ?? null,
        quotas: parseTenantQuotas(row.quotas),
      });
    },
  );

  // ==========================================================================

  const ComputeDefaultsResponseSchema = z.object({
    computeDefaults: TenantComputeDefaultsSchema.nullable(),
  });

  // GET /v1/tenant/compute-defaults — read tenant compute defaults
  app.get(
    '/compute-defaults',
    {
      config: { authz: { resource: 'tenant', action: 'read' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Get tenant compute egress defaults',
        response: { 200: ComputeDefaultsResponseSchema, 403: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;

      const rows = await db
        .select({ computeDefaults: tenants.computeDefaults })
        .from(tenants)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .limit(1);

      const row = rows[0] as { computeDefaults: Record<string, unknown> | null } | undefined;
      reply.send({ computeDefaults: row?.computeDefaults ?? null });
    },
  );

  // PUT /v1/tenant/compute-defaults — replace tenant compute defaults (admin only)
  app.put(
    '/compute-defaults',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Replace tenant compute egress defaults',
        body: z.object({ computeDefaults: TenantComputeDefaultsSchema.nullable() }),
        response: { 200: ComputeDefaultsResponseSchema, 403: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!tenant.isAdmin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;

      // Cast through unknown to satisfy exactOptionalPropertyTypes: Zod output
      // has `description?: string | undefined` but Drizzle $type expects `description?: string`.
      const computeDefaultsValue = request.body
        .computeDefaults as typeof tenants.computeDefaults._.data;
      const result = await db
        .update(tenants)
        .set({ computeDefaults: computeDefaultsValue, updatedAt: new Date() })
        .where(eq(tenants.tenantId, tenant.tenantId))
        .returning({ computeDefaults: tenants.computeDefaults });

      const row = result[0] as { computeDefaults: Record<string, unknown> | null } | undefined;
      reply.send({ computeDefaults: row?.computeDefaults ?? null });
    },
  );

  // GET /v1/tenant/egress-requests — list egress approval requests for this tenant
  app.get(
    '/egress-requests',
    {
      config: { authz: { resource: 'tenant', action: 'read' } },
      schema: {
        tags: ['Tenant'],
        summary: 'List egress approval requests',
        querystring: z.object({
          status: z.enum(['pending_approval', 'approved', 'rejected']).optional(),
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            requests: z.array(EgressApprovalRequestSchema),
          }),
          403: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const { status, spaceId } = request.query;

      const conditions = [
        eq(egressApprovalRequests.tenantId, tenant.tenantId),
        // Integration-host requests share the table under scope 'integration'
        // and have their own listing (/tenant/integration-host-requests).
        inArray(egressApprovalRequests.scope, ['tenant', 'space']),
      ];
      if (status) conditions.push(eq(egressApprovalRequests.status, status));
      if (spaceId) conditions.push(eq(egressApprovalRequests.spaceId, spaceId));

      const rows = await db
        .select()
        .from(egressApprovalRequests)
        .where(and(...conditions))
        .orderBy(egressApprovalRequests.requestedAt);

      reply.send({
        requests: rows.map((r) => ({
          requestId: r.requestId,
          requestedHosts: r.requestedHosts,
          scope: r.scope as 'tenant' | 'space',
          spaceId: r.spaceId ?? undefined,
          requestedBy: r.requestedBy,
          requestedAt: r.requestedAt.toISOString(),
          reason: r.reason ?? undefined,
          status: r.status as 'pending_approval' | 'approved' | 'rejected',
          reviewedBy: r.reviewedBy ?? undefined,
          reviewedAt: r.reviewedAt?.toISOString(),
        })),
      });
    },
  );

  // POST /v1/tenant/egress-requests — create an egress approval request
  app.post(
    '/egress-requests',
    {
      config: { authz: { resource: 'tenant', action: 'read' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Create an egress approval request',
        body: z.object({
          requestedHosts: z.array(z.string().max(256)).min(1).max(50),
          scope: z.enum(['tenant', 'space']).default('tenant'),
          spaceId: z.string().uuid().optional(),
          reason: z.string().max(1000).optional(),
        }),
        response: {
          201: EgressApprovalRequestSchema,
          403: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;

      const rows = await db
        .insert(egressApprovalRequests)
        .values({
          tenantId: tenant.tenantId,
          scope: request.body.scope,
          spaceId: request.body.spaceId ?? null,
          requestedHosts: request.body.requestedHosts,
          requestedBy: request.authUser?.userId ?? 'unknown',
          reason: request.body.reason ?? null,
          status: 'pending_approval',
        })
        .returning();

      const row = rows[0]!;
      if (fastify.appContext.redis) {
        publishActionCenterWake(fastify.appContext.redis, {
          source: 'egress_request',
          tenantId: tenant.tenantId,
          // A tenant-scoped request surfaces in every space of the tenant.
          ...(row.scope === 'space' && row.spaceId ? { spaceId: row.spaceId } : {}),
        });
      }
      reply.status(201).send({
        requestId: row.requestId,
        requestedHosts: row.requestedHosts,
        scope: row.scope as 'tenant' | 'space',
        spaceId: row.spaceId ?? undefined,
        requestedBy: row.requestedBy,
        requestedAt: row.requestedAt.toISOString(),
        reason: row.reason ?? undefined,
        status: row.status as 'pending_approval' | 'approved' | 'rejected',
        reviewedBy: row.reviewedBy ?? undefined,
        reviewedAt: row.reviewedAt?.toISOString(),
      });
    },
  );

  // PATCH /v1/tenant/egress-requests/:requestId — approve or reject a request (admin only)
  app.patch(
    '/egress-requests/:requestId',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Approve or reject an egress request',
        params: z.object({ requestId: z.string().uuid() }),
        body: z.object({
          status: z.enum(['approved', 'rejected']),
        }),
        response: {
          200: EgressApprovalRequestSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!tenant.isAdmin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;

      const rows = await db
        .update(egressApprovalRequests)
        .set({
          status: request.body.status,
          reviewedBy: request.authUser?.userId ?? 'admin',
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(egressApprovalRequests.requestId, request.params.requestId),
            eq(egressApprovalRequests.tenantId, tenant.tenantId),
            inArray(egressApprovalRequests.scope, ['tenant', 'space']),
          ),
        )
        .returning();

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'NotFound', message: 'Egress request not found' });
      }

      if (fastify.appContext.redis) {
        publishActionCenterWake(fastify.appContext.redis, {
          source: 'egress_request',
          tenantId: tenant.tenantId,
          ...(row.scope === 'space' && row.spaceId ? { spaceId: row.spaceId } : {}),
        });
      }
      reply.send({
        requestId: row.requestId,
        requestedHosts: row.requestedHosts,
        scope: row.scope as 'tenant' | 'space',
        spaceId: row.spaceId ?? undefined,
        requestedBy: row.requestedBy,
        requestedAt: row.requestedAt.toISOString(),
        reason: row.reason ?? undefined,
        status: row.status as 'pending_approval' | 'approved' | 'rejected',
        reviewedBy: row.reviewedBy ?? undefined,
        reviewedAt: row.reviewedAt?.toISOString(),
      });
    },
  );

  // ==========================================================================
  // OAuth default policy (Plan 185 §4.5 / §10) — the three oauth_default_*
  // columns on public.tenants. Read + update is tenant admin only.
  // ==========================================================================

  function mapTenantPolicyRow(row: {
    oauthDefaultOwnerScope: string;
    oauthDefaultClientScope: string;
    oauthAllowUserSelfConnect: boolean;
  }): TenantOAuthPolicy {
    return {
      defaultOwnerScope: row.oauthDefaultOwnerScope === 'user' ? 'user' : 'space',
      defaultClientScope: row.oauthDefaultClientScope as TenantOAuthPolicy['defaultClientScope'],
      allowUserSelfConnect: row.oauthAllowUserSelfConnect,
    };
  }

  // GET /v1/tenant/oauth-policy — read the tenant OAuth default policy.
  // Readable by any authenticated tenant member: the three default-policy
  // fields are non-secret configuration that binding authors (granted via
  // api_config:write, not tenant admin) need to seed ownership defaults.
  // Mutation stays admin-only (PATCH below).
  app.get(
    '/oauth-policy',
    {
      config: { authz: { resource: 'tenant', action: 'read' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Get the tenant OAuth default policy',
        response: { 200: TenantOAuthPolicyResponseSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;

      const rows = await db
        .select({
          oauthDefaultOwnerScope: tenants.oauthDefaultOwnerScope,
          oauthDefaultClientScope: tenants.oauthDefaultClientScope,
          oauthAllowUserSelfConnect: tenants.oauthAllowUserSelfConnect,
        })
        .from(tenants)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .limit(1);

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'NotFound', message: 'Tenant not found' });
      }
      reply.send({ policy: mapTenantPolicyRow(row) });
    },
  );

  // PATCH /v1/tenant/oauth-policy — patch the tenant OAuth default policy (admin only)
  app.patch(
    '/oauth-policy',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Update the tenant OAuth default policy (admin only)',
        body: TenantOAuthPolicyUpdateInputSchema,
        response: { 200: TenantOAuthPolicyResponseSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!tenant.isAdmin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
      }
      const db = fastify.appContext.db as PostgresJsDatabase;

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (request.body.defaultOwnerScope !== undefined) {
        updates['oauthDefaultOwnerScope'] = request.body.defaultOwnerScope;
      }
      if (request.body.defaultClientScope !== undefined) {
        updates['oauthDefaultClientScope'] = request.body.defaultClientScope;
      }
      if (request.body.allowUserSelfConnect !== undefined) {
        updates['oauthAllowUserSelfConnect'] = request.body.allowUserSelfConnect;
      }

      const rows = await db
        .update(tenants)
        .set(updates)
        .where(eq(tenants.tenantId, tenant.tenantId))
        .returning({
          oauthDefaultOwnerScope: tenants.oauthDefaultOwnerScope,
          oauthDefaultClientScope: tenants.oauthDefaultClientScope,
          oauthAllowUserSelfConnect: tenants.oauthAllowUserSelfConnect,
        });

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'NotFound', message: 'Tenant not found' });
      }
      reply.send({ policy: mapTenantPolicyRow(row) });
    },
  );

  // ==========================================================================
  // Tenant-scoped OAuth client apps (Plan 185 §10, Dimension B) — rows in the
  // per-tenant `oauth_clients` table with scope='tenant'. Tenant admin only;
  // service principals are blocked. client_secret is WRITE-ONLY (encrypted at
  // rest, never returned).
  // ==========================================================================

  const OAuthClientErrorSchema = z.object({ error: z.string() });
  const OAuthClientConflictSchema = z.object({ error: z.string(), message: z.string() });

  // GET /v1/tenant/oauth-clients — list tenant OAuth client apps
  app.get(
    '/oauth-clients',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'List OAuth client apps registered for the tenant (admin only)',
        response: { 200: OAuthClientListResponseSchema, 403: OAuthClientErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!tenant.isAdmin) {
        reply.status(403).send({ error: 'Tenant OAuth clients require tenant admin role' });
        return;
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantContext = createTenantContext(tenant.tenantId);

      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(oauthClients)
          .where(and(eq(oauthClients.scope, 'tenant'), eq(oauthClients.scopeId, tenant.tenantId)));
      })) as OauthClientRow[];

      reply.send({ clients: rows.map(mapOAuthClientRow) });
    },
  );

  // POST /v1/tenant/oauth-clients — register a tenant OAuth client app
  app.post(
    '/oauth-clients',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Register an OAuth client app for the tenant (admin only)',
        description:
          'The client_secret is encrypted at rest (AES-256-GCM envelope) and never returned.',
        body: OAuthClientCreateInputSchema.omit({ scope: true, scopeId: true }),
        response: {
          201: OAuthClientCreateResponseSchema,
          400: OAuthClientErrorSchema,
          403: OAuthClientErrorSchema,
          409: OAuthClientConflictSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'OAuth client apps can only be managed by human users' });
        return;
      }
      if (!tenant.isAdmin) {
        reply.status(403).send({ error: 'Tenant OAuth clients require tenant admin role' });
        return;
      }

      const userId = request.authUser?.userId;
      if (!userId) {
        reply.status(403).send({ error: 'Authentication required' });
        return;
      }

      const body = request.body;
      if (!getOAuthIssuer(body.issuerKey) && !body.authorizationServer) {
        reply.status(400).send({
          error: `Unknown issuer "${body.issuerKey}". Supply authorizationServer for an unregistered issuer.`,
        });
        return;
      }

      const encryptedClientSecret = body.clientSecret
        ? await encryptCredentialEnvelope(body.clientSecret)
        : null;

      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantContext = createTenantContext(tenant.tenantId);
      try {
        const rows = await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .insert(oauthClients)
            .values({
              scope: 'tenant',
              scopeId: tenant.tenantId,
              issuerKey: body.issuerKey,
              clientId: body.clientId,
              encryptedClientSecret,
              authorizationServer: body.authorizationServer ?? null,
              defaultScopesJson: body.defaultScopes ?? [],
              label: body.label,
              createdBy: userId,
            })
            .returning();
        });

        reply.status(201).send({ client: mapOAuthClientRow(rows[0]!) });
      } catch (error) {
        const classified = classifyDbError(error, 'register OAuth client');
        if (classified.statusCode === 409) {
          reply.status(409).send({
            error: 'oauth_client_conflict',
            message: `An OAuth client for issuer "${body.issuerKey}" is already registered for this tenant.`,
          });
          return;
        }
        throw classified;
      }
    },
  );

  // GET /v1/tenant/oauth-clients/:id — read a single tenant OAuth client
  app.get(
    '/oauth-clients/:id',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Get a single tenant OAuth client app (admin only)',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: OAuthClientGetResponseSchema,
          403: OAuthClientErrorSchema,
          404: OAuthClientErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      if (!tenant.isAdmin) {
        reply.status(403).send({ error: 'Tenant OAuth clients require tenant admin role' });
        return;
      }
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantContext = createTenantContext(tenant.tenantId);

      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(oauthClients)
          .where(
            and(
              eq(oauthClients.id, request.params.id),
              eq(oauthClients.scope, 'tenant'),
              eq(oauthClients.scopeId, tenant.tenantId),
            ),
          )
          .limit(1);
      })) as OauthClientRow[];

      const row = rows[0];
      if (!row) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }
      reply.send({ client: mapOAuthClientRow(row) });
    },
  );

  // POST /v1/tenant/oauth-clients/:id/rotate-secret — rotate the client secret
  app.post(
    '/oauth-clients/:id/rotate-secret',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Rotate a tenant OAuth client secret (admin only)',
        params: z.object({ id: z.string().uuid() }),
        body: OAuthClientRotateSecretInputSchema,
        response: {
          200: OAuthClientRotateSecretResponseSchema,
          403: OAuthClientErrorSchema,
          404: OAuthClientErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'OAuth client apps can only be managed by human users' });
        return;
      }
      if (!tenant.isAdmin) {
        reply.status(403).send({ error: 'Tenant OAuth clients require tenant admin role' });
        return;
      }

      const encryptedClientSecret = await encryptCredentialEnvelope(request.body.clientSecret);
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantContext = createTenantContext(tenant.tenantId);

      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .update(oauthClients)
          .set({ encryptedClientSecret, updatedAt: new Date() })
          .where(
            and(
              eq(oauthClients.id, request.params.id),
              eq(oauthClients.scope, 'tenant'),
              eq(oauthClients.scopeId, tenant.tenantId),
            ),
          )
          .returning();
      })) as OauthClientRow[];

      const row = rows[0];
      if (!row) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }
      reply.send({ client: mapOAuthClientRow(row) });
    },
  );

  // DELETE /v1/tenant/oauth-clients/:id — delete a tenant OAuth client
  app.delete(
    '/oauth-clients/:id',
    {
      config: { authz: { resource: 'tenant', action: 'admin' } },
      schema: {
        tags: ['Tenant'],
        summary: 'Delete a tenant OAuth client app (admin only)',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: OAuthClientDeleteResponseSchema,
          403: OAuthClientErrorSchema,
          404: OAuthClientErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();

      if (request.authUser?.isServicePrincipal) {
        reply.status(403).send({ error: 'OAuth client apps can only be managed by human users' });
        return;
      }
      if (!tenant.isAdmin) {
        reply.status(403).send({ error: 'Tenant OAuth clients require tenant admin role' });
        return;
      }

      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantContext = createTenantContext(tenant.tenantId);

      const deleted = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .delete(oauthClients)
          .where(
            and(
              eq(oauthClients.id, request.params.id),
              eq(oauthClients.scope, 'tenant'),
              eq(oauthClients.scopeId, tenant.tenantId),
            ),
          )
          .returning({ id: oauthClients.id });
      })) as Array<{ id: string }>;

      if (deleted.length === 0) {
        reply.status(404).send({ error: 'OAuth client not found' });
        return;
      }
      reply.send({ id: request.params.id, deleted: true });
    },
  );
};
