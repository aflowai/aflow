import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRunTasks,
  workflowRunCompletionPending,
} from '@aflow/database';
import { RESERVED_TASK_STATUS } from './concurrencySlots.js';

/**
 * A dispatch claim may create the row or upgrade the slot its scheduler already
 * reserved — and nothing else. Any other existing row belongs to a task another
 * path is driving, and the empty RETURNING is what tells the caller to skip it.
 */
const RESERVED_SLOT_ONLY = sql`workflow_run_tasks.status = ${RESERVED_TASK_STATUS}`;

/**
 * Atomically claim a task for scheduling (104d Phase 1a).
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING against the UNIQUE (run_id, task_id)
 * constraint. If a row is returned, the claim succeeded and the caller may
 * proceed to `scheduleStep`. If no row is returned, another scheduling pass
 * already claimed this task — the caller must skip it.
 *
 * This is the serialization point for claim-before-schedule: `scheduleStep`
 * is never called without a successful claim.
 *
 * @returns The inserted row id if claimed, null if already claimed by another pass.
 */
export async function claimTask(
  db: PostgresJsDatabase,
  tenantId: string,
  params: {
    runId: string;
    taskId: string;
    sessionId?: string;
  },
): Promise<string | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // ON CONFLICT DO NOTHING: if (run_id, task_id) already exists, returns empty
    const result = await tx
      .insert(workflowRunTasks)
      .values({
        runId: params.runId,
        taskId: params.taskId,
        status: 'scheduled',
        attempt: 1,
        startedAt: new Date(),
        ...(params.sessionId != null ? { sessionId: params.sessionId } : {}),
      })
      .onConflictDoNothing({ target: [workflowRunTasks.runId, workflowRunTasks.taskId] })
      .returning({ id: workflowRunTasks.id });

    return result[0]?.id ?? null;
  });
}

export interface ClaimHumanTaskParams {
  runId: string;
  taskId: string;
  attempt: number;
  inputRef: string;
  humanTaskHydrationRef?: string;
  humanTaskHydrationPauseVersion?: number;
  humanTaskHydrationAttempt?: number;
}

export async function claimHumanTask(
  db: PostgresJsDatabase,
  tenantId: string,
  params: ClaimHumanTaskParams,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const inserted = await tx
      .insert(workflowRunTasks)
      .values({
        runId: params.runId,
        taskId: params.taskId,
        status: 'paused',
        attempt: params.attempt,
        inputRef: params.inputRef,
        startedAt: new Date(),
        ...(params.humanTaskHydrationRef
          ? { humanTaskHydrationRef: params.humanTaskHydrationRef }
          : {}),
        ...(params.humanTaskHydrationPauseVersion !== undefined
          ? { humanTaskHydrationPauseVersion: params.humanTaskHydrationPauseVersion }
          : {}),
        ...(params.humanTaskHydrationAttempt !== undefined
          ? { humanTaskHydrationAttempt: params.humanTaskHydrationAttempt }
          : {}),
      })
      .onConflictDoUpdate({
        target: [workflowRunTasks.runId, workflowRunTasks.taskId],
        set: {
          status: sql`excluded.status`,
          attempt: sql`excluded.attempt`,
          inputRef: sql`excluded.input_ref`,
          startedAt: sql`excluded.started_at`,
          humanTaskHydrationRef: sql`excluded.human_task_hydration_ref`,
          humanTaskHydrationPauseVersion: sql`excluded.human_task_hydration_pause_version`,
          humanTaskHydrationAttempt: sql`excluded.human_task_hydration_attempt`,
          dispatchDeadlineAt: null,
        },
        setWhere: RESERVED_SLOT_ONLY,
      })
      .returning({ id: workflowRunTasks.id });
    return inserted.length > 0;
  });
}

export interface ClaimAndScheduleParams {
  runId: string;
  taskId: string;
  attempt: number;
  workerSessionId: string;
  dispatchAttemptToken: string;
  inputRef: string;
  dueAt: Date;
  /** Optional — recorded for observability when present. */
  stepExecutionId?: string;
  /** Optional — for agent-task dispatches only. */
  sessionId?: string;
  operationId?: string;
}

export async function claimAndSchedule(
  db: PostgresJsDatabase,
  tenantId: string,
  params: ClaimAndScheduleParams,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const inserted = await tx
      .insert(workflowRunTasks)
      .values({
        runId: params.runId,
        taskId: params.taskId,
        status: 'running',
        attempt: params.attempt,
        workerSessionId: params.workerSessionId,
        dispatchAttemptToken: params.dispatchAttemptToken,
        inputRef: params.inputRef,
        startedAt: new Date(),
        ...(params.stepExecutionId != null ? { stepExecutionId: params.stepExecutionId } : {}),
        ...(params.sessionId != null ? { sessionId: params.sessionId } : {}),
        ...(params.operationId != null ? { operationId: params.operationId } : {}),
      })
      .onConflictDoUpdate({
        target: [workflowRunTasks.runId, workflowRunTasks.taskId],
        set: {
          status: sql`excluded.status`,
          attempt: sql`excluded.attempt`,
          workerSessionId: sql`excluded.worker_session_id`,
          dispatchAttemptToken: sql`excluded.dispatch_attempt_token`,
          inputRef: sql`excluded.input_ref`,
          startedAt: sql`excluded.started_at`,
          stepExecutionId: sql`excluded.step_execution_id`,
          sessionId: sql`excluded.session_id`,
          operationId: sql`excluded.operation_id`,
          dispatchDeadlineAt: null,
        },
        setWhere: RESERVED_SLOT_ONLY,
      })
      .returning({ id: workflowRunTasks.id });

    if (inserted.length === 0) {
      return false; // another scheduling pass won
    }

    await tx
      .insert(workflowRunCompletionPending)
      .values({
        runId: params.runId,
        taskId: params.taskId,
        attempt: params.attempt,
        workerSessionId: params.workerSessionId,
        dueAt: params.dueAt,
      })
      .onConflictDoNothing({
        target: [
          workflowRunCompletionPending.runId,
          workflowRunCompletionPending.taskId,
          workflowRunCompletionPending.attempt,
        ],
      });

    return true;
  });
}

/**
 * Release a claimed task row — delete it so a future scheduling pass can
 * re-claim it. Used as rollback when `scheduleStep()` fails after a
 * successful `claimTask()`.
 *
 * Only deletes the row if it's still in 'scheduled' status (the claim state).
 * If the task has already transitioned (e.g., to 'running'), the delete is
 * a safe no-op.
 */
export async function releaseClaimedTask(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  taskId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .delete(workflowRunTasks)
      .where(
        and(
          eq(workflowRunTasks.runId, runId),
          eq(workflowRunTasks.taskId, taskId),
          eq(workflowRunTasks.status, 'scheduled'),
        ),
      );
  });
}

export async function claimTaskForRerun(
  db: PostgresJsDatabase,
  tenantId: string,
  params: {
    runId: string;
    taskId: string;
    sessionId?: string;
  },
): Promise<string | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const result = await tx
      .update(workflowRunTasks)
      .set({
        status: 'scheduled',
        startedAt: new Date(),
        ...(params.sessionId != null ? { sessionId: params.sessionId } : {}),
      })
      .where(
        and(
          eq(workflowRunTasks.runId, params.runId),
          eq(workflowRunTasks.taskId, params.taskId),
          eq(workflowRunTasks.status, 'pending'),
          sql`${workflowRunTasks.attempt} > 1`,
        ),
      )
      .returning({ id: workflowRunTasks.id });
    return result[0]?.id ?? null;
  });
}

export async function releaseRerunClaim(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  taskId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .update(workflowRunTasks)
      .set({
        status: 'pending',
        startedAt: null,
        sessionId: null,
      })
      .where(
        and(
          eq(workflowRunTasks.runId, runId),
          eq(workflowRunTasks.taskId, taskId),
          eq(workflowRunTasks.status, 'scheduled'),
          sql`${workflowRunTasks.attempt} > 1`,
        ),
      );
  });
}

export async function resetTasksForRerun(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { runId: string; taskIds: readonly string[] },
): Promise<string[]> {
  if (params.taskIds.length === 0) return [];
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .update(workflowRunTasks)
      .set({
        status: 'pending',
        attempt: sql`${workflowRunTasks.attempt} + 1`,
        outputRef: null,
        summary: null,
        metricsJson: null,
        failureReason: null,
        completedAt: null,
        durationMs: null,
        costCents: null,
        stepExecutionId: null,
        pollCycle: 1,
      })
      .where(
        and(
          eq(workflowRunTasks.runId, params.runId),
          inArray(workflowRunTasks.taskId, params.taskIds as string[]),
        ),
      )
      .returning({ taskId: workflowRunTasks.taskId });
    return rows.map((r) => r.taskId);
  });
}

export interface CasCompleteTaskParams {
  runId: string;
  taskId: string;
  attempt: number;
  status: 'succeeded' | 'failed' | 'paused';
  completedAt: Date;
  durationMs?: number;
  outputRef?: string;
  failureReason?: string;
  summary?: string;
  metricsJson?: unknown;
  reflectionJson?: unknown;
  failedAt?: Date;
  errorCode?: string;
  errorClassification?: string;
  errorRetryable?: boolean;
}

export async function casCompleteTask(
  db: PostgresJsDatabase,
  tenantId: string,
  params: CasCompleteTaskParams,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRunTasks)
      .set({
        status: params.status,
        completedAt: params.completedAt,
        ...(params.durationMs != null ? { durationMs: params.durationMs } : {}),
        ...(params.outputRef != null ? { outputRef: params.outputRef } : {}),
        ...(params.failureReason != null ? { failureReason: params.failureReason } : {}),
        ...(params.summary != null ? { summary: params.summary } : {}),
        ...(params.metricsJson != null ? { metricsJson: params.metricsJson } : {}),
        ...(params.reflectionJson != null ? { reflectionJson: params.reflectionJson } : {}),
        ...(params.failedAt != null ? { failedAt: params.failedAt } : {}),
        ...(params.errorCode != null ? { errorCode: params.errorCode } : {}),
        ...(params.errorClassification != null
          ? { errorClassification: params.errorClassification }
          : {}),
        ...(params.errorRetryable != null ? { errorRetryable: params.errorRetryable } : {}),
        // worker_session_id / step_execution_id / started_at intentionally
        // not set — the claim row already carries them and they must
        // survive completion as evidence for sweeper / observability.
      })
      .where(
        and(
          eq(workflowRunTasks.runId, params.runId),
          eq(workflowRunTasks.taskId, params.taskId),
          eq(workflowRunTasks.attempt, params.attempt),
          // Status guard: only update non-terminal rows. Prevents
          // racing a concurrent cancel (status='cancelled') or a stale
          // duplicate that already wrote terminal.
          sql`${workflowRunTasks.status} NOT IN ('succeeded', 'failed', 'blocked', 'skipped', 'cancelled', 'paused')`,
        ),
      )
      .returning({ id: workflowRunTasks.id });
    return updated.length > 0;
  });
}
