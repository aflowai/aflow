import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  mcpServerBindings,
  type McpServerBindingRow,
} from '@aflow/database';
import { McpServerBindingSchema } from '@aflow/schemas';
import { publishMcpCatalogInvalidation } from '@aflow/redis';
import {
  collectMcpBindingHosts,
  enforceIntegrationHostPolicy,
  extractMcpCredentialKeys,
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

      const tenantContext = createTenantContext(tenant.tenantId);

      try {
        await enforceIntegrationHostPolicy({
          db,
          tenantId: tenant.tenantId as string,
          spaceId: space.spaceId as string,
          kind: 'mcp',
          hosts: collectMcpBindingHosts(body.auth as unknown as Record<string, unknown>),
          grantRefs: [
            { artifactType: 'mcp_binding', artifactKey: body.bindingId },
            { artifactType: 'mcp_definition', artifactKey: body.serverId },
          ],
        });
      } catch (err) {
        const denial = integrationPolicyDenialPayload(err);
        if (denial) {
          reply.code(400).send(denial);
          return;
        }
        throw err;
      }

      if (body.enabled && body.auth.type !== 'none') {
        const existing = (await withTenantSchema(db, tenantContext, async (tx) => {
          return tx
            .select({ pinnedOrigin: mcpServerBindings.pinnedOrigin })
            .from(mcpServerBindings)
            .where(
              and(
                eq(mcpServerBindings.bindingId, body.bindingId),
                eq(mcpServerBindings.spaceId, space.spaceId),
              ),
            )
            .limit(1);
        })) as Array<{ pinnedOrigin: string | null }>;

        const pinnedOrigin = existing[0]?.pinnedOrigin ?? null;
        if (!pinnedOrigin) {
          reply.code(400).send({
            error:
              `Binding "${body.bindingId}" has auth.type="${body.auth.type}" and cannot be ` +
              `enabled without a pinned origin. Upsert with enabled: false first, then run ` +
              `mcp.binding.test to populate pinnedOrigin, then upsert again with enabled: true.`,
          });
          return;
        }
      }

      const scopeIdentity = {
        tenantId: tenant.tenantId as string,
        spaceId: space.spaceId as string,
      };
      const scopeWithSpace = composeStoredBindingScope(body.scope, scopeIdentity);
      // Null when the request stated no scope, so the update below keeps the
      // narrowing already stored rather than replacing it with a space-wide one.
      const scopeStated = statedBindingScope(body.scope, scopeIdentity);

      await withTenantSchema(db, tenantContext, async (tx) => {
        await tx.execute(sql`
          INSERT INTO mcp_server_bindings (
            binding_id, server_id, name, description, space_id,
            scope_json, auth_json, connection_policy_json,
            subscribe_list_changed, sampling_policy,
            owner_scope, client_scope,
            enabled
          )
          VALUES (
            ${body.bindingId},
            ${body.serverId},
            ${body.name},
            ${body.description ?? null},
            ${space.spaceId}::uuid,
            ${JSON.stringify(scopeWithSpace)}::jsonb,
            ${JSON.stringify(body.auth)}::jsonb,
            ${JSON.stringify(body.connectionPolicy ?? {})}::jsonb,
            ${!body.subscribeListChanged ? 0 : 1},
            ${body.samplingPolicy ?? 'off'},
            ${body.ownerScope ?? 'tenant'},
            ${body.clientScope ?? 'platform'},
            ${!body.enabled ? 0 : 1}
          )
          ON CONFLICT (binding_id, space_id) DO UPDATE SET
            server_id = EXCLUDED.server_id,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            scope_json = COALESCE(${scopeStated === null ? null : JSON.stringify(scopeStated)}::jsonb, mcp_server_bindings.scope_json),
            auth_json = EXCLUDED.auth_json,
            connection_policy_json = EXCLUDED.connection_policy_json,
            subscribe_list_changed = EXCLUDED.subscribe_list_changed,
            sampling_policy = EXCLUDED.sampling_policy,
            owner_scope = EXCLUDED.owner_scope,
            client_scope = EXCLUDED.client_scope,
            enabled = EXCLUDED.enabled,
            updated_at = NOW()
        `);
      });

      const redis = getRedis(fastify);
      if (redis) {
        publishMcpCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'binding',
          serverId: body.serverId,
          bindingId: body.bindingId,
        });
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

      const tenantContext = createTenantContext(tenant.tenantId);

      // Find the row in THIS space first so we can include serverId in the
      // invalidation event and avoid touching another space's row.
      const existing = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select({ serverId: mcpServerBindings.serverId })
          .from(mcpServerBindings)
          .where(
            and(
              eq(mcpServerBindings.bindingId, bindingId),
              eq(mcpServerBindings.spaceId, space.spaceId),
            ),
          )
          .limit(1);
      })) as Array<{ serverId: string }>;

      if (existing.length === 0) {
        reply.code(404).send({ error: `MCP binding "${bindingId}" not found in this space` });
        return;
      }

      const serverId = existing[0]!.serverId;

      await withTenantSchema(db, tenantContext, async (tx) => {
        // OAuth tokens are owner-keyed on (integration_kind, resource_key=serverId,
        // owner_scope, owner_id) — connect-once, shared across every binding to the
        // same server (Plan 185 §3.3). Deleting one binding must NOT delete that
        // shared token; another binding (or the same owner in another space) may
        // still use it. Server-delete handles server-wide token teardown.
        await tx.execute(
          sql`DELETE FROM mcp_server_bindings WHERE binding_id = ${bindingId} AND space_id = ${space.spaceId}::uuid`,
        );
      });

      const redis = getRedis(fastify);
      if (redis) {
        publishMcpCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'binding',
          serverId,
          bindingId,
        });
      }

      reply.send({ status: 'deleted' });
    },
  );
}
