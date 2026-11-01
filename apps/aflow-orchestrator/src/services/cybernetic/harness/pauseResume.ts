/**
 * Pause, failure propagation, and run completion.
 */
import { createTenantContext, withTenantSchema } from '@aflow/database';
import {
  casCompleteTask as ledgerCasCompleteTask,
  pauseRun as ledgerPauseRun,
  completeRun as ledgerCompleteRun,
  blockDescendantTasks,
  computeDescendants,
  emitRunUpdated,
  type CompleteRunParams,
  type RunFailure,
} from '@aflow/cybernetic-runtime';
import type {
  TenantId,
  TrialExecutionState,
  WaiterNotifiedOutcome,
  WorkflowRunCancellation,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { fireCyberneticPostRunHooksStandalone } from '../postRunHooks.js';
import {
  advanceSchedulerCursor,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  loadRunByRunIdAcrossSpaces,
  resolveWorkflowForRun,
  terminalStatusToAttentionKind,
  writeAttentionItem,
} from './helpers.js';
import { notifyWaiters } from './waiters.js';
import { releaseScheduleCreates } from '../../SessionOrchestrator/handlers/inlineOps/scheduleCreateBudget.js';
import { linkEndedRunToPlanNode, wakeResidentOnRunEnd } from './planLinks.js';
import { armPullRequestOnPublication } from '../../pullRequestEvents/arm.js';
import type { HarnessDeps } from './types.js';

export async function pauseRunForTask(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  taskId: string,
  attempt: number,
  contractRef?: string,
  pauseReason?: string,
  /**
   * When pausing after a succeeded Runner output that failed validation,
   * pass the attempted output ref so `replace_output` can merge patches
   * against the real output (contract ref lives on the run row only).
   */
  taskOutputRef?: string,
): Promise<void> {
  const tenantIdStr = tenantId as string;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness',
    runId,
    taskId,
  });

  // Order: CAS the task row FIRST, then pause the run.
  //
  // Why: ledgerPauseRun bumps `pause_version` unconditionally. If two
  // paused results race, the loser's CAS would miss but it would have
  // already bumped pause_version — making the winner's emitted resume
  // contract reference a stale version (Helmsman holds a stale
  // contract). CAS-task-first short-circuits the loser before any
  // run-row mutation.
  //
  // Failure mode: if we crash between casCompleteTask (landed) and
  // ledgerPauseRun, the row is paused but the run isn't. The reconcile
  // sweeper detects "task paused, run not paused" and re-drives the
  // pause + attention + notify path (idempotent — pauseRun is
  // re-pauseable, addAttentionItem is INSERT-only, markWaiterNotified
  // is WHERE-notified_at-IS-NULL).

  // 1. CAS-mark task row paused for this attempt.
  const completedAt = new Date();
  const taskRowOutputRef = taskOutputRef ?? contractRef;
  const landed = await ledgerCasCompleteTask(deps.db, tenantIdStr, {
    runId,
    taskId,
    attempt,
    status: 'paused',
    completedAt,
    ...(taskRowOutputRef !== undefined ? { outputRef: taskRowOutputRef } : {}),
  });
  if (!landed) {
    // Another path won (cancel / sweeper rerun / duplicate). Skip the
    // rest of the pause sequence — the winning path drives its own
    // state. Critically: pause_version is NOT bumped, so any resume
    // contract emitted by the winner remains valid.
    log.info(`[pauseRunForTask] CAS lost; another path advanced run=${runId} task=${taskId}`);
    return;
  }
  await advanceSchedulerCursor(deps.db, tenantIdStr, runId);

  // 2+3+4. Run-side pause sequence (run row pause + attention + waiters).
  await pauseRunOnly(deps, tenantId, runId, taskId, attempt, contractRef, {
    ...(pauseReason !== undefined ? { pauseReason } : {}),
  });

  log.info(`[pauseRunForTask] paused run=${runId} task=${taskId}`);
}

export async function pauseRunOnly(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  taskId: string,
  attempt: number,
  contractRef?: string,
  opts?: {
    pauseReason?: string;
    /**
     * When false, skip waking the run's
     * pending waiters. Used by the human-task dispatch path: from the
     * Helmsman's point of view, a workflow that pauses on a HITL human
     * task is still running — operator approval is just the next "tool
     * call" the workflow has to wait on. Waking Helmsman at the pause
     * ends its turn and disconnects it from the run; with this flag
     * Helmsman stays parked and wakes naturally when the workflow
     * terminates (completes / fails / cancelled), seeing the full
     * outcome including any post-approve task failures.
     * The chat UI still gets live transitions via
     * `emitWorkflowProgress`'s originating-session fan-out, so the
     * operator sees the run-surface card update — they just don't get
     * a chat-mediated narration from Helmsman until the run is done.
     * Defaults to true (wake) for backward compatibility with the
     * agent-pause path, which legitimately needs Helmsman to act.
     */
    notifyWaiters?: boolean;
    /**
     * What execution observed, from the caller that built the contract. The
     * pause payload cannot answer this after the fact.
     */
    executionState?: TrialExecutionState | undefined;
  },
): Promise<void> {
  const tenantIdStr = tenantId as string;
  const shouldNotify = opts?.notifyWaiters ?? true;

  const run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
  const pauseTenantCtx = createTenantContext(tenantId);
  const pauseVersion = await withTenantSchema(deps.db, pauseTenantCtx, async (tx) => {
    const tookVersion = await ledgerPauseRun(
      deps.db,
      tenantIdStr,
      runId,
      {
        reason: opts?.pauseReason ?? 'task_paused',
        ...(contractRef !== undefined ? { payloadRef: contractRef } : {}),
        ...(opts?.executionState !== undefined ? { executionState: opts.executionState } : {}),
      },
      tx,
    );
    if (run) {
      await writeAttentionItem(tx, tenantId, run, 'workflow_run_paused', {
        taskId,
        attempt,
        ...(contractRef !== undefined ? { contractRef } : {}),
      });
    }
    return tookVersion;
  });

  if (run) {
    await emitRunUpdated(deps.redis, {
      tenantId: tenantIdStr,
      spaceId: run.spaceId,
      runId,
      workflowSlug: run.workflowSlug,
      status: 'paused',
    });
  }

  if (!shouldNotify) {
    return;
  }
  if (pauseVersion === null) {
    getOrchestratorLogger().info(
      `[pauseRunOnly] run=${runId} was neither running nor paused; no pause to report to its waiters`,
    );
    return;
  }

  await notifyWaiters(deps, {
    tenantId,
    runId,
    outcome: 'paused',
    pauseVersion,
    ...(contractRef !== undefined ? { payloadRef: contractRef } : {}),
  });
}

export async function applyFailureMode(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  failedTaskId: string,
): Promise<void> {
  const tenantIdStr = tenantId as string;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness',
    runId,
    taskId: failedTaskId,
  });

  const run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
  if (!run) {
    log.error(`[applyFailureMode] run not found: ${runId}`, undefined, {
      tenantId: tenantIdStr,
      runId,
      failedTaskId,
    });
    return;
  }
  const workflow = await resolveWorkflowForRun(deps.db, tenantIdStr, run);
  if (!workflow) {
    log.error(`[applyFailureMode] workflow not resolvable for run=${runId}`, undefined, {
      tenantId: tenantIdStr,
      runId,
      failedTaskId,
    });
    return;
  }

  const failedTaskDef = workflow.tasks.find((t) => t.taskId === failedTaskId);
  const failureMode = failedTaskDef?.failureMode ?? 'isolate';

  const { dispatchNextOrTerminate } = await import('./dispatch.js');

  // Readiness counts a failed optional task as a satisfied dependency, and its
  // dependents' `when` can read its status; blocking them here would decide
  // for them before either is consulted.
  if (failedTaskDef?.optional === true) {
    await dispatchNextOrTerminate(deps, tenantId, runId);
    return;
  }

  if (failureMode === 'cancel_siblings') {
    const nonTerminal = run.tasks.filter((t) => !isTerminalTaskStatus(t.status));
    if (nonTerminal.length > 0) {
      await blockDescendantTasks(
        deps.db,
        tenantIdStr,
        runId,
        nonTerminal.map((t) => t.taskId),
      );
    }
    await completeRun(deps, tenantId, runId, {
      status: 'failed',
      failure: failedTasksFailure(run.tasks, [failedTaskId]),
    });
    return;
  }

  // isolate — block only descendants of the failed task; sibling branches may continue.
  const descendants = computeDescendants(workflow.tasks, new Set([failedTaskId]));
  if (descendants.size > 0) {
    await blockDescendantTasks(deps.db, tenantIdStr, runId, [...descendants]);
  }

  await dispatchNextOrTerminate(deps, tenantId, runId);
}

/**
 * The failure of a run that ended on its tasks, naming each one with the
 * reason its row records.
 */
export function failedTasksFailure(
  rows: ReadonlyArray<{ taskId: string; status: string; failureReason: string | null }>,
  taskIds: readonly string[],
): RunFailure {
  const parts = taskIds.map((taskId) => {
    const row = rows.find((r) => r.taskId === taskId);
    const status = row?.status ?? 'failed';
    return row?.failureReason
      ? `${taskId} (${status}): ${row.failureReason}`
      : `${taskId} (${status})`;
  });
  return {
    reason: 'task_failed',
    message: `The run ended on ${taskIds.length === 1 ? 'task' : 'tasks'} ${parts.join('; ')}.`,
    taskIds: [...taskIds],
  };
}

// ============================================================================
// completeRun — terminal flush + waiters + attention + post-run hooks
// ============================================================================

/**
 * How a run ends. A failed run names why — the record a reader of the run
 * gets, written to `failure_json` by the same CAS that ends it — so no path
 * can end a run failed in silence.
 */
export type RunEnding =
  | { status: 'completed' }
  | {
      status: 'failed';
      failure: RunFailure;
      /**
       * The cursor version the caller's verdict was reached from. The run
       * ends only if no task outcome has been recorded since.
       */
      expectedSchedulerCursorVersion?: number;
    }
  | {
      status: 'cancelled';
      /**
       * Stamped on the run row by the terminal CAS and threaded into the
       * waiter wake-up envelope so the parked Helmsman can distinguish an
       * operator's deliberate stop.
       */
      cancellation: WorkflowRunCancellation;
      attention?: Record<string, unknown>;
    };

export async function completeRun(
  deps: HarnessDeps,
  tenantId: TenantId,
  runId: string,
  ending: RunEnding,
): Promise<boolean> {
  const terminalStatus = ending.status;
  const cancellation = ending.status === 'cancelled' ? ending.cancellation : undefined;
  const tenantIdStr = tenantId as string;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness',
    runId,
  });

  const run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
  if (!run) {
    log.error(`[completeRun] run not found: ${runId}`, undefined, {
      tenantId: tenantIdStr,
      runId,
      terminalStatus,
    });
    return false;
  }
  if (isTerminalRunStatus(run.status)) {
    log.debug(`[completeRun] run already ${run.status}; idempotent skip`);
    return false;
  }

  // 1+2. Atomic terminal-flush: workflow_runs UPDATE + attention_items
  //      INSERT in a single TX, so a crash between leaves the run still
  //      "running" rather than terminal-without-attention. The ledger
  const attentionKind = terminalStatusToAttentionKind(terminalStatus);
  const tenantCtx = createTenantContext(tenantId);
  const completedAt = new Date();
  const ledgerParams: CompleteRunParams =
    ending.status === 'failed'
      ? {
          runId,
          completedAt,
          status: 'failed',
          failure: ending.failure,
          ...(ending.expectedSchedulerCursorVersion !== undefined
            ? { expectedSchedulerCursorVersion: ending.expectedSchedulerCursorVersion }
            : {}),
        }
      : ending.status === 'cancelled'
        ? { runId, completedAt, status: 'cancelled', cancellation: ending.cancellation }
        : { runId, completedAt, status: 'completed' };
  const attentionPayload: Record<string, unknown> = {
    terminalStatus,
    ...(ending.status === 'failed' ? ending.failure : {}),
    ...(ending.status === 'cancelled' ? (ending.attention ?? {}) : {}),
  };
  const casLanded = await withTenantSchema(deps.db, tenantCtx, async (tx) => {
    const landed = await ledgerCompleteRun(deps.db, tenantIdStr, ledgerParams, tx);
    if (!landed) return false;
    await writeAttentionItem(tx, tenantId, run, attentionKind, attentionPayload);
    return true;
  });

  if (!casLanded) {
    log.info(
      `[completeRun] CAS lost — run=${runId} was ended or advanced by another path first; skipping waiters/hooks`,
    );
    return false;
  }

  await releaseScheduleCreates(deps.redis, tenantIdStr, runId);

  await emitRunUpdated(deps.redis, {
    tenantId: tenantIdStr,
    spaceId: run.spaceId,
    runId,
    workflowSlug: run.workflowSlug,
    status: terminalStatus,
  });

  // 3. Notify waiters
  const waiterOutcome: Exclude<WaiterNotifiedOutcome, 'paused'> =
    terminalStatus === 'completed'
      ? 'completed'
      : terminalStatus === 'failed'
        ? 'failed'
        : 'cancelled';
  await notifyWaiters(deps, {
    tenantId,
    runId,
    outcome: waiterOutcome,
    ...(cancellation ? { cancellation } : {}),
  });

  // 4. Fire post-run hooks (eval / coach / skill projection — best effort)
  try {
    await fireCyberneticPostRunHooksStandalone({
      tenantId: tenantIdStr,
      spaceId: run.spaceId,
      workflowSlug: run.workflowSlug,
      runId,
      db: deps.db,
      redis: deps.redis,
      payloadStore: deps.payloadStore,
    });
  } catch (err) {
    log.warn(
      `[completeRun] post-run hooks failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await linkEndedRunToPlanNode(deps, tenantIdStr, run, terminalStatus);
  } catch (err) {
    log.warn(
      `[completeRun] linking the run to plan node ${run.planNodeId ?? '(none)'} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await armPullRequestOnPublication(deps, tenantIdStr, run, terminalStatus);
  } catch (err) {
    log.warn(
      `[completeRun] arming the pull request of publication ${runId} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await wakeResidentOnRunEnd(deps, tenantIdStr, run);
  } catch (err) {
    log.warn(
      `[completeRun] waking the resident for run ${runId} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (ending.status === 'failed') {
    log.warn(
      `[completeRun] run=${runId} terminal=failed reason=${ending.failure.reason}: ${ending.failure.message}`,
    );
  } else {
    log.info(`[completeRun] run=${runId} terminal=${terminalStatus}`);
  }
  return true;
}
