import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { McpServerDefinitionSchema } from '@aflow/schemas';
import {
  deleteMcpServerDefinition,
  getMcpServerDefinitionRow,
  listMcpServerDefinitionRows,
  upsertMcpServerDefinition,
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

      const rows = await listMcpServerDefinitionRows({
        db,
        tenantId: tenant.tenantId as string,
        spaceId: space.spaceId,
      });

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

      const row = await getMcpServerDefinitionRow({
        db,
        tenantId: tenant.tenantId as string,
        spaceId: space.spaceId,
        serverId,
      });

      if (!row) {
        reply.code(404).send({ error: `MCP server definition "${serverId}" not found` });
        return;
      }

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

      try {
        await upsertMcpServerDefinition({
          db,
          tenantId: tenant.tenantId as string,
          spaceId: space.spaceId,
          redis: getRedis(fastify),
          definition: body,
        });
      } catch (err) {
        const denial = integrationPolicyDenialPayload(err);
        if (denial) {
          reply.code(400).send(denial);
          return;
        }
        throw err;
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
        summary:
          'Delete an MCP server definition with its bindings, its space-owned OAuth tokens and ' +
          'consent state, and the credentials no other binding in the space references',
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

      await deleteMcpServerDefinition({
        db,
        tenantId: tenant.tenantId as string,
        spaceId: space.spaceId,
        redis: getRedis(fastify),
        serverId,
      });

      reply.send({ status: 'deleted' });
    },
  );
}
