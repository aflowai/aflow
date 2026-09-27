import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, causalMeasurements } from '@aflow/database';
import { finalizeExpiredWindows } from '@aflow/cybernetic-runtime';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const causalInspectorRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  app.get(
    '/:spaceId/proposals/:proposalId/causal',
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
        summary: 'Causal measurement for a ratified proposal',
        params: z.object({
          spaceId: z.string().uuid(),
          proposalId: z.string().uuid(),
        }),
        response: {
          200: z.object({
            measurement: z
              .object({
                proposalId: z.string(),
                subjectKind: z.string(),
                subjectId: z.string(),
                ratifiedAt: z.string(),
                baselineWindow: z.object({
                  start: z.string(),
                  end: z.string(),
                }),
                postWindow: z.object({
                  start: z.string(),
                  end: z.string().nullable(),
                }),
                baselineMetrics: z.record(z.unknown()).nullable(),
                postMetrics: z.record(z.unknown()).nullable(),
                delta: z.number().nullable(),
                finalized: z.boolean(),
              })
              .nullable(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId, proposalId } = request.params;
      const tenantCtx = createTenantContext(tenant.tenantId);

      // Check-on-read finalization: if any windows for this space have
      // elapsed, finalize them before returning. This is the minimal
      // expired-window path described in the 104e follow-up plan.
      const redis = fastify.appContext.redis;
      if (redis) {
        try {
          await finalizeExpiredWindows({
            tenantId: tenant.tenantId,
            spaceId,
            db,
            redis,
          });
        } catch {
          // Best-effort — don't block the read
        }
      }

      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select()
          .from(causalMeasurements)
          .where(
            and(
              eq(causalMeasurements.spaceId, spaceId),
              eq(causalMeasurements.proposalId, proposalId),
            ),
          )
          .limit(1),
      );

      const row = rows[0];
      if (!row) {
        return { measurement: null };
      }

      const baseline = row.baselineMetrics as Record<string, unknown>;
      const post = row.postMetrics as Record<string, unknown>;
      const baselineAvg = (baseline['avgOverall'] as number | undefined) ?? null;
      const postAvg = (post['avgOverall'] as number | undefined) ?? null;
      const delta = baselineAvg !== null && postAvg !== null ? postAvg - baselineAvg : null;

      return {
        measurement: {
          proposalId: row.proposalId,
          subjectKind: row.subjectKind,
          subjectId: row.subjectId,
          ratifiedAt: row.ratifiedAt.toISOString(),
          baselineWindow: {
            start: row.baselineWindowStart.toISOString(),
            end: row.baselineWindowEnd.toISOString(),
          },
          postWindow: {
            start: row.postWindowStart.toISOString(),
            end: row.postWindowEnd?.toISOString() ?? null,
          },
          baselineMetrics: row.baselineMetrics as Record<string, unknown> | null,
          postMetrics: row.postMetrics as Record<string, unknown> | null,
          delta,
          finalized: row.deltaComputedAt !== null,
        },
      };
    },
  );
};
