import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  agentSchedules,
} from '@aflow/database';
import { validateCronExpression, getNextCronFireTime, isValidTimezone } from '@aflow/schemas';
import {
  CreateScheduleBodySchema,
  ListSchedulesQuerySchema,
  UpdateScheduleBodySchema,
} from './schemas.js';
import { rowToResponse } from './helpers.js';

export function registerScheduleRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /v1/schedules — Create schedule
  app.post(
    '/',
    {
      config: {
        authzExempt: {
          reason:
            'No `schedule` AuthzResourceType yet; the handler enforces space membership via requireSpace()/canWrite.',
        },
      },
      schema: {
        tags: ['schedules'],
        summary: 'Create a flow schedule',
        body: CreateScheduleBodySchema,
      },
    },
    async (request, reply) => {
      const space = await request.requireSpace();
      if (!space.canWrite) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Write access required' });
      }

      const tenant = await request.requireTenant();
      const creatorUserId = request.authUser?.userId;
      if (!creatorUserId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message:
            'Schedules run as their creator, and this request carries no user identity — ' +
            'a run started by this schedule could not resolve credentials.',
        });
      }
      const body = request.body;

      // Validate cron expression
      if (body.kind === 'cron') {
        if (!body.cronExpression) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'cronExpression is required for cron schedules',
          });
        }
        const err = validateCronExpression(body.cronExpression);
        if (err) {
          return reply
            .status(400)
            .send({ error: 'Bad Request', message: `Invalid cron expression: ${err}` });
        }
      }

      // Validate timezone
      if (!isValidTimezone(body.timezone)) {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: `Invalid timezone: ${body.timezone}` });
      }

      // Validate one-shot
      if (body.kind === 'one_shot' && !body.scheduledAt) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'scheduledAt is required for one_shot schedules',
        });
      }

      // Validate on_completion
      if (body.kind === 'on_completion' && !body.sourceFlowId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'sourceFlowId is required for on_completion schedules',
        });
      }

      // Compute next_fire_at
      let nextFireAt: Date | null = null;
      if (body.kind === 'cron' && body.cronExpression) {
        const next = getNextCronFireTime(body.cronExpression, body.timezone);
        if (next) nextFireAt = new Date(next);
      } else if (body.kind === 'one_shot' && body.scheduledAt) {
        nextFireAt = new Date(body.scheduledAt);
      }

      // Auto-set maxFirings for one_shot
      const maxFirings = body.kind === 'one_shot' && !body.maxFirings ? 1 : body.maxFirings;

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const { getPlatformAgentBySystemRole } = await import('@aflow/platform-artifacts');
      const { agents } = await import('@aflow/database');
      const UUID_SHAPE_SCHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      async function resolveTagged(
        flowId: string,
      ): Promise<
        | { ok: true; kind: 'platform-role'; systemRole: string }
        | { ok: true; kind: 'custom-agent'; agentId: string }
        | { ok: false; reason: string }
      > {
        if (UUID_SHAPE_SCHED.test(flowId)) {
          const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
            return tx
              .select({ id: agents.id, archivedAt: agents.archivedAt })
              .from(agents)
              .where(and(eq(agents.id, flowId), eq(agents.spaceId, space.spaceId)))
              .limit(1);
          });
          if (rows.length === 0 || rows[0]?.archivedAt) {
            return {
              ok: false,
              reason: `Custom agent ${flowId} not found or archived in this space`,
            };
          }
          return { ok: true, kind: 'custom-agent', agentId: flowId };
        }
        if (!getPlatformAgentBySystemRole(flowId)) {
          return { ok: false, reason: `Unknown platform agent role: "${flowId}"` };
        }
        return { ok: true, kind: 'platform-role', systemRole: flowId };
      }

      let targetKind: 'platform-role' | 'custom-agent' | null = null;
      let targetSystemRole: string | null = null;
      let targetAgentId: string | null = null;
      if (body.action === 'start_run' && body.flowId) {
        const resolved = await resolveTagged(body.flowId);
        if (!resolved.ok) {
          return reply.status(400).send({ error: 'Bad Request', message: resolved.reason });
        }
        targetKind = resolved.kind;
        if (resolved.kind === 'platform-role') targetSystemRole = resolved.systemRole;
        else targetAgentId = resolved.agentId;
      }

      let sourceKind: 'platform-role' | 'custom-agent' | null = null;
      let sourceSystemRole: string | null = null;
      let sourceAgentId: string | null = null;
      if (body.sourceFlowId) {
        const resolved = await resolveTagged(body.sourceFlowId);
        if (!resolved.ok) {
          return reply.status(400).send({ error: 'Bad Request', message: resolved.reason });
        }
        sourceKind = resolved.kind;
        if (resolved.kind === 'platform-role') sourceSystemRole = resolved.systemRole;
        else sourceAgentId = resolved.agentId;
      }

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .insert(agentSchedules)
          .values({
            spaceId: space.spaceId,
            name: body.name,
            description: body.description ?? null,
            action: body.action,
            targetKind,
            targetSystemRole,
            targetAgentId,
            agentVersion: body.flowVersion ?? null,
            targetSessionId: body.targetRunId ?? null,
            targetStepExecutionId: null,
            kind: body.kind,
            cronExpression: body.cronExpression ?? null,
            timezone: body.timezone,
            scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
            sourceKind,
            sourceSystemRole,
            sourceAgentId,
            sourceStatus: body.sourceStatus ?? null,
            inputTemplate: body.inputTemplate,
            status: 'active',
            maxFirings: maxFirings ?? null,
            firingCount: 0,
            nextFireAt,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            metadata: body.metadata ?? {},
            createdBy: creatorUserId,
            creatorUserId,
            creatorTenantRole: tenant.tenantRole,
            creatorSpaceRole: space.spaceRole,
          })
          .returning();
      });

      const row = rows[0];
      if (!row) {
        return reply
          .status(500)
          .send({ error: 'Internal Server Error', message: 'Failed to create schedule' });
      }
      return reply.status(201).send(rowToResponse(row));
    },
  );

  // GET /v1/schedules — List schedules
  app.get(
    '/',
    {
      config: {
        authzExempt: {
          reason:
            'No `schedule` AuthzResourceType yet; the handler enforces space membership via requireSpace()/canWrite.',
        },
      },
      schema: {
        tags: ['schedules'],
        summary: 'List flow schedules in the current space',
        querystring: ListSchedulesQuerySchema,
      },
    },
    async (request, reply) => {
      const space = await request.requireSpace();
      const tenant = await request.requireTenant();
      const { status, flowId, kind, limit, cursor } = request.query;

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const conditions = [eq(agentSchedules.spaceId, space.spaceId)];
      if (status) {
        conditions.push(eq(agentSchedules.status, status));
      } else {
        conditions.push(sql`${agentSchedules.status} != 'deleted'`);
      }
      if (flowId) {
        const UUID_SHAPE_SCHED2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (UUID_SHAPE_SCHED2.test(flowId)) {
          conditions.push(eq(agentSchedules.targetAgentId, flowId));
        } else {
          conditions.push(eq(agentSchedules.targetSystemRole, flowId));
        }
      }
      if (kind) conditions.push(eq(agentSchedules.kind, kind));
      if (cursor) conditions.push(sql`${agentSchedules.id} < ${cursor}`);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .select()
          .from(agentSchedules)
          .where(and(...conditions))
          .orderBy(desc(agentSchedules.createdAt))
          .limit(limit + 1);
      });

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const schedules = pageRows.map(rowToResponse);
      const lastItem = pageRows[pageRows.length - 1];

      return reply.send({
        schedules,
        nextCursor: hasMore && lastItem ? lastItem.id : null,
      });
    },
  );

  // GET /v1/schedules/:scheduleId — Get schedule
  app.get(
    '/:scheduleId',
    {
      config: {
        authzExempt: {
          reason:
            'No `schedule` AuthzResourceType yet; the handler enforces space membership via requireSpace()/canWrite.',
        },
      },
      schema: {
        tags: ['schedules'],
        summary: 'Get a flow schedule by ID',
        params: z.object({ scheduleId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const space = await request.requireSpace();
      const tenant = await request.requireTenant();
      const { scheduleId } = request.params;

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .select()
          .from(agentSchedules)
          .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, space.spaceId)))
          .limit(1);
      });

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'Not Found', message: 'Schedule not found' });
      }

      return reply.send(rowToResponse(row));
    },
  );

  // PATCH /v1/schedules/:scheduleId — Update schedule
  app.patch(
    '/:scheduleId',
    {
      config: {
        authzExempt: {
          reason:
            'No `schedule` AuthzResourceType yet; the handler enforces space membership via requireSpace()/canWrite.',
        },
      },
      schema: {
        tags: ['schedules'],
        summary: 'Update a flow schedule',
        params: z.object({ scheduleId: z.string().uuid() }),
        body: UpdateScheduleBodySchema,
      },
    },
    async (request, reply) => {
      const space = await request.requireSpace();
      if (!space.canWrite) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Write access required' });
      }

      const tenant = await request.requireTenant();
      const { scheduleId } = request.params;
      const body = request.body;

      const updates: Record<string, unknown> = { updatedAt: new Date() };

      if (body.status !== undefined) updates['status'] = body.status;
      if (body.name !== undefined) updates['name'] = body.name;
      if (body.description !== undefined) updates['description'] = body.description;
      if (body.inputTemplate !== undefined) updates['inputTemplate'] = body.inputTemplate;
      if (body.expiresAt !== undefined) {
        updates['expiresAt'] = body.expiresAt ? new Date(body.expiresAt) : null;
      }

      if (body.cronExpression !== undefined) {
        const err = validateCronExpression(body.cronExpression);
        if (err) {
          return reply.status(400).send({ error: 'Bad Request', message: `Invalid cron: ${err}` });
        }
        updates['cronExpression'] = body.cronExpression;
        const tz = body.timezone ?? 'UTC';
        const next = getNextCronFireTime(body.cronExpression, tz);
        updates['nextFireAt'] = next ? new Date(next) : null;
      }
      if (body.timezone !== undefined) {
        if (!isValidTimezone(body.timezone)) {
          return reply
            .status(400)
            .send({ error: 'Bad Request', message: `Invalid timezone: ${body.timezone}` });
        }
        updates['timezone'] = body.timezone;
      }

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .update(agentSchedules)
          .set(updates)
          .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, space.spaceId)))
          .returning();
      });

      const row = rows[0];
      if (!row) {
        return reply.status(404).send({ error: 'Not Found', message: 'Schedule not found' });
      }

      return reply.send(rowToResponse(row));
    },
  );

  // DELETE /v1/schedules/:scheduleId — Soft-delete schedule
  app.delete(
    '/:scheduleId',
    {
      config: {
        authzExempt: {
          reason:
            'No `schedule` AuthzResourceType yet; the handler enforces space membership via requireSpace()/canWrite.',
        },
      },
      schema: {
        tags: ['schedules'],
        summary: 'Delete a flow schedule',
        params: z.object({ scheduleId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const space = await request.requireSpace();
      if (!space.canWrite) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Write access required' });
      }

      const tenant = await request.requireTenant();
      const { scheduleId } = request.params;

      const db = getDatabase();
      const tenantCtx = createTenantContext(tenant.tenantId);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .update(agentSchedules)
          .set({ status: 'deleted', updatedAt: new Date() })
          .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, space.spaceId)))
          .returning({ id: agentSchedules.id });
      });

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Not Found', message: 'Schedule not found' });
      }

      return reply.send({ deleted: true as const, scheduleId });
    },
  );
}
