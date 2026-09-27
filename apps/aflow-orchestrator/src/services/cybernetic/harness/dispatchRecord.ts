/**
 * Task row CAS record helpers for onWorkflowTaskComplete.
 */
import { casCompleteTask as ledgerCasCompleteTask, getTaskRow } from '@aflow/cybernetic-runtime';
import type { WorkflowTaskRow } from '@aflow/cybernetic-runtime';
import type { TenantId, WorkflowTask } from '@aflow/schemas';
import type { WorkflowTaskOutcome } from './types.js';
import type { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { bumpSchedulerCursorVersion, isRestingTaskStatus } from './helpers.js';
import type { HarnessDeps } from './types.js';

export function shouldPauseOnTransientFailure(
  task: WorkflowTask | null,
  outcome: Extract<WorkflowTaskOutcome, { kind: 'failed' }>,
): boolean {
  if (!task) return false;
  if ((task.retryability ?? 'unknown') !== 'safe') return false;
  if (outcome.errorClassification !== 'transient') return false;
  return outcome.errorRetryable === true;
}

// ============================================================================
// recordTaskResult — write task row terminal status
// ============================================================================

interface RecordTaskOutcomeExtras {
  outputRef?: string;
  errorRef?: string;
  failureReason?: string;
  errorCode?: string;
  errorClassification?: string;
  errorRetryable?: boolean;
}

/**
 * Re-drive helper used when the completion CAS misses. Reloads the
 * task row and chooses one of:
 *   - `'unrecoverable'` — row vanished, attempt drifted past, or row
 *     is cancelled mid-flight. Caller drops the result (CAS miss
 *     means another path holds authority; nothing for us to do here).
 *   - One of the resting statuses — the duplicate-redrive switch
 *     above advances the run from the persisted status.
 *
 * Crucially, we do NOT proceed from the incoming outcome on a CAS
 * miss — `outcome.kind === 'succeeded'` could be stale if a cancel
 * landed between pre-check and CAS, so honouring it would advance
 * from a state the row no longer reflects.
 */
export async function reloadAndReDrive(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  taskId: string,
  attempt: number,
  log: ReturnType<ReturnType<typeof getOrchestratorLogger>['child']>,
): Promise<'unrecoverable' | 'succeeded' | 'failed' | 'paused' | 'skipped' | 'blocked'> {
  const tenantIdStr = tenantId as string;
  const reloaded = await getTaskRow(deps.db, tenantIdStr, runId, taskId);

  if (!reloaded) {
    log.warn(`[onWorkflowTaskComplete] CAS miss: task row vanished after pre-check`);
    return 'unrecoverable';
  }
  if (reloaded.attempt !== attempt) {
    log.info(
      `[onWorkflowTaskComplete] CAS miss: attempt drifted past — row.attempt=${String(reloaded.attempt)} our.attempt=${String(attempt)}; dropping`,
    );
    return 'unrecoverable';
  }
  if (reloaded.status === 'cancelled') {
    log.info(`[onWorkflowTaskComplete] CAS miss: row cancelled mid-flight; dropping`);
    return 'unrecoverable';
  }
  if (!isRestingTaskStatus(reloaded.status)) {
    // Race: row is back to a non-resting status (running/scheduled).
    // This is unusual — typically CAS-miss means the row moved
    // forward. If we end up here, treat as unrecoverable; the path
    // that put it back to running owns the next decision.
    log.warn(
      `[onWorkflowTaskComplete] CAS miss but row at non-resting status=${reloaded.status}; dropping`,
    );
    return 'unrecoverable';
  }

  log.info(
    `[onWorkflowTaskComplete] CAS miss: persisted status=${reloaded.status}; re-driving from persisted`,
  );
  return reloaded.status as 'succeeded' | 'failed' | 'paused' | 'skipped' | 'blocked';
}

export async function recordTaskOutcome(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  taskId: string,
  attempt: number,
  status: 'succeeded' | 'failed',
  taskRow: WorkflowTaskRow,
  extras: RecordTaskOutcomeExtras,
): Promise<boolean> {
  const tenantIdStr = tenantId as string;
  const completedAt = new Date();
  const startedAt = taskRow.startedAt ?? completedAt;
  const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());

  // CAS update — guarded on (run_id, task_id, attempt) AND
  // status NOT terminal. A concurrent cancel / sweeper-rerun cannot race
  // past this; if the CAS misses, the row was claimed by another path
  // (terminal already, attempt bumped). The caller's `onWorkflowTaskComplete`
  // already handles the duplicate-redrive flow above — re-reading the
  // row would risk drift, so we just report the CAS outcome.
  const landed = await ledgerCasCompleteTask(deps.db, tenantIdStr, {
    runId,
    taskId,
    attempt,
    status,
    completedAt,
    durationMs,
    ...(extras.outputRef !== undefined ? { outputRef: extras.outputRef } : {}),
    ...(extras.failureReason !== undefined ? { failureReason: extras.failureReason } : {}),
    ...(status === 'failed' ? { failedAt: completedAt } : {}),
    ...(extras.errorCode !== undefined ? { errorCode: extras.errorCode } : {}),
    ...(extras.errorClassification !== undefined
      ? { errorClassification: extras.errorClassification }
      : {}),
    ...(extras.errorRetryable !== undefined ? { errorRetryable: extras.errorRetryable } : {}),
  });

  // Bump `scheduler_cursor_version` only when the CAS landed. The
  // sweeper uses this to detect causal progress; bumping on a no-op
  // would let a sibling sweep mistake a no-progress retry for advance.
  if (landed) {
    await bumpSchedulerCursorVersion(deps.db, tenantIdStr, runId);
  }
  return landed;
}
