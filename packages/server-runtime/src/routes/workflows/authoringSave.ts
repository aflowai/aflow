/**
 * Lossless full-skill save — the operator authority for editing a skill's
 * workflow + manifest (goal / campaign contract) together. Merges a partial
 * edit against the locked current docs under per-artifact version preconditions
 * (a concurrent change to an untouched artifact is rejected, not clobbered),
 * transactionally. Eval edits stay on the `eval.criterion.*` op path.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { applySkillSurfacePatch } from '@aflow/cybernetic-runtime';
import { SkillValiditySchema } from '@aflow/schemas';
import { WorkflowSlugParamsSchema, spaceWriteAuthz, getDb } from './shared.js';

const ErrorBody = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export function registerAuthoringSaveRoute(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.put(
    '/:spaceId/workflows/:slug/authoring',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Save a partial full-skill edit (workflow + goal/contract) losslessly',
        params: WorkflowSlugParamsSchema,
        body: z.object({
          tokens: z.object({
            workflowRevision: z.number().int().nonnegative().optional(),
            manifestHash: z.string().nullable().optional(),
          }),
          workflow: z.record(z.unknown()).optional(),
          manifest: z
            .object({ goal: z.unknown().optional(), campaign: z.unknown().optional() })
            .optional(),
        }),
        response: {
          200: z.object({
            ok: z.literal(true),
            newRevision: z.number(),
            contractValidity: SkillValiditySchema,
          }),
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
      const { spaceId, slug } = request.params;
      const { tokens, workflow, manifest } = request.body;

      const result = await applySkillSurfacePatch(
        { db: getDb(fastify), tenantId: tenant.tenantId, spaceId },
        {
          slug,
          tokens,
          ...(workflow ? { workflow } : {}),
          ...(manifest ? { manifest } : {}),
        },
      );
      if (!result.ok) {
        return reply.status(result.status).send({
          error: result.code,
          message: result.detail,
          ...(result.details ? { details: result.details } : {}),
        });
      }
      return reply.send({
        ok: true as const,
        newRevision: result.newRevision,
        contractValidity: result.validity,
      });
    },
  );
}
