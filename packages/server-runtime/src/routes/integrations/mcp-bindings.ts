import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  mcpServerBindings,
  type McpServerBindingRow,
} from '@aflow/database';
import { McpServerBindingSchema } from '@aflow/schemas';
import {
  deleteMcpServerBinding,
  extractMcpCredentialKeys,
  McpBindingOriginNotPinnedError,
  upsertMcpServerBinding,
} from '@aflow/cybernetic-runtime';
import { McpServerBindingResponseSchema, mapMcpBindingRow } from './mcp-shared.js';
import {
  IntegrationWriteErrorSchema,
  getDb,
  getRedis,
  integrationPolicyDenialPayload,
} from './shared.js';
import {
  RequestBindingScopeSchema,
  composeStoredBindingScope,
  statedBindingScope,
} from './bindingScope.js';

export function registerMcpBindingRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/mcp/bindings',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'List MCP server bindings in the current space',
        querystring: z.object({
          serverId: z.string().optional(),
        }),
        response: {
          200: z.object({ bindings: z.array(McpServerBindingResponseSchema) }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);

      if (!db) {
        reply.send({ bindings: [] });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const query = request.query as { serverId?: string };
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        if (query.serverId) {
          return tx
            .select()
            .from(mcpServerBindings)
            .where(
              and(
                eq(mcpServerBindings.serverId, query.serverId),
                eq(mcpServerBindings.spaceId, space.spaceId),
              ),
            );
        }
        return tx
          .select()
          .from(mcpServerBindings)
          .where(eq(mcpServerBindings.spaceId, space.spaceId));
      })) as McpServerBindingRow[];

      const bindings = rows.map((row) => {
        const authJson = (row.authJson ?? {}) as Record<string, unknown>;
        return mapMcpBindingRow(
          row as Parameters<typeof mapMcpBindingRow>[0],
          extractMcpCredentialKeys(authJson),
        );
      });

      reply.send({ bindings });
    },
  );

  app.get(
    '/mcp/bindings/:bindingId',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Get MCP binding detail in the current space',
        params: z.object({ bindingId: z.string() }),
        response: {
          200: z.object({ binding: McpServerBindingResponseSchema }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { bindingId } = request.params as { bindingId: string };

      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(mcpServerBindings)
          .where(
            and(
              eq(mcpServerBindings.bindingId, bindingId),
              eq(mcpServerBindings.spaceId, space.spaceId),
            ),
          )
          .limit(1);
      })) as McpServerBindingRow[];

      if (rows.length === 0) {
        reply.code(404).send({ error: `MCP binding "${bindingId}" not found in this space` });
        return;
      }

      const row = rows[0]!;
      const authJson = (row.authJson ?? {}) as Record<string, unknown>;
      const binding = mapMcpBindingRow(
        row as Parameters<typeof mapMcpBindingRow>[0],
        extractMcpCredentialKeys(authJson),
      );
      reply.send({ binding });
    },
  );

  app.post(
    '/mcp/bindings',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Create or update an MCP server binding in the current space',
        body: McpServerBindingSchema.omit({
          createdAt: true,
          updatedAt: true,
          // Cache + pin + metadata populated by mcp.binding.test, never from caller.
          cachedTools: true,
          cachedToolsAt: true,
          pinnedOrigin: true,
          sessionMetadata: true,
          scope: true,
        }).extend({
          // Replaces the stored shape's `scope`, which requires a tenant the
          // caller cannot know.
          scope: RequestBindingScopeSchema,
        }),
        response: {
          200: z.object({ bindingId: z.string(), status: z.string() }),
          400: IntegrationWriteErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const body = request.body;

      if (!db) throw new Error('Database not configured');

      const scopeIdentity = {
        tenantId: tenant.tenantId as string,
        spaceId: space.spaceId as string,
      };
      const { scope: requestScope, ...binding } = body;

      try {
        await upsertMcpServerBinding({
          db,
          tenantId: tenant.tenantId as string,
          spaceId: space.spaceId,
          redis: getRedis(fastify),
          binding,
          scope: composeStoredBindingScope(requestScope, scopeIdentity),
          // Null when the request stated no scope, so an update keeps the
          // narrowing already stored rather than replacing it with a space-wide one.
          scopeOnUpdate: statedBindingScope(requestScope, scopeIdentity),
        });
      } catch (err) {
        const denial = integrationPolicyDenialPayload(err);
        if (denial) {
          reply.code(400).send(denial);
          return;
        }
        if (err instanceof McpBindingOriginNotPinnedError) {
          reply.code(400).send({ error: err.message });
          return;
        }
        throw err;
      }

      reply.send({ bindingId: body.bindingId, status: 'ok' });
    },
  );

  app.delete(
    '/mcp/bindings/:bindingId',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Delete an MCP server binding from the current space',
        params: z.object({ bindingId: z.string() }),
        response: {
          200: z.object({ status: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { bindingId } = request.params as { bindingId: string };

      if (!db) throw new Error('Database not configured');

      const deleted = await deleteMcpServerBinding({
        db,
        tenantId: tenant.tenantId as string,
        spaceId: space.spaceId,
        redis: getRedis(fastify),
        bindingId,
      });

      if (!deleted) {
        reply.code(404).send({ error: `MCP binding "${bindingId}" not found in this space` });
        return;
      }

      reply.send({ status: 'deleted' });
    },
  );
}
