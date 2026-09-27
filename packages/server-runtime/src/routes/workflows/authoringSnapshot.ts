/**
 * Full-skill authoring snapshot — the server-owned read model the designer
 * edits against. Returns the workflow (incl. activation), the manifest (goal +
 * campaign contract), the eval suite, and the per-artifact version tokens the
 * save preconditions on, so a partial edit merges losslessly without clobbering
 * a concurrent change to an artifact the editor never touched.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SkillAuthoringSnapshotSchema } from '@aflow/schemas';
import { loadSkillAuthoringSnapshot } from '@aflow/cybernetic-runtime';
import { WorkflowSlugParamsSchema, spaceReadAuthz, getDb, ErrorSchema } from './shared.js';

export function registerAuthoringSnapshotRoute(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/workflows/:slug/authoring-snapshot',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Full-skill authoring snapshot (workflow + manifest + evals + version tokens)',
        params: WorkflowSlugParamsSchema,
        response: { 200: SkillAuthoringSnapshotSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const snapshot = await loadSkillAuthoringSnapshot(
        { db: getDb(fastify), tenantId: tenant.tenantId, spaceId },
        slug,
      );
      if (!snapshot) {
        return reply
          .status(404)
          .send({ error: 'NotFound', message: `Skill ${slug} not found or unreadable` });
      }
      return reply.send(snapshot);
    },
  );
}
