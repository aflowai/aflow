import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  archiveSkill,
  unarchiveSkill,
  purgeSkill,
  previewSkill,
  SkillLifecycleError,
  type SkillLifecycleErrorCode,
} from '@aflow/cybernetic-runtime';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const skillLifecycleRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  /** Lifecycle errors from `@aflow/cybernetic-runtime` map to HTTP status.
   *  Literal union so Fastify's typed reply.code() accepts the result. */
  function lifecycleErrorToStatus(code: SkillLifecycleErrorCode): 403 | 404 | 409 | 500 {
    switch (code) {
      case 'SKILL_NOT_FOUND':
        return 404;
      case 'PLATFORM_ARTIFACT_READ_ONLY':
        return 403;
      case 'SKILL_NOT_ARCHIVED':
      case 'SKILL_HAS_ACTIVE_RUNS':
      case 'SKILL_HAS_LIVE_RUNS':
      case 'SKILL_HAS_HISTORICAL_RUNS':
        return 409;
      case 'WORKFLOW_DOC_MISSING':
        return 500;
    }
  }

  const SkillIdParams = z.object({
    spaceId: z.string().uuid(),
    skillId: z.string().min(1).max(128),
  });

  const LifecycleErrorBody = z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  });

  // POST /v1/spaces/:spaceId/skills/:skillId/archive
  app.post(
    '/:spaceId/skills/:skillId/archive',
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
        tags: ['Skill Lifecycle'],
        summary: 'Archive a custom workspace skill (Plan 119 §4.3)',
        params: SkillIdParams,
        body: z
          .object({
            force: z.boolean().optional(),
          })
          .optional(),
        response: {
          200: z.object({
            skillId: z.string(),
            archivedAt: z.string().datetime(),
            softDeletedDocPaths: z.array(z.string()),
            closedProposalCount: z.number().int().nonnegative(),
            forceCancelledRunIds: z.array(z.string()),
          }),
          403: LifecycleErrorBody,
          404: LifecycleErrorBody,
          409: LifecycleErrorBody,
          500: LifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const { spaceId, skillId } = request.params;
      const tenant = await request.requireTenant();
      const force = request.body?.force === true;
      try {
        const result = await archiveSkill(
          {
            db,
            tenantId: tenant.tenantId,
            spaceId,
            actorUserId: request.authUser?.userId ?? null,
          },
          skillId,
          { force },
        );
        return result;
      } catch (err) {
        if (err instanceof SkillLifecycleError) {
          return reply
            .code(lifecycleErrorToStatus(err.code))
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );

  // POST /v1/spaces/:spaceId/skills/:skillId/unarchive
  app.post(
    '/:spaceId/skills/:skillId/unarchive',
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
        tags: ['Skill Lifecycle'],
        summary: 'Unarchive a custom workspace skill (Plan 119 §4.5)',
        params: SkillIdParams,
        body: z.object({}).optional(),
        response: {
          200: z.object({
            skillId: z.string(),
            restoredAt: z.string().datetime(),
            restoredDocPaths: z.array(z.string()),
          }),
          403: LifecycleErrorBody,
          404: LifecycleErrorBody,
          409: LifecycleErrorBody,
          500: LifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const { spaceId, skillId } = request.params;
      const tenant = await request.requireTenant();
      try {
        const result = await unarchiveSkill(
          {
            db,
            tenantId: tenant.tenantId,
            spaceId,
            actorUserId: request.authUser?.userId ?? null,
          },
          skillId,
        );
        return result;
      } catch (err) {
        if (err instanceof SkillLifecycleError) {
          return reply
            .code(lifecycleErrorToStatus(err.code))
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );

  // POST /v1/spaces/:spaceId/skills/:skillId/purge
  app.post(
    '/:spaceId/skills/:skillId/purge',
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
        tags: ['Skill Lifecycle'],
        summary: 'Permanently delete an archived skill, including telemetry (Plan 119 §4.6)',
        params: SkillIdParams,
        body: z
          .object({
            confirmRunHistoryDangling: z.boolean().optional(),
          })
          .optional(),
        response: {
          200: z.object({
            skillId: z.string(),
            purgedAt: z.string().datetime(),
            tombstonePath: z.string(),
            deletedDocPaths: z.array(z.string()),
            deletedFeedbackCount: z.number().int().nonnegative(),
            deletedCausalMeasurementCount: z.number().int().nonnegative(),
            danglingRunCount: z.number().int().nonnegative(),
          }),
          403: LifecycleErrorBody,
          404: LifecycleErrorBody,
          409: LifecycleErrorBody,
          500: LifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const { spaceId, skillId } = request.params;
      const tenant = await request.requireTenant();
      const confirmRunHistoryDangling = request.body?.confirmRunHistoryDangling === true;
      try {
        const result = await purgeSkill(
          {
            db,
            tenantId: tenant.tenantId,
            spaceId,
            actorUserId: request.authUser?.userId ?? null,
          },
          skillId,
          { confirmRunHistoryDangling },
        );
        return result;
      } catch (err) {
        if (err instanceof SkillLifecycleError) {
          return reply
            .code(lifecycleErrorToStatus(err.code))
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );

  // GET /v1/spaces/:spaceId/skills/:skillId/preview?kind=archive|purge
  app.get(
    '/:spaceId/skills/:skillId/preview',
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
        tags: ['Skill Lifecycle'],
        summary: 'Preview archive/purge counts (read-only, Plan 119 §4.2)',
        params: SkillIdParams,
        querystring: z.object({ kind: z.enum(['archive', 'purge']) }),
        response: {
          200: z.object({
            skillId: z.string(),
            kind: z.enum(['archive', 'purge']),
            isPlatformSkill: z.boolean(),
            affectedDocPaths: z.array(z.string()),
            proposalsToClose: z.number().int().nonnegative(),
            feedbackRowsToDelete: z.number().int().nonnegative(),
            causalMeasurementsToDelete: z.number().int().nonnegative(),
            historicalRunCount: z.number().int().nonnegative(),
            activeRunCount: z.number().int().nonnegative(),
          }),
          404: LifecycleErrorBody,
          500: LifecycleErrorBody,
        },
      },
    },
    async (request, reply) => {
      const { spaceId, skillId } = request.params;
      const { kind } = request.query;
      const tenant = await request.requireTenant();
      try {
        const result = await previewSkill(
          {
            db,
            tenantId: tenant.tenantId,
            spaceId,
            actorUserId: request.authUser?.userId ?? null,
          },
          skillId,
          kind,
        );
        return result;
      } catch (err) {
        if (err instanceof SkillLifecycleError) {
          // preview is read-only; only NOT_FOUND or WORKFLOW_DOC_MISSING reach
          // here. Narrow the status to the schema's declared union.
          const status: 404 | 500 = err.code === 'SKILL_NOT_FOUND' ? 404 : 500;
          return reply
            .code(status)
            .send({ code: err.code, message: err.message, details: err.details });
        }
        throw err;
      }
    },
  );
};
