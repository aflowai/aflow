import type { FastifyPluginAsync } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BadRequestError } from '../lib/errors.js';
import {
  AgentIdPathParamSchema,
  AgentDefinitionSchema,
  importAgentSpec,
  exportToAgentSpec,
  validateAgentSpec,
  type AgentDefinition,
} from '@aflow/schemas';

export const interopRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  const typedApp = app as unknown as ReturnType<typeof app.withTypeProvider<ZodTypeProvider>>;

  // ==========================================================================
  // POST /v1/agents/import/agentspec
  // ==========================================================================

  typedApp.post(
    '/import/agentspec',
    {
      schema: {
        tags: ['Interop'],
        summary: 'Import an Agent Spec component as a Phoenix AgentDefinition',
        description:
          'Accepts an Agent Spec JSON (Agent, Flow, Swarm, or ManagerWorkers) and returns a Phoenix AgentDefinition.',
        body: z.record(z.unknown()),
        response: {
          200: z.object({
            agent: z.record(z.unknown()),
            warnings: z.array(z.string()),
            unresolvedSecrets: z.array(z.string()),
          }),
          400: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: { authz: { resource: 'agent', action: 'write', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      // Validate the Agent Spec input
      const validation = validateAgentSpec(request.body);
      if (!validation.ok) {
        const messages = validation.errors
          .map((e: { path: string; message: string }) => `${e.path}: ${e.message}`)
          .join('; ');
        reply.status(400).send({ error: 'InvalidAgentSpec', message: messages });
        return;
      }

      try {
        const result = importAgentSpec(validation.value);
        reply.send({
          agent: result.flow as unknown as Record<string, unknown>,
          warnings: result.warnings,
          unresolvedSecrets: result.unresolvedSecrets,
        });
      } catch (err) {
        request.log.error({ err }, 'Agent Spec import failed');
        throw new BadRequestError('Agent Spec import failed.', 'ImportFailed');
      }
    },
  );

  // ==========================================================================
  // GET /v1/agents/:agentId/export/agentspec
  // ==========================================================================

  typedApp.get(
    '/:agentId/export/agentspec',
    {
      schema: {
        tags: ['Interop'],
        summary: 'Export a Phoenix AgentDefinition as Agent Spec JSON',
        description:
          'Returns the agent converted to an Agent Spec component with optional round-trip metadata.',
        params: z.object({
          agentId: AgentIdPathParamSchema,
        }),
        querystring: z.object({
          includePhoenixMetadata: z.enum(['true', 'false']).optional(),
        }),
        response: {
          200: z.object({
            component: z.record(z.unknown()),
            warnings: z.array(z.string()),
          }),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
      config: { authz: { resource: 'agent', action: 'read', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { agentId } = request.params;
      const includePhoenixMetadata = request.query.includePhoenixMetadata !== 'false';
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

        const parseResult = AgentDefinitionSchema.safeParse(definition);
        if (!parseResult.success) {
          request.log.warn(
            { agentId, errors: parseResult.error.issues },
            'Agent definition failed schema parse for Agent Spec export',
          );
          reply
            .status(404)
            .send({ error: 'NotFound', message: `Agent ${agentId} definition is invalid` });
          return;
        }

        const flowDef: AgentDefinition = parseResult.data;
        const result = exportToAgentSpec(flowDef, { includePhoenixMetadata });

        reply.send({
          component: result.component as unknown as Record<string, unknown>,
          warnings: result.warnings,
        });
      } catch (err) {
        request.log.error({ err, agentId }, 'Failed to export agent as Agent Spec');
        reply.status(404).send({ error: 'NotFound', message: `Agent ${agentId} not found` });
      }
    },
  );
};
