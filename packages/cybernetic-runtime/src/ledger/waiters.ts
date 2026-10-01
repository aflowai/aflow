import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRunTasks,
  workflowRunWaiters,
  workflowRunCompletionPending,
} from '@aflow/database';
import type { WorkflowRunWaiterRow, WorkflowRunCompletionPendingRow } from '@aflow/database';
import type { WaiterNotifiedOutcome } from '@aflow/schemas';
// ============================================================================

/**
 * Read waiters for a run that haven't been notified yet.
 */
export async function loadPendingWaiters(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<WorkflowRunWaiterRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    return await tx
      .select()
      .from(workflowRunWaiters)
      .where(and(eq(workflowRunWaiters.runId, runId), sql`notified_at IS NULL`));
  });
}

export async function loadPendingWaitersForSession(
  db: PostgresJsDatabase,
  tenantId: string,
  waiterSessionId: string,
): Promise<WorkflowRunWaiterRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    return await tx
      .select()
      .from(workflowRunWaiters)
      .where(
        and(eq(workflowRunWaiters.waiterSessionId, waiterSessionId), sql`notified_at IS NULL`),
      );
  });
}

/**
 * The runs a session has a step parked on — its delegation waits. A session
 * waiter is left out: it is pending for as long as a run started without
 * waiting lives, while the session itself goes on working or rests at its
 * prompt, so it says nothing about what the session is blocked on.
 */
export async function loadParkedStepWaitersForSession(
  db: PostgresJsDatabase,
  tenantId: string,
  waiterSessionId: string,
): Promise<WorkflowRunWaiterRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    return await tx
      .select()
      .from(workflowRunWaiters)
      .where(
        and(
          eq(workflowRunWaiters.waiterSessionId, waiterSessionId),
          isNotNull(workflowRunWaiters.waiterStepExecutionId),
          isNull(workflowRunWaiters.notifiedAt),
        ),
      );
  });
}

export async function loadWorkflowTaskByWorkerSession(
  db: PostgresJsDatabase,
  tenantId: string,
  workerSessionId: string,
): Promise<{
  runId: string;
  taskId: string;
  attempt: number;
  dispatchAttemptToken: string | null;
} | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({
        runId: workflowRunTasks.runId,
        taskId: workflowRunTasks.taskId,
        attempt: workflowRunTasks.attempt,
        dispatchAttemptToken: workflowRunTasks.dispatchAttemptToken,
      })
      .from(workflowRunTasks)
      .where(eq(workflowRunTasks.workerSessionId, workerSessionId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Insert a waiter row for a Helmsman session parking on a run — or, without a
 * step, for a session that started the run without waiting on it.
 *
 * Respects the partial unique index `waiters_one_active_per_session`: if
 * an active waiter (notified_at IS NULL) already exists for (run, session),
 * this fails with a uniqueness violation. The harness reuses that as a
 * signal that the same Helmsman is re-parking on the same run without
 * being notified first — caller's responsibility to handle (e.g.,
 * markWaiterNotified before re-add, or treat as no-op).
 *
 * The one exception it resolves itself: a session that started the run
 * without waiting and now parks a step on it. Its session-scoped row is
 * released in the same transaction as the step's row is inserted, so the
 * session is never left waiting on the run twice, or not at all.
 *
 * @returns the inserted row's id.
 */
export async function addWaiter(
  db: PostgresJsDatabase,
  tenantId: string,
  args: { runId: string; waiterSessionId: string; waiterStepExecutionId?: string },
): Promise<string> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    if (args.waiterStepExecutionId !== undefined) {
      await tx
        .update(workflowRunWaiters)
        .set({ notifiedAt: new Date(), notifiedOutcome: 'handed_off' })
        .where(
          and(
            eq(workflowRunWaiters.runId, args.runId),
            eq(workflowRunWaiters.waiterSessionId, args.waiterSessionId),
            isNull(workflowRunWaiters.waiterStepExecutionId),
            isNull(workflowRunWaiters.notifiedAt),
          ),
        );
    }
    const rows = await tx
      .insert(workflowRunWaiters)
      .values({
        runId: args.runId,
        waiterSessionId: args.waiterSessionId,
        waiterStepExecutionId: args.waiterStepExecutionId ?? null,
      })
      .returning({ id: workflowRunWaiters.id });
    const id = rows[0]?.id;
    if (!id) {
      throw new Error('addWaiter: insert returned no row');
    }
    return id;
  });
}

/**
 * Stamp a waiter as notified, recording the outcome that woke them up.
 * Idempotent under repeat invocation — `notified_at` is only set once;
 * a second call with the same waiterId does nothing because the WHERE
 * clause excludes already-notified rows.
 */
export async function markWaiterNotified(
  db: PostgresJsDatabase,
  tenantId: string,
  args: { waiterId: string; outcome: WaiterNotifiedOutcome },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .update(workflowRunWaiters)
      .set({ notifiedAt: new Date(), notifiedOutcome: args.outcome })
      .where(and(eq(workflowRunWaiters.id, args.waiterId), sql`notified_at IS NULL`));
  });
}

/**
 * What a session waiter is told: a pause, by the `pause_version` that pause
 * took, or the outcome that ended its wait.
 */
export type SessionWaiterReport =
  | { outcome: 'paused'; pauseVersion: number }
  | { outcome: Exclude<WaiterNotifiedOutcome, 'paused'> };

/** A terminal outcome retires the waiter, so it is heard once and needs no pause to tell it apart. */
export function sessionWaiterDeliveryKey(report: SessionWaiterReport): string {
  return report.outcome === 'paused' ? `paused:${String(report.pauseVersion)}` : report.outcome;
}

/**
 * Take the delivery of one report to a session waiter, inside the caller's
 * transaction so the wakeup it guards commits with it or not at all.
 *
 * A session waiter stays pending across pauses — it must still hear how the
 * run ends — so it is the recorded key, not `notified_at`, that makes a
 * re-driven or concurrent notification of a pause find nothing to deliver.
 * The key only moves forward: a notify of a pause no later than the one
 * recorded is refused as delivered, however late it arrives. A terminal
 * outcome retires the waiter in the same statement.
 *
 * @returns whether this call owns the delivery.
 */
export async function claimSessionWaiterDelivery(
  tx: PostgresJsDatabase,
  args: { waiterId: string; report: SessionWaiterReport },
): Promise<boolean> {
  const { report } = args;
  const lastDeliveredKey = sessionWaiterDeliveryKey(report);
  const pending = and(
    eq(workflowRunWaiters.id, args.waiterId),
    isNull(workflowRunWaiters.waiterStepExecutionId),
    isNull(workflowRunWaiters.notifiedAt),
  );
  // A terminal key retires the waiter, so a pending one holds a pause's or none.
  const deliveredPause = sql`substring(${workflowRunWaiters.lastDeliveredKey} from '^paused:([0-9]+)$')::int`;
  const rows = await tx
    .update(workflowRunWaiters)
    .set(
      report.outcome === 'paused'
        ? { lastDeliveredKey }
        : { lastDeliveredKey, notifiedAt: new Date(), notifiedOutcome: report.outcome },
    )
    .where(
      report.outcome === 'paused'
        ? and(
            pending,
            sql`(${workflowRunWaiters.lastDeliveredKey} IS NULL OR ${deliveredPause} < ${report.pauseVersion})`,
          )
        : pending,
    )
    .returning({ id: workflowRunWaiters.id });
  return rows.length > 0;
}

/**
 * Insert (or no-op on duplicate) a completion-pending row.
 *
 * Called in two cases by the harness:
 *   1. At task claim time — covers crash between row claim and Runner
 *      spawn / executor enqueue.
 *   2. On Runner-terminal detection — covers crash between terminal
 *      detection and `recordTaskResult`.
 *
 * The unique constraint `pending_one_per_attempt(run_id, task_id, attempt)`
 * naturally dedupes both paths into a single row per attempt.
 */
export async function addCompletionPending(
  db: PostgresJsDatabase,
  tenantId: string,
  args: {
    runId: string;
    taskId: string;
    attempt: number;
    workerSessionId: string;
    dueAt: Date;
  },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .insert(workflowRunCompletionPending)
      .values({
        runId: args.runId,
        taskId: args.taskId,
        attempt: args.attempt,
        workerSessionId: args.workerSessionId,
        dueAt: args.dueAt,
      })
      .onConflictDoNothing({
        target: [
          workflowRunCompletionPending.runId,
          workflowRunCompletionPending.taskId,
          workflowRunCompletionPending.attempt,
        ],
      });
  });
}

/**
 * Bump a completion-pending row's `dueAt` and increment the sweeper
 * retry counter. Called by `reconcileStaleRun` when the worker is
 * still alive and non-terminal — extends the sweep cadence rather
 * than treating the entry as stale.
 *
 * @returns true if a row was updated, false if the row no longer
 *   exists (already cleared by another path).
 */
export async function bumpCompletionPendingDueAt(
  db: PostgresJsDatabase,
  tenantId: string,
  args: {
    runId: string;
    taskId: string;
    attempt: number;
    newDueAt: Date;
    lastError?: string;
  },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const result = await tx
      .update(workflowRunCompletionPending)
      .set({
        dueAt: args.newDueAt,
        attemptCount: sql`${workflowRunCompletionPending.attemptCount} + 1`,
        ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
      })
      .where(
        and(
          eq(workflowRunCompletionPending.runId, args.runId),
          eq(workflowRunCompletionPending.taskId, args.taskId),
          eq(workflowRunCompletionPending.attempt, args.attempt),
        ),
      )
      .returning({ id: workflowRunCompletionPending.id });
    return result.length > 0;
  });
}

/**
 * Delete the completion-pending row for an attempt. Called from
 * `recordTaskResult` (success path) and from `onWorkflowTaskComplete`
 * when the task was cancelled mid-flight (drop-without-record).
 */
export async function clearCompletionPending(
  db: PostgresJsDatabase,
  tenantId: string,
  args: { runId: string; taskId: string; attempt: number },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .delete(workflowRunCompletionPending)
      .where(
        and(
          eq(workflowRunCompletionPending.runId, args.runId),
          eq(workflowRunCompletionPending.taskId, args.taskId),
          eq(workflowRunCompletionPending.attempt, args.attempt),
        ),
      );
  });
}

export async function recoverOrphanedTaskAttempt(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  taskId: string,
  attempt: number,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const deleted = await tx
      .delete(workflowRunTasks)
      .where(
        and(
          eq(workflowRunTasks.runId, runId),
          eq(workflowRunTasks.taskId, taskId),
          eq(workflowRunTasks.attempt, attempt),
          // Only recover from 'running' — anything else is a real
          // state we must not destroy (terminal, paused, etc.).
          eq(workflowRunTasks.status, 'running'),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (deleted.length === 0) {
      // Row already transitioned (e.g., the Runner came back, or a
      // concurrent sweeper handled it). Leave the completion_pending
      // alone so the new state's owner can clear it on terminal.
      return false;
    }
    await tx
      .delete(workflowRunCompletionPending)
      .where(
        and(
          eq(workflowRunCompletionPending.runId, runId),
          eq(workflowRunCompletionPending.taskId, taskId),
          eq(workflowRunCompletionPending.attempt, attempt),
        ),
      );
    return true;
  });
}

export async function listCompletionPendingForRun(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<WorkflowRunCompletionPendingRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    return await tx
      .select()
      .from(workflowRunCompletionPending)
      .where(eq(workflowRunCompletionPending.runId, runId));
  });
}

export async function clearAllCompletionPendingForRun(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .delete(workflowRunCompletionPending)
      .where(eq(workflowRunCompletionPending.runId, runId));
  });
}

/**
 * List completion-pending rows past their `dueAt`. The sweeper uses
 * this to find work; for each entry it inspects the worker session
 * state and bumps / re-dispatches / re-runs intercept / drops the row.
 */
export async function listDueCompletionPending(
  db: PostgresJsDatabase,
  tenantId: string,
  opts: { limit: number; now?: Date },
): Promise<WorkflowRunCompletionPendingRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const cutoff = opts.now ?? new Date();
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // Use the typed `lte` operator instead of a raw `sql` template so
    // drizzle communicates the column type (timestamptz) to postgres-js;
    // the raw template lost the type and made postgres-js's prepared
    // Bind step throw "Received an instance of Date" when serializing.
    return await tx
      .select()
      .from(workflowRunCompletionPending)
      .where(lte(workflowRunCompletionPending.dueAt, cutoff))
      .limit(opts.limit);
  });
}
