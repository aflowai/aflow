import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ActiveSurfaceSnapshotSchema } from '@aflow/schemas';
import { buildActiveSurface } from '@aflow/cybernetic-runtime';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const activeSurfaceRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/:spaceId/cybernetic/active-surface',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'read',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Cybernetic'],
        summary: 'Live active-surface snapshot for a cybernetic space',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          // Scope the snapshot to a session and its descendants. Drives the
          // chat session inspector's Map tab so it surfaces only skill
          // activations belonging to the current session — including
          // completed/failed runs, with no time window.
          sessionId: z.string().uuid().optional(),
        }),
        response: { 200: ActiveSurfaceSnapshotSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const { sessionId } = request.query;
      const ctx = fastify.appContext;
      const db = ctx.db as PostgresJsDatabase;

      // Redis is required by `buildActiveSurface` (entity event read +
      // attention cache). The aggregator already returns a fallback-static
      // snapshot on internal failure, so we surface that path explicitly
      // when redis is missing rather than crashing the request.
      if (!ctx.redis) {
        return {
          spaceId,
          capturedAt: new Date().toISOString(),
          activeSurfaceVersion: 'fallback',
          capturedFrom: 'fallback-static' as const,
          freshnessReason: 'redis unavailable',
          helmsman: {
            sessionId: null,
            lifecycle: 'unknown' as const,
            mode: null,
            triggerSource: null,
            lastInteractionAt: null,
          },
          surfacedRuns: [],
          coach: {
            lifecycle: 'idle' as const,
            pendingProposals: 0,
            pendingPlatformIssues: 0,
            pendingAnomalies: 0,
          },
          recentTransitions: [],
        };
      }

      return buildActiveSurface({
        db,
        redis: ctx.redis,
        tenantId: tenant.tenantId,
        spaceId,
        ...(sessionId ? { rootSessionId: sessionId } : {}),
      });
    },
  );
};
