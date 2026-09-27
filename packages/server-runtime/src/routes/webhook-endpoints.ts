import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  webhookEndpoints,
  encryptCredentialEnvelope,
  type WebhookEndpointRow,
} from '@aflow/database';
import {
  CreateWebhookEndpointBodySchema,
  UpdateWebhookEndpointBodySchema,
  WebhookEndpointStatusSchema,
} from '@aflow/schemas';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl.js';

// ============================================================================
// Route Schemas
// ============================================================================

const ListWebhookEndpointsQuerySchema = z.object({
  status: WebhookEndpointStatusSchema.optional(),
  targetKind: z.enum(['platform-role', 'custom-agent']).optional(),
  targetSystemRole: z.string().min(1).max(64).optional(),
  targetAgentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().optional(),
});

// ============================================================================
// Routes
// ============================================================================

export const webhookEndpointRoutes: FastifyPluginAsync = (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  // POST /v1/webhook-endpoints — Create
  app.post(
    '/',
    {
      config: {
        authzExempt: {
          reason:
            'No `webhook` AuthzResourceType yet; the handler enforces tenant-admin or space-admin via requireTenant()/requireSpace().',
        },
      },
      schema: {
        tags: ['webhooks'],
        summary: 'Create a webhook endpoint',
        body: CreateWebhookEndpointBodySchema,
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      // Webhook creation requires tenant admin or space admin
      if (!tenant.isAdmin && !space.isSpaceAdmin) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Webhook endpoints can only be created by tenant or space admins',
        });
      }

      const body = request.body;

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);
      const { targetToColumns, agentTargetKey } = await import('@aflow/schemas');

      if (body.target.kind === 'custom-agent') {
        const { agents } = await import('@aflow/database');
        // Capture the narrowed agentId for use inside the transaction closure
        // — TS narrowing on `body.target` is lost across the async boundary.
        const customAgentId = body.target.agentId;
        const agentRows = await withTenantSchema(db, tenantCtx, async (tx) => {
          return tx
            .select({ id: agents.id, archivedAt: agents.archivedAt })
            .from(agents)
            .where(and(eq(agents.id, customAgentId), eq(agents.spaceId, space.spaceId)))
            .limit(1);
        });
        if (agentRows.length === 0 || agentRows[0]?.archivedAt) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: `Custom agent ${customAgentId} not found or archived in this space`,
          });
        }
      }

      // Generate and encrypt HMAC secret
      const plaintextSecret = randomBytes(32).toString('hex');
      const secretEncrypted = await encryptCredentialEnvelope(plaintextSecret);
      const { PersistentAgentTargetSchema } = await import('@aflow/schemas');
      const brandedTarget = PersistentAgentTargetSchema.parse(body.target);
      const targetCols = targetToColumns(brandedTarget);
      void agentTargetKey; // for log usage if needed

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .insert(webhookEndpoints)
          .values({
            spaceId: space.spaceId,
            targetKind: targetCols.targetKind as 'platform-role' | 'custom-agent',
            targetSystemRole: targetCols.targetSystemRole,
            targetAgentId: targetCols.targetAgentId,
            name: body.name,
            description: body.description ?? null,
            secretEncrypted,
            signatureHeader: body.signatureHeader,
            deliveryIdHeader: body.deliveryIdHeader,
            timestampHeader: body.timestampHeader,
            replayWindowSeconds: body.replayWindowSeconds,
            requireDeliveryId: body.requireDeliveryId,
            inputMapping: body.inputMapping ?? null,
            filterExpression: body.filterExpression ?? null,
            status: 'active',
            creatorUserId: request.authUser?.userId ?? null,
            creatorTenantRole: tenant.tenantRole,
            creatorSpaceRole: space.spaceRole,
            createdBy: request.authUser?.userId ?? null,
          })
          .returning();
      });

      const row = rows[0];
      if (!row) {
        return reply
          .status(500)
          .send({ error: 'Internal Server Error', message: 'Failed to create webhook endpoint' });
      }

      // Build the public URL with the real endpoint ID
      const apiBase = resolveApiBaseUrl();
      const url = `${apiBase}/v1/webhooks/ingest/${tenant.tenantId}/${row.id}`;

      // Return with plaintext secret (ONE TIME ONLY)
      return reply.status(201).send({
        ...rowToResponse(row),
        url,
        secret: plaintextSecret,
      });
    },
  );

  // GET /v1/webhook-endpoints — List
  app.get(
    '/',
    {
      config: {
        authzExempt: {
          reason:
            'No `webhook` AuthzResourceType yet; the handler enforces tenant-admin or space-admin via requireTenant()/requireSpace().',
        },
      },
      schema: {
        tags: ['webhooks'],
        summary: 'List webhook endpoints in the current space',
        querystring: ListWebhookEndpointsQuerySchema,
      },
    },
    async (request, reply) => {
      const space = await request.requireSpace();
      const tenant = await request.requireTenant();
      const { status, targetKind, targetSystemRole, targetAgentId, limit, cursor } =
        request.query as {
          status?: string;
          targetKind?: 'platform-role' | 'custom-agent';
          targetSystemRole?: string;
          targetAgentId?: string;
          limit: number;
          cursor?: string;
        };

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const conditions = [eq(webhookEndpoints.spaceId, space.spaceId)];
      if (status) {
        conditions.push(eq(webhookEndpoints.status, status));
      }
      if (targetKind) conditions.push(eq(webhookEndpoints.targetKind, targetKind));
      if (targetSystemRole)
        conditions.push(eq(webhookEndpoints.targetSystemRole, targetSystemRole));
      if (targetAgentId) conditions.push(eq(webhookEndpoints.targetAgentId, targetAgentId));
      if (cursor) conditions.push(sql`${webhookEndpoints.id} < ${cursor}`);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .select()
          .from(webhookEndpoints)
          .where(and(...conditions))
          .orderBy(desc(webhookEndpoints.createdAt))
          .limit(limit + 1);
      });

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const baseUrl = resolveApiBaseUrl();
      const endpoints = pageRows.map((r) => ({
        ...rowToResponse(r),
        url: `${baseUrl}/v1/webhooks/ingest/${tenant.tenantId}/${r.id}`,
      }));
      const lastItem = pageRows[pageRows.length - 1];

      return reply.send({
        endpoints,
        nextCursor: hasMore && lastItem ? lastItem.id : null,
      });
    },
  );

  // GET /v1/webhook-endpoints/:webhookId — Get one
  app.get(
    '/:webhookId',
    {
      config: {
        authzExempt: {
          reason:
            'No `webhook` AuthzResourceType yet; the handler enforces tenant-admin or space-admin via requireTenant()/requireSpace().',
        },
      },
      schema: {
        tags: ['webhooks'],
        summary: 'Get a webhook endpoint by ID',
        params: z.object({ webhookId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const space = await request.requireSpace();
      const tenant = await request.requireTenant();
      const { webhookId } = request.params;

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .select()
          .from(webhookEndpoints)
          .where(
            and(eq(webhookEndpoints.id, webhookId), eq(webhookEndpoints.spaceId, space.spaceId)),
          )
          .limit(1);
      });

      const row = rows[0];
      if (!row) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Webhook endpoint not found' });
      }

      const baseUrl = resolveApiBaseUrl();
      return reply.send({
        ...rowToResponse(row),
        url: `${baseUrl}/v1/webhooks/ingest/${tenant.tenantId}/${row.id}`,
      });
    },
  );

  // PATCH /v1/webhook-endpoints/:webhookId — Update
  app.patch(
    '/:webhookId',
    {
      config: {
        authzExempt: {
          reason:
            'No `webhook` AuthzResourceType yet; the handler enforces tenant-admin or space-admin via requireTenant()/requireSpace().',
        },
      },
      schema: {
        tags: ['webhooks'],
        summary: 'Update a webhook endpoint',
        params: z.object({ webhookId: z.string().uuid() }),
        body: UpdateWebhookEndpointBodySchema,
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      if (!tenant.isAdmin && !space.isSpaceAdmin) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Webhook endpoints can only be modified by tenant or space admins',
        });
      }

      const { webhookId } = request.params;
      const body = request.body;

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      let newPlaintextSecret: string | undefined;

      if (body.name !== undefined) updates['name'] = body.name;
      if (body.description !== undefined) updates['description'] = body.description;
      if (body.target !== undefined) {
        const { targetToColumns, PersistentAgentTargetSchema } = await import('@aflow/schemas');
        const cols = targetToColumns(PersistentAgentTargetSchema.parse(body.target));
        updates['targetKind'] = cols.targetKind;
        updates['targetSystemRole'] = cols.targetSystemRole;
        updates['targetAgentId'] = cols.targetAgentId;
      }
      if (body.status !== undefined) updates['status'] = body.status;
      if (body.signatureHeader !== undefined) updates['signatureHeader'] = body.signatureHeader;
      if (body.deliveryIdHeader !== undefined) updates['deliveryIdHeader'] = body.deliveryIdHeader;
      if (body.timestampHeader !== undefined) updates['timestampHeader'] = body.timestampHeader;
      if (body.replayWindowSeconds !== undefined)
        updates['replayWindowSeconds'] = body.replayWindowSeconds;
      if (body.requireDeliveryId !== undefined)
        updates['requireDeliveryId'] = body.requireDeliveryId;
      if (body.inputMapping !== undefined) updates['inputMapping'] = body.inputMapping;
      if (body.filterExpression !== undefined) updates['filterExpression'] = body.filterExpression;

      if (body.regenerateSecret) {
        newPlaintextSecret = randomBytes(32).toString('hex');
        updates['secretEncrypted'] = await encryptCredentialEnvelope(newPlaintextSecret);
      }

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .update(webhookEndpoints)
          .set(updates)
          .where(
            and(eq(webhookEndpoints.id, webhookId), eq(webhookEndpoints.spaceId, space.spaceId)),
          )
          .returning();
      });

      const row = rows[0];
      if (!row) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Webhook endpoint not found' });
      }

      const baseUrl = resolveApiBaseUrl();
      const response: Record<string, unknown> = {
        ...rowToResponse(row),
        url: `${baseUrl}/v1/webhooks/ingest/${tenant.tenantId}/${row.id}`,
      };

      // Only include secret if it was regenerated
      if (newPlaintextSecret) {
        response['secret'] = newPlaintextSecret;
      }

      return reply.send(response);
    },
  );

  // DELETE /v1/webhook-endpoints/:webhookId — Hard delete
  app.delete(
    '/:webhookId',
    {
      config: {
        authzExempt: {
          reason:
            'No `webhook` AuthzResourceType yet; the handler enforces tenant-admin or space-admin via requireTenant()/requireSpace().',
        },
      },
      schema: {
        tags: ['webhooks'],
        summary: 'Delete a webhook endpoint',
        params: z.object({ webhookId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      if (!tenant.isAdmin && !space.isSpaceAdmin) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Webhook endpoints can only be deleted by tenant or space admins',
        });
      }

      const { webhookId } = request.params;

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .delete(webhookEndpoints)
          .where(
            and(eq(webhookEndpoints.id, webhookId), eq(webhookEndpoints.spaceId, space.spaceId)),
          )
          .returning({ id: webhookEndpoints.id });
      });

      if (rows.length === 0) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Webhook endpoint not found' });
      }

      return reply.send({ deleted: true as const, webhookId });
    },
  );

  return Promise.resolve();
};

// ============================================================================
// Helpers
// ============================================================================

function rowToResponse(row: WebhookEndpointRow): Record<string, unknown> {
  const target =
    row.targetKind === 'platform-role' && row.targetSystemRole
      ? { kind: 'platform-role' as const, systemRole: row.targetSystemRole }
      : row.targetKind === 'custom-agent' && row.targetAgentId
        ? { kind: 'custom-agent' as const, agentId: row.targetAgentId }
        : null;
  return {
    id: row.id,
    spaceId: row.spaceId,
    target,
    name: row.name,
    description: row.description ?? null,
    signatureHeader: row.signatureHeader,
    deliveryIdHeader: row.deliveryIdHeader,
    timestampHeader: row.timestampHeader,
    replayWindowSeconds: row.replayWindowSeconds,
    requireDeliveryId: row.requireDeliveryId,
    inputMapping: row.inputMapping ?? null,
    filterExpression: row.filterExpression ?? null,
    status: row.status,
    lastReceivedAt: row.lastReceivedAt ? row.lastReceivedAt.toISOString() : null,
    lastError: row.lastError ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // secretEncrypted is NEVER exposed
  };
}
