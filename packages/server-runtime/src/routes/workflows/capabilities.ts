/**
 * Space-scoped capability-gate preview for the skill designer.
 *
 * The capabilities picker grants operations to a task, but what the Runner can
 * actually invoke at run time is bounded by the space's capability profile
 * (`compileRunAccessGrant` → `enforceGrant`). This endpoint runs the real gate
 * over the operation registry for the caller's space role and returns the ops
 * that would be denied, so the designer can warn the operator instead of
 * letting them grant something that only fails once the run starts. The gate
 * logic itself is never duplicated — we call `enforceGrant`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { compileRunAccessGrant } from '@aflow/authz';
import { getAllOperations, enforceGrant } from '@aflow/schemas';
import { ErrorSchema, spaceReadAuthz, getDb } from './shared.js';

const BlockedOperationSchema = z.object({
  operationId: z.string(),
  /** The `capabilityGroupId:accessMode` pair the op needs but the profile lacks. */
  requires: z.string(),
  reason: z.string(),
});

const OperationGrantabilityResponseSchema = z.object({
  spaceRole: z.string(),
  profileId: z.string().optional(),
  blocked: z.array(BlockedOperationSchema),
});

export function registerCapabilityRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/capabilities/operations',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Operations the space capability profile would deny at run time',
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: OperationGrantabilityResponseSchema,
          401: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const authUser = request.authUser;
      if (!authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }

      const grant = await compileRunAccessGrant(
        {
          tenantId: tenant.tenantId,
          spaceId: space.spaceId,
          spaceRole: space.spaceRole,
          userId: authUser.userId,
          tenantRole: tenant.tenantRole,
          grantReason: 'start',
        },
        getDb(fastify),
      );

      const blocked: Array<z.infer<typeof BlockedOperationSchema>> = [];
      for (const [operationId, desc] of getAllOperations()) {
        if (desc.internal || !desc.agentTool) continue;
        const result = enforceGrant(
          grant,
          operationId,
          desc.mutates,
          desc.privileged ?? false,
          desc.capabilityGroupId,
          desc.accessMode,
          desc.riskModifiers,
        );
        if (!result.allowed) {
          blocked.push({
            operationId,
            requires: `${desc.capabilityGroupId}:${desc.accessMode}`,
            reason: result.reason,
          });
        }
      }

      reply.send({
        spaceRole: space.spaceRole,
        ...(grant.compiledProfileId ? { profileId: grant.compiledProfileId } : {}),
        blocked,
      });
    },
  );
}
