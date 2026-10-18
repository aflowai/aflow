import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyPluginCallback } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SkillSearchInputSchema, SkillSearchOutputSchema } from '@aflow/schemas';
import { searchInstalledSkills } from '@aflow/cybernetic-runtime';

export const spaceAgentCapabilitiesRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/:spaceId/skills/discovery',
    {
      config: { authz: { resource: 'space', action: 'read', spaceIdFrom: 'param' } },
      schema: {
        tags: ['Spaces'],
        summary: 'Search installed skills for agent placement',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: SkillSearchInputSchema.extend({
          limit: z.coerce.number().int().min(1).max(20).default(20),
        }),
        response: { 200: SkillSearchOutputSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      return searchInstalledSkills(
        {
          db: fastify.appContext.db as PostgresJsDatabase,
          tenantId: tenant.tenantId,
          spaceId: request.params.spaceId,
        },
        request.query,
        true,
      );
    },
  );
  done();
};
