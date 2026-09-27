/**
 * Ready-task scheduling wave — skip loop, dispatch successors, run terminal check.
 */
import { recordTaskSkipped as ledgerRecordTaskSkipped } from '@aflow/cybernetic-runtime';
import type { TenantId, SessionId } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import {
  computeReadyView,
  emitTaskUpdate,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  loadRunByRunIdAcrossSpaces,
  resolveWorkflowForRun,
} from './helpers.js';
import { applyFailureMode, completeRun } from './pauseResume.js';
import type { HarnessDeps } from './types.js';
import { dispatchAllOrCollectFailures, persistFailedDispatches } from './dispatchBatch.js';

export async function dispatchNextOrTerminate(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
): Promise<void> {
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness',
    runId,
  });
  const tenantIdStr = tenantId as string;

  let run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
  if (!run) {
    log.error(`[dispatchNextOrTerminate] run not found: ${runId}`, undefined, {
      tenantId: tenantIdStr,
      runId,
    });
    return;
  }
  if (isTerminalRunStatus(run.status)) {
    log.debug(`[dispatchNextOrTerminate] run already ${run.status}; skipping`);
    return;
  }
  if (run.status === 'paused') {
    log.debug(`[dispatchNextOrTerminate] run paused; holding (no dispatch/terminate)`);
    return;
  }

  const workflow = await resolveWorkflowForRun(deps.db, tenantIdStr, run);
  if (!workflow) {
    log.error(
      `[dispatchNextOrTerminate] workflow definition not resolvable for run=${runId}`,
      undefined,
      {
        tenantId: tenantIdStr,
        runId,
        slug: run.workflowSlug,
        revision: run.workflowRevision,
      },
    );
    return;
  }

  // Optional vs required split — completion is judged against required
  // tasks only. Optional task failures count as "satisfied dep" via
  // failedOptionalTaskIds (graph helper input).
  const optionalTaskIds = new Set(workflow.tasks.filter((t) => t.optional).map((t) => t.taskId));
  const requiredTasks = workflow.tasks.filter((t) => !t.optional);

  // Skip-loop: cascading when-predicate skips can unblock descendants
  // that themselves want to be skipped. Reload + recompute until stable.
  let readyResult = await computeReadyView(run.tasks, workflow, optionalTaskIds, deps.payloadStore);
  while (readyResult.skipped.length > 0) {
    for (const { task: skippedTask, reason } of readyResult.skipped) {
      await ledgerRecordTaskSkipped(deps.db, tenantIdStr, {
        runId,
        taskId: skippedTask.taskId,
        reason,
      });
      // Surface the skip transition on
      // the chat session's event stream so the run-surface card flips
      // the row from "scheduled / waiting on N" (forward-DAG ghost
      // render) to a real "skipped" pill. Without this, the ledger row
      // lands at status='skipped' but no WorkflowTaskUpdate event
      // fires; the reducer never sees the transition, so the task
      // stays rendered as a forward-DAG node ("waiting on 1") even
      // after the run completes. Best-effort: surface emit failures
      // don't roll back the skip — the next live event or a snapshot
      // refetch will recover state.
      await emitTaskUpdate(deps, {
        tenantId,
        runId,
        taskId: skippedTask.taskId,
        label: skippedTask.name,
        status: 'skipped',
        attempt: 1,
        completedAt: new Date(),
        ...(reason ? { summary: `Skipped: ${reason}` } : {}),
      }).catch((err: unknown) => {
        logOrchestratorError(
          `[dispatchNextOrTerminate] emit WorkflowTaskUpdate(skipped) failed: ${err instanceof Error ? err.message : String(err)}`,
          err,
          { tenantId: tenantIdStr, runId, taskId: skippedTask.taskId },
        );
      });
    }
    const reloaded = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
    if (!reloaded) break;
    run = reloaded;
    if (run.status === 'paused' || isTerminalRunStatus(run.status)) {
      log.debug(`[dispatchNextOrTerminate] run ${run.status} after skip-loop reload; holding`);
      return;
    }
    readyResult = await computeReadyView(run.tasks, workflow, optionalTaskIds, deps.payloadStore);
  }

  // When-predicate errors → fail the run (matches existing engine
  // semantics). The error message names each offending task so the
  // operator can fix the workflow definition.
  if (readyResult.errors.length > 0) {
    const errorDetail = readyResult.errors.map((e) => `${e.task.taskId}: ${e.reason}`).join('; ');
    log.warn(`[dispatchNextOrTerminate] when-predicate errors — failing run: ${errorDetail}`);
    await completeRun(deps, tenantId, runId, 'failed');
    return;
  }

  // Filter ready set: only dispatch tasks that don't yet have a row.
  //
  // `computeReadyTasksWithWhen` excludes succeeded/skipped/failed-optional
  // (its `completedTaskIds` / `skippedTaskIds` / `failedOptionalTaskIds`
  // inputs) but a 'running' / 'scheduled' / 'paused' sibling whose deps
  // were already satisfied still surfaces as ready on every recompute.
  // Without this filter, Phase 2.2's `dispatchTask` would re-claim or
  // re-spawn an in-flight task whenever another root task completes.
  //
  const tasksWithRows = new Set(run.tasks.map((t) => t.taskId));
  const dispatchable = readyResult.ready.filter((t) => !tasksWithRows.has(t.taskId));

  if (dispatchable.length > 0) {
    log.debug(
      `[dispatchNextOrTerminate] dispatching ${String(dispatchable.length)} ready task(s) ` +
        `(${String(readyResult.ready.length - dispatchable.length)} ready-but-already-claimed filtered)`,
    );
    // Helmsman context source — `workflow_runs.session_id` records the
    // Helmsman session that initiated the run. Used by `dispatchTask`
    // for credential / actorContext inheritance on Runner spawns and
    // operation-task envelopes. If absent (system-initiated run with no
    // Helmsman), dispatchTask falls back to harness-only context.
    const helmsmanSessionId = (run.sessionId ?? '') as SessionId;
    // Anything the slot reservation deferred stays ready with no row, so the
    // next completion's wave reconsiders it — the same treatment ready-but-
    // already-claimed tasks get above.
    const { failed } = await dispatchAllOrCollectFailures(deps, {
      tenantId,
      runId,
      readyTasks: dispatchable,
      helmsmanSessionId,
    });
    if (failed.length > 0) {
      await persistFailedDispatches(deps, tenantId, runId, failed);
      // applyFailureMode handles cancel_siblings / isolate semantics
      // and ends with completeRun(failed) → notifyWaiters(failed).
      await applyFailureMode(deps, tenantId, runId, failed[0]!.taskId);
    }
    return;
  }

  // Ready-but-claimed tasks remain in flight; nothing for us to do
  // here. Fall through to the termination check — a parallel running
  // task will eventually emit its own onWorkflowTaskComplete and drive
  // the run forward.
  //
  if (readyResult.ready.length > 0) {
    const rowsByTaskId = new Map(run.tasks.map((r) => [r.taskId, r]));
    const anyTrulyInFlight = readyResult.ready.some((t) => {
      const row = rowsByTaskId.get(t.taskId);
      return row && !isTerminalTaskStatus(row.status);
    });
    if (anyTrulyInFlight) {
      log.debug(
        `[dispatchNextOrTerminate] all ready tasks already claimed (${String(readyResult.ready.length)}); awaiting their results`,
      );
      return;
    }
    // All "ready" tasks have terminal rows — treat as no work remaining
    // and proceed to the termination check below. Logging at info so
    // the path is traceable in prod when it fires.
    log.info(
      `[dispatchNextOrTerminate] all ready tasks have terminal rows (${String(readyResult.ready.length)}); proceeding to terminal check`,
    );
  }

  // No ready tasks remaining. Decide between "fully terminal" (run
  // complete) or "mid-run wait" (something asynchronous in flight, no
  // ready successors yet).
  //
  // Termination criterion (matches existing engine): every REQUIRED
  // task must have a row in a terminal status. Optional task rows that
  // don't exist or are non-terminal don't block completion.
  const terminalRowIds = new Set(
    run.tasks.filter((t) => isTerminalTaskStatus(t.status)).map((t) => t.taskId),
  );
  const allRequiredTerminal = requiredTasks.every((t) => terminalRowIds.has(t.taskId));

  if (allRequiredTerminal) {
    // Failed iff any required task ended in a failure-shaped status.
    // 'cancelled' is treated as failure for run-level decision (a cancel
    // mid-flight propagates to run-level via cancelRun, but if a row
    // ends up cancelled by some other path we still surface it as
    // failure-like for the workflow).
    const runRows = run.tasks;
    const hasFailedRequired = requiredTasks.some((t) => {
      const row = runRows.find((r) => r.taskId === t.taskId);
      return row?.status === 'failed' || row?.status === 'blocked' || row?.status === 'cancelled';
    });
    const terminalStatus: 'completed' | 'failed' = hasFailedRequired ? 'failed' : 'completed';
    await completeRun(deps, tenantId, runId, terminalStatus);
    return;
  }

  log.debug(`[dispatchNextOrTerminate] mid-run wait — no ready tasks, required not all terminal`);
}
