/**
 * First-class workflow run cancellation with Runner cascade.
 */
import { randomUUID } from 'node:crypto';
import { addControlMessage, markStepCancelled, publishStepAbort } from '@aflow/redis';
import {
  listCompletionPendingForRun,
  cancelNonTerminalTasksForRun,
  clearAllCompletionPendingForRun,
  loadParkedStepWaitersForSession,
} from '@aflow/cybernetic-runtime';
import type {
  TenantId,
  SessionId,
  TraceId,
  IdempotencyKey,
  WorkflowRunCancellationInput,
} from '@aflow/schemas';
import { WorkflowRunCancellationSchema } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import {
  emitTaskUpdate,
  emitTerminalRunUpdate,
  isTerminalTaskStatus,
  loadRunByRunIdAcrossSpaces,
  resolveWorkflowForRun,
  runTerminalStatusToOutcome,
} from './helpers.js';
import { completeRun } from './pauseResume.js';
import type { CancelRunResult, HarnessDeps } from './types.js';
import { CancelCascadeDeliveryError } from './types.js';

export { CancelCascadeDeliveryError } from './types.js';
export type { CancelRunResult } from './types.js';

export async function cancelRun(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  /**
   * Cancellation provenance — actor + optional reason. Callers attribute
   * deliberately (`operator` route / `agent` inline op); omission parses to
   * the schema default (`cancelledBy: 'system'`).
   */
  cancellation?: WorkflowRunCancellationInput,
): Promise<CancelRunResult> {
  const tenantIdStr = tenantId as string;
  const resolvedCancellation = WorkflowRunCancellationSchema.parse(cancellation ?? {});
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:cancelRun',
    runId,
  });

  const run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
  if (!run) {
    log.warn(`[cancelRun] run not found: ${runId}`);
    return { cancelledAt: new Date(), cancelledTaskIds: [], interruptedSessions: [] };
  }

  // 1. Discover cascade targets from the durable in-flight ledger.
  //    completion_pending is written at claim time and cleared on
  //    terminal record, so it survives a crash mid-cancel.
  const pendingRows = await listCompletionPendingForRun(deps.db, tenantIdStr, runId);
  const taskRowSessions = run.tasks
    .filter((t) => !isTerminalTaskStatus(t.status) && t.workerSessionId != null)
    .map((t) => t.workerSessionId!);
  const interruptedSessions = Array.from(
    new Set([...pendingRows.map((p) => p.workerSessionId), ...taskRowSessions]),
  );
  // The cancellation record is per ATTEMPT — a retry reuses the step execution id
  // and only bumps the attempt, so a record without one would outlive what it
  // describes and drop the next legitimate attempt.
  const attemptBySession = new Map<string, number>();
  for (const p of pendingRows) attemptBySession.set(p.workerSessionId, p.attempt);
  for (const t of run.tasks) {
    if (t.workerSessionId != null) attemptBySession.set(t.workerSessionId, t.attempt);
  }

  log.info(
    `[cancelRun] cascading cancel_run to ${String(interruptedSessions.length)} Runner ` +
      `session(s) (sources: ${String(pendingRows.length)} pending + ` +
      `${String(taskRowSessions.length)} task-row)`,
  );

  // 2. Cascade BEFORE bulk-cancel: a crash between cascade and bulk-cancel
  //    leaves both the cascade source (completion_pending) and the
  //    non-terminal task rows intact, so the retry's step (1) can
  //    rediscover targets cleanly.
  //
  const cascadeFailures: Array<{ sessionId: string; reason: string }> = [];
  for (const sessionId of interruptedSessions) {
    // An OPERATION task has no Runner session: its `workerSessionId` IS the step
    // execution id (dispatchTask passes it as `stepExecutionId`). The control
    // message below is addressed to a session, so for those rows it resolves to
    // nothing and the executor keeps running — which is how a coding step could
    // outlive the cancel that terminated its ledger row. Publishing the step
    // abort reaches the executor directly; it is a no-op for an agent task,
    // whose in-flight step is aborted through its own session instead.
    // Durable record FIRST, then the fast path: an executor that reads the record
    // before the publish lands still refuses the job, whereas the reverse order
    // leaves a window where neither reaches it.
    await markStepCancelled(
      deps.redis,
      sessionId,
      attemptBySession.get(sessionId) ?? 1,
      'cancelled',
    );
    publishStepAbort(deps.redis, sessionId, 'cancelled');
    try {
      await addControlMessage(deps.redis, {
        messageVersion: 1,
        type: 'cancel_run',
        tenantId,
        runId: sessionId as SessionId,
        traceId: randomUUID() as TraceId,
        idempotencyKey: `workflow-cancel:${runId}:${sessionId}` as IdempotencyKey,
        requestedAtMs: Date.now(),
      });
    } catch (err) {
      const reasonMsg = err instanceof Error ? err.message : String(err);
      logOrchestratorError(
        `[cancelRun] failed to send cancel_run to session=${sessionId}: ${reasonMsg}`,
        err,
        { tenantId: tenantIdStr, runId, sessionId },
      );
      cascadeFailures.push({ sessionId, reason: reasonMsg });
    }
  }

  if (cascadeFailures.length > 0) {
    // Abort early — leave task rows + completion_pending intact so the
    // retry path rediscovers and re-cascades. Throw a typed error that
    // the handler converts to CASCADE_DELIVERY_FAILED for the caller.
    const summary = cascadeFailures.map((f) => `${f.sessionId}: ${f.reason}`).join('; ');
    throw new CancelCascadeDeliveryError(runId, cascadeFailures.length, summary);
  }

  // 3. Bulk-CAS task rows → 'cancelled'. After this, a Runner's
  //    eventual terminal landing finds the row terminal and drops
  //    via casCompleteTask's status guard.
  const { cancelledTaskIds } = await cancelNonTerminalTasksForRun(deps.db, tenantIdStr, runId);

  if (cancelledTaskIds.length > 0) {
    const workflowDef = await resolveWorkflowForRun(deps.db, tenantIdStr, run).catch(() => null);
    const taskNameById = new Map<string, string>();
    if (workflowDef) {
      for (const t of workflowDef.tasks) {
        if (t.taskId && t.name) taskNameById.set(t.taskId, t.name);
      }
    }
    const taskRowById = new Map<string, (typeof run.tasks)[number]>();
    for (const t of run.tasks) taskRowById.set(t.taskId, t);
    const completedAt = new Date();
    await Promise.allSettled(
      cancelledTaskIds.map(async (taskId) => {
        const row = taskRowById.get(taskId);
        try {
          await emitTaskUpdate(deps, {
            tenantId,
            runId,
            taskId,
            label: taskNameById.get(taskId) ?? taskId,
            status: 'cancelled',
            attempt: row?.attempt ?? 1,
            ...(row?.workerSessionId ? { workerSessionId: row.workerSessionId } : {}),
            ...(row?.operationId ? { operationId: row.operationId } : {}),
            ...(row?.startedAt ? { startedAt: row.startedAt } : {}),
            completedAt,
          });
        } catch (err) {
          logOrchestratorError(
            `[cancelRun] emit WorkflowTaskUpdate(cancelled) failed for task=${taskId}`,
            err,
            { tenantId: tenantIdStr, runId, taskId },
          );
        }
      }),
    );
  }

  // 4. Now safe to clear the pending rows — the cascade has been
  //    delivered (or re-attempts are deterministic via step 1 →
  //    step 2 idempotent message keys).
  await clearAllCompletionPendingForRun(deps.db, tenantIdStr, runId);

  // 5. Terminal flush + attention + waiters + post-run hooks. CAS-
  //    guarded inside ledgerCompleteRun: if a parallel completion
  //    path won the run-row terminal write, this short-circuits and
  //    skips the duplicate attention + waiter notification.
  const extras: Record<string, unknown> = {
    cancelledTaskIds,
    interruptedSessions,
    cancelledBy: resolvedCancellation.cancelledBy,
  };
  if (resolvedCancellation.reason !== undefined && resolvedCancellation.reason.length > 0) {
    extras['reason'] = resolvedCancellation.reason;
  }
  const didComplete = await completeRun(
    deps,
    tenantId,
    runId,
    'cancelled',
    extras,
    resolvedCancellation,
  );

  if (!didComplete) {
    const persisted = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
    const persistedOutcome = persisted ? runTerminalStatusToOutcome(persisted.status) : null;
    if (persisted && persistedOutcome) {
      await emitTerminalRunUpdate(deps, {
        tenantId,
        runId,
        outcome: persistedOutcome,
        runDetail: persisted,
      }).catch((err: unknown) => {
        logOrchestratorError(
          `[cancelRun] emit WorkflowRunUpdate(${persistedOutcome}) failed for run=${runId}`,
          err,
          { tenantId: tenantIdStr, runId },
        );
      });
    } else {
      log.warn(
        `[cancelRun] completeRun skipped its emit but run=${runId} is not terminal ` +
          `(status=${persisted?.status ?? 'not-found'}); no fallback WorkflowRunUpdate emitted`,
      );
    }
  }

  await cancelRunsStartedBy(deps, tenantId, runId, interruptedSessions);

  return { cancelledAt: new Date(), cancelledTaskIds, interruptedSessions };
}

/**
 * A run started by one of this run's tasks has no other caller: left running,
 * it works on for a parent that can no longer use its answer. It is cancelled
 * after the parent is terminal, so its own ending reaches a task that is
 * already cancelled and is dropped there.
 */
async function cancelRunsStartedBy(
  deps: HarnessDeps,
  tenantId: TenantId,
  parentRunId: string,
  workerSessionIds: readonly string[],
): Promise<void> {
  const tenantIdStr = tenantId as string;
  for (const workerSessionId of workerSessionIds) {
    let childRunIds: string[] = [];
    try {
      const waiting = await loadParkedStepWaitersForSession(deps.db, tenantIdStr, workerSessionId);
      childRunIds = waiting.map((waiter) => waiter.runId);
    } catch (err) {
      logOrchestratorError(
        `[cancelRun] could not read the runs session=${workerSessionId} of run=${parentRunId} started: ${err instanceof Error ? err.message : String(err)}`,
        err,
        { tenantId: tenantIdStr, runId: parentRunId, sessionId: workerSessionId },
      );
    }
    for (const childRunId of childRunIds) {
      try {
        await cancelRun(deps, tenantId, childRunId, {
          cancelledBy: 'system',
          reason: `Run ${parentRunId}, whose task started it, was cancelled.`,
        });
      } catch (err) {
        logOrchestratorError(
          `[cancelRun] could not cancel run=${childRunId} started by run=${parentRunId}: ${err instanceof Error ? err.message : String(err)}`,
          err,
          { tenantId: tenantIdStr, runId: childRunId, parentRunId },
        );
      }
    }
  }
}
