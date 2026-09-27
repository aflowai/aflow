import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, guardrailPolicies } from '@aflow/database';
import {
  GuardrailPolicySchema,
  GuardrailScopeSchema,
  GuardrailRailSchema,
  GuardrailPolicySettingsSchema,
  StreamKeys,
} from '@aflow/schemas';
import { readGuardrailLog } from '@aflow/redis';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

const PolicyResponseSchema = z.object({
  id: z.string(),
  policyId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  version: z.string(),
  scope: z.record(z.unknown()),
  rails: z.array(z.record(z.unknown())),
  settings: z.record(z.unknown()).nullable(),
  tags: z.array(z.string()).nullable(),
  spaceId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function toPolicyResponse(row: Record<string, unknown>) {
  return {
    id: row['id'] as string,
    policyId: row['policyId'] as string,
    name: row['name'] as string,
    description: (row['description'] as string | null) ?? null,
    version: (row['version'] as string) ?? '1',
    scope: row['scope'] as Record<string, unknown>,
    rails: row['rails'] as Array<Record<string, unknown>>,
    settings: (row['settings'] as Record<string, unknown> | null) ?? null,
    tags: (row['tags'] as string[] | null) ?? null,
    spaceId: (row['spaceId'] as string | null) ?? null,
    createdBy: (row['createdBy'] as string | null) ?? null,
    createdAt: new Date(
      (row['createdAt'] as string) ?? (row['created_at'] as string),
    ).toISOString(),
    updatedAt: new Date(
      (row['updatedAt'] as string) ?? (row['updated_at'] as string),
    ).toISOString(),
  };
}

export const guardrailsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  // POST /v1/guardrails — Create guardrail policy
  app.post(
    '/',
    {
      schema: {
        tags: ['Guardrails'],
        summary: 'Create guardrail policy',
        body: z.object({
          policyId: z.string().min(1).max(128),
          name: z.string().min(1).max(256),
          description: z.string().max(2000).optional(),
          version: z.string().max(64).optional(),
          scope: GuardrailScopeSchema,
          rails: z.array(GuardrailRailSchema).min(1).max(100),
          settings: GuardrailPolicySettingsSchema.optional(),
          tags: z.array(z.string().max(64)).max(20).optional(),
        }),
        response: {
          201: PolicyResponseSchema,
          400: ErrorSchema,
          500: ErrorSchema,
        },
      },
      config: { authz: { resource: 'agent', action: 'write', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);

      // Validate the full policy schema
      const parsed = GuardrailPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'ValidationError',
          message: parsed.error.message,
        });
      }

      const result = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .insert(guardrailPolicies)
          .values({
            policyId: parsed.data.policyId,
            name: parsed.data.name,
            description: parsed.data.description,
            version: parsed.data.version,
            scope: parsed.data.scope,
            rails: parsed.data.rails,
            settings: parsed.data.settings,
            tags: parsed.data.tags,
            createdBy: request.authUser?.userId,
          } as typeof guardrailPolicies.$inferInsert)
          .returning();
      });

      const row = (result as Array<Record<string, unknown>>)[0];
      if (!row) {
        return reply.status(500).send({
          error: 'InternalError',
          message: 'Failed to create policy',
        });
      }

      // Publish cache invalidation
      const redis = fastify.appContext.redis;
      if (redis) {
        redis
          .publish(
            StreamKeys.guardrailInvalidateChannel(tenant.tenantId),
            JSON.stringify({ kind: 'policy_changed', policyId: parsed.data.policyId }),
          )
          .catch(() => {});
      }

      reply.status(201).send(toPolicyResponse(row));
    },
  );

  // GET /v1/guardrails — List guardrail policies
  app.get(
    '/',
    {
      schema: {
        tags: ['Guardrails'],
        summary: 'List guardrail policies',
        response: {
          200: z.object({ policies: z.array(PolicyResponseSchema) }),
        },
      },
      config: { authz: { resource: 'agent', action: 'read', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);

      const result = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx.select().from(guardrailPolicies);
      });

      const rows = result as Array<Record<string, unknown>>;
      reply.send({ policies: rows.map(toPolicyResponse) });
    },
  );

  // GET /v1/guardrails/:policyId — Get guardrail policy by ID
  app.get(
    '/:policyId',
    {
      schema: {
        tags: ['Guardrails'],
        summary: 'Get guardrail policy',
        params: z.object({ policyId: z.string() }),
        response: {
          200: PolicyResponseSchema,
          404: ErrorSchema,
        },
      },
      config: { authz: { resource: 'agent', action: 'read', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);

      const result = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .select()
          .from(guardrailPolicies)
          .where(eq(guardrailPolicies.policyId, request.params.policyId))
          .limit(1);
      });

      const row = (result as Array<Record<string, unknown>>)[0];
      if (!row) {
        return reply.status(404).send({
          error: 'NotFound',
          message: `Policy ${request.params.policyId} not found`,
        });
      }
      reply.send(toPolicyResponse(row));
    },
  );

  // PUT /v1/guardrails/:policyId — Update guardrail policy
  app.put(
    '/:policyId',
    {
      schema: {
        tags: ['Guardrails'],
        summary: 'Update guardrail policy',
        params: z.object({ policyId: z.string() }),
        body: z.object({
          name: z.string().min(1).max(256).optional(),
          description: z.string().max(2000).optional(),
          version: z.string().max(64).optional(),
          scope: GuardrailScopeSchema.optional(),
          rails: z.array(GuardrailRailSchema).min(1).max(100).optional(),
          settings: GuardrailPolicySettingsSchema.optional(),
          tags: z.array(z.string().max(64)).max(20).optional(),
        }),
        response: {
          200: PolicyResponseSchema,
          404: ErrorSchema,
          500: ErrorSchema,
        },
      },
      config: { authz: { resource: 'agent', action: 'write', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      const body = request.body;
      if (body.name !== undefined) updates['name'] = body.name;
      if (body.description !== undefined) updates['description'] = body.description;
      if (body.version !== undefined) updates['version'] = body.version;
      if (body.scope !== undefined) updates['scope'] = body.scope;
      if (body.rails !== undefined) updates['rails'] = body.rails;
      if (body.settings !== undefined) updates['settings'] = body.settings;
      if (body.tags !== undefined) updates['tags'] = body.tags;

      const result = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .update(guardrailPolicies)
          .set(updates as Partial<typeof guardrailPolicies.$inferInsert>)
          .where(eq(guardrailPolicies.policyId, request.params.policyId))
          .returning();
      });

      const row = (result as Array<Record<string, unknown>>)[0];
      if (!row) {
        return reply.status(404).send({
          error: 'NotFound',
          message: `Policy ${request.params.policyId} not found`,
        });
      }

      // Publish cache invalidation
      const redis = fastify.appContext.redis;
      if (redis) {
        redis
          .publish(
            StreamKeys.guardrailInvalidateChannel(tenant.tenantId),
            JSON.stringify({ kind: 'policy_changed', policyId: request.params.policyId }),
          )
          .catch(() => {});
      }

      reply.send(toPolicyResponse(row));
    },
  );

  // DELETE /v1/guardrails/:policyId — Delete guardrail policy
  app.delete(
    '/:policyId',
    {
      schema: {
        tags: ['Guardrails'],
        summary: 'Delete guardrail policy',
        params: z.object({ policyId: z.string() }),
        response: {
          200: z.object({ deleted: z.boolean() }),
          404: ErrorSchema,
        },
      },
      config: { authz: { resource: 'agent', action: 'write', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);

      const result = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .delete(guardrailPolicies)
          .where(eq(guardrailPolicies.policyId, request.params.policyId))
          .returning();
      });

      const rows = result as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        return reply.status(404).send({
          error: 'NotFound',
          message: `Policy ${request.params.policyId} not found`,
        });
      }

      // Publish cache invalidation
      const redis = fastify.appContext.redis;
      if (redis) {
        redis
          .publish(
            StreamKeys.guardrailInvalidateChannel(tenant.tenantId),
            JSON.stringify({ kind: 'policy_changed', policyId: request.params.policyId }),
          )
          .catch(() => {});
      }

      reply.send({ deleted: true });
    },
  );

  // GET /v1/guardrails/effective — Get effective policies for a flow (debug endpoint)
  app.get(
    '/effective',
    {
      schema: {
        tags: ['Guardrails'],
        summary: 'Get effective guardrail policies for a flow (debug endpoint)',
        querystring: z.object({
          flowId: z.string(),
          spaceId: z.string().optional(),
        }),
        response: {
          200: z.object({
            policies: z.array(PolicyResponseSchema),
            flowId: z.string(),
            tenantId: z.string(),
          }),
        },
      },
      config: { authz: { resource: 'agent', action: 'read', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const db = fastify.appContext.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenant.tenantId);

      // Load all policies and filter to those matching the scope
      const result = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx.select().from(guardrailPolicies);
      });

      const allRows = result as Array<Record<string, unknown>>;

      // Filter to matching scope (platform, tenant, space, or flow)
      const matching = allRows.filter((row) => {
        const scope = row['scope'] as Record<string, unknown> | null;
        if (!scope) return false;
        if (scope['platform']) return true;
        const tenantIds = scope['tenantIds'] as string[] | undefined;
        if (tenantIds?.includes(tenant.tenantId)) return true;
        const spaceIds = scope['spaceIds'] as string[] | undefined;
        if (request.query.spaceId && spaceIds?.includes(request.query.spaceId)) return true;
        const flowIds = scope['flowIds'] as string[] | undefined;
        if (flowIds?.includes(request.query.flowId)) return true;
        return false;
      });

      reply.send({
        policies: matching.map(toPolicyResponse),
        flowId: request.query.flowId,
        tenantId: tenant.tenantId,
      });
    },
  );
};

// Separate route for guardrail log (registered under /sessions prefix)
export const guardrailLogRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  // GET /v1/sessions/:sessionId/guardrail-log
  app.get(
    '/:sessionId/guardrail-log',
    {
      schema: {
        tags: ['Guardrails'],
        summary: 'Get guardrail check log for a session',
        params: z.object({ sessionId: z.string().uuid() }),
        querystring: z.object({
          count: z.coerce.number().int().positive().max(5000).optional(),
        }),
        response: {
          200: z.object({ checks: z.array(z.record(z.unknown())) }),
          500: ErrorSchema,
        },
      },
      config: { authz: { resource: 'session', action: 'read' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const redis = fastify.appContext.redis;

      if (!redis) {
        return reply.status(500).send({
          error: 'InternalError',
          message: 'Redis not available',
        });
      }

      const checks = await readGuardrailLog(
        redis,
        tenant.tenantId,
        request.params.sessionId,
        request.query.count ?? 1000,
      );

      reply.send({ checks });
    },
  );
};
