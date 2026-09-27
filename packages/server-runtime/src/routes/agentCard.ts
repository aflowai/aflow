import type { FastifyPluginAsync } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  AgentIdPathParamSchema,
  AgentDefinitionSchema,
  generateAgentCard,
  generatePlatformAgentCard,
  type AgentDefinition,
} from '@aflow/schemas';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl.js';

// ============================================================================
// Per-Agent Agent Card
// ============================================================================

export const flowAgentCardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  const typedApp = app as unknown as ReturnType<typeof app.withTypeProvider<ZodTypeProvider>>;

  // GET /v1/agents/:agentId/agent-card
  typedApp.get(
    '/:agentId/agent-card',
    {
      config: {
        authz: {
          resource: 'agent',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Agents'],
        summary: 'Get A2A Agent Card for an agent',
        description:
          'Returns an A2A-compatible Agent Card JSON describing the agent as a discoverable A2A agent.',
        params: z.object({
          agentId: AgentIdPathParamSchema,
        }),
        response: {
          200: z.record(z.unknown()),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { agentId } = request.params;
      const context = request.server.appContext;

      if (!context?.db) {
        reply.status(404).send({ error: 'NotFound', message: `Agent ${agentId} not found` });
        return;
      }

      try {
        const { resolveAgentPathParam, loadAgentTargetDefinition } =
          await import('@aflow/database');
        const resolved = await resolveAgentPathParam(
          context.db as PostgresJsDatabase,
          tenant.tenantId,
          space.spaceId,
          agentId,
        );
        const loaded = await loadAgentTargetDefinition(
          context.db as PostgresJsDatabase,
          tenant.tenantId,
          resolved.target,
          'latest',
        );
        const definition = loaded.definition as unknown as Record<string, unknown>;

        // Parse as AgentDefinition (best-effort — use passthrough for unknown fields)
        const parseResult = AgentDefinitionSchema.safeParse(definition);
        if (!parseResult.success) {
          request.log.warn(
            { agentId, errors: parseResult.error.issues },
            'Agent definition failed schema parse for agent card generation',
          );
          reply
            .status(404)
            .send({ error: 'NotFound', message: `Agent ${agentId} definition is invalid` });
          return;
        }

        const flowDef: AgentDefinition = parseResult.data;
        const baseUrl = resolveApiBaseUrl();

        const card = generateAgentCard(flowDef, {
          baseUrl,
          providerName: 'Phoenix Aflow',
          providerUrl: process.env['PLATFORM_URL'] ?? baseUrl,
        });

        reply.header('content-type', 'application/json');
        reply.send(card);
      } catch (err) {
        request.log.error({ err, agentId }, 'Failed to generate agent card');
        reply.status(404).send({ error: 'NotFound', message: `Agent ${agentId} not found` });
      }
    },
  );
};

// ============================================================================
// Platform-Level Agent Card (well-known)
// ============================================================================

export const wellKnownAgentCardRoutes: FastifyPluginAsync = async (app) => {
  // GET /.well-known/agent.json — no auth required
  app.get(
    '/agent.json',
    {
      schema: {
        tags: ['A2A'],
        summary: 'Platform-level A2A Agent Card',
        description:
          'Returns an A2A-compatible Agent Card describing the Phoenix platform as a discoverable agent service.',
        response: {
          200: z.record(z.unknown()),
        },
      },
    },
    async (_request, reply) => {
      const baseUrl = resolveApiBaseUrl();

      const card = generatePlatformAgentCard({
        baseUrl,
        providerName: 'Phoenix Aflow',
        providerUrl: process.env['PLATFORM_URL'] ?? baseUrl,
      });

      reply.header('content-type', 'application/json');
      reply.send(card);
    },
  );
};
