/**
 * Shared dispatch helpers — post-claim failure.
 *
 * The `DISPATCH_PENDING_INTERVAL_MS` timing constant and the shared
 * operation-task dispatch live in `operationTaskDispatch.ts` (kept out of
 * this module so the dispatch helper stays unit-testable without this
 * module's ledger/emit import graph).
 */
import {
  casCompleteTask as ledgerCasCompleteTask,
  clearCompletionPending,
} from '@aflow/cybernetic-runtime';
import type { TenantId } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { emitTaskUpdate } from './helpers.js';
import type { HarnessDeps } from './types.js';

export async function postClaimFailure(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  taskId: string,
  attempt: number,
  reason: string,
  failureMeta?: {
    label?: string;
    operationId?: string;
    workerSessionId?: string;
    startedAt?: Date;
  },
): Promise<void> {
  const tenantIdStr = tenantId as string;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:postClaimFailure',
    runId,
    taskId,
    attempt,
  });

  let casLanded = false;
  const failedAt = new Date();
  try {
    await ledgerCasCompleteTask(deps.db, tenantIdStr, {
      runId,
      taskId,
      attempt,
      status: 'failed',
      completedAt: failedAt,
      failureReason: reason,
      failedAt,
    });
    casLanded = true;
  } catch (casErr) {
    log.error(
      `[postClaimFailure] CAS to 'failed' threw — row may be in a transient state for the sweeper`,
      casErr instanceof Error ? casErr : undefined,
      { tenantId: tenantIdStr, runId, taskId, attempt },
    );
  }

  if (casLanded) {
    await emitTaskUpdate(deps, {
      tenantId,
      runId,
      taskId,
      label: failureMeta?.label ?? taskId,
      status: 'failed',
      attempt,
      ...(failureMeta?.workerSessionId ? { workerSessionId: failureMeta.workerSessionId } : {}),
      ...(failureMeta?.operationId ? { operationId: failureMeta.operationId } : {}),
      ...(failureMeta?.startedAt ? { startedAt: failureMeta.startedAt } : {}),
      completedAt: new Date(),
      failureReason: reason,
    }).catch((err: unknown) => {
      logOrchestratorError(
        `[postClaimFailure] emit WorkflowTaskUpdate(failed) failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
        { tenantId: tenantIdStr, runId, taskId, attempt },
      );
    });
  }

  try {
    await clearCompletionPending(deps.db, tenantIdStr, { runId, taskId, attempt });
  } catch (clearErr) {
    log.error(
      `[postClaimFailure] clearCompletionPending threw — sweeper will eventually pick it up`,
      clearErr instanceof Error ? clearErr : undefined,
      { tenantId: tenantIdStr, runId, taskId, attempt },
    );
  }
}
