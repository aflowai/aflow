import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { listCoachActivityForTimeline } from '../../services/actionCenter/sources/coachActivitySource.js';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const coachActivityRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  app.get(
    '/:spaceId/coach-activity',
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
        summary: 'Coach Activity timeline',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          skillSlug: z.string().min(1).max(64).optional(),
          outcome: z.string().min(1).max(64).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                spaceId: z.string().uuid(),
                coachSessionId: z.string().nullable(),
                skillSlug: z.string().nullable(),
                triggerKind: z.string(),
                triggerCause: z.string().nullable(),
                outcome: z.string(),
                status: z.string(),
                proposalCount: z.number().int(),
                observationCount: z.number().int(),
                learningCount: z.number().int(),
                previewFailedCount: z.number().int(),
                bypassesGate: z.boolean(),
                costCents: z.number().nullable(),
                durationMs: z.number().int().nullable(),
                contextDocPath: z.string().nullable(),
                factsDocPath: z.string().nullable(),
                rationale: z.string().nullable(),
                createdAt: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const { skillSlug, outcome, limit } = request.query;
      const redis = fastify.appContext.redis;
      if (!redis) return { items: [] };
      const payloadStore = fastify.appContext.payloadStore;
      if (!payloadStore) return { items: [] };
      const rows = await listCoachActivityForTimeline(
        { db, redis, payloadStore },
        { tenantId: tenant.tenantId, spaceId },
        {
          limit,
          ...(skillSlug ? { skillSlug } : {}),
          ...(outcome ? { outcome } : {}),
        },
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          spaceId: r.spaceId,
          coachSessionId: r.coachSessionId ?? null,
          skillSlug: r.skillSlug ?? null,
          triggerKind: r.triggerKind,
          triggerCause: r.triggerCause ?? null,
          outcome: r.outcome,
          status: r.status,
          proposalCount: r.proposalCount,
          observationCount: r.observationCount,
          learningCount: r.learningCount,
          previewFailedCount: r.previewFailedCount,
          bypassesGate: r.bypassesGate,
          costCents: r.costCents !== null ? Number(r.costCents) : null,
          durationMs: r.durationMs ?? null,
          contextDocPath: r.contextDocPath ?? null,
          factsDocPath: r.factsDocPath ?? null,
          rationale: r.rationale ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );
};
