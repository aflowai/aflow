/**
 * The space's plan as the operator reads it (Plan 322 P3). The route reads
 * through the plan engine, the one authority the Helmsman's `plan.node.*`
 * operations call too (D7), so the operator sees the tree those write.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PlanTreeOutputSchema } from '@aflow/schemas';
import { createPlanNodeStore, readPlanTrees } from '@aflow/cybernetic-runtime';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const planRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/:spaceId/plan',
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
        tags: ['Spaces'],
        summary:
          "The space's plan: every tree, each node nested under its parent with its outcome, links and runs in flight",
        params: z.object({ spaceId: z.string().uuid() }),
        response: { 200: PlanTreeOutputSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const store = createPlanNodeStore(
        fastify.appContext.db as PostgresJsDatabase,
        tenant.tenantId,
      );
      return readPlanTrees({ store, spaceId });
    },
  );
};
