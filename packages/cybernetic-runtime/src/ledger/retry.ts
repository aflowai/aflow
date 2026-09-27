import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
  workflowRunCompletionPending,
} from '@aflow/database';
import { clearBlockedDescendantsForRetry } from './tasks.js';
import { awaitingDispatchPatch } from './dispatchArming.js';
import { hasFreeSlotForTask } from './concurrencySlots.js';
// ============================================================================

export interface ClaimRetriedTaskParams {
  runId: string;
  taskId: string;
  /** Expected attempt — must match the row's current value (set by the commit-retry helper). */
  attempt: number;
  workerSessionId: string;
  dispatchAttemptToken: string;
  inputRef: string;
  stepExecutionId?: string;
  operationId?: string;
  sessionId?: string;
  dueAt: Date;
}

export async function claimRetriedTask(
  db: PostgresJsDatabase,
  tenantId: string,
  params: ClaimRetriedTaskParams,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRunTasks)
      .set({
        workerSessionId: params.workerSessionId,
        dispatchAttemptToken: params.dispatchAttemptToken,
        inputRef: params.inputRef,
        startedAt: new Date(),
        // The claim is the dispatch, so the deadline it was racing is spent.
        // Cleared in this same statement rather than a follow-up, both to keep
        // the claim one round trip and so the row can never carry a live worker
        // and an expired deadline at once.
        dispatchDeadlineAt: null,
        ...(params.stepExecutionId != null ? { stepExecutionId: params.stepExecutionId } : {}),
        ...(params.sessionId != null ? { sessionId: params.sessionId } : {}),
        ...(params.operationId != null ? { operationId: params.operationId } : {}),
      })
      .where(
        and(
          eq(workflowRunTasks.runId, params.runId),
          eq(workflowRunTasks.taskId, params.taskId),
          eq(workflowRunTasks.attempt, params.attempt),
          sql`${workflowRunTasks.workerSessionId} IS NULL`,
          eq(workflowRunTasks.status, 'running'),
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

export interface CommitRetryFailedTaskArgs {
  runId: string;
  taskId: string;
  /**
   * CAS token half 1 — must match the failed row's `failed_at`. Pairs
   * with `attempt` to identify the exact failure being retried.
   */
  failedAt: Date;
  /** CAS token half 2 — must match the failed row's current attempt. */
  attempt: number;
  maxAttempts: number;
  /** Skip the attempt-budget gate for a deliberate, operator-confirmed retry. */
  allowBudgetReset?: boolean;
  remediationNote?: string;
  descendantTaskIds?: string[];
}

export type CommitRetryFailedTaskResult =
  | 'committed'
  | 'wrong_run_state'
  | 'stale_failure_cas'
  | 'task_not_found_or_not_failed'
  | 'attempt_budget_exhausted'
  | 'at_parallel_limit';

class WrongRunStateError extends Error {
  constructor(runId: string, actual: string) {
    super(`Run ${runId} is not in 'failed' state (status=${actual}); retry_failed_task refused.`);
    this.name = 'WrongRunStateError';
  }
}
class StaleFailureCasError extends Error {
  constructor(runId: string, taskId: string) {
    super(
      `retry_failed_task CAS missed on run ${runId} task ${taskId} — (failedAt, attempt) did not match the live row.`,
    );
    this.name = 'StaleFailureCasError';
  }
}
class TaskNotFoundOrNotFailedError extends Error {
  constructor(runId: string, taskId: string) {
    super(
      `Task ${taskId} on run ${runId} is not in 'failed' state — retry_failed_task cannot transition it.`,
    );
    this.name = 'TaskNotFoundOrNotFailedError';
  }
}
class AttemptBudgetExhaustedError extends Error {
  constructor(taskId: string, attempt: number, maxAttempts: number) {
    super(
      `Task ${taskId} retry budget exhausted: attempt=${String(attempt)} >= maxAttempts=${String(maxAttempts)}.`,
    );
    this.name = 'AttemptBudgetExhaustedError';
  }
}

export async function commitRetryFailedTaskAndResume(
  db: PostgresJsDatabase,
  tenantId: string,
  args: CommitRetryFailedTaskArgs,
): Promise<CommitRetryFailedTaskResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // 1. Load the failed task row. Read its existing columns so the
    //    `prior_failures` append can capture the failure being retried.
    const rows = await tx
      .select()
      .from(workflowRunTasks)
      .where(and(eq(workflowRunTasks.runId, args.runId), eq(workflowRunTasks.taskId, args.taskId)))
      .limit(1);
    const row = rows[0];
    if (row?.status !== 'failed') {
      throw new TaskNotFoundOrNotFailedError(args.runId, args.taskId);
    }
    // CAS check on (failedAt, attempt). Comparing Date instances
    // millisecond-equal: getTime() avoids reference-vs-value pitfalls.
    if (row.failedAt?.getTime() !== args.failedAt.getTime() || row.attempt !== args.attempt) {
      throw new StaleFailureCasError(args.runId, args.taskId);
    }
    // 2. Attempt-budget check.
    if (row.attempt >= args.maxAttempts && !args.allowBudgetReset) {
      throw new AttemptBudgetExhaustedError(args.taskId, row.attempt, args.maxAttempts);
    }

    // 3. Build the prior-failure snapshot from the row's current state.
    //    Appended to the existing `prior_failures` JSONB array.
    const newSnapshot: Record<string, unknown> = {
      attempt: row.attempt,
      failedAt: row.failedAt.toISOString(),
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(row.errorClassification ? { errorClassification: row.errorClassification } : {}),
      ...(row.errorRetryable !== null ? { errorRetryable: row.errorRetryable } : {}),
      ...(row.failureReason ? { failureReason: row.failureReason } : {}),
      ...(args.remediationNote ? { remediationNote: args.remediationNote } : {}),
    };
    const snapshotJson = JSON.stringify(newSnapshot);

    // 4. CAS the run row: status='failed' → 'running', clear terminal
    //    markers. Failed runs have no resume_claim_token / pauseVersion,
    //    so the CAS guard is just status='failed' (plus runId).
    const runUpdate = await tx
      .update(workflowRuns)
      .set({
        status: 'running',
        completedAt: null,
        failureJson: null,
      })
      .where(and(eq(workflowRuns.runId, args.runId), eq(workflowRuns.status, 'failed')))
      .returning({ id: workflowRuns.id });
    if (runUpdate.length === 0) {
      throw new WrongRunStateError(args.runId, 'not-failed');
    }

    // 5. In-place task-row update: flip status back to running, bump
    //    attempt, clear failure metadata, append the prior-failure
    //    snapshot. The unique key `(run_id, task_id)` is preserved so
    //    downstream readers (operator surfaces, sweeper) see a monotone
    //    attempt counter and a complete prior-failures audit trail.
    //
    //    `output_ref` / `summary` / `duration_ms` are also cleared:
    //    a failed row may have partial output / summary; clearing them
    //    keeps "this row represents an in-flight attempt N" cleanly.
    // Putting the row back into `running` takes one of the run's slots. An
    // operation that bills on submit cannot un-buy an over-limit call, so the
    // limit is enforced here rather than left to a later reservation pass.
    if (!(await hasFreeSlotForTask(tx, args.runId, args.taskId))) {
      return 'at_parallel_limit';
    }

    const taskUpdate = await tx
      .update(workflowRunTasks)
      .set({
        ...awaitingDispatchPatch(),
        attempt: row.attempt + 1,
        failedAt: null,
        errorCode: null,
        errorClassification: null,
        errorRetryable: null,
        failureReason: null,
        completedAt: null,
        outputRef: null,
        summary: null,
        durationMs: null,
        // step_execution_id / session_id are cleared alongside the worker
        // session the arming patch clears — the new attempt populates them at
        // retry-claim time. Clearing `session_id` matters even though the
        // column is a legacy duplicate of `worker_session_id` for agent tasks:
        // if `dispatchRetriedTask` throws pre-claim (e.g. buildTaskInputRef
        // raises before `claimRetriedTask` writes the new claim fields),
        // the fallback `casCompleteTask` writes the row at attempt=N+1
        // with the OLD attempt's session id still in place. Downstream
        // readers that key digest / thread assembly on `session_id`
        // would then attribute the new failure to the prior attempt's
        // thread (cross-attempt contamination).
        stepExecutionId: null,
        sessionId: null,
        pollCycle: 1,
        priorFailures: sql`COALESCE(${workflowRunTasks.priorFailures}, '[]'::jsonb) || ${snapshotJson}::jsonb`,
      })
      .where(
        and(
          eq(workflowRunTasks.runId, args.runId),
          eq(workflowRunTasks.taskId, args.taskId),
          eq(workflowRunTasks.status, 'failed'),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (taskUpdate.length !== 1) {
      // Race: another path (concurrent retry winning, sweeper) advanced
      // the row out from under us between the select and update.
      throw new StaleFailureCasError(args.runId, args.taskId);
    }

    await clearBlockedDescendantsForRetry(tx, args.runId, args.descendantTaskIds ?? []);

    return 'committed' as const;
  }).catch((err: unknown) => {
    if (err instanceof WrongRunStateError) return 'wrong_run_state' as const;
    if (err instanceof StaleFailureCasError) return 'stale_failure_cas' as const;
    if (err instanceof TaskNotFoundOrNotFailedError) return 'task_not_found_or_not_failed' as const;
    if (err instanceof AttemptBudgetExhaustedError) return 'attempt_budget_exhausted' as const;
    throw err;
  });
}
