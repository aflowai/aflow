/**
 * Multi-task dispatch batching for startRun / dispatchNext waves.
 */
import {
  recordTaskResult as ledgerRecordTaskResultViaLegacy,
  reserveTaskSlots,
} from '@aflow/cybernetic-runtime';
import type { TenantId, SessionId, Workflow } from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { dispatchTask } from './dispatchTask.js';
import type { HarnessDeps } from './types.js';
import { PostClaimDispatchError } from './types.js';

interface DispatchFailureRecord {
  taskId: string;
  reason: string;
  postClaim: boolean;
}

export interface DispatchWaveResult {
  /** Reserved and dispatched without throwing. */
  dispatched: string[];
  /** Ready but unreserved — still ready, picked up by a later wave. */
  deferred: string[];
  failed: DispatchFailureRecord[];
}

interface DispatchAllArgs {
  tenantId: TenantId;
  runId: string;
  readyTasks: Workflow['tasks'];
  helmsmanSessionId: SessionId;
}

/**
 * Reserve the run's free parallel slots, then dispatch exactly what was
 * reserved.
 *
 * The reservation gates first-wave dispatch width. Slicing the ready list here
 * instead would let two schedulers racing on the same run each observe the same
 * free slots and dispatch against them twice over.
 *
 * The retry, resume and producer-rerun lanes re-enter a slot without reserving,
 * and each one takes the same `SELECT … FOR UPDATE` on the run row that this
 * reservation takes and refuses once the run sits at its pinned limit. None of
 * them can push a run past its ceiling, so a task deferred here is waiting on a
 * sibling to reach a terminal state.
 */
export async function dispatchAllOrCollectFailures(
  deps: HarnessDeps,
  args: DispatchAllArgs,
): Promise<DispatchWaveResult> {
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:dispatchAllOrCollectFailures',
    runId: args.runId,
  });
  const reservation = await reserveTaskSlots(deps.db, args.tenantId as string, {
    runId: args.runId,
    readyTaskIds: args.readyTasks.map((task) => task.taskId),
  });
  if (reservation.deferred.length > 0) {
    log.debug(
      `[dispatchAll] reserved ${String(reservation.reserved.length)} of ` +
        `${String(args.readyTasks.length)} ready task(s) (limit ` +
        `${String(reservation.limit)}, ${String(reservation.activeCount)} already active); ` +
        `deferred to a later wave: ${reservation.deferred.join(', ')}`,
    );
  }
  const reserved = new Set(reservation.reserved);
  const failed: DispatchFailureRecord[] = [];
  const dispatched: string[] = [];
  for (const ready of args.readyTasks) {
    if (!reserved.has(ready.taskId)) continue;
    try {
      await dispatchTask(deps, {
        tenantId: args.tenantId,
        runId: args.runId,
        taskId: ready.taskId,
        attempt: 1,
        helmsmanSessionId: args.helmsmanSessionId,
      });
      dispatched.push(ready.taskId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const postClaim = err instanceof PostClaimDispatchError;
      log.error(
        `[dispatchTask] failed for taskId=${ready.taskId} (postClaim=${String(postClaim)})`,
        err instanceof Error ? err : undefined,
        {
          tenantId: args.tenantId,
          runId: args.runId,
          taskId: ready.taskId,
          postClaim,
          error: reason,
        },
      );
      failed.push({ taskId: ready.taskId, reason, postClaim });
    }
  }
  return { dispatched, deferred: reservation.deferred, failed };
}

/**
 * Persist a 'failed' task row for each PRE-CLAIM dispatch-failure
 * record. Post-claim failures already had their row CAS-transitioned
 * to 'failed' (with claim metadata preserved) and their
 * completion_pending row cleared by `dispatchTask`'s post-claim
 * catch path — re-running the legacy upsert would overwrite
 * worker_session_id / step_execution_id with nulls.
 *
 * Best-effort per-row: a single row write failure is logged but
 * doesn't block the others.
 */
export async function persistFailedDispatches(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  failed: DispatchFailureRecord[],
): Promise<void> {
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:persistFailedDispatches',
    runId,
  });
  const tenantIdStr = tenantId as string;
  for (const failure of failed) {
    if (failure.postClaim) {
      // Skip — dispatchTask's post-claim handler already CAS-wrote
      // the 'failed' row and cleared completion_pending.
      continue;
    }
    try {
      await ledgerRecordTaskResultViaLegacy(deps.db, tenantIdStr, {
        runId,
        taskId: failure.taskId,
        status: 'failed',
        attempt: 1,
        completedAt: new Date(),
        failureReason: failure.reason,
      });
    } catch (recordErr) {
      log.error(
        `failed to persist task-failure row for ${failure.taskId}`,
        recordErr instanceof Error ? recordErr : undefined,
        { tenantId: tenantIdStr, runId, taskId: failure.taskId },
      );
    }
  }
}
