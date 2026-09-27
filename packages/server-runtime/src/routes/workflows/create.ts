/**
 * Operator skill creation. Builds a minimal valid starter skill and applies it
 * through the same create authority the agent uses (a ratified `skill_compose`
 * change → `applySkillComposeBundle`). Lands the operator in the designer on
 * the new slug.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { cloneOperatorSkill, createOperatorSkill } from '../../services/operatorSkillCreate.js';
import { spaceWriteAuthz, getDb } from './shared.js';

const SpaceParamsSchema = z.object({ spaceId: z.string().uuid() });
const ErrorBody = z.object({ error: z.string(), message: z.string() });

export function registerSkillCreateRoute(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/:spaceId/skills',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Create a new skill from a starter template',
        params: SpaceParamsSchema,
        body: z.object({
          name: z.string().min(1).max(120),
          goal: z.string().min(1).max(2000),
          archetype: z.enum(['process', 'project']),
        }),
        response: {
          200: z.object({ slug: z.string() }),
          401: ErrorBody,
          409: ErrorBody,
          422: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const authUser = request.authUser;
      if (!authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      // Use the route param — the exact resource `spaceWriteAuthz` gated — so the
      // skill is created where authorization was checked (not the X-Space-ID
      // header, which `requireSpace()` would resolve and could diverge).
      const { spaceId } = request.params;
      const { name, goal, archetype } = request.body;

      const result = await createOperatorSkill({
        tenantId: tenant.tenantId,
        spaceId,
        name,
        goal,
        archetype,
        operatorUserId: authUser.userId,
        db: getDb(fastify),
      });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.code, message: result.detail });
      }
      return reply.send({ slug: result.slug });
    },
  );

  app.post(
    '/:spaceId/skills/:slug/clone',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Clone a skill under a new name',
        params: z.object({ spaceId: z.string().uuid(), slug: z.string().min(1).max(64) }),
        body: z.object({ name: z.string().min(1).max(120) }),
        response: {
          200: z.object({ slug: z.string() }),
          401: ErrorBody,
          404: ErrorBody,
          409: ErrorBody,
          422: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const authUser = request.authUser;
      if (!authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      const { spaceId, slug: sourceSlug } = request.params;
      const { name } = request.body;

      const result = await cloneOperatorSkill({
        tenantId: tenant.tenantId,
        spaceId,
        sourceSlug,
        name,
        operatorUserId: authUser.userId,
        db: getDb(fastify),
      });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.code, message: result.detail });
      }
      return reply.send({ slug: result.slug });
    },
  );
}
