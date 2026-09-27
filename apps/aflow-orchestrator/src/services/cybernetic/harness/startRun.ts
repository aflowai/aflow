/**
 * Initial workflow run dispatch + first-wave scheduling.
 */
import {
  listTaskRows,
  recordTaskSkipped as ledgerRecordTaskSkipped,
} from '@aflow/cybernetic-runtime';
import type { WorkflowTaskRow } from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { computeReadyView, isTerminalTaskStatus } from './helpers.js';
import { applyFailureMode, completeRun } from './pauseResume.js';
import { dispatchAllOrCollectFailures, persistFailedDispatches } from './dispatch.js';
import type { HarnessDeps, StartRunArgs, StartRunResult } from './types.js';

export type { StartRunArgs, StartRunResult } from './types.js';

export async function startRun(deps: HarnessDeps, args: StartRunArgs): Promise<StartRunResult> {
  const { tenantId, runId, workflow, callingHelmsmanSessionId } = args;
  const tenantIdStr = tenantId as string;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:startRun',
    runId,
    slug: workflow.slug,
  });

  // 1. Compute first-wave ready tasks via skip-loop.
  //
  // Cascading skips matter even on a fresh run: a root task with a
  // when-predicate evaluating false enters 'skipped'; that skip can
  // unblock a descendant with `tasks.<root>.status == 'skipped'`,
  // which itself may want to skip further. Without the reload+recompute
  // loop, a skipped root with no surviving siblings would leave the
  // run with no in-flight tasks and no later harness decision — the
  // run would hang.
  //
  // Mirrors `dispatchNextOrTerminate`'s skip-loop semantics. Each
  // pass: record skips (`recordTaskSkipped` adds rows), reload task
  // rows from DB, recompute readiness from the fresh status set.
  const optionalTaskIds = new Set(workflow.tasks.filter((t) => t.optional).map((t) => t.taskId));

  let currentTaskRows: WorkflowTaskRow[] = [];
  let readyResult = await computeReadyView(
    currentTaskRows,
    workflow,
    optionalTaskIds,
    deps.payloadStore,
  );
  while (readyResult.skipped.length > 0) {
    for (const { task: skippedTask, reason } of readyResult.skipped) {
      await ledgerRecordTaskSkipped(deps.db, tenantIdStr, {
        runId,
        taskId: skippedTask.taskId,
        reason,
      });
    }
    const reloaded = await listTaskRows(deps.db, tenantIdStr, runId);
    currentTaskRows = reloaded;
    readyResult = await computeReadyView(
      currentTaskRows,
      workflow,
      optionalTaskIds,
      deps.payloadStore,
    );
  }

  if (readyResult.errors.length > 0) {
    const detail = readyResult.errors.map((e) => `${e.task.taskId}: ${e.reason}`).join('; ');
    log.warn(`[startRun] when-predicate errors on first wave; failing run: ${detail}`);
    await completeRun(deps, tenantId, runId, 'failed');
    return { runId, activeTasks: [] };
  }

  // After the skip-loop settles, all required tasks may have been
  // skipped (degenerate case — workflow with only conditional roots
  // and the conditions don't fire). In that case there's nothing to
  // dispatch and nothing in flight; complete the run cleanly.
  const requiredTasks = workflow.tasks.filter((t) => !t.optional);
  const terminalRowIds = new Set(
    currentTaskRows.filter((t) => isTerminalTaskStatus(t.status)).map((t) => t.taskId),
  );
  if (readyResult.ready.length === 0 && requiredTasks.every((t) => terminalRowIds.has(t.taskId))) {
    const hasFailedRequired = requiredTasks.some((t) => {
      const row = currentTaskRows.find((r) => r.taskId === t.taskId);
      return row?.status === 'failed' || row?.status === 'blocked' || row?.status === 'cancelled';
    });
    const terminalStatus: 'completed' | 'failed' = hasFailedRequired ? 'failed' : 'completed';
    log.info(`[startRun] all required tasks resolved during first-wave skip-loop; completing`);
    await completeRun(deps, tenantId, runId, terminalStatus);
    return { runId, activeTasks: [] };
  }

  // 3. Dispatch each ready task. dispatchTask owns the per-type
  // branching (agent / operation / human) and CAS-safe claim.
  //
  // First-wave dispatch failure is fatal for the run. dispatchTask
  // resolves inputs (buildTaskInputRef / buildDelegateTaskInput)
  // BEFORE the atomic claim;
  // failures there (DeriveSchemaError, missing pinned revision,
  // payload-store I/O, etc.) leave no task row and no
  // completion_pending row. If we caught-and-logged we'd return a
  // PAUSED Helmsman step waiting for a workflow that has no path
  // forward — silent hang. Surface the failure as a run-level fail
  // so the Helmsman wakes up with a typed error.
  // Dispatch each ready task; collect any failures via the shared
  // helper used by dispatchNextOrTerminate too. dispatchTask throws on
  // invariant / input-resolution failures (Phase 2.2.3b); collecting
  // here lets startRun persist a failed row for each + drive
  // applyFailureMode rather than letting the exception escape.
  const wave = await dispatchAllOrCollectFailures(deps, {
    tenantId,
    runId,
    readyTasks: readyResult.ready,
    helmsmanSessionId: callingHelmsmanSessionId,
  });
  const failedDispatches = wave.failed;
  const activeTasks = wave.dispatched;

  if (failedDispatches.length > 0) {
    await persistFailedDispatches(deps, tenantId, runId, failedDispatches);
    // applyFailureMode honours cancel_siblings / isolate semantics;
    // for first-wave failures with no siblings to consider, it ends
    // with completeRun(failed) → notifyWaiters(failed) → Helmsman
    // wakeup with the typed error.
    await applyFailureMode(deps, tenantId, runId, failedDispatches[0]!.taskId);
    return { runId, activeTasks };
  }

  if (optionalTaskIds.size > 0) {
    log.debug(`[startRun] ${String(optionalTaskIds.size)} optional task(s) declared`);
  }

  log.info(
    `[startRun] dispatched ${String(activeTasks.length)} initial task(s)` +
      (wave.deferred.length > 0
        ? `, ${String(wave.deferred.length)} deferred over the run's parallel limit`
        : '') +
      `; waiter=${callingHelmsmanSessionId}`,
  );
  return { runId, activeTasks };
}
