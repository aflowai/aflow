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
import type { Redis } from 'ioredis';
import {
  PlanLoopMeasureOutputSchema,
  PlanLoopMeasureQuerySchema,
  PlanNodeCloseInputSchema,
  PlanNodeDetailOutputSchema,
  PlanNodeDetailQuerySchema,
  PlanNodeOpenSchema,
  PlanNodeRefusalDetailsSchema,
  PlanNodeUpdateOutputSchema,
  PlanNodeWriteRefusalSchema,
  PlanTreeOutputSchema,
  PlanTreeQuerySchema,
  type PlanNodeWriteRefusal,
} from '@aflow/schemas';
import {
  createPlanNodeStore,
  createResidentScheduleStore,
  openPlanNode,
  readPlanLoopMeasure,
  readPlanNodeDetail,
  readPlanTrees,
  requestResidentWake,
  updatePlanNode,
  type PlanOpError,
} from '@aflow/cybernetic-runtime';
import { isInteractiveUser } from '../utils/interactiveUser.js';
import { PLAN_WRITE_OPERATOR_ONLY } from '../lib/planWriteAuthority.js';

/**
 * An engine refusal in the operator's words. A stale or unchanged write
 * carries the node as it now stands, so the page can say what changed and
 * write again against the current revision.
 */
function refusalBody(
  refusal: PlanOpError,
  expectedRevision: number,
  write: 'close' | 'open' = 'close',
): PlanNodeWriteRefusal {
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
  if (refusal.code === 'PLAN_NODE_UNCHANGED' && current.success && write === 'open') {
    return {
      error: refusal.code,
      message: `This step is ${current.data.status}: it waits on no person, so there is nothing to approve and nothing was written.`,
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

function refusalStatus(refusal: PlanOpError): 404 | 409 | 422 {
  if (refusal.code === 'PLAN_NODE_NOT_FOUND') return 404;
  if (refusal.code === 'PLAN_NODE_STALE') return 409;
  return 422;
}

/**
 * A person wrote a node: the space's resident acts on it at once, or after the
 * wake in flight (Plan 331 D4). Best effort — the write stands whatever this
 * does, and the next heartbeat reads the same board.
 */
async function wakeResident(
  db: PostgresJsDatabase,
  redis: Redis,
  tenantId: string,
  spaceId: string,
  log: { warn: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    await requestResidentWake(
      { redis, schedules: createResidentScheduleStore(db) },
      { tenantId, spaceId, cause: 'node_written' },
    );
  } catch (err) {
    log.warn({ err, spaceId }, 'waking the resident after a plan write failed');
  }
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
          "The space's plan as a board: every tree, each node nested under its parent with its counts, rounds, owner and newest pull request, and each plan's tallies with its done nodes by day",
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: PlanTreeQuerySchema,
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
      const { closedSince, tz } = request.query;
      return readPlanTrees(
        { store, spaceId },
        {
          ...(closedSince !== undefined ? { closedSince } : {}),
          ...(tz !== undefined ? { tz } : {}),
        },
      );
    },
  );

  // One node in full for the board's rail: what the operator reads before
  // closing it — its goal and criteria, at the revision they write against —
  // and a page of its links, which the tree no longer carries.
  app.get(
    '/:spaceId/plan/nodes/:nodeId',
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
          'One plan node in full — its goal, criteria, note and revision — with its children, runs in flight and a page of its links',
        params: z.object({ spaceId: z.string().uuid(), nodeId: z.string().uuid() }),
        querystring: PlanNodeDetailQuerySchema,
        response: {
          200: PlanNodeDetailOutputSchema,
          400: PlanNodeWriteRefusalSchema,
          404: PlanNodeWriteRefusalSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, nodeId } = request.params;
      const store = createPlanNodeStore(
        fastify.appContext.db as PostgresJsDatabase,
        tenant.tenantId,
      );
      const result = await readPlanNodeDetail({ store, spaceId }, nodeId, request.query);
      if (!result.ok) {
        if (result.code === 'PLAN_LINK_CURSOR_INVALID') {
          return reply.status(400).send({ error: result.code, message: result.message });
        }
        return reply.status(404).send({
          error: result.code,
          message: 'This step is not in the space’s plan any more.',
        });
      }
      const { ok: _ok, ...read } = result;
      return read;
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
      const authUser = request.authUser;
      if (!authUser || !isInteractiveUser(authUser)) {
        return reply
          .status(403)
          .send({ error: 'operator_only', message: PLAN_WRITE_OPERATOR_ONLY });
      }
      const operator = { userId: authUser.userId };
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
        return reply.status(refusalStatus(result)).send(refusalBody(result, body.expectedRevision));
      }
      // The write is the person signed in: who it was comes from the session,
      // never the body, and is kept where every other operator write is.
      if (fastify.audit) {
        fastify.audit.record({
          actor: {
            userId: operator.userId,
            kind: 'human',
            authMethod: authUser.authMethod,
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
      await wakeResident(
        fastify.appContext.db as PostgresJsDatabase,
        redis,
        tenant.tenantId,
        spaceId,
        request.log,
      );
      return { node: result.node };
    },
  );

  // The operator moves a node to active (Plan 332 D6, Plan 331 D5): Approve or
  // Resume on a blocked node, Reopen on a closed one. A write of its own, with
  // an audit row of its own — never the close.
  app.patch(
    '/:spaceId/plan/nodes/:nodeId/open',
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
          'Open a plan node — approve or resume a blocked one, reopen a closed one — against the revision the operator read',
        params: z.object({ spaceId: z.string().uuid(), nodeId: z.string().uuid() }),
        body: PlanNodeOpenSchema,
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
      const authUser = request.authUser;
      if (!authUser || !isInteractiveUser(authUser)) {
        return reply
          .status(403)
          .send({ error: 'operator_only', message: PLAN_WRITE_OPERATOR_ONLY });
      }
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
      const db = fastify.appContext.db as PostgresJsDatabase;
      const result = await openPlanNode(
        {
          store: createPlanNodeStore(db, tenant.tenantId),
          spaceId,
          redis,
          tenantId: tenant.tenantId,
          createdBy: authUser.userId,
        },
        {
          nodeId,
          expectedRevision: body.expectedRevision,
          ...(body.why !== undefined ? { why: body.why } : {}),
        },
      );
      if (!result.ok) {
        return reply
          .status(refusalStatus(result))
          .send(refusalBody(result, body.expectedRevision, 'open'));
      }
      if (fastify.audit) {
        fastify.audit.record({
          actor: {
            userId: authUser.userId,
            kind: 'human',
            authMethod: authUser.authMethod,
            tenantId: tenant.tenantId,
          },
          category: 'resource',
          action: 'plan.node.open',
          outcome: 'success',
          target: {
            resourceType: 'plan_node',
            resourceId: nodeId,
            tenantId: tenant.tenantId,
            spaceId,
          },
          details: { from: result.left, revision: result.node.revision },
          request: { method: request.method, path: request.url },
        });
      }
      await wakeResident(db, redis, tenant.tenantId, spaceId, request.log);
      return { node: result.node };
    },
  );

  // What the loop costs the operator over a window (Plan 331 D7).
  app.get(
    '/:spaceId/plan/loop',
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
          "What the loop cost the operator over a window: their actions per merged pull request, each node's idle time before its first commission, and each node's cost with the resident's wakes beside it",
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: PlanLoopMeasureQuerySchema,
        response: { 200: PlanLoopMeasureOutputSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      return readPlanLoopMeasure(
        fastify.appContext.db as PostgresJsDatabase,
        tenant.tenantId,
        request.params.spaceId,
        request.query,
      );
    },
  );
};
