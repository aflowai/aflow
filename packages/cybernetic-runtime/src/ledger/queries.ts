import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, asc, desc, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import type { WorkflowRunRow, WorkflowRunTaskRow } from '@aflow/database';
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowTaskRow,
  RunStats,
  ActiveRunWithTaskCounts,
} from './types.js';

export type {
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowTaskRow,
  RunStats,
  ActiveRunWithTaskCounts,
};

// ============================================================================
// Read helpers (bounded)
// ============================================================================

function toSummary(row: WorkflowRunRow): WorkflowRunSummary {
  return {
    id: row.id,
    spaceId: row.spaceId,
    workflowSlug: row.workflowSlug,
    runId: row.runId,
    sessionId: row.sessionId,
    status: row.status,
    workflowRevision: row.workflowRevision,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    totalCostCents: row.totalCostCents,
    totalTokens: row.totalTokens,
    pausedReason: row.pausedReason,
    pausedPayloadRef: row.pausedPayloadRef,
    pauseVersion: row.pauseVersion,
    resumeAttemptCount: row.resumeAttemptCount,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    learningCount: Array.isArray(row.learningsJson) ? row.learningsJson.length : 0,
    score: row.score,
    evalBatchId: row.evalBatchId,
    ...(row.planNodeId !== null ? { planNodeId: row.planNodeId } : {}),
  };
}

/**
 * Production-run filter: eval-batch trials are excluded by default.
 *
 * Every seam that answers "what is this space/skill doing" takes it — a frozen
 * replay is not work the operator started, and a live-tier batch runs in the
 * home space where nothing else tells the two apart. Only a lookup keyed by a
 * specific `run_id` omits it, since a trial must be readable by its own id.
 * The raw-SQL queries below spell the predicate out; a builder query composes
 * this.
 */
function excludeEvalBatchRuns() {
  return isNull(workflowRuns.evalBatchId);
}

/**
 * Exported so a caller that must read task rows inside its own transaction
 * projects them the same way. A hand-mirrored copy silently drops whatever
 * column is added next, and a liveness rule keyed on that column then reads a
 * missing field rather than a value.
 */
export function toTaskRow(row: WorkflowRunTaskRow): WorkflowTaskRow {
  return {
    id: row.id,
    runId: row.runId,
    taskId: row.taskId,
    status: row.status,
    attempt: row.attempt,
    sessionId: row.sessionId,
    workerSessionId: row.workerSessionId,
    dispatchDeadlineAt: row.dispatchDeadlineAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    costCents: row.costCents,
    metricsJson: row.metricsJson,
    summary: row.summary,
    failureReason: row.failureReason,
    outputRef: row.outputRef,
    inputRef: row.inputRef,
    reflectionJson: row.reflectionJson,
    operationId: row.operationId,
    errorCode: row.errorCode,
    errorClassification: row.errorClassification,
    errorRetryable: row.errorRetryable,
    failedAt: row.failedAt,
    priorFailures: row.priorFailures,
    pollCycle: row.pollCycle,
  };
}

/** Load a single run by runId, including its task rows. */
export async function loadRunById(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  runId: string,
): Promise<WorkflowRunDetail | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.spaceId, spaceId), eq(workflowRuns.runId, runId)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const taskRows = await tx
      .select()
      .from(workflowRunTasks)
      .where(eq(workflowRunTasks.runId, runId));

    return {
      ...toSummary(row),
      evaluationJson: row.evaluationJson,
      failureJson: row.failureJson,
      learningsJson: row.learningsJson,
      schedulerCursorAt: row.schedulerCursorAt,
      metadata: row.metadata,
      tasks: taskRows.map(toTaskRow),
    };
  });
}

/**
 * Single-column lookup of the run's
 * originating chat session id. Used by `emitWorkflowProgress` to fan
 * workflow events out to the chat UI even when no waiter is parked
 * (operator-driven resume case: Helmsman ended its turn at the HITL
 * pause, isn't a waiter anymore, but the run-surface card still needs
 * to see post-approve transitions). Indexed by `runId`; runs at the
 * same cost as the existing `loadPendingWaiters` call already on this
 * hot path.
 */
export async function loadRunOriginatingSessionId(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<string | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({ sessionId: workflowRuns.sessionId })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1);
    return rows[0]?.sessionId ?? null;
  });
}

export async function getRunCampaignId(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<string | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({ campaignId: workflowRuns.campaignId })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1);
    return rows[0]?.campaignId ?? null;
  });
}

/**
 * The two columns learnings injection scopes on: the campaign, and the
 * frozen-mode marker (a set `evalBatchId` means the run reads NO live
 * learning state — Plan 269 D5 stationarity).
 */
export async function getRunLearningScope(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<{ campaignId: string | null; evalBatchId: string | null } | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({ campaignId: workflowRuns.campaignId, evalBatchId: workflowRuns.evalBatchId })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function listRecentRuns(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  slug: string,
  opts: {
    limit: number;
    before?: Date;
    beforeRunId?: string;
    campaignId?: string;
    /** Default false — eval-batch trials are not production history. */
    includeEvalRuns?: boolean;
  },
): Promise<WorkflowRunSummary[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const conditions = [eq(workflowRuns.spaceId, spaceId), eq(workflowRuns.workflowSlug, slug)];
    if (opts.includeEvalRuns !== true) {
      conditions.push(excludeEvalBatchRuns());
    }
    if (opts.campaignId !== undefined) {
      conditions.push(eq(workflowRuns.campaignId, opts.campaignId));
    }
    if (opts.before) {
      if (opts.beforeRunId !== undefined) {
        conditions.push(
          sql`(${workflowRuns.startedAt} < ${opts.before} OR (${workflowRuns.startedAt} = ${opts.before} AND ${workflowRuns.runId} < ${opts.beforeRunId}))`,
        );
      } else {
        conditions.push(sql`${workflowRuns.startedAt} < ${opts.before}`);
      }
    }

    const rows = await tx
      .select()
      .from(workflowRuns)
      .where(and(...conditions))
      .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.runId))
      .limit(opts.limit);

    return rows.map(toSummary);
  });
}

/**
 * The newest learning-bearing terminal runs of a campaign — the read-through
 * source for learnings recorded durably during a run whose candidate rows the
 * async post-run hooks have not written yet.
 */
export async function listTerminalRunLearningsForCampaign(
  db: PostgresJsDatabase,
  tenantId: string,
  campaignId: string,
  opts: { limit: number },
): Promise<Array<{ runId: string; learningsJson: unknown; completedAt: Date | null }>> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        runId: workflowRuns.runId,
        learningsJson: workflowRuns.learningsJson,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.campaignId, campaignId),
          inArray(workflowRuns.status, ['completed', 'failed', 'cancelled']),
          sql`${workflowRuns.learningsJson} IS NOT NULL`,
          excludeEvalBatchRuns(),
        ),
      )
      .orderBy(desc(workflowRuns.completedAt), desc(workflowRuns.runId))
      .limit(opts.limit),
  );
}

export async function listRecentlyTerminalRuns(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  opts: { limit: number; withinMs: number },
): Promise<WorkflowRunSummary[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const cutoff = new Date(Date.now() - opts.withinMs);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, spaceId),
          inArray(workflowRuns.status, ['completed', 'failed', 'cancelled']),
          sql`${workflowRuns.completedAt} >= ${cutoff.toISOString()}`,
          excludeEvalBatchRuns(),
        ),
      )
      .orderBy(desc(workflowRuns.completedAt))
      .limit(opts.limit);

    return rows.map(toSummary);
  });
}

/** List active runs (status in running, paused) for a space. */
export async function listActiveRuns(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  opts: { limit: number },
): Promise<WorkflowRunSummary[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, spaceId),
          inArray(workflowRuns.status, ['running', 'paused']),
          excludeEvalBatchRuns(),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(opts.limit);

    return rows.map(toSummary);
  });
}

/** List active runs for a specific workflow in a space. */
export async function listActiveRunsForWorkflow(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  slug: string,
  opts: { limit: number },
): Promise<WorkflowRunSummary[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, spaceId),
          eq(workflowRuns.workflowSlug, slug),
          inArray(workflowRuns.status, ['running', 'paused']),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(opts.limit);

    return rows.map(toSummary);
  });
}

/**
 * Slug-scoped variant of {@link listActiveRunsWithLiveness} — active runs for
 * one workflow with aggregated task-status counts, so the concurrency gate can
 * call `deriveRunLivenessFromCounts()` and discount runs that are actually
 * stalled (durable `running`/`paused` rows whose work is dead). Without this,
 * a zombie run pins the per-workflow concurrency slot and deadlocks new starts.
 */
export async function listActiveRunsForWorkflowWithLiveness(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  slug: string,
  opts: { limit: number },
): Promise<ActiveRunWithTaskCounts[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        r.run_id,
        r.space_id,
        r.workflow_slug,
        r.session_id,
        r.status,
        r.started_at,
        r.scheduler_cursor_at,
        r.plan_node_id,
        COALESCE(t.total_tasks, 0)::int AS total_tasks,
        COALESCE(t.succeeded_tasks, 0)::int AS succeeded_tasks,
        COALESCE(t.live_tasks, 0)::int AS live_tasks,
        COALESCE(t.scheduled_tasks, 0)::int AS scheduled_tasks,
        COALESCE(t.paused_tasks, 0)::int AS paused_tasks
      FROM workflow_runs r
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS total_tasks,
          count(*) FILTER (WHERE wrt.status = 'succeeded')::int AS succeeded_tasks,
          count(*) FILTER (WHERE wrt.status IN ('running','claimed','in_flight'))::int AS live_tasks,
          count(*) FILTER (WHERE wrt.status = 'scheduled')::int AS scheduled_tasks,
          count(*) FILTER (WHERE wrt.status = 'paused')::int AS paused_tasks
        FROM workflow_run_tasks wrt
        WHERE wrt.run_id = r.run_id
      ) t ON true
      WHERE r.space_id = ${spaceId}
        AND r.workflow_slug = ${slug}
        AND r.status IN ('running', 'paused')
        AND r.eval_batch_id IS NULL
      -- Definitely-non-stalled rows (any active/scheduled/paused task, or a
      -- run-level pause) first, so the LIMIT window can't drop a live run in
      -- favour of newer zombies — the caller discounts the stalled ones. This
      -- ordering key is time-independent, so it never drifts from the staleness
      -- threshold in deriveRunLivenessFromCounts (the actual decision authority).
      ORDER BY
        (CASE
           WHEN r.status = 'paused'
             OR COALESCE(t.live_tasks, 0) + COALESCE(t.scheduled_tasks, 0)
                + COALESCE(t.paused_tasks, 0) > 0
           THEN 0 ELSE 1
         END),
        r.started_at DESC
      LIMIT ${opts.limit}
    `);

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      runId: row['run_id'] as string,
      spaceId: row['space_id'] as string,
      workflowSlug: row['workflow_slug'] as string,
      sessionId: (row['session_id'] as string | null) ?? null,
      status: row['status'] as string,
      startedAt: new Date(row['started_at'] as string),
      schedulerCursorAt: row['scheduler_cursor_at']
        ? new Date(row['scheduler_cursor_at'] as string)
        : null,
      totalTasks: row['total_tasks'] as number,
      succeededTasks: row['succeeded_tasks'] as number,
      liveTasks: row['live_tasks'] as number,
      scheduledTasks: row['scheduled_tasks'] as number,
      pausedTasks: row['paused_tasks'] as number,
    }));
  });
}

/**
 * Every task row of a run, bounded by the run's own task graph.
 *
 * Deliberately uncapped: the callers derive readiness from the whole status
 * set, so a truncated read is not a smaller answer but a wrong one — tasks
 * whose rows fell off the end read as "no row yet" and get dispatched again.
 * Reading one row is `getTaskRow`, not a slice of this.
 */
export async function listTaskRows(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<WorkflowTaskRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx.select().from(workflowRunTasks).where(eq(workflowRunTasks.runId, runId));

    return rows.map(toTaskRow);
  });
}

/** One task row by its natural key — `(run_id, task_id)` is unique. */
export async function getTaskRow(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  taskId: string,
): Promise<WorkflowTaskRow | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowRunTasks)
      .where(and(eq(workflowRunTasks.runId, runId), eq(workflowRunTasks.taskId, taskId)))
      .limit(1);

    const row = rows[0];
    return row ? toTaskRow(row) : null;
  });
}

export async function getRunStatistics(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  slug: string,
  opts: { windowDays: number; campaignId?: string },
): Promise<RunStats> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const cutoff = new Date(Date.now() - opts.windowDays * 24 * 60 * 60 * 1000);

  return withTenantSchema(db, tenantCtx, async (tx) => {
    const conditions = [
      eq(workflowRuns.spaceId, spaceId),
      eq(workflowRuns.workflowSlug, slug),
      sql`${workflowRuns.startedAt} >= ${cutoff.toISOString()}`,
      excludeEvalBatchRuns(),
    ];
    if (opts.campaignId !== undefined) {
      conditions.push(eq(workflowRuns.campaignId, opts.campaignId));
    }
    const result = await tx
      .select({
        totalRuns: sql<number>`count(*)::int`,
        completedRuns: sql<number>`count(*) filter (where ${workflowRuns.status} = 'completed')::int`,
        failedRuns: sql<number>`count(*) filter (where ${workflowRuns.status} = 'failed')::int`,
        avgDurationMs: sql<
          number | null
        >`avg(extract(epoch from (${workflowRuns.completedAt} - ${workflowRuns.startedAt})) * 1000)::int`,
      })
      .from(workflowRuns)
      .where(and(...conditions));

    const row = result[0];
    return {
      totalRuns: row?.totalRuns ?? 0,
      completedRuns: row?.completedRuns ?? 0,
      failedRuns: row?.failedRuns ?? 0,
      avgDurationMs: row?.avgDurationMs ?? null,
    };
  });
}

/**
 * Production-run count for the Coach activation gate and its kin: frozen
 * eval-batch trials are excluded — a batch of trials must not fast-forward
 * a skill through the Coach bootstrap window or any run-count statistic.
 */
export async function countProductionRuns(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  slug: string,
): Promise<number> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const result = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, spaceId),
          eq(workflowRuns.workflowSlug, slug),
          excludeEvalBatchRuns(),
        ),
      );
    return result[0]?.count ?? 0;
  });
}

// ============================================================================
// Bounded attention helper (104d Phase 1a)
// ============================================================================

/**
 * List active runs with aggregated task-status counts in a single query.
 *
 * Replaces the N+1 pattern of `listActiveRuns()` + per-run `loadRunById()`.
 * The JOIN aggregates task statuses so `deriveRunLivenessFromCounts()` can
 * be called without any additional queries.
 */
export async function listActiveRunsWithLiveness(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  opts: { limit: number },
): Promise<ActiveRunWithTaskCounts[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        r.run_id,
        r.space_id,
        r.workflow_slug,
        r.session_id,
        r.status,
        r.started_at,
        r.scheduler_cursor_at,
        COALESCE(t.total_tasks, 0)::int AS total_tasks,
        COALESCE(t.succeeded_tasks, 0)::int AS succeeded_tasks,
        COALESCE(t.live_tasks, 0)::int AS live_tasks,
        COALESCE(t.scheduled_tasks, 0)::int AS scheduled_tasks,
        COALESCE(t.paused_tasks, 0)::int AS paused_tasks
      FROM workflow_runs r
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS total_tasks,
          count(*) FILTER (WHERE wrt.status = 'succeeded')::int AS succeeded_tasks,
          count(*) FILTER (WHERE wrt.status IN ('running','claimed','in_flight'))::int AS live_tasks,
          count(*) FILTER (WHERE wrt.status = 'scheduled')::int AS scheduled_tasks,
          count(*) FILTER (WHERE wrt.status = 'paused')::int AS paused_tasks
        FROM workflow_run_tasks wrt
        WHERE wrt.run_id = r.run_id
      ) t ON true
      WHERE r.space_id = ${spaceId}
        AND r.status IN ('running', 'paused')
        AND r.eval_batch_id IS NULL
      ORDER BY r.started_at DESC
      LIMIT ${opts.limit}
    `);

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      runId: row['run_id'] as string,
      spaceId: row['space_id'] as string,
      workflowSlug: row['workflow_slug'] as string,
      sessionId: (row['session_id'] as string | null) ?? null,
      status: row['status'] as string,
      startedAt: new Date(row['started_at'] as string),
      schedulerCursorAt: row['scheduler_cursor_at']
        ? new Date(row['scheduler_cursor_at'] as string)
        : null,
      totalTasks: row['total_tasks'] as number,
      succeededTasks: row['succeeded_tasks'] as number,
      liveTasks: row['live_tasks'] as number,
      scheduledTasks: row['scheduled_tasks'] as number,
      pausedTasks: row['paused_tasks'] as number,
      ...(typeof row['plan_node_id'] === 'string' ? { planNodeId: row['plan_node_id'] } : {}),
    }));
  });
}

/**
 * Every plan node the runs a session drove serve, ended or not: the plan a
 * conversation has taken up. A run a run started is driven by the session
 * that drove its parent, so it counts here too.
 */
export async function listPlanNodeIdsDrivenBySession(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  sessionId: string,
): Promise<string[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .selectDistinct({ planNodeId: workflowRuns.planNodeId })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, spaceId),
          eq(workflowRuns.sessionId, sessionId),
          isNotNull(workflowRuns.planNodeId),
        ),
      );
    return rows.flatMap((row) => (row.planNodeId !== null ? [row.planNodeId] : []));
  });
}

/**
 * Session-scoped variant of `listActiveRunsWithLiveness` that also returns
 * terminal runs. Returns every run (running, paused, completed, failed,
 * cancelled) for a set of session IDs, with the same task-status counts
 * the lifecycle adapter consumes.
 *
 * Used by the chat session inspector's Map tab to scope skill activations
 * to the current chat session and its descendants. No time window — once
 * a run is owned by a session in the set, it stays in the result for the
 * lifetime of that scope (as long as the row exists).
 */
export async function listRunsForSessionsWithLiveness(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  sessionIds: string[],
  opts: { limit: number },
): Promise<ActiveRunWithTaskCounts[]> {
  if (sessionIds.length === 0) return [];
  // Drizzle's `sql` template splats arrays as positional tuples when used
  // with `.execute()` — `ANY(($2,$3,$4)::uuid[])` is a row constructor, not
  // a uuid array, and Postgres rejects it. Pass as a single text-array
  // literal that Postgres coerces to uuid[]. UUIDs are hex/dashes only, so
  // bare concatenation is safe.
  for (const id of sessionIds) {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      throw new Error(`listRunsForSessionsWithLiveness: invalid uuid: ${id}`);
    }
  }
  const sessionArrayLiteral = `{${sessionIds.join(',')}}`;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT
        r.run_id,
        r.space_id,
        r.workflow_slug,
        r.session_id,
        r.status,
        r.started_at,
        r.completed_at,
        r.scheduler_cursor_at,
        COALESCE(t.total_tasks, 0)::int AS total_tasks,
        COALESCE(t.succeeded_tasks, 0)::int AS succeeded_tasks,
        COALESCE(t.live_tasks, 0)::int AS live_tasks,
        COALESCE(t.scheduled_tasks, 0)::int AS scheduled_tasks,
        COALESCE(t.paused_tasks, 0)::int AS paused_tasks
      FROM workflow_runs r
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS total_tasks,
          count(*) FILTER (WHERE wrt.status = 'succeeded')::int AS succeeded_tasks,
          count(*) FILTER (WHERE wrt.status IN ('running','claimed','in_flight'))::int AS live_tasks,
          count(*) FILTER (WHERE wrt.status = 'scheduled')::int AS scheduled_tasks,
          count(*) FILTER (WHERE wrt.status = 'paused')::int AS paused_tasks
        FROM workflow_run_tasks wrt
        WHERE wrt.run_id = r.run_id
      ) t ON true
      WHERE r.space_id = ${spaceId}
        AND r.session_id = ANY(${sessionArrayLiteral}::uuid[])
      ORDER BY r.started_at DESC
      LIMIT ${opts.limit}
    `);

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      runId: row['run_id'] as string,
      spaceId: row['space_id'] as string,
      workflowSlug: row['workflow_slug'] as string,
      sessionId: (row['session_id'] as string | null) ?? null,
      status: row['status'] as string,
      startedAt: new Date(row['started_at'] as string),
      completedAt: row['completed_at'] ? new Date(row['completed_at'] as string) : null,
      schedulerCursorAt: row['scheduler_cursor_at']
        ? new Date(row['scheduler_cursor_at'] as string)
        : null,
      totalTasks: row['total_tasks'] as number,
      succeededTasks: row['succeeded_tasks'] as number,
      liveTasks: row['live_tasks'] as number,
      scheduledTasks: row['scheduled_tasks'] as number,
      pausedTasks: row['paused_tasks'] as number,
    }));
  });
}

/**
 * Collect a session and all its descendants via the `parent_session_id`
 * chain. Bounded by `maxDepth` to keep the recursive CTE cheap. Returns
 * the input session even if it has no descendants.
 */
export async function listSessionDescendants(
  db: PostgresJsDatabase,
  tenantId: string,
  rootSessionId: string,
  opts: { maxDepth: number; limit: number },
): Promise<string[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT session_id, parent_session_id, 0 AS depth
        FROM sessions
        WHERE session_id = ${rootSessionId}::uuid
        UNION ALL
        SELECT s.session_id, s.parent_session_id, d.depth + 1
        FROM sessions s
        INNER JOIN descendants d ON s.parent_session_id = d.session_id
        WHERE d.depth < ${opts.maxDepth}
      )
      SELECT session_id FROM descendants
      LIMIT ${opts.limit}
    `);
    return (rows as Array<Record<string, unknown>>).map((r) => r['session_id'] as string);
  });
}

/**
 * Walk upward from a session via `parent_session_id` to find the cascade
 * root — the topmost ancestor with no parent. When the user opens the chat
 * inspector on a sub-agent (Driver / Runner / Coach), this lets us anchor
 * the active surface on the Helmsman that owns the cascade so the bird's-
 * eye view is always coherent rather than scoped to a single sub-tree.
 *
 * Bounded by `maxDepth`; returns the input session if no parent chain exists
 * (already a root or row missing).
 */
export async function findCascadeRoot(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
  opts: { maxDepth: number },
): Promise<string> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx.execute(sql`
      WITH RECURSIVE ancestors AS (
        SELECT session_id, parent_session_id, 0 AS depth
        FROM sessions
        WHERE session_id = ${sessionId}::uuid
        UNION ALL
        SELECT s.session_id, s.parent_session_id, a.depth + 1
        FROM sessions s
        INNER JOIN ancestors a ON s.session_id = a.parent_session_id
        WHERE a.depth < ${opts.maxDepth}
      )
      SELECT session_id
      FROM ancestors
      WHERE parent_session_id IS NULL
      ORDER BY depth DESC
      LIMIT 1
    `);
    const root = rows[0]?.['session_id'];
    return typeof root === 'string' ? root : sessionId;
  });
}

// ============================================================================
// Evaluation-envelope backfill (Plan 269 D16 — closing the accepted window)
// ============================================================================

export interface EnvelopeBackfillCandidateRow {
  runId: string;
  spaceId: string;
  workflowSlug: string;
  completedAt: Date | null;
}

/**
 * Terminal runs in cybernetic spaces whose `evaluation_json` is still NULL —
 * the crash window between the terminal CAS and the in-process post-run
 * hook. Joined on `spaces.directives IS NOT NULL` to mirror the hook's own
 * gate: a run the hook would skip anyway must not be re-selected forever.
 * Oldest-first so re-firing drains the historical window; the grace-window
 * cut is applied in-process by {@link selectEnvelopeBackfillCandidates}.
 */
export async function listRunsMissingEvaluationEnvelope(
  db: PostgresJsDatabase,
  tenantId: string,
  opts: { limit: number },
): Promise<EnvelopeBackfillCandidateRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        runId: workflowRuns.runId,
        spaceId: workflowRuns.spaceId,
        workflowSlug: workflowRuns.workflowSlug,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .innerJoin(
        spaces,
        and(eq(spaces.id, workflowRuns.spaceId), sql`${spaces.directives} IS NOT NULL`),
      )
      .where(
        and(
          inArray(workflowRuns.status, ['completed', 'failed', 'cancelled']),
          sql`${workflowRuns.evaluationJson} IS NULL`,
        ),
      )
      .orderBy(asc(workflowRuns.completedAt), asc(workflowRuns.runId))
      .limit(opts.limit),
  );
}

/**
 * The pure selection over candidate rows: only runs terminal for longer than
 * the grace window are re-fired (the in-process hook normally lands within
 * seconds of the terminal CAS — re-firing inside the window would race it),
 * and a terminal run with no `completedAt` is malformed, not backfillable.
 */
export function selectEnvelopeBackfillCandidates<T extends { completedAt: Date | null }>(
  rows: readonly T[],
  opts: { now: Date; graceMs: number; limit: number },
): T[] {
  const cutoffMs = opts.now.getTime() - opts.graceMs;
  return rows
    .filter((row) => row.completedAt !== null && row.completedAt.getTime() <= cutoffMs)
    .slice(0, opts.limit);
}

/**
 * The moment the envelope writer first went live for this tenant, derived
 * structurally from the rows themselves: the earliest `decidedAt` any
 * envelope carries. No hardcoded date, no persisted watermark — and stable,
 * because every later write (in-process hook or backfill) stamps a LATER
 * `decidedAt` and can never move the minimum back.
 */
export async function getEarliestEnvelopeDecidedAt(
  db: PostgresJsDatabase,
  tenantId: string,
): Promise<Date | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({
        earliest: sql<
          string | null
        >`min((${workflowRuns.evaluationJson}->>'decidedAt')::timestamptz)`,
      })
      .from(workflowRuns)
      .where(sql`${workflowRuns.evaluationJson} IS NOT NULL`);
    const earliest = rows[0]?.earliest;
    return earliest ? new Date(earliest) : null;
  });
}

/**
 * D16 backfill split: a NULL-envelope run terminal BEFORE the envelope era
 * started is pre-envelope history — it gets a plain envelope decision, never
 * a full pipeline re-fire (the founding hazard: first deploy re-firing
 * eval/score/candidate over the entire historical backlog). Runs terminal
 * inside the era are the actual crash window and keep the full re-fire.
 * A null era start means no envelope has ever been written — everything
 * terminal so far predates the machinery.
 */
export function partitionEnvelopeBackfillCandidates<T extends { completedAt: Date | null }>(
  rows: readonly T[],
  opts: { envelopeEraStart: Date | null },
): { historical: T[]; crashWindow: T[] } {
  const historical: T[] = [];
  const crashWindow: T[] = [];
  for (const row of rows) {
    const isHistorical =
      opts.envelopeEraStart === null ||
      (row.completedAt !== null && row.completedAt.getTime() < opts.envelopeEraStart.getTime());
    (isHistorical ? historical : crashWindow).push(row);
  }
  return { historical, crashWindow };
}
