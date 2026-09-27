/**
 * Space archive, unarchive, blast-radius previews, and permanent purge.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { type getConnection, spaceMemberships } from '@aflow/database';
import { getSpaceOwnerId } from './spacesShared.js';
import {
  archiveSpace,
  unarchiveSpace,
  previewArchiveSpace,
  previewSpacePurge,
  purgeSpace,
  SpaceLifecycleError,
  type SpaceLifecycleErrorCode,
} from '@aflow/cybernetic-runtime';

/** Raw postgres-js client type — purge runs hand-written cascade SQL. */
type RawSql = ReturnType<typeof getConnection>;

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin; route handlers use await
export const spaceLifecycleRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  function spaceLifecycleErrorToStatus(code: SpaceLifecycleErrorCode): 400 | 403 | 404 | 409 | 500 {
    switch (code) {
      case 'SPACE_NAME_MISMATCH':
        return 400;
      case 'SPACE_NOT_FOUND':
        return 404;
      case 'SPACE_GENERAL_PROTECTED':
      case 'SPACE_GENERAL_MISSING':
        return 403;
      case 'SPACE_NOT_ARCHIVED':
      case 'SPACE_HAS_ACTIVE_SESSIONS':
      case 'SPACE_HAS_LIVE_SESSIONS':
      case 'SPACE_HAS_ACTIVE_RUNS':
      case 'SPACE_HAS_LIVE_RUNS':
        return 409;
    }
  }

  const SpaceLifecycleErrorBody = z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  });

  // POST /v1/spaces/:spaceId/archive
  app.post(
    '/:spaceId/archive',
    {
      config: {
        authz: {
          resource: 'space_lifecycle',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Archive a workspace (Plan 121 §4.3)',
        params: z.object({ spaceId: z.string().uuid() }),
        body: z
          .object({
            reason: z.string().max(500).optional(),
            force: z.boolean().optional(),
          })
          .optional(),
        response: {
          200: z.object({
            spaceId: z.string().uuid(),
            archivedAt: z.string().datetime(),
            pausedScheduleCount: z.number().int().nonnegative(),
            pausedWebhookCount: z.number().int().nonnegative(),
            memberCount: z.number().int().nonnegative(),
            tenantDefaultSpaceUpdated: z.boolean(),
            forceCancelledSessionIds: z.array(z.string()),
            forceCancelledRunIds: z.array(z.string()),
          }),
          400: SpaceLifecycleErrorBody,
          403: SpaceLifecycleErrorBody,
          404: SpaceLifecycleErrorBody,
          409: SpaceLifecycleErrorBody,
          500: SpaceLifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const reason = request.body?.reason;
      const force = request.body?.force === true;
      const db = fastify.appContext.db as PostgresJsDatabase;
      const redis = fastify.appContext.redis;
      if (!redis) {
        return reply
          .code(500)
          .send({ code: 'INTERNAL', message: 'Redis is required for the archive probe' });
      }
      try {
        const result = await archiveSpace(
          {
            db,
            redis,
            tenantId: tenant.tenantId,
            actorUserId: request.authUser?.userId ?? null,
          },
          spaceId,
          {
            ...(reason !== undefined ? { reason } : {}),
            ...(force ? { force: true } : {}),
          },
        );
        return result;
      } catch (err) {
        if (err instanceof SpaceLifecycleError) {
          return reply
            .code(spaceLifecycleErrorToStatus(err.code))
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );

  // POST /v1/spaces/:spaceId/unarchive
  // The central archived-space preHandler would 410 this request before the
  // handler ran — opt out via `config.allowArchived: true`.
  app.post(
    '/:spaceId/unarchive',
    {
      config: {
        allowArchived: true,
        authz: {
          resource: 'space_lifecycle',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Unarchive a workspace (Plan 121 §4.6)',
        params: z.object({ spaceId: z.string().uuid() }),
        body: z.object({}).optional(),
        response: {
          200: z.object({
            spaceId: z.string().uuid(),
            restoredAt: z.string().datetime(),
            pausedByArchiveScheduleCount: z.number().int().nonnegative(),
            pausedByArchiveWebhookCount: z.number().int().nonnegative(),
          }),
          400: SpaceLifecycleErrorBody,
          403: SpaceLifecycleErrorBody,
          404: SpaceLifecycleErrorBody,
          409: SpaceLifecycleErrorBody,
          500: SpaceLifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const db = fastify.appContext.db as PostgresJsDatabase;
      const redis = fastify.appContext.redis;
      if (!redis) {
        return reply
          .code(500)
          .send({ code: 'INTERNAL', message: 'Redis is required for the lifecycle path' });
      }
      try {
        const result = await unarchiveSpace(
          {
            db,
            redis,
            tenantId: tenant.tenantId,
            actorUserId: request.authUser?.userId ?? null,
          },
          spaceId,
        );

        // Restore the owner invariant — an archived-era owner change (or a
        // pre-258 row) may leave the owner without their admin membership.
        const ownerId = await getSpaceOwnerId(db, tenant.tenantId, spaceId);
        if (ownerId) {
          const existing = await db
            .select({ id: spaceMemberships.id, role: spaceMemberships.role })
            .from(spaceMemberships)
            .where(
              and(
                eq(spaceMemberships.tenantId, tenant.tenantId),
                eq(spaceMemberships.spaceId, spaceId),
                eq(spaceMemberships.userId, ownerId),
              ),
            )
            .limit(1);
          const row = existing[0];
          if (!row) {
            await db
              .insert(spaceMemberships)
              .values({ tenantId: tenant.tenantId, spaceId, userId: ownerId, role: 'admin' });
          } else if (row.role !== 'admin') {
            await db
              .update(spaceMemberships)
              .set({ role: 'admin', updatedAt: new Date() })
              .where(eq(spaceMemberships.id, row.id));
          }
        }
        return result;
      } catch (err) {
        if (err instanceof SpaceLifecycleError) {
          return reply
            .code(spaceLifecycleErrorToStatus(err.code))
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );

  // GET /v1/spaces/:spaceId/archive-preview
  // Read-only — must be reachable on archived spaces too so the danger-zone
  // dialog can populate counts after archive. opt-out from preHandler.
  app.get(
    '/:spaceId/archive-preview',
    {
      config: {
        allowArchived: true,
        authz: {
          resource: 'space_lifecycle',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Preview archive blast radius (read-only)',
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: z.object({
            spaceId: z.string().uuid(),
            isGeneralSpace: z.boolean(),
            isTenantDefaultSpace: z.boolean(),
            activeSessionCount: z.number().int().nonnegative(),
            activeWorkflowRunCount: z.number().int().nonnegative(),
            activeScheduleCount: z.number().int().nonnegative(),
            activeWebhookCount: z.number().int().nonnegative(),
            memberCount: z.number().int().nonnegative(),
            blockingItems: z.array(
              z.object({
                kind: z.enum(['session', 'workflow_run']),
                id: z.string(),
                status: z.string(),
              }),
            ),
          }),
          404: SpaceLifecycleErrorBody,
          500: SpaceLifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const db = fastify.appContext.db as PostgresJsDatabase;
      const redis = fastify.appContext.redis;
      if (!redis) {
        return reply
          .code(500)
          .send({ code: 'INTERNAL', message: 'Redis is required for the active-session probe' });
      }
      try {
        const result = await previewArchiveSpace(
          {
            db,
            redis,
            tenantId: tenant.tenantId,
            actorUserId: request.authUser?.userId ?? null,
          },
          spaceId,
        );
        return result;
      } catch (err) {
        if (err instanceof SpaceLifecycleError) {
          const status: 404 | 500 = err.code === 'SPACE_NOT_FOUND' ? 404 : 500;
          return reply
            .code(status)
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );

  // GET /v1/spaces/:spaceId/purge-preview
  // Read-only blast-radius preview for purge. Reachable on archived spaces so
  // the danger-zone dialog can populate per-table counts + the name-confirm
  // field. opt-out from the archived-space preHandler.
  app.get(
    '/:spaceId/purge-preview',
    {
      config: {
        allowArchived: true,
        authz: {
          resource: 'space_lifecycle',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Preview purge blast radius (read-only, Plan 176 §3.5)',
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: z.object({
            spaceId: z.string().uuid(),
            name: z.string(),
            slug: z.string(),
            isGeneralSpace: z.boolean(),
            isArchived: z.boolean(),
            perTableCounts: z.record(z.number().int().nonnegative()),
            totalRows: z.number().int().nonnegative(),
          }),
          404: SpaceLifecycleErrorBody,
          500: SpaceLifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const db = fastify.appContext.db as PostgresJsDatabase;
      const sql = fastify.appContext.sql as RawSql | null;
      const redis = fastify.appContext.redis;
      if (!sql || !redis) {
        return reply
          .code(500)
          .send({ code: 'INTERNAL', message: 'Database and Redis are required for purge preview' });
      }
      try {
        const result = await previewSpacePurge(
          {
            db,
            sql,
            redis,
            tenantId: tenant.tenantId,
            actorUserId: request.authUser?.userId ?? null,
          },
          spaceId,
        );
        return result;
      } catch (err) {
        if (err instanceof SpaceLifecycleError) {
          const status: 404 | 500 = err.code === 'SPACE_NOT_FOUND' ? 404 : 500;
          return reply
            .code(status)
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );

  // POST /v1/spaces/:spaceId/purge
  // Permanent forget-me delete. Operates on an ARCHIVED space, so it must
  // opt out of the archived-space preHandler 410. Archive-first + typed-name
  // confirmation are enforced in the runtime.
  app.post(
    '/:spaceId/purge',
    {
      config: {
        allowArchived: true,
        authz: {
          resource: 'space_lifecycle',
          action: 'admin',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Permanently purge an archived workspace (Plan 176 §3.5)',
        params: z.object({ spaceId: z.string().uuid() }),
        body: z.object({ confirmName: z.string().min(1) }),
        response: {
          200: z.object({
            spaceId: z.string().uuid(),
            name: z.string(),
            purgedAt: z.string().datetime(),
            perTableCounts: z.record(z.number().int().nonnegative()),
            totalRows: z.number().int().nonnegative(),
          }),
          400: SpaceLifecycleErrorBody,
          403: SpaceLifecycleErrorBody,
          404: SpaceLifecycleErrorBody,
          409: SpaceLifecycleErrorBody,
          500: SpaceLifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const { confirmName } = request.body;
      const db = fastify.appContext.db as PostgresJsDatabase;
      const sql = fastify.appContext.sql as RawSql | null;
      const redis = fastify.appContext.redis;
      if (!sql || !redis) {
        return reply
          .code(500)
          .send({ code: 'INTERNAL', message: 'Database and Redis are required for purge' });
      }
      try {
        const result = await purgeSpace(
          {
            db,
            sql,
            redis,
            tenantId: tenant.tenantId,
            actorUserId: request.authUser?.userId ?? null,
          },
          spaceId,
          { confirmName },
        );
        return result;
      } catch (err) {
        if (err instanceof SpaceLifecycleError) {
          return reply
            .code(spaceLifecycleErrorToStatus(err.code))
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );
};
