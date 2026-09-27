import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, inArray, isNull, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRunCompletionPending,
  workflowRunTasks,
} from '@aflow/database';
import { getCyberneticLogger } from '../logger.js';
export interface RecordTaskResultParams {
  runId: string;
  taskId: string;
  status: string;
  attempt?: number;
  sessionId?: string;
  workerSessionId?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  costCents?: number;
  metricsJson?: unknown;
  summary?: string;
  failureReason?: string;
  outputRef?: string;
  reflectionJson?: unknown;
  /** 104d Phase 5 — StepExecution ID for recovery (distinguishes live from orphaned). */
  stepExecutionId?: string;
}

export async function recordTaskResult(
  db: PostgresJsDatabase,
  tenantId: string,
  params: RecordTaskResultParams,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .insert(workflowRunTasks)
      .values({
        runId: params.runId,
        taskId: params.taskId,
        status: params.status,
        ...(params.attempt != null ? { attempt: params.attempt } : {}),
        ...(params.sessionId != null ? { sessionId: params.sessionId } : {}),
        ...(params.workerSessionId != null ? { workerSessionId: params.workerSessionId } : {}),
        ...(params.startedAt != null ? { startedAt: params.startedAt } : {}),
        ...(params.completedAt != null ? { completedAt: params.completedAt } : {}),
        ...(params.durationMs != null ? { durationMs: params.durationMs } : {}),
        ...(params.costCents != null ? { costCents: params.costCents } : {}),
        ...(params.metricsJson != null ? { metricsJson: params.metricsJson } : {}),
        ...(params.summary != null ? { summary: params.summary } : {}),
        ...(params.failureReason != null ? { failureReason: params.failureReason } : {}),
        ...(params.outputRef != null ? { outputRef: params.outputRef } : {}),
        ...(params.reflectionJson != null ? { reflectionJson: params.reflectionJson } : {}),
        ...(params.stepExecutionId != null ? { stepExecutionId: params.stepExecutionId } : {}),
      })
      .onConflictDoUpdate({
        target: [workflowRunTasks.runId, workflowRunTasks.taskId],
        set: {
          // Guard: do not overwrite a 'blocked' row. A blocked task should stay
          // blocked even if a previously-running sibling reports back late
          // (cancel_siblings scenario). Other terminal states (succeeded, failed,
          // skipped) CAN be updated (e.g., recording final metrics on success).
          status: sql`CASE WHEN workflow_run_tasks.status = 'blocked' THEN workflow_run_tasks.status ELSE excluded.status END`,
          attempt: sql`excluded.attempt`,
          sessionId: sql`excluded.session_id`,
          workerSessionId: sql`excluded.worker_session_id`,
          // Preserve startedAt/completedAt across intermediate upserts.
          startedAt: sql`COALESCE(excluded.started_at, workflow_run_tasks.started_at)`,
          completedAt: sql`COALESCE(excluded.completed_at, workflow_run_tasks.completed_at)`,
          durationMs: sql`COALESCE(excluded.duration_ms, workflow_run_tasks.duration_ms)`,
          costCents: sql`COALESCE(excluded.cost_cents, workflow_run_tasks.cost_cents)`,
          metricsJson: sql`COALESCE(excluded.metrics_json, workflow_run_tasks.metrics_json)`,
          summary: sql`CASE WHEN workflow_run_tasks.status = 'blocked' THEN workflow_run_tasks.summary ELSE excluded.summary END`,
          failureReason: sql`excluded.failure_reason`,
          outputRef: sql`excluded.output_ref`,
          reflectionJson: sql`COALESCE(excluded.reflection_json, workflow_run_tasks.reflection_json)`,
          stepExecutionId: sql`excluded.step_execution_id`,
        },
      });
  });
}

export async function setTaskReflection(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { runId: string; taskId: string; attempt: number; reflection: unknown },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRunTasks)
      .set({ reflectionJson: params.reflection })
      .where(
        and(
          eq(workflowRunTasks.runId, params.runId),
          eq(workflowRunTasks.taskId, params.taskId),
          eq(workflowRunTasks.attempt, params.attempt),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    return updated.length > 0;
  });
}

/**
 * Persist the agent's submit_output `summary` on the task row. The field
 * is advertised on the tool contract; without this write nothing persists
 * it, so the eval's reserved `summary` criterion can never resolve for
 * agent tasks. Attempt-guarded; never overwrites an
 * existing summary (the completion writer wins if both run).
 */
export async function setTaskSummary(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { runId: string; taskId: string; attempt: number; summary: string },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRunTasks)
      .set({ summary: params.summary })
      .where(
        and(
          eq(workflowRunTasks.runId, params.runId),
          eq(workflowRunTasks.taskId, params.taskId),
          eq(workflowRunTasks.attempt, params.attempt),
          isNull(workflowRunTasks.summary),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    return updated.length > 0;
  });
}

export async function advanceTaskPollCycle(
  db: PostgresJsDatabase,
  tenantId: string,
  params: {
    runId: string;
    taskId: string;
    attempt: number;
    fromCycle: number;
    toCycle: number;
    /** Fresh per-cycle step execution id (uuid) — also the worker_session_id. */
    stepExecutionId: string;
    /** Re-armed completion_pending supervision deadline. */
    dueAt: Date;
  },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRunTasks)
      .set({
        pollCycle: params.toCycle,
        stepExecutionId: params.stepExecutionId,
        workerSessionId: params.stepExecutionId,
      })
      .where(
        and(
          eq(workflowRunTasks.runId, params.runId),
          eq(workflowRunTasks.taskId, params.taskId),
          eq(workflowRunTasks.attempt, params.attempt),
          eq(workflowRunTasks.status, 'running'),
          eq(workflowRunTasks.pollCycle, params.fromCycle),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (updated.length === 0) return false;

    await tx
      .insert(workflowRunCompletionPending)
      .values({
        runId: params.runId,
        taskId: params.taskId,
        attempt: params.attempt,
        workerSessionId: params.stepExecutionId,
        dueAt: params.dueAt,
      })
      .onConflictDoUpdate({
        target: [
          workflowRunCompletionPending.runId,
          workflowRunCompletionPending.taskId,
          workflowRunCompletionPending.attempt,
        ],
        set: {
          workerSessionId: params.stepExecutionId,
          dueAt: params.dueAt,
        },
      });

    return true;
  });
}

/**
 * Record a task as skipped (104d Phase 1 — when predicate evaluated to false).
 * Uses INSERT ON CONFLICT DO UPDATE to handle the case where the task was
 * previously claimed but is now being skipped.
 */
export async function recordTaskSkipped(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { runId: string; taskId: string; reason: string },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .insert(workflowRunTasks)
      .values({
        runId: params.runId,
        taskId: params.taskId,
        status: 'skipped',
        attempt: 0,
        summary: params.reason,
        completedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workflowRunTasks.runId, workflowRunTasks.taskId],
        set: {
          status: sql`'skipped'`,
          summary: sql`excluded.summary`,
          completedAt: sql`excluded.completed_at`,
        },
      });
  });
}

/**
 * Block all pending tasks that are descendants of a failed task (cancel_siblings mode).
 * Sets status to 'blocked' for any task row not already in a terminal state.
 */
export async function blockDescendantTasks(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  taskIds: string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    // Insert 'blocked' rows for tasks that don't have rows yet,
    // or update existing non-terminal rows to 'blocked'.
    for (const taskId of taskIds) {
      await tx
        .insert(workflowRunTasks)
        .values({
          runId,
          taskId,
          status: 'blocked',
          attempt: 0,
          completedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [workflowRunTasks.runId, workflowRunTasks.taskId],
          set: {
            // Only update to 'blocked' if the EXISTING row is not already terminal.
            // workflow_run_tasks.status is the current DB value; excluded.status is
            // always 'blocked' (the INSERT value) so we must NOT check excluded.
            status: sql`CASE WHEN workflow_run_tasks.status NOT IN ('succeeded', 'failed', 'blocked', 'skipped') THEN 'blocked' ELSE workflow_run_tasks.status END`,
            completedAt: sql`COALESCE(workflow_run_tasks.completed_at, excluded.completed_at)`,
          },
        });
    }
  });
}

export async function clearBlockedDescendantsForRetry(
  tx: PostgresJsDatabase,
  runId: string,
  descendantTaskIds: string[],
): Promise<{ clearedTaskIds: string[] }> {
  if (descendantTaskIds.length === 0) {
    return { clearedTaskIds: [] };
  }

  const deleted = await tx
    .delete(workflowRunTasks)
    .where(
      and(
        eq(workflowRunTasks.runId, runId),
        eq(workflowRunTasks.status, 'blocked'),
        inArray(workflowRunTasks.taskId, descendantTaskIds),
      ),
    )
    .returning({ taskId: workflowRunTasks.taskId });

  const clearedTaskIds = deleted.map((row) => row.taskId);
  if (clearedTaskIds.length > 0) {
    await tx
      .delete(workflowRunCompletionPending)
      .where(
        and(
          eq(workflowRunCompletionPending.runId, runId),
          inArray(workflowRunCompletionPending.taskId, clearedTaskIds),
        ),
      );
    getCyberneticLogger().info(
      `[clearBlockedDescendantsForRetry] cleared ${String(clearedTaskIds.length)} blocked descendant(s) on retry`,
      {
        runId,
        clearedTaskIds,
        consideredDescendantCount: descendantTaskIds.length,
      },
    );
  }

  return { clearedTaskIds };
}

export async function cancelNonTerminalTasksForRun(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<{ cancelledTaskIds: string[]; interruptedSessions: string[] }> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRunTasks)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(
        and(
          eq(workflowRunTasks.runId, runId),
          // Same set as casCompleteTask's status guard; 'paused' rows are
          // ALSO cancelled (a cancel during pause is the user's signal to
          // tear down rather than resume).
          sql`${workflowRunTasks.status} NOT IN ('succeeded', 'failed', 'blocked', 'skipped', 'cancelled')`,
        ),
      )
      .returning({
        taskId: workflowRunTasks.taskId,
        workerSessionId: workflowRunTasks.workerSessionId,
      });
    const cancelledTaskIds = updated.map((r) => r.taskId);
    const interruptedSessions = Array.from(
      new Set(updated.map((r) => r.workerSessionId).filter((s): s is string => s != null)),
    );
    return { cancelledTaskIds, interruptedSessions };
  });
}

export async function interruptRunningTaskToPaused(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  taskId: string,
): Promise<{ paused: boolean; workerSessionId: string | null; attempt: number }> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRunTasks)
      .set({ status: 'paused' })
      .where(
        and(
          eq(workflowRunTasks.runId, runId),
          eq(workflowRunTasks.taskId, taskId),
          eq(workflowRunTasks.status, 'running'),
        ),
      )
      .returning({
        workerSessionId: workflowRunTasks.workerSessionId,
        attempt: workflowRunTasks.attempt,
      });
    const row = updated[0];
    if (!row) return { paused: false, workerSessionId: null, attempt: 0 };
    return { paused: true, workerSessionId: row.workerSessionId, attempt: row.attempt };
  });
}
