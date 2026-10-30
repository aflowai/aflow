/**
 * The space's plan as the operator reads and writes it (Plan 322 P3). Both go
 * through the plan engine, the one authority the Helmsman's `plan.node.*`
 * operations call too (D7), so the operator sees the tree those write and a
 * write of theirs is judged by the same rules — the revision compare-and-set
 * of D6 above all.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
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
  PlanNodeOpenInputSchema,
  PlanNodePlaceInputSchema,
  PlanNodePlaceRefusalDetailsSchema,
  PlanNodeReviseInputSchema,
  PlanNodeRefusalDetailsSchema,
  PlanNodeUpdateOutputSchema,
  PlanNodeWriteRefusalSchema,
  PlanBoardOutputSchema,
  PlanBoardQuerySchema,
  PlanOverviewOutputSchema,
  type PlanNodeStatus,
  type PlanNodeWriteRefusal,
} from '@aflow/schemas';
import {
  createPlanNodeStore,
  createResidentScheduleStore,
  readPlanLoopMeasure,
  openPlanNode,
  placePlanNode,
  revisePlanNode,
  readPlanBoard,
  readPlanNodeDetail,
  readPlanOverview,
  requestResidentWake,
  updatePlanNode,
  type PlanOpError,
  type PlanWriteContext,
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
  unchanged: (status: PlanNodeStatus) => string = (status) =>
    `This step already stands as this would leave it (${status}), so nothing was written.`,
): PlanNodeWriteRefusal {
  if (refusal.code === 'PLAN_NODE_PLACE_STALE') {
    const placed = PlanNodePlaceRefusalDetailsSchema.safeParse(refusal.details);
    return {
      error: refusal.code,
      message:
        'The step this was placed against is not beside it any more, so nothing was written. Its siblings ' +
        'are listed as they now stand; choose again among them.',
      ...(placed.success ? { siblings: placed.data.siblings } : {}),
    };
  }
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
      message: unchanged(current.data.status),
      current: current.data,
    };
  }
  if (refusal.code === 'PLAN_NODE_NOT_FOUND') {
    return { error: refusal.code, message: 'This step is not in the space’s plan any more.' };
  }
  return { error: refusal.code, message: refusal.message };
}

/**
 * The engine's remedy for an overlong note names update fields the open route
 * does not take. On an approve the operator's lever is the reason they typed;
 * on a reopen the overflow is the engine's line over the recorded outcome,
 * which a shorter reason or none cannot bring under the limit.
 */
function openNoteTooLongBody(refusal: PlanOpError): PlanNodeWriteRefusal {
  const details = z
    .object({ status: z.string(), noteLength: z.number(), noteMaxChars: z.number() })
    .partial()
    .safeParse(refusal.details);
  const { status, noteLength, noteMaxChars } = details.success ? details.data : {};
  const size =
    noteLength !== undefined && noteMaxChars !== undefined
      ? ` at ${String(noteLength)} characters, past the ${String(noteMaxChars)} a note holds`
      : ' longer than a note holds';
  if (status === 'done' || status === 'dropped') {
    return {
      error: refusal.code,
      message:
        `Reopening heads this step’s note with the outcome it was closed with, which would leave the note${size}, ` +
        'so nothing was written. A shorter reason, or none, does not bring it under: the recorded outcome has ' +
        `to be shortened first, and the plan page cannot write it. Ask the Helmsman to shorten the outcome while ` +
        `the step is still ${status}, then reopen it.`,
    };
  }
  return {
    error: refusal.code,
    message:
      `This would leave the step’s note${size}, so nothing was written. Shorten the reason, or clear it ` +
      'and approve again without one.',
  };
}

type OperatorAuthMethod = NonNullable<FastifyRequest['authUser']>['authMethod'];

function refusalStatus(refusal: PlanOpError): 404 | 409 | 422 {
  if (refusal.code === 'PLAN_NODE_NOT_FOUND') return 404;
  if (refusal.code === 'PLAN_NODE_STALE' || refusal.code === 'PLAN_NODE_PLACE_STALE') return 409;
  return 422;
}

const PLAN_WRITE_AUTHZ = {
  authz: {
    resource: 'space',
    action: 'write',
    resourceIdFrom: 'param',
    resourceIdParam: 'spaceId',
  },
} as const;

const PLAN_READ_AUTHZ = {
  authz: {
    resource: 'space',
    action: 'read',
    resourceIdFrom: 'param',
    resourceIdParam: 'spaceId',
  },
} as const;

const PlanWriteParamsSchema = z.object({ spaceId: z.string().uuid(), nodeId: z.string().uuid() });

const PLAN_WRITE_RESPONSES = {
  200: PlanNodeUpdateOutputSchema,
  403: z.object({ error: z.string(), message: z.string() }),
  404: PlanNodeWriteRefusalSchema,
  409: PlanNodeWriteRefusalSchema,
  422: PlanNodeWriteRefusalSchema,
  503: z.object({ error: z.string(), message: z.string() }),
};

interface PlanWriter {
  ctx: PlanWriteContext;
  userId: string;
  authMethod: OperatorAuthMethod;
}

/** Who an operator's write is, from the session; undefined once the refusal is sent. */
async function operatorWriting(
  fastify: FastifyInstance,
  request: FastifyRequest,
  params: { spaceId: string; nodeId: string },
  reply: FastifyReply,
): Promise<PlanWriter | undefined> {
  const authUser = request.authUser;
  if (!authUser || !isInteractiveUser(authUser)) {
    await reply.status(403).send({ error: 'operator_only', message: PLAN_WRITE_OPERATOR_ONLY });
    return undefined;
  }
  const redis = fastify.appContext.redis;
  if (!redis) {
    await reply.status(503).send({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Writing the plan needs Redis, which this server runs without.',
    });
    return undefined;
  }
  const tenant = await request.requireTenant();
  const store = createPlanNodeStore(fastify.appContext.db as PostgresJsDatabase, tenant.tenantId);
  return {
    ctx: {
      store,
      spaceId: params.spaceId,
      redis,
      tenantId: tenant.tenantId,
      createdBy: authUser.userId,
      actorKind: 'human',
    },
    userId: authUser.userId,
    authMethod: authUser.authMethod,
  };
}

/**
 * The write is the person signed in: who it was comes from the session, never
 * the body, and is kept where every other operator write is.
 */
async function recordPlanWrite(
  fastify: FastifyInstance,
  request: FastifyRequest,
  params: { spaceId: string; nodeId: string },
  writer: PlanWriter,
  action: 'plan.node.close' | 'plan.node.open' | 'plan.node.place' | 'plan.node.revise',
  details: Record<string, unknown>,
): Promise<void> {
  await wakeResident(
    fastify.appContext.db as PostgresJsDatabase,
    writer.ctx.redis,
    writer.ctx.tenantId,
    params.spaceId,
    request.log,
  );
  if (!fastify.audit) return;
  const { ctx } = writer;
  fastify.audit.record({
    actor: {
      userId: writer.userId,
      kind: 'human',
      authMethod: writer.authMethod,
      tenantId: ctx.tenantId,
    },
    category: 'resource',
    action,
    outcome: 'success',
    target: {
      resourceType: 'plan_node',
      resourceId: params.nodeId,
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
    },
    details,
    request: { method: request.method, path: request.url },
  });
}

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

  // Plan 332 D7's overview: every root with its state and, on an open plan,
  // its steps' counts; and the lanes, open steps across plans. No done step.
  app.get(
    '/:spaceId/plan',
    {
      config: PLAN_READ_AUTHZ,
      schema: {
        tags: ['Spaces'],
        summary:
          "The space's plans as rows — every root by position with its state and, open, its steps counted by the board's columns — and the Needs you, In flight and Up next lanes across every open plan",
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({}).strict(),
        response: { 200: PlanOverviewOutputSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const store = createPlanNodeStore(
        fastify.appContext.db as PostgresJsDatabase,
        tenant.tenantId,
      );
      return readPlanOverview({ store, spaceId: request.params.spaceId });
    },
  );

  app.get(
    '/:spaceId/plan/roots/:rootId',
    {
      config: PLAN_READ_AUTHZ,
      schema: {
        tags: ['Spaces'],
        summary:
          "One plan as a board: its root and every node under it nested with its counts, rounds and newest pull request, and the plan's tally with its state and its done nodes by day",
        params: z.object({ spaceId: z.string().uuid(), rootId: z.string().uuid() }),
        querystring: PlanBoardQuerySchema,
        response: { 200: PlanBoardOutputSchema, 404: PlanNodeWriteRefusalSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, rootId } = request.params;
      const store = createPlanNodeStore(
        fastify.appContext.db as PostgresJsDatabase,
        tenant.tenantId,
      );
      const { closedSince, tz } = request.query;
      const result = await readPlanBoard({ store, spaceId }, rootId, {
        ...(closedSince !== undefined ? { closedSince } : {}),
        ...(tz !== undefined ? { tz } : {}),
      });
      if (!result.ok) {
        return reply.status(404).send({
          error: result.code,
          message: 'This plan is not in the space any more.',
        });
      }
      const { ok: _ok, ...board } = result;
      return board;
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
      config: PLAN_WRITE_AUTHZ,
      schema: {
        tags: ['Spaces'],
        summary:
          'Close a plan node — done with its outcome, or dropped with its branch — against the revision the operator read',
        params: PlanWriteParamsSchema,
        body: PlanNodeCloseInputSchema,
        response: PLAN_WRITE_RESPONSES,
      },
    },
    async (request, reply) => {
      const writer = await operatorWriting(fastify, request, request.params, reply);
      if (!writer) return reply;
      const body = request.body;
      const result = await updatePlanNode(writer.ctx, {
        nodeId: request.params.nodeId,
        expectedRevision: body.expectedRevision,
        status: body.status,
        ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
      });
      if (!result.ok) {
        return reply.status(refusalStatus(result)).send(refusalBody(result, body.expectedRevision));
      }
      await recordPlanWrite(fastify, request, request.params, writer, 'plan.node.close', {
        status: body.status,
        revision: result.node.revision,
      });
      return { node: result.node };
    },
  );

  // Plan 332 D6: Approve on a blocked node, Reopen on a closed one — to
  // `active` through the same update, the note left by the engine's rule.
  app.patch(
    '/:spaceId/plan/nodes/:nodeId/open',
    {
      config: PLAN_WRITE_AUTHZ,
      schema: {
        tags: ['Spaces'],
        summary:
          'Approve a blocked plan node or reopen a closed one — back to active — against the revision the operator read',
        params: PlanWriteParamsSchema,
        body: PlanNodeOpenInputSchema,
        response: PLAN_WRITE_RESPONSES,
      },
    },
    async (request, reply) => {
      const writer = await operatorWriting(fastify, request, request.params, reply);
      if (!writer) return reply;
      const body = request.body;
      const result = await openPlanNode(writer.ctx, {
        nodeId: request.params.nodeId,
        expectedRevision: body.expectedRevision,
        ...(body.why !== undefined ? { why: body.why } : {}),
        ...(body.spendCents !== undefined ? { spendCents: body.spendCents } : {}),
      });
      if (!result.ok) {
        if (result.code === 'PLAN_NODE_NOTE_TOO_LONG') {
          return reply.status(refusalStatus(result)).send(openNoteTooLongBody(result));
        }
        return reply
          .status(refusalStatus(result))
          .send(
            refusalBody(
              result,
              body.expectedRevision,
              (status) =>
                `This step is ${status}, not blocked or closed, so there is nothing to approve or reopen; nothing was written.`,
            ),
          );
      }
      await recordPlanWrite(fastify, request, request.params, writer, 'plan.node.open', {
        status: result.from,
        revision: result.node.revision,
      });
      return { node: result.node };
    },
  );

  // Plan 337 P4: Revise on a blocked node — it stays blocked, the operator's
  // note above its note, and the resident is woken to rewrite it.
  app.patch(
    '/:spaceId/plan/nodes/:nodeId/revise',
    {
      config: PLAN_WRITE_AUTHZ,
      schema: {
        tags: ['Spaces'],
        summary:
          'Send a blocked plan node back for revision with a note — it stays blocked — against the revision the operator read',
        params: PlanWriteParamsSchema,
        body: PlanNodeReviseInputSchema,
        response: PLAN_WRITE_RESPONSES,
      },
    },
    async (request, reply) => {
      const writer = await operatorWriting(fastify, request, request.params, reply);
      if (!writer) return reply;
      const body = request.body;
      const result = await revisePlanNode(writer.ctx, {
        nodeId: request.params.nodeId,
        expectedRevision: body.expectedRevision,
        why: body.why,
      });
      if (!result.ok) {
        if (result.code === 'PLAN_NODE_NOTE_TOO_LONG') {
          return reply.status(refusalStatus(result)).send({
            error: result.code,
            message:
              'This would leave the step’s note longer than a note holds, so nothing was written. Shorten what you wrote.',
          });
        }
        return reply
          .status(refusalStatus(result))
          .send(
            refusalBody(
              result,
              body.expectedRevision,
              (status) =>
                `This step is ${status}, not blocked, so there is no proposal to send back. Nothing was written.`,
            ),
          );
      }
      await recordPlanWrite(fastify, request, request.params, writer, 'plan.node.revise', {
        revision: result.node.revision,
      });
      return { node: result.node };
    },
  );

  // Plan 332 D6: directly before or after a sibling — roots among roots.
  app.patch(
    '/:spaceId/plan/nodes/:nodeId/place',
    {
      config: PLAN_WRITE_AUTHZ,
      schema: {
        tags: ['Spaces'],
        summary:
          'Put a plan node directly before or after one of its siblings, against the revision the operator read',
        params: PlanWriteParamsSchema,
        body: PlanNodePlaceInputSchema,
        response: PLAN_WRITE_RESPONSES,
      },
    },
    async (request, reply) => {
      const writer = await operatorWriting(fastify, request, request.params, reply);
      if (!writer) return reply;
      const body = request.body;
      const anchor = 'before' in body ? { before: body.before } : { after: body.after };
      const result = await placePlanNode(writer.ctx, {
        nodeId: request.params.nodeId,
        expectedRevision: body.expectedRevision,
        ...anchor,
      });
      if (!result.ok) {
        return reply
          .status(refusalStatus(result))
          .send(
            refusalBody(
              result,
              body.expectedRevision,
              () => 'This step already stands there among its siblings, so nothing was written.',
            ),
          );
      }
      await recordPlanWrite(fastify, request, request.params, writer, 'plan.node.place', {
        ...anchor,
        revision: result.node.revision,
      });
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
