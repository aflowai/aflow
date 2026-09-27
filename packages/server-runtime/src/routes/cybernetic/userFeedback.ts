import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, or, sql } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, userFeedback } from '@aflow/database';
import { UserFeedbackReasonSchema } from '@aflow/schemas';
import { appendEntityEvent } from '@aflow/redis';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const userFeedbackRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  // -------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/user-feedback
  // -------------------------------------------------------------------------

  app.post(
    '/:spaceId/user-feedback',
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
        tags: ['Cybernetic'],
        summary: 'Submit structured user feedback',
        params: z.object({ spaceId: z.string().uuid() }),
        body: z.object({
          subjectKind: z.enum(['run', 'proposal', 'skill', 'message']),
          subjectId: z.string().min(1).max(256),
          reasonCode: UserFeedbackReasonSchema,
          freeText: z.string().max(1000).optional(),
        }),
        response: {
          201: z.object({ feedbackId: z.string().uuid(), message: z.string() }),
          400: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const body = request.body;
      const userId = request.authUser?.userId;
      if (!userId) {
        return reply.status(400).send({ error: 'Authenticated user required' });
      }

      // 'other' requires non-empty free text
      if (body.reasonCode === 'other' && (!body.freeText || body.freeText.trim().length === 0)) {
        return reply.status(400).send({ error: "Reason 'other' requires non-empty freeText" });
      }

      const tenantCtx = createTenantContext(tenant.tenantId);
      const feedbackId = randomUUID();

      const vals: Record<string, unknown> = {
        id: feedbackId,
        spaceId,
        subjectKind: body.subjectKind,
        subjectId: body.subjectId,
        reasonCode: body.reasonCode,
        createdByUserId: userId,
      };
      if (body.freeText !== undefined) vals['freeText'] = body.freeText;

      await withTenantSchema(db, tenantCtx, async (tx) =>
        tx.insert(userFeedback).values(vals as typeof userFeedback.$inferInsert),
      );

      // Emit entity.user.feedback event
      const redis = fastify.appContext.redis;
      if (redis) {
        try {
          await appendEntityEvent(redis, {
            tenantId: tenant.tenantId,
            spaceId,
            event: {
              eventId: randomUUID(),
              eventType: 'entity.user.feedback',
              spaceId,
              tenantId: tenant.tenantId,
              timestamp: Date.now(),
              operatingMode: 'procedural',
              payload: {
                feedbackId,
                subjectKind: body.subjectKind,
                subjectId: body.subjectId,
                reasonCode: body.reasonCode,
              },
              summary: `User feedback: ${body.reasonCode} on ${body.subjectKind} ${body.subjectId}`,
            },
          });
        } catch {
          // Best-effort
        }
      }

      return await reply.status(201).send({
        feedbackId,
        message: 'Feedback recorded',
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/spaces/:spaceId/skills/:skillId/user-feedback
  // -------------------------------------------------------------------------

  app.get(
    '/:spaceId/skills/:skillId/user-feedback',
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
        tags: ['Cybernetic'],
        summary: 'List user feedback for a skill (including its runs)',
        params: z.object({
          spaceId: z.string().uuid(),
          skillId: z.string().min(1).max(128),
        }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: z.object({
            feedback: z.array(
              z.object({
                feedbackId: z.string().uuid(),
                subjectKind: z.string(),
                subjectId: z.string(),
                reasonCode: z.string(),
                freeText: z.string().nullable(),
                createdByUserId: z.string().uuid(),
                createdAt: z.string(),
              }),
            ),
            reasonCounts: z.record(z.string(), z.number().int()),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId, skillId } = request.params;
      const { limit } = request.query;
      const tenantCtx = createTenantContext(tenant.tenantId);

      // Feedback can be linked to the skill directly or to runs of the skill.
      const skillCondition = and(
        eq(userFeedback.spaceId, spaceId),
        or(
          and(eq(userFeedback.subjectKind, 'skill'), eq(userFeedback.subjectId, skillId)),
          and(
            eq(userFeedback.subjectKind, 'run'),
            sql`${userFeedback.subjectId} LIKE ${skillId + ':%'}`,
          ),
        ),
      );

      // Reason-code counts from the full dataset (not the paged slice)
      const countRows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({
            reasonCode: userFeedback.reasonCode,
            count: sql<number>`count(*)::int`,
          })
          .from(userFeedback)
          .where(skillCondition)
          .groupBy(userFeedback.reasonCode),
      );
      const reasonCounts: Record<string, number> = {};
      for (const r of countRows) {
        reasonCounts[r.reasonCode] = r.count;
      }

      // Paged recent entries
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select()
          .from(userFeedback)
          .where(skillCondition)
          .orderBy(sql`${userFeedback.createdAt} DESC`)
          .limit(limit),
      );

      const feedback = rows.map((r) => ({
        feedbackId: r.id,
        subjectKind: r.subjectKind,
        subjectId: r.subjectId,
        reasonCode: r.reasonCode,
        freeText: r.freeText,
        createdByUserId: r.createdByUserId,
        createdAt: r.createdAt.toISOString(),
      }));

      return { feedback, reasonCounts };
    },
  );
};
