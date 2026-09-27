import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq, and, sql } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  mcpServerDefinitions,
  type McpServerDefinitionRow,
} from '@aflow/database';
import { McpServerDefinitionSchema } from '@aflow/schemas';
import { publishMcpCatalogInvalidation } from '@aflow/redis';
import {
  collectMcpServerHosts,
  deleteMcpIntegration,
  enforceIntegrationHostPolicy,
} from '@aflow/cybernetic-runtime';
import { McpServerDefinitionResponseSchema, mapMcpDefinitionRow } from './mcp-shared.js';
import {
  IntegrationWriteErrorSchema,
  getDb,
  getRedis,
  integrationPolicyDenialPayload,
} from './shared.js';

export function registerMcpServerRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/mcp/servers',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'List MCP server definitions',
        response: {
          200: z.object({
            definitions: z.array(McpServerDefinitionResponseSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);

      if (!db) {
        reply.send({ definitions: [] });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(mcpServerDefinitions)
          .where(eq(mcpServerDefinitions.spaceId, space.spaceId));
      })) as McpServerDefinitionRow[];

      const definitions = rows.map((row) =>
        mapMcpDefinitionRow(row as Parameters<typeof mapMcpDefinitionRow>[0]),
      );
      reply.send({ definitions });
    },
  );

  app.get(
    '/mcp/servers/:serverId',
    {
      config: { authz: { resource: 'api_config', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Get MCP server definition detail',
        params: z.object({ serverId: z.string() }),
        response: {
          200: z.object({ definition: z.record(z.unknown()) }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const { serverId } = request.params as { serverId: string };

      if (!db) {
        reply.code(404).send({ error: 'Database not configured' });
        return;
      }

      const tenantContext = createTenantContext(tenant.tenantId);
      const rows = (await withTenantSchema(db, tenantContext, async (tx) => {
        return tx
          .select()
          .from(mcpServerDefinitions)
          .where(
            and(
              eq(mcpServerDefinitions.serverId, serverId),
              eq(mcpServerDefinitions.spaceId, space.spaceId),
            ),
          )
          .limit(1);
      })) as McpServerDefinitionRow[];

      if (rows.length === 0) {
        reply.code(404).send({ error: `MCP server definition "${serverId}" not found` });
        return;
      }

      const row = rows[0]!;
      const defJson = row.definitionJson ?? {};

      reply.send({
        definition: {
          serverId: row.serverId,
          name: row.name,
          description: row.description ?? null,
          serverUrl: row.serverUrl,
          transport: row.transport,
          tags: row.tags ?? [],
          source: row.source,
          enabled: (row.enabled ?? 1) === 1,
          ...(defJson as Record<string, unknown>),
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        },
      });
    },
  );

  app.post(
    '/mcp/servers',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Create or update an MCP server definition',
        body: McpServerDefinitionSchema.omit({ createdAt: true, updatedAt: true }),
        response: {
          200: z.object({ serverId: z.string(), status: z.string() }),
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
      const definitionJson: Record<string, unknown> = { ...body };

      try {
        await enforceIntegrationHostPolicy({
          db,
          tenantId: tenant.tenantId as string,
          spaceId: space.spaceId as string,
          kind: 'mcp',
          hosts: collectMcpServerHosts(body),
          grantRefs: [{ artifactType: 'mcp_definition', artifactKey: body.serverId }],
        });
      } catch (err) {
        const denial = integrationPolicyDenialPayload(err);
        if (denial) {
          reply.code(400).send(denial);
          return;
        }
        throw err;
      }

      await withTenantSchema(db, tenantContext, async (tx) => {
        await tx.execute(sql`
          INSERT INTO mcp_server_definitions (
            server_id, name, description, server_url, transport,
            definition_json, tags, source, enabled, space_id
          )
          VALUES (
            ${body.serverId},
            ${body.name},
            ${body.description ?? null},
            ${body.serverUrl},
            ${body.transport ?? 'streamable_http'},
            ${JSON.stringify(definitionJson)}::jsonb,
            ${JSON.stringify(body.tags ?? [])}::jsonb,
            ${body.source ?? 'custom'},
            1,
            ${space.spaceId}::uuid
          )
          ON CONFLICT (server_id, space_id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            server_url = EXCLUDED.server_url,
            transport = EXCLUDED.transport,
            definition_json = EXCLUDED.definition_json,
            tags = EXCLUDED.tags,
            source = EXCLUDED.source,
            updated_at = NOW()
        `);
      });

      const redis = getRedis(fastify);
      if (redis) {
        publishMcpCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'definition',
          serverId: body.serverId,
        });
      }

      reply.send({ serverId: body.serverId, status: 'ok' });
    },
  );

  app.delete(
    '/mcp/servers/:serverId',
    {
      config: { authz: { resource: 'api_config', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Integrations'],
        summary: 'Delete an MCP server definition',
        params: z.object({ serverId: z.string() }),
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
      const { serverId } = request.params as { serverId: string };

      if (!db) throw new Error('Database not configured');

      const tenantContext = createTenantContext(tenant.tenantId);

      await withTenantSchema(db, tenantContext, async (tx) =>
        deleteMcpIntegration(tx, space.spaceId, serverId),
      );

      const redis = getRedis(fastify);
      if (redis) {
        publishMcpCatalogInvalidation(redis, tenant.tenantId as string, space.spaceId, {
          kind: 'definition',
          serverId,
        });
      }

      reply.send({ status: 'deleted' });
    },
  );
}
