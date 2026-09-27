/**
 * Surface action endpoints.
 *
 * POST /v1/surfaces/actions — dispatch a surface action event from the client.
 *
 * Actions are routed based on their `eventType`:
 * - submit/invoke: forwarded to the orchestrator via control stream
 * - navigate/change: may be handled locally or forwarded
 * - custom: forwarded to control stream for custom handling
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SurfaceActionEventSchema } from '@aflow/schemas';
import { appendSessionEvent } from '@aflow/redis';

const SurfaceActionResponseSchema = z.object({
  ok: z.boolean(),
  eventId: z.string().optional(),
});

export const surfacesRoutes: FastifyPluginAsync = async (fastify) => {
  const server = fastify.withTypeProvider<ZodTypeProvider>();
  server.addHook('preHandler', server.authenticate);

  /**
   * POST /surfaces/actions — dispatch a surface action event.
   */
  server.post(
    '/actions',
    {
      schema: {
        body: SurfaceActionEventSchema,
        response: {
          200: SurfaceActionResponseSchema,
          503: z.object({ ok: z.literal(false) }),
        },
      },
      config: { authz: { resource: 'session', action: 'write' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const tenantId = tenant.tenantId;
      const action = request.body;

      const redis = fastify.appContext.redis;
      if (!redis) {
        return reply.code(503).send({ ok: false });
      }

      // Emit as a SessionEvent so SSE subscribers (and the orchestrator) can see it
      await appendSessionEvent(redis, tenantId, action.runId, {
        eventId: action.eventId,
        eventType: 'SurfaceUpdate' as const,
        timestamp: Date.now(),
        sessionId: action.runId,
        stepExecutionId: action.stepExecutionId,
        metadata: {
          actionEvent: true,
          surfaceId: action.surfaceId,
          componentId: action.componentId,
          eventName: action.eventName,
          eventType: action.eventType,
        },
        surfaceId: action.surfaceId,
      });

      // For invoke/submit actions, also post to control stream for orchestrator pickup
      if (action.eventType === 'invoke' || action.eventType === 'submit') {
        await redis.xadd(
          'aflow:control',
          '*',
          'type',
          'surface_action',
          'tenantId',
          tenantId,
          'runId',
          action.runId,
          'payload',
          JSON.stringify(action),
        );
      }

      return reply.send({ ok: true, eventId: action.eventId });
    },
  );
};
