import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  WorkflowRunDetailOutputSchema,
  WorkflowRunResumeInputSchema,
  WorkflowResumeResolutionSchema,
  WorkflowRunPauseInputSchema,
  WorkflowRunPauseOutputSchema,
  WorkflowRunCancelOperatorInputSchema,
  WorkflowRunCancelOperatorOutputSchema,
} from '@aflow/schemas';
import { buildWorkflowRunDetail } from '@aflow/cybernetic-runtime';
import { readLatestSessionPosition } from '@aflow/redis';
import { encodeSessionCursor } from '../services/sessionCursor.js';
import { and, eq, desc, isNull, lt, inArray, sql } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import {
  WorkflowRunSummarySchema,
  buildWorkflowRunSummaries,
  type WorkflowRunSummaryRow,
} from './workflows/runSummary.js';
import { resumeWorkflowRunFromOperatorUi } from '../services/workflowRunOperatorResume.js';
import { pauseWorkflowRunFromOperatorUi } from '../services/workflowRunPauseOperator.js';
import { cancelWorkflowRunFromOperatorUi } from '../services/workflowRunCancelOperator.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

/** Statuses treated as "live" for the space feed's priority zone. */
const ACTIVE_RUN_STATUSES = ['running', 'paused'] as const;
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const KNOWN_RUN_STATUSES = new Set<string>([...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);

const RUN_STATUS_COLUMNS = {
  runId: workflowRuns.runId,
  status: workflowRuns.status,
  workflowSlug: workflowRuns.workflowSlug,
  workflowRevision: workflowRuns.workflowRevision,
  startedAt: workflowRuns.startedAt,
  completedAt: workflowRuns.completedAt,
  totalCostCents: workflowRuns.totalCostCents,
  totalTokens: workflowRuns.totalTokens,
  evaluationJson: workflowRuns.evaluationJson,
  pausedReason: workflowRuns.pausedReason,
  initiatedByUserId: workflowRuns.initiatedByUserId,
  sessionId: workflowRuns.sessionId,
} as const;

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const workflowRunsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/:spaceId/workflow-runs/:runId',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'read',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Get workflow run detail (Plan 135 §4.1.3)',
        description:
          'Returns the WorkflowRunDetailOutput DTO for a specific workflow run, ' +
          'including task rows, active waiters, and (for paused runs) the live ' +
          'resume contract. Powers the chat-surface mount/rehydration path.',
        params: z.object({
          spaceId: z.string().uuid(),
          runId: z.string().uuid(),
        }),
        response: {
          200: WorkflowRunDetailOutputSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, runId } = request.params;

      const payloadStore = fastify.appContext.payloadStore;
      if (!payloadStore) {
        // Server misconfiguration — surface as a 500 rather than fabricating
        // a 404 (which would mislead the client into thinking the run doesn't
        // exist). Fastify default error handler maps thrown errors to 500.
        throw new Error('PayloadStore is not configured on this server instance.');
      }

      const output = await buildWorkflowRunDetail(
        fastify.appContext.db as PostgresJsDatabase,
        payloadStore,
        tenant.tenantId,
        spaceId,
        runId,
      );

      if (!output) {
        return reply.code(404).send({
          error: 'WORKFLOW_RUN_NOT_FOUND',
          message: `No workflow run found with id "${runId}" in this space.`,
        });
      }

      const redis = fastify.appContext.redis;
      if (output.originatingSessionId && redis) {
        try {
          const position = await readLatestSessionPosition(
            redis,
            tenant.tenantId,
            output.originatingSessionId,
          );
          if (position) {
            output.tailCursor = encodeSessionCursor({
              eventId: position.eventId,
              redisStreamId: position.id,
            });
          }
        } catch {
          // Cursor is an optimization; a read failure just means the container
          // tails from "now" and leans on the hydrate snapshot + catch-up.
        }
      }

      return output;
    },
  );

  app.get(
    '/:spaceId/workflow-runs',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'read',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Space-wide workflow run feed (Plan 228 §5.1)',
        description:
          'Live-first run feed across ALL skills/sessions in a space. `status` selects the ' +
          'always-on set (running/paused, paused-first); `recent` tops it up with the N most ' +
          'recent terminal runs. Powers the Workbench runs zone; the client joins slug→name.',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          status: z.string().optional(),
          recent: z.coerce.number().int().min(0).max(20).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          cursor: z.string().datetime().optional(),
        }),
        response: {
          200: z.object({
            runs: z.array(WorkflowRunSummarySchema),
            counts: z.object({ running: z.number().int(), paused: z.number().int() }),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const limit = request.query.limit ?? 50;
      const recent = request.query.recent ?? 0;
      const cursor = request.query.cursor ?? null;

      const requested = (request.query.status ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => KNOWN_RUN_STATUSES.has(s));
      const activeStatuses = requested.length > 0 ? requested : [...ACTIVE_RUN_STATUSES];

      const tenantCtx = createTenantContext(tenant.tenantId);
      const db = fastify.appContext.db as PostgresJsDatabase;

      const { activeRows, recentRows, counts, taskCounts } = await withTenantSchema(
        db,
        tenantCtx,
        async (tx) => {
          // Frozen eval-batch trials never enter the space run feed
          // (Plan 269 D5) — batch surfaces read them by batchId.
          const conditions = [
            eq(workflowRuns.spaceId, spaceId),
            inArray(workflowRuns.status, activeStatuses),
            isNull(workflowRuns.evalBatchId),
          ];
          if (cursor) conditions.push(lt(workflowRuns.startedAt, new Date(cursor)));

          // Paused first (needs a decision), then running, then most recent.
          const statusRank = sql`case
            when ${workflowRuns.status} = 'paused' then 0
            when ${workflowRuns.status} = 'running' then 1
            else 2 end`;

          const activeRows = await tx
            .select(RUN_STATUS_COLUMNS)
            .from(workflowRuns)
            .where(and(...conditions))
            .orderBy(statusRank, desc(workflowRuns.startedAt))
            .limit(limit + 1);

          const recentRows =
            recent > 0
              ? await tx
                  .select(RUN_STATUS_COLUMNS)
                  .from(workflowRuns)
                  .where(
                    and(
                      eq(workflowRuns.spaceId, spaceId),
                      inArray(workflowRuns.status, [...TERMINAL_RUN_STATUSES]),
                      isNull(workflowRuns.evalBatchId),
                    ),
                  )
                  .orderBy(desc(workflowRuns.startedAt))
                  .limit(recent)
              : [];

          // Live running/paused totals for the header/rail badge — independent
          // of the page limit and the requested `status` filter.
          const countRows = await tx
            .select({ status: workflowRuns.status, count: sql<number>`count(*)::int` })
            .from(workflowRuns)
            .where(
              and(
                eq(workflowRuns.spaceId, spaceId),
                inArray(workflowRuns.status, [...ACTIVE_RUN_STATUSES]),
                isNull(workflowRuns.evalBatchId),
              ),
            )
            .groupBy(workflowRuns.status);
          const counts = { running: 0, paused: 0 };
          for (const c of countRows) {
            if (c.status === 'running') counts.running = c.count;
            else if (c.status === 'paused') counts.paused = c.count;
          }

          const runIds = [...activeRows, ...recentRows].map((r) => r.runId);
          let taskCounts = new Map<string, number>();
          if (runIds.length > 0) {
            const taskRows = await tx
              .select({ runId: workflowRunTasks.runId, count: sql<number>`count(*)::int` })
              .from(workflowRunTasks)
              .where(inArray(workflowRunTasks.runId, runIds))
              .groupBy(workflowRunTasks.runId);
            taskCounts = new Map(taskRows.map((r) => [r.runId, r.count]));
          }

          return { activeRows, recentRows, counts, taskCounts };
        },
      );

      const hasMore = activeRows.length > limit;
      const activePage: WorkflowRunSummaryRow[] = hasMore ? activeRows.slice(0, limit) : activeRows;

      const runs = await buildWorkflowRunSummaries(
        fastify,
        tenant.tenantId,
        spaceId,
        [...activePage, ...recentRows],
        taskCounts,
      );

      const lastActive = activePage[activePage.length - 1];
      const nextCursor = hasMore && lastActive ? lastActive.startedAt.toISOString() : null;

      return { runs, counts, nextCursor };
    },
  );

  app.post(
    '/:spaceId/workflow-runs/:runId/resume',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Resume a paused workflow run (Plan 167 operator UI)',
        description:
          'Operator-facing entry point for human-task approve/reject/collect on the workflow run surface. ' +
          'Commits ledger state on the API tier and enqueues harness advance on the worker.',
        params: z.object({
          spaceId: z.string().uuid(),
          runId: z.string().uuid(),
        }),
        body: z.object({
          pauseVersion: z.number().int().nonnegative(),
          resolution: WorkflowResumeResolutionSchema,
        }),
        response: {
          200: z.object({ runId: z.string().uuid() }),
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const userId = request.authUser?.userId ?? 'operator';
      const { spaceId, runId } = request.params;
      const body = request.body;

      const payloadStore = fastify.appContext.payloadStore;
      const redis = fastify.appContext.redis;
      if (!payloadStore || !redis) {
        throw new Error('PayloadStore and Redis are required for workflow resume.');
      }

      const parsedInput = WorkflowRunResumeInputSchema.parse({
        runId,
        pauseVersion: body.pauseVersion,
        resolution: body.resolution,
      });

      const result = await resumeWorkflowRunFromOperatorUi(
        {
          db: fastify.appContext.db as PostgresJsDatabase,
          redis,
          payloadStore,
        },
        {
          tenantId: tenant.tenantId,
          spaceId,
          userId,
          input: parsedInput,
        },
      );

      if (!result.ok) {
        const status =
          result.code === 'WORKFLOW_RUN_NOT_FOUND' || result.code === 'RUN_NOT_PAUSED'
            ? 404
            : result.code === 'STALE_PAUSE_VERSION' ||
                result.code === 'RESUME_IN_PROGRESS' ||
                result.code === 'RESUME_COMMIT_LOST'
              ? 409
              : 400;
        return reply.code(status).send({ error: result.code, message: result.message });
      }

      return { runId: result.runId };
    },
  );

  app.post(
    '/:spaceId/workflow-runs/:runId/pause',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Pause a running workflow run (Plan 182 operator UI)',
        description:
          'Operator-initiated run-level soft quiesce. CAS-transitions a running run to ' +
          'paused with a manual resume contract, keeps any parked Helmsman waiter asleep, ' +
          'and emits a live paused run-update. Resume via the /resume route with mode ' +
          '"acknowledge". Already-paused runs are returned as-is (no re-stamp); terminal ' +
          'runs return 409.',
        params: z.object({
          spaceId: z.string().uuid(),
          runId: z.string().uuid(),
        }),
        body: z.object({
          reason: z.string().max(500).optional(),
        }),
        response: {
          200: WorkflowRunPauseOutputSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const userId = request.authUser?.userId ?? 'operator';
      const { spaceId, runId } = request.params;

      const payloadStore = fastify.appContext.payloadStore;
      const redis = fastify.appContext.redis;
      if (!payloadStore || !redis) {
        throw new Error('PayloadStore and Redis are required for workflow pause.');
      }

      const parsedInput = WorkflowRunPauseInputSchema.parse({
        runId,
        ...(request.body.reason !== undefined ? { reason: request.body.reason } : {}),
      });

      const result = await pauseWorkflowRunFromOperatorUi(
        {
          db: fastify.appContext.db as PostgresJsDatabase,
          redis,
          payloadStore,
        },
        {
          tenantId: tenant.tenantId,
          spaceId,
          userId,
          input: parsedInput,
        },
      );

      if (!result.ok) {
        const status =
          result.code === 'WORKFLOW_RUN_NOT_FOUND'
            ? 404
            : result.code === 'RUN_NOT_RUNNING'
              ? 409
              : 400;
        return reply.code(status).send({ error: result.code, message: result.message });
      }

      return result.output;
    },
  );

  app.post(
    '/:spaceId/workflow-runs/:runId/cancel',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          spaceIdFrom: 'param',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Spaces'],
        summary: 'Cancel a workflow run (Plan 182 operator UI)',
        description:
          'Operator-initiated cancellation. Validates the run on the API tier and enqueues the ' +
          'cancel cascade (cancel_run fan-out + terminal completeRun waiter-wake) onto the worker ' +
          'harness-advance stream. Returns "cancelling"; the terminal WorkflowRunUpdate(cancelled) ' +
          'arrives over SSE once the cascade finishes. Terminal runs return 409.',
        params: z.object({
          spaceId: z.string().uuid(),
          runId: z.string().uuid(),
        }),
        body: z.object({
          reason: z.string().max(500).optional(),
        }),
        response: {
          200: WorkflowRunCancelOperatorOutputSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const userId = request.authUser?.userId ?? 'operator';
      const { spaceId, runId } = request.params;

      const payloadStore = fastify.appContext.payloadStore;
      const redis = fastify.appContext.redis;
      if (!payloadStore || !redis) {
        throw new Error('PayloadStore and Redis are required for workflow cancel.');
      }

      const parsedInput = WorkflowRunCancelOperatorInputSchema.parse({
        runId,
        ...(request.body.reason !== undefined ? { reason: request.body.reason } : {}),
      });

      const result = await cancelWorkflowRunFromOperatorUi(
        {
          db: fastify.appContext.db as PostgresJsDatabase,
          redis,
          payloadStore,
        },
        {
          tenantId: tenant.tenantId,
          spaceId,
          userId,
          input: parsedInput,
        },
      );

      if (!result.ok) {
        const status =
          result.code === 'WORKFLOW_RUN_NOT_FOUND'
            ? 404
            : result.code === 'WORKFLOW_RUN_ALREADY_TERMINAL'
              ? 409
              : 400;
        return reply.code(status).send({ error: result.code, message: result.message });
      }

      return result.output;
    },
  );
};
