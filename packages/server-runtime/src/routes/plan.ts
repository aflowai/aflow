/**
 * The space's plan as the operator reads and writes it (Plan 322 P3). Both go
 * through the plan engine, the one authority the Helmsman's `plan.node.*`
 * operations call too (D7), so the operator sees the tree those write and a
 * write of theirs is judged by the same rules — the revision compare-and-set
 * of D6 above all.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  PlanNodeCloseInputSchema,
  PlanNodeRefusalDetailsSchema,
  PlanNodeUpdateOutputSchema,
  PlanNodeWriteRefusalSchema,
  PlanTreeOutputSchema,
  type PlanNodeWriteRefusal,
} from '@aflow/schemas';
import {
  createPlanNodeStore,
  readPlanTrees,
  updatePlanNode,
  type PlanOpError,
} from '@aflow/cybernetic-runtime';
import { requireOperatorPrincipal } from '../lib/operatorPrincipal.js';

const OPERATOR_ONLY_PLAN_WRITE =
  'The plan page writes as the person signed in. An agent writes the plan through plan.node.update, and only the Helmsman holds it; a run never rewrites the plan it serves.';

/**
 * An engine refusal in the operator's words. A stale or unchanged write
 * carries the node as it now stands, so the page can say what changed and
 * write again against the current revision.
 */
function refusalBody(refusal: PlanOpError, expectedRevision: number): PlanNodeWriteRefusal {
  const current = PlanNodeRefusalDetailsSchema.safeParse(refusal.details);
  if (refusal.code === 'PLAN_NODE_STALE' && current.success) {
    const { revision, status } = current.data;
    return {
      error: refusal.code,
      message:
        `This step changed since the plan was read: it is at revision ${String(revision)} (${status}), and this ` +
        `was decided against revision ${String(expectedRevision)}, so nothing was written. Read the plan again ` +
        'and choose against the step as it now stands.',
      current: current.data,
    };
  }
  if (refusal.code === 'PLAN_NODE_UNCHANGED' && current.success) {
    return {
      error: refusal.code,
      message: `This step already stands as this would leave it (${current.data.status}), so nothing was written.`,
      current: current.data,
    };
  }
  if (refusal.code === 'PLAN_NODE_NOT_FOUND') {
    return { error: refusal.code, message: 'This step is not in the space’s plan any more.' };
  }
  return { error: refusal.code, message: refusal.message };
}

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

  app.patch(
    '/:spaceId/plan/nodes/:nodeId',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary:
          'Close a plan node — done with its outcome, or dropped with its branch — against the revision the operator read',
        params: z.object({ spaceId: z.string().uuid(), nodeId: z.string().uuid() }),
        body: PlanNodeCloseInputSchema,
        response: {
          200: PlanNodeUpdateOutputSchema,
          403: z.object({ error: z.string(), message: z.string() }),
          404: PlanNodeWriteRefusalSchema,
          409: PlanNodeWriteRefusalSchema,
          422: PlanNodeWriteRefusalSchema,
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const operator = requireOperatorPrincipal(request, reply, OPERATOR_ONLY_PLAN_WRITE);
      if (!operator) return reply;
      const redis = fastify.appContext.redis;
      if (!redis) {
        return reply.status(503).send({
          error: 'SERVICE_UNAVAILABLE',
          message: 'Writing the plan needs Redis, which this server runs without.',
        });
      }
      const tenant = await request.requireTenant();
      const { spaceId, nodeId } = request.params;
      const body = request.body;
      const store = createPlanNodeStore(
        fastify.appContext.db as PostgresJsDatabase,
        tenant.tenantId,
      );
      const result = await updatePlanNode(
        { store, spaceId, redis, tenantId: tenant.tenantId, createdBy: operator.userId },
        {
          nodeId,
          expectedRevision: body.expectedRevision,
          status: body.status,
          ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
        },
      );
      if (!result.ok) {
        const status =
          result.code === 'PLAN_NODE_NOT_FOUND'
            ? 404
            : result.code === 'PLAN_NODE_STALE'
              ? 409
              : 422;
        return reply.status(status).send(refusalBody(result, body.expectedRevision));
      }
      // The write is the person signed in: who it was comes from the session,
      // never the body, and is kept where every other operator write is.
      if (fastify.audit) {
        fastify.audit.record({
          actor: {
            userId: operator.userId,
            kind: 'human',
            authMethod: request.authUser?.authMethod ?? 'unknown',
            tenantId: tenant.tenantId,
          },
          category: 'resource',
          action: 'plan.node.close',
          outcome: 'success',
          target: {
            resourceType: 'plan_node',
            resourceId: nodeId,
            tenantId: tenant.tenantId,
            spaceId,
          },
          details: { status: body.status, revision: result.node.revision },
          request: { method: request.method, path: request.url },
        });
      }
      return { node: result.node };
    },
  );
};
