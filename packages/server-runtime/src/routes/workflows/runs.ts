/**
 * Workflow run history read route.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, desc, isNull, lt, sql, inArray } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import { WorkflowSlugParamsSchema, spaceReadAuthz, getDb } from './shared.js';
import {
  WorkflowRunSummarySchema,
  buildWorkflowRunSummaries,
  type WorkflowRunSummaryRow,
} from './runSummary.js';

export function registerWorkflowRunRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/workflows/:slug/runs',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Paginated run history for a workflow',
        params: WorkflowSlugParamsSchema,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).optional(),
          cursor: z.string().datetime().optional(),
          status: z.string().optional(),
        }),
        response: {
          200: z.object({
            runs: z.array(WorkflowRunSummarySchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const limit = request.query.limit ?? 20;
      const cursor = request.query.cursor ?? null;
      const statusFilter = request.query.status ?? null;

      const tenantCtx = createTenantContext(tenant.tenantId);
      const db = getDb(fastify);

      const { runRows, taskCounts } = await withTenantSchema(db, tenantCtx, async (tx) => {
        // Frozen eval-batch trials are not production history (Plan 269 D5);
        // batch surfaces read them by batchId, never through this feed.
        const conditions = [
          eq(workflowRuns.spaceId, spaceId),
          eq(workflowRuns.workflowSlug, slug),
          isNull(workflowRuns.evalBatchId),
        ];
        if (cursor) {
          conditions.push(lt(workflowRuns.startedAt, new Date(cursor)));
        }
        if (statusFilter) {
          conditions.push(eq(workflowRuns.status, statusFilter));
        }

        const rows = await tx
          .select({
            id: workflowRuns.id,
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
          })
          .from(workflowRuns)
          .where(and(...conditions))
          .orderBy(desc(workflowRuns.startedAt))
          .limit(limit + 1);

        // Task counts per run.
        // Cost is NOT aggregated here — it's an analytics concern handled by
        // a projector/sweeper that populates workflowRuns.totalCostCents
        // from cascade session data. Until then, cost shows from the run row
        // (if populated) or from the eval memory doc fallback.
        const runIds = rows.map((r) => r.runId);
        let taskCounts = new Map<string, number>();
        if (runIds.length > 0) {
          const taskRows = await tx
            .select({
              runId: workflowRunTasks.runId,
              count: sql<number>`count(*)::int`,
            })
            .from(workflowRunTasks)
            .where(inArray(workflowRunTasks.runId, runIds))
            .groupBy(workflowRunTasks.runId);
          taskCounts = new Map(taskRows.map((r) => [r.runId, r.count]));
        }

        return { runRows: rows, taskCounts };
      });

      const hasMore = runRows.length > limit;
      const page: WorkflowRunSummaryRow[] = hasMore ? runRows.slice(0, limit) : runRows;

      const runs = await buildWorkflowRunSummaries(
        fastify,
        tenant.tenantId,
        spaceId,
        page,
        taskCounts,
      );

      const lastRow = page[page.length - 1];
      const nextCursor = hasMore && lastRow ? lastRow.startedAt.toISOString() : null;

      return { runs, nextCursor };
    },
  );
}
