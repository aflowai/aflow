/**
 * The operator's actions on the space's models on this computer: load one
 * before it is first needed, or unload one to give the machine its memory
 * back (Plan 323 D10). Operator-only REST, never an operation: no agent loads
 * gigabytes or evicts the model a run is on.
 *
 * Registered in every edition and refused outside the local one, where no
 * model runs on the operator's machine.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { contextWindowForModel, createDefaultModelCatalog } from '@aflow/ai-client';
import type { Redis } from '@aflow/redis';
import { resolveSpaceLocalRuntime } from '../lib/localRuntime.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

export const localModelRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/:spaceId/local-models/:action',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Load or unload a model on this computer',
        params: z.object({ spaceId: z.string().uuid(), action: z.enum(['warm', 'unload']) }),
        body: z.object({ model: z.string().min(1) }),
        response: {
          200: z.object({
            model: z.string(),
            action: z.enum(['warm', 'unload']),
            window: z.number().nullable(),
          }),
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          502: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (fastify.edition.edition !== 'community-local') {
        return reply.status(404).send({
          error: 'NotFound',
          message:
            'Models on this computer belong to the local edition, which runs on the machine they run on.',
        });
      }
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { spaceId, action } = request.params;
      const model = createDefaultModelCatalog().getModel(request.body.model);
      if (model?.provider !== 'ollama') {
        return reply.status(400).send({
          error: 'NotLocal',
          message: `${request.body.model} is not a model on this computer.`,
        });
      }
      const runtime = await resolveSpaceLocalRuntime({
        db: fastify.appContext.db as PostgresJsDatabase,
        redis: fastify.appContext.redis as Redis | undefined,
        tenantId: tenant.tenantId as string,
        userId: request.authUser?.userId as string,
        spaceId,
      });
      if (!runtime) {
        return reply.status(409).send({
          error: 'NoConnection',
          message: 'This space has no Ollama connection. Add one under Settings → Credentials.',
        });
      }
      const tag = model.providerModelId ?? model.id;
      const window = action === 'warm' ? contextWindowForModel(model, runtime.config) : null;
      try {
        if (window !== null) await runtime.client.warm(tag, window);
        else await runtime.client.unload(tag);
      } catch (error) {
        return reply.status(502).send({
          error: 'RuntimeError',
          message: `Ollama did not ${action === 'warm' ? 'load' : 'unload'} ${tag}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      return reply.send({ model: model.id, action, window });
    },
  );
};
