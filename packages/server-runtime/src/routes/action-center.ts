import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { resolveActionCenterActorContext } from '../services/actionCenter/resolveActorContext.js';
import {
  ActionCenterItemKindSchema,
  ActionCenterItemSchema,
  ActionCenterResolveRequestSchema,
  PostInstallTaskSchema,
  type ActionCenterItemOrigin,
  type TenantId,
} from '@aflow/schemas';
import {
  ActionCenterAuthzError,
  ActionCenterResolveError,
  type ActionCenterAggregator,
} from '../services/actionCenter/aggregator.js';
import { publishActionCenterWake } from '@aflow/redis';
import type { ActionCenterContext } from '../services/actionCenter/types.js';
import { isInteractiveUser } from '../utils/interactiveUser.js';
import { projectActionCenterItem } from '../services/actionCenter/authz.js';

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  detail: z.string().optional(),
});

/**
 * Errors that hand back the item as it now stands, so the client can re-render
 * without another round trip. Declared wherever `latestItem` is sent —
 * serialization strips fields the response schema does not name, so a branch
 * answering with the plain error shape would drop it silently.
 */
const StaleErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  detail: z.string().optional(),
  latestItem: ActionCenterItemSchema.optional(),
});

export interface ActionCenterRoutesOptions {
  /** Shared aggregator instance. `null` in mock mode (no DB/Redis) —
   *  every handler short-circuits to a 503 in that case. Constructed in
   *  `app.ts` via `buildSpaceActionCenterAggregator` and handed to both
   *  this REST plugin and the `space.action_center` realtime topic, so
   *  the two surfaces cannot drift on which sources they expose. */
  aggregator: ActionCenterAggregator | null;
}

export const actionCenterRoutes: FastifyPluginAsync<ActionCenterRoutesOptions> = async (
  fastify,
  opts,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const appCtx = app.appContext;
  const dbHandle = appCtx.db as PostgresJsDatabase | null;

  const aggregator: ActionCenterAggregator | null = opts.aggregator;
  const db: PostgresJsDatabase | null = aggregator ? dbHandle : null;

  // ─────────────────────────────────────────────────────────────────────────
  // GET /v1/spaces/:spaceId/action-center
  // ─────────────────────────────────────────────────────────────────────────

  app.get(
    '/:spaceId/action-center',
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
        tags: ['ActionCenter'],
        summary: 'List open Action Center items for a space (Plan 156)',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          kind: ActionCenterItemKindSchema.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200).optional(),
        }),
        response: {
          200: z.object({ items: z.array(ActionCenterItemSchema) }),
          401: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!aggregator) return notLive(reply);
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const { kind, limit = 200 } = request.query;
      const ctx = await resolveActorContext(request, tenant.tenantId, spaceId, db!);
      let items = await aggregator.list(ctx);
      if (kind) items = items.filter((i) => i.kind === kind);
      if (items.length > limit) items = items.slice(0, limit);
      return { items };
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /v1/spaces/:spaceId/action-center/:itemId
  // ─────────────────────────────────────────────────────────────────────────

  app.get(
    '/:spaceId/action-center/:itemId',
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
        tags: ['ActionCenter'],
        summary: 'Action Center item detail',
        params: z.object({
          spaceId: z.string().uuid(),
          itemId: z.string().min(1).max(256),
        }),
        response: {
          200: ActionCenterItemSchema,
          404: ErrorSchema,
          401: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!aggregator) return notLive(reply);
      const tenant = await request.requireTenant();
      const { spaceId, itemId } = request.params;
      const ctx = await resolveActorContext(request, tenant.tenantId, spaceId, db!);
      const item = await aggregator.get(ctx, itemId);
      if (!item) {
        return reply
          .status(404)
          .send({ error: 'NOT_FOUND', message: `Action Center item ${itemId} not found.` });
      }
      return item;
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /v1/spaces/:spaceId/action-center/:itemId/resolve
  // ─────────────────────────────────────────────────────────────────────────

  app.post(
    '/:spaceId/action-center/:itemId/resolve',
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
        tags: ['ActionCenter'],
        summary: 'Resolve an Action Center item (CAS-checked, audit-logged)',
        params: z.object({
          spaceId: z.string().uuid(),
          itemId: z.string().min(1).max(256),
        }),
        body: ActionCenterResolveRequestSchema,
        response: {
          200: z.object({
            item: ActionCenterItemSchema,
            setupChecklist: z.array(PostInstallTaskSchema).optional(),
          }),
          403: ErrorSchema,
          404: ErrorSchema,
          409: StaleErrorSchema,
          422: StaleErrorSchema,
          500: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!aggregator) return notLive(reply);
      const tenant = await request.requireTenant();
      const { spaceId, itemId } = request.params;
      const body = request.body;
      const ctx = await resolveActorContext(request, tenant.tenantId, spaceId, db!);

      // CAS: the origin the client observed must match the source's current
      // state. We re-read the item here and compare; mismatches return 409.
      const current = await aggregator.get(ctx, itemId);
      if (!current) {
        return reply
          .status(404)
          .send({ error: 'NOT_FOUND', message: `Action Center item ${itemId} not found.` });
      }
      if (!originMatches(current.origin, body.origin)) {
        return reply.status(409).send({
          error: 'STALE_ACTION_CENTER_ITEM',
          message: `Origin CAS mismatch for ${itemId} — reload before resolving.`,
          latestItem: current,
        });
      }

      try {
        const result = await aggregator.resolve(ctx, itemId, body.resolution);
        if (appCtx.redis) {
          // One wake for every resolution and assignment taken here, so the
          // other viewers of the item see it settle without waiting for the
          // audit cycle. Settings items (host requests, egress grants) can
          // surface in every space of the tenant.
          publishActionCenterWake(appCtx.redis, {
            source: 'action_center_resolve',
            tenantId: tenant.tenantId,
            ...(current.origin.type === 'settings' ? {} : { spaceId }),
          });
        }
        return {
          item: result.item,
          ...(result.setupChecklist !== undefined ? { setupChecklist: result.setupChecklist } : {}),
        };
      } catch (err) {
        if (err instanceof ActionCenterAuthzError) {
          return reply.status(403).send({ error: 'FORBIDDEN', message: err.message });
        }
        if (err instanceof ActionCenterResolveError) {
          if (err.code === 'STALE_ACTION_CENTER_ITEM') {
            return reply.status(409).send({
              error: 'STALE_ACTION_CENTER_ITEM',
              message: err.message,
              ...(err.detail ? { detail: err.detail } : {}),
              ...(err.latestItem
                ? { latestItem: projectActionCenterItem(ctx, err.latestItem) }
                : {}),
            });
          }
          if (err.code === 'NOT_FOUND') {
            return reply.status(404).send({ error: 'NOT_FOUND', message: err.message });
          }
          if (err.code === 'INVALID_RESOLUTION') {
            return reply.status(422).send({ error: 'INVALID_RESOLUTION', message: err.message });
          }
          if (err.code === 'FORBIDDEN') {
            return reply.status(403).send({ error: 'FORBIDDEN', message: err.message });
          }
          if (err.code === 'RATIFICATION_APPLY_FAILED') {
            return reply.status(422).send({
              error: 'RATIFICATION_APPLY_FAILED',
              message: err.message,
              ...(err.detail ? { detail: err.detail } : {}),
              ...(err.latestItem
                ? { latestItem: projectActionCenterItem(ctx, err.latestItem) }
                : {}),
            });
          }
          return reply.status(500).send({
            error: 'DISPATCH_FAILED',
            message: err.message,
            ...(err.detail ? { detail: err.detail } : {}),
          });
        }
        throw err;
      }
    },
  );
};

// ============================================================================
// Helpers
// ============================================================================

function notLive(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({
    error: 'SERVICE_UNAVAILABLE',
    message: 'Action Center requires database + redis + payload store; running in mock mode.',
  });
}

async function resolveActorContext(
  request: FastifyRequest,
  tenantId: TenantId,
  spaceId: string,
  db: PostgresJsDatabase,
): Promise<ActionCenterContext> {
  const userId = request.authUser?.userId;
  if (!userId) {
    throw new ActionCenterAuthzError('Authentication required.');
  }
  const tenant = await request.requireTenant().catch(() => null);
  return resolveActionCenterActorContext(db, tenantId, spaceId, {
    userId,
    isTenantAdmin: Boolean(tenant?.isAdmin),
    ...(request.authUser?.authMethod ? { authMethod: request.authUser.authMethod } : {}),
    isInteractiveUser: isInteractiveUser(request.authUser),
  });
}

function originMatches(current: ActionCenterItemOrigin, claimed: ActionCenterItemOrigin): boolean {
  if (current.type !== claimed.type) return false;
  switch (current.type) {
    case 'step':
      return (
        claimed.type === 'step' &&
        current.stepExecutionId === claimed.stepExecutionId &&
        current.pauseVersion === claimed.pauseVersion &&
        current.pauseToken === claimed.pauseToken
      );
    case 'gate':
      return (
        claimed.type === 'gate' &&
        current.stepExecutionId === claimed.stepExecutionId &&
        current.pauseVersion === claimed.pauseVersion &&
        current.gateRequestId === claimed.gateRequestId
      );
    case 'proposal':
      return (
        claimed.type === 'proposal' &&
        current.proposalId === claimed.proposalId &&
        current.proposalRevision === claimed.proposalRevision
      );
    case 'session_invitation':
      return (
        claimed.type === 'session_invitation' &&
        current.sessionId === claimed.sessionId &&
        current.inviteeUserId === claimed.inviteeUserId &&
        current.generation === claimed.generation
      );
    case 'settings':
      return (
        claimed.type === 'settings' &&
        current.recordId === claimed.recordId &&
        current.recordVersion === claimed.recordVersion
      );
    case 'coach_activity':
      return (
        claimed.type === 'coach_activity' &&
        current.activityId === claimed.activityId &&
        current.createdAt === claimed.createdAt
      );
    case 'trigger_armed':
      return (
        claimed.type === 'trigger_armed' &&
        current.scheduleId === claimed.scheduleId &&
        current.createdAt === claimed.createdAt
      );
    case 'workflow_task':
      return (
        claimed.type === 'workflow_task' &&
        current.runId === claimed.runId &&
        current.taskId === claimed.taskId &&
        current.pauseVersion === claimed.pauseVersion
      );
    // The same hand-off, whoever has joined it since: Done is meant for every
    // run waiting on the site, including one that arrived after the page loaded.
    case 'browser_handoff':
      return (
        claimed.type === 'browser_handoff' &&
        current.machineLabel === claimed.machineLabel &&
        current.profileId === claimed.profileId &&
        current.site === claimed.site &&
        current.startedAt === claimed.startedAt
      );
  }
}
