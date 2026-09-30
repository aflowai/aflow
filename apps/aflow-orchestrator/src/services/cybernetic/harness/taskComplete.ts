/**
 * Workflow task result ingestion — onWorkflowTaskComplete.
 */
import {
  getTaskRow,
  clearCompletionPending,
  drainSurfaceStreamToWaiters,
  buildResumeContract,
  buildEvalTaskResultsFromRows,
  resolvePausedContractRef,
  resolveTaskPromotedState,
  storeWorkflowResumeContract,
  type WorkflowTaskRow,
} from '@aflow/cybernetic-runtime';
import type { Workflow, WorkflowTask } from '@aflow/schemas';
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import { discardTaskDraft } from '@aflow/cybernetic-runtime';
import { StreamKeys } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import {
  emitTaskUpdate,
  extractPresentationFromOutput,
  isRestingTaskStatus,
  loadRunByRunIdAcrossSpaces,
  resolveWorkflowForRun,
} from './helpers.js';
import { applyFailureMode, pauseRunForTask } from './pauseResume.js';
import { tryRouteContractFailure } from './contractFailureRoute.js';
import { notifyWaiters } from './waiters.js';
import type { HarnessDeps, OnWorkflowTaskCompleteArgs, WorkflowTaskOutcome } from './types.js';
import { dispatchNextOrTerminate } from './dispatchNext.js';
import { applyPollGate } from './pollPolicy.js';
import { applyOpTaskOutputContract } from './opTaskOutputContract.js';
import {
  recordTaskOutcome,
  reloadAndReDrive,
  shouldPauseOnTransientFailure,
} from './dispatchRecord.js';

/**
 * The attempt's scratch draft goes with the attempt, whatever the outcome.
 *
 * A draft that outlives its task turns a fixed working buffer into one document
 * per task per attempt for every run the space ever makes, and the document is
 * not session-scoped in `repo.put`, so no session cascade reclaims it. Called
 * on the cancelled path too, which returns before the ordinary cleanup.
 *
 * Best-effort: a completed task must not be re-reported because its scratch
 * would not drop.
 */
async function discardAttemptDraft(
  deps: HarnessDeps,
  args: {
    tenantId: Parameters<typeof createTenantContext>[0];
    tenantIdStr: string;
    workerSessionId: string | null | undefined;
    spaceId: string;
  },
): Promise<void> {
  if (!args.workerSessionId) return;
  // Deliberately not caught. This runs while completion is still pending, so a
  // failure leaves the pending row in place and redelivery retries it — where
  // swallowing it recorded the task terminal, took the resting-status branch on
  // redelivery, and left the row and its bodies unreachable for good. Payload
  // deletion inside `discardTaskDraft` stays best-effort: invisible bytes cost
  // storage, while the row is what keeps the draft readable.
  const tenantCtx = createTenantContext(args.tenantId);
  await discardTaskDraft({
    repo: createMemoryDocRepository(deps.db, tenantCtx),
    payloadStore: deps.payloadStore,
    scope: {
      tenantId: args.tenantIdStr,
      sessionId: args.workerSessionId,
      spaceId: args.spaceId,
    },
  });
}

export async function onWorkflowTaskComplete(
  deps: HarnessDeps,
  args: OnWorkflowTaskCompleteArgs,
): Promise<void> {
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness',
    runId: args.workflowExecution.runId,
    taskId: args.workflowExecution.taskId,
    attempt: args.workflowExecution.attempt,
    ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
  });

  const { tenantId, workflowExecution, outcome } = args;
  const { runId, taskId, attempt } = workflowExecution;
  const tenantIdStr = tenantId as string;

  // 1. Load task row
  const taskRow = await getTaskRow(deps.db, tenantIdStr, runId, taskId);
  if (!taskRow) {
    log.warn(
      `[onWorkflowTaskComplete] task row not found for run=${runId} task=${taskId} — dropping result`,
    );
    return;
  }

  // 2a. Stale-attempt guard
  if (taskRow.attempt !== attempt) {
    log.info(
      `[onWorkflowTaskComplete] stale attempt — row.attempt=${String(taskRow.attempt)} result.attempt=${String(attempt)}; dropping`,
    );
    await clearCompletionPending(deps.db, tenantIdStr, { runId, taskId, attempt });
    return;
  }

  // 2b. Cancelled mid-flight — drop without record
  if (taskRow.status === 'cancelled') {
    log.info(
      `[onWorkflowTaskComplete] task cancelled mid-flight; clearing completion_pending without record`,
    );
    // A cancelled attempt still leaves its scratch behind, and this path returns
    // before the cleanup below. The draft is not session-scoped in `repo.put`,
    // so nothing downstream reclaims it.
    const cancelledRun = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
    if (cancelledRun) {
      await discardAttemptDraft(deps, {
        tenantId,
        tenantIdStr,
        workerSessionId: taskRow.workerSessionId,
        spaceId: cancelledRun.spaceId,
      });
    }
    await clearCompletionPending(deps.db, tenantIdStr, { runId, taskId, attempt });
    return;
  }

  // 3. Load run for spaceId / slug needed by downstream handlers
  const run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
  if (!run) {
    log.error(`[onWorkflowTaskComplete] run row not found for runId=${runId}`, undefined, {
      tenantId: tenantIdStr,
      runId,
      taskId,
      attempt,
    });
    return;
  }

  // The draft is NOT discarded here. `outcome` is not yet final: a failure can
  // still become a pause below (a transient-failure resume contract, or a
  // producer-contract failure routed to a fixer), and an attempt that resumes
  // has to find the work it accumulated. Cleanup happens once the attempt is
  // definitively over — see `discardAttemptDraft` at each terminal record.

  let gatedOutcome: WorkflowTaskOutcome = outcome;
  // Hoisted out of the gate block — the firstWrite emission below reuses the
  // resolved definition to compute the task's promoted run-level state.
  let succeededWorkflow: Workflow | null = null;
  let succeededTaskDef: WorkflowTask | null = null;
  if (!isRestingTaskStatus(taskRow.status) && outcome.kind === 'succeeded') {
    try {
      succeededWorkflow = await resolveWorkflowForRun(deps.db, tenantIdStr, run);
      succeededTaskDef = succeededWorkflow?.tasks.find((t) => t.taskId === taskId) ?? null;
    } catch (err) {
      log.warn(
        `[onWorkflowTaskComplete] could not resolve workflow def for succeeded-outcome gates (passing through): ${err instanceof Error ? err.message : String(err)}`,
      );
      succeededWorkflow = null;
      succeededTaskDef = null;
    }
    if (succeededTaskDef?.poll) {
      const gate = await applyPollGate(deps, {
        tenantId,
        run,
        taskRow,
        taskDef: succeededTaskDef,
        workflowExecution,
        outcome,
        ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
      });
      if (gate.kind === 'handled') {
        return;
      }
      gatedOutcome = gate.outcome;
    }
    if (gatedOutcome.kind === 'succeeded') {
      gatedOutcome = await applyOpTaskOutputContract(deps, {
        tenantId,
        taskRow,
        workflow: succeededWorkflow ?? null,
        taskDef: succeededTaskDef,
        workflowExecution,
        outcome: gatedOutcome,
      });
    }
  }
  const effectiveOutcome = gatedOutcome;

  // 4. Decide whether to write the row or pick up the persisted status.
  //
  // The "already resting" duplicate path skips the write but RE-DRIVES
  // the post-record decision so a crash between write and drive doesn't
  // strand the run. completion_pending is the upstream signal that
  // delivery is being retried; the result-consumer ACKs only after this
  // handler returns successfully.
  //
  // CAS-miss path: the task CAS guards (run_id, task_id, attempt) AND
  // status NOT terminal. Concurrent cancel/rerun/sweeper can win
  // between our pre-check and the CAS. When the CAS misses, we cannot
  // trust the incoming `outcome` to reflect current state; reload the
  // row and re-drive based on the persisted status.
  let recordedStatus: 'succeeded' | 'failed' | 'paused' | 'skipped' | 'blocked';
  let firstWrite = false;

  // `isRestingTaskStatus` covers terminal statuses AND `paused` —
  // a paused row also represents persisted state that another path
  // already wrote, so a duplicate paused result must NOT re-call
  // pauseRunForTask (would bump pause_version + duplicate attention).
  if (isRestingTaskStatus(taskRow.status)) {
    log.info(
      `[onWorkflowTaskComplete] task already ${taskRow.status}; re-driving post-record path`,
    );
    recordedStatus = taskRow.status as typeof recordedStatus;
  } else if (effectiveOutcome.kind === 'succeeded') {
    await discardAttemptDraft(deps, {
      tenantId,
      tenantIdStr,
      workerSessionId: taskRow.workerSessionId,
      spaceId: run.spaceId,
    });
    const landed = await recordTaskOutcome(
      deps,
      tenantId,
      runId,
      taskId,
      attempt,
      'succeeded',
      taskRow,
      { outputRef: effectiveOutcome.outputRef },
    );
    if (!landed) {
      const reloaded = await reloadAndReDrive(deps, tenantId, runId, taskId, attempt, log);
      if (reloaded === 'unrecoverable') return;
      recordedStatus = reloaded;
    } else {
      recordedStatus = 'succeeded';
      firstWrite = true;
    }
  } else if (effectiveOutcome.kind === 'failed') {
    let failedWorkflow: Workflow | null = null;
    try {
      failedWorkflow = await resolveWorkflowForRun(deps.db, tenantIdStr, run);
    } catch {
      failedWorkflow = null;
    }
    const pausedTaskDef: WorkflowTask | null =
      failedWorkflow?.tasks.find((t) => t.taskId === taskId) ?? null;

    // A typed producer-contract failure routes to a fixer before the consumer
    // is recorded failed; `not_routed` falls through to the normal paths below.
    const routed = await tryRouteContractFailure(deps, {
      tenantId,
      run,
      workflow: failedWorkflow,
      consumerTaskRow: taskRow,
      attempt,
      outcome: effectiveOutcome,
    });
    if (routed.kind !== 'not_routed') {
      await clearCompletionPending(deps.db, tenantIdStr, { runId, taskId, attempt });
      return;
    }

    if (shouldPauseOnTransientFailure(pausedTaskDef, effectiveOutcome) && pausedTaskDef !== null) {
      const failureMessage =
        effectiveOutcome.failureReason ?? 'Transient external failure on the last attempt.';
      const contract = buildResumeContract({
        pauseCause: 'transient_error',
        runId,
        taskId,
        taskDef: pausedTaskDef,
        errorMessage: failureMessage,
        ...(effectiveOutcome.errorCode ? { errorCode: effectiveOutcome.errorCode } : {}),
        pausedTaskAttempt: attempt,
      });
      let contractRef: string | undefined;
      try {
        contractRef = await storeWorkflowResumeContract({
          payloadStore: deps.payloadStore,
          tenantId: tenantIdStr,
          runId,
          taskId,
          attempt,
          contract,
        });
      } catch (err) {
        log.warn(
          `[onWorkflowTaskComplete] transient_error contract store failed; falling back to failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (contractRef !== undefined) {
        await emitTaskUpdate(deps, {
          tenantId,
          runId,
          taskId,
          label: taskRow.taskId,
          status: 'paused',
          attempt,
          ...(taskRow.workerSessionId ? { workerSessionId: taskRow.workerSessionId } : {}),
          ...(taskRow.operationId ? { operationId: taskRow.operationId } : {}),
          ...(taskRow.startedAt ? { startedAt: taskRow.startedAt } : {}),
          completedAt: new Date(),
        }).catch((err: unknown) => {
          logOrchestratorError(
            `[onWorkflowTaskComplete] emit WorkflowTaskUpdate(paused/transient) failed: ${err instanceof Error ? err.message : String(err)}`,
            err,
            { tenantId: tenantIdStr, runId, taskId, attempt },
          );
        });
        await pauseRunForTask(
          deps,
          tenantId,
          runId,
          taskId,
          attempt,
          contractRef,
          'transient_error',
        );
        await clearCompletionPending(deps.db, tenantIdStr, { runId, taskId, attempt });
        return;
      }
    }

    // Past every path that could still resume this attempt: the contract-failure
    // route and the transient-failure pause both returned above, so the failure
    // is final and the scratch goes with it.
    await discardAttemptDraft(deps, {
      tenantId,
      tenantIdStr,
      workerSessionId: taskRow.workerSessionId,
      spaceId: run.spaceId,
    });

    const landed = await recordTaskOutcome(
      deps,
      tenantId,
      runId,
      taskId,
      attempt,
      'failed',
      taskRow,
      {
        ...(effectiveOutcome.errorRef !== undefined ? { errorRef: effectiveOutcome.errorRef } : {}),
        ...(effectiveOutcome.failureReason !== undefined
          ? { failureReason: effectiveOutcome.failureReason }
          : {}),
        ...(effectiveOutcome.errorCode !== undefined
          ? { errorCode: effectiveOutcome.errorCode }
          : {}),
        ...(effectiveOutcome.errorClassification !== undefined
          ? { errorClassification: effectiveOutcome.errorClassification }
          : {}),
        ...(effectiveOutcome.errorRetryable !== undefined
          ? { errorRetryable: effectiveOutcome.errorRetryable }
          : {}),
      },
    );
    if (!landed) {
      const reloaded = await reloadAndReDrive(deps, tenantId, runId, taskId, attempt, log);
      if (reloaded === 'unrecoverable') return;
      recordedStatus = reloaded;
    } else {
      recordedStatus = 'failed';
      firstWrite = true;
    }
  } else {
    // paused — first delivery. pauseRunForTask owns the run pause / row
    // mark / attention / notifyWaiters as a single sequence. Its CAS
    // guard returns early if a concurrent path won; the safe behaviour
    // is to clear completion_pending and let the winner's drive
    // advance the run.
    //
    await emitTaskUpdate(deps, {
      tenantId,
      runId,
      taskId,
      label: taskRow.taskId,
      status: 'paused',
      attempt,
      ...(taskRow.workerSessionId ? { workerSessionId: taskRow.workerSessionId } : {}),
      ...(taskRow.operationId ? { operationId: taskRow.operationId } : {}),
      ...(taskRow.startedAt ? { startedAt: taskRow.startedAt } : {}),
      completedAt: new Date(),
    }).catch((err: unknown) => {
      logOrchestratorError(
        `[onWorkflowTaskComplete] emit WorkflowTaskUpdate(paused) failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
        { tenantId: tenantIdStr, runId, taskId, attempt },
      );
    });
    let pausedTaskDef: WorkflowTask | null = null;
    if (effectiveOutcome.contractRef !== undefined) {
      try {
        const workflowForPause = await resolveWorkflowForRun(deps.db, tenantIdStr, run);
        pausedTaskDef = workflowForPause?.tasks.find((t) => t.taskId === taskId) ?? null;
      } catch (err) {
        log.warn(
          `[onWorkflowTaskComplete] could not resolve workflow def for pause contract enrichment: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    let wrappedContractRef: string | undefined;
    let pauseReason: string | undefined;
    if (effectiveOutcome.contractRef !== undefined) {
      const resolved = await resolvePausedContractRef({
        payloadStore: deps.payloadStore,
        tenantId: tenantIdStr,
        runId,
        taskId,
        pausedTaskAttempt: attempt,
        contractRef: effectiveOutcome.contractRef,
        taskDef: pausedTaskDef,
      });
      if (resolved) {
        wrappedContractRef = resolved.contractRef;
        pauseReason = resolved.pauseReason;
      } else {
        wrappedContractRef = effectiveOutcome.contractRef;
      }
    }
    await pauseRunForTask(
      deps,
      tenantId,
      runId,
      taskId,
      attempt,
      wrappedContractRef,
      pauseReason,
      effectiveOutcome.taskOutputRef,
    );
    await clearCompletionPending(deps.db, tenantIdStr, { runId, taskId, attempt });
    return;
  }

  if (firstWrite) {
    const presentation =
      effectiveOutcome.kind === 'succeeded'
        ? await extractPresentationFromOutput(deps.payloadStore, effectiveOutcome.outputRef)
        : undefined;

    // First-class output: resolve the task's declared `promoteOutputs`
    // against its just-recorded result and stamp the sanitized slice on
    // the terminal emit, so the chat surface shows live output values
    // mid-run. Best-effort; the run-terminal `result` re-derives the full
    // bag from the rows, so a miss here only delays display.
    const promotedState =
      effectiveOutcome.kind === 'succeeded' && succeededTaskDef && succeededWorkflow
        ? await computePromotedState(deps, runId, taskRow, effectiveOutcome.outputRef, {
            taskDef: succeededTaskDef,
            workflow: succeededWorkflow,
          })
        : undefined;

    await emitTaskUpdate(deps, {
      tenantId,
      runId,
      taskId,
      label: taskRow.taskId, // shared DTO builder sources real label from workflow def; here we use taskId as fallback
      status: recordedStatus,
      attempt,
      ...(taskRow.workerSessionId ? { workerSessionId: taskRow.workerSessionId } : {}),
      ...(taskRow.operationId ? { operationId: taskRow.operationId } : {}),
      ...(taskRow.startedAt ? { startedAt: taskRow.startedAt } : {}),
      completedAt: new Date(),
      ...(effectiveOutcome.kind === 'failed' && effectiveOutcome.failureReason !== undefined
        ? { failureReason: effectiveOutcome.failureReason }
        : {}),
      ...(presentation ? { presentation } : {}),
      ...(promotedState ? { promotedState } : {}),
    }).catch((err: unknown) => {
      logOrchestratorError(
        `[onWorkflowTaskComplete] emit WorkflowTaskUpdate(${recordedStatus}) failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
        { tenantId: tenantIdStr, runId, taskId, attempt },
      );
    });

    let drained = false;
    try {
      await drainSurfaceStreamToWaiters(
        { db: deps.db, redis: deps.redis },
        { tenantId: tenantIdStr, runId, taskId },
      );
      drained = true;
    } catch (err) {
      log.debug(
        `[onWorkflowTaskComplete] surface stream drain failed (leaving stream for consumer + TTL): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (drained) {
      try {
        const progressStreamKey = StreamKeys.workflowTaskProgressStream(tenantIdStr, runId, taskId);
        await deps.redis.del(progressStreamKey);
        await deps.redis.srem(StreamKeys.workflowTaskProgressIndexKey, progressStreamKey);
      } catch (err) {
        log.debug(
          `[onWorkflowTaskComplete] failed to DEL progress stream (TTL will cover): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 5. Drive the run forward based on the recorded status. Each branch
  //    is idempotent under repeat delivery (see header).
  await clearCompletionPending(deps.db, tenantIdStr, { runId, taskId, attempt });

  switch (recordedStatus) {
    case 'succeeded':
      await dispatchNextOrTerminate(deps, tenantId, runId);
      break;
    case 'failed':
      await applyFailureMode(deps, tenantId, runId, taskId);
      break;
    case 'paused': {
      // Re-drive of a duplicate paused result. The original
      // pauseRunForTask wrote the run-pause / attention rows; we just
      // re-poke waiters in case the first delivery crashed before
      // notifyWaiters. markWaiterNotified is WHERE-notified_at-IS-NULL
      // so already-notified waiters are skipped.
      //
      // Reload the run row before reading pausedPayloadRef — the
      // initial load (step 3 above) happened before we knew this
      // was a duplicate, so pauseRunOnly's ledgerPauseRun may have
      // committed paused_payload_ref AFTER that load. Pass it so the
      // re-drive notification carries the same contract ref shape
      // as the first delivery; otherwise a waiter that only sees
      // the re-drive would wake without the contract payload.
      const refreshedRun = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
      if (refreshedRun?.pausedReason === 'manual') {
        log.info(
          `[onWorkflowTaskComplete] late result on an operator-paused (manual) run=${runId} task=${taskId}; not waking waiters`,
        );
        break;
      }
      if (refreshedRun?.status !== 'paused') {
        log.info(
          `[onWorkflowTaskComplete] late paused result on run=${runId} task=${taskId}, which is no longer paused; not waking waiters`,
        );
        break;
      }
      // The pause version and the contract come from the same row read, so
      // the pause this re-drive reports and the contract it carries agree.
      await notifyWaiters(deps, {
        tenantId,
        runId,
        outcome: 'paused',
        pauseVersion: refreshedRun.pauseVersion,
        ...(refreshedRun.pausedPayloadRef ? { payloadRef: refreshedRun.pausedPayloadRef } : {}),
        runDetail: refreshedRun,
      });
      break;
    }
    case 'skipped':
    case 'blocked':
      // A concurrent path (when-predicate skip, cancel_siblings cascade)
      // moved this row to skipped/blocked while the result was in
      // flight. That path drove its own forward decision; nothing more
      // to do here.
      break;
  }
}

/**
 * Resolve the just-succeeded task's `promoteOutputs` into a sanitized
 * run-level state slice for the live `WorkflowTaskUpdate`. The in-memory
 * row predates the success write, so status/outputRef are overlaid before
 * decoding. Returns `undefined` when the task promotes nothing or on any
 * decode failure (best-effort).
 */
async function computePromotedState(
  deps: HarnessDeps,
  runId: string,
  taskRow: WorkflowTaskRow,
  outputRef: string,
  def: { taskDef: WorkflowTask; workflow: Workflow },
): Promise<Record<string, unknown> | undefined> {
  if (!def.taskDef.promoteOutputs || def.taskDef.promoteOutputs.length === 0) return undefined;
  try {
    const decoded = await buildEvalTaskResultsFromRows(
      [{ ...taskRow, status: 'succeeded', outputRef }],
      deps.payloadStore,
      { runId },
    );
    const entry = decoded[0];
    if (!entry) return undefined;
    return resolveTaskPromotedState(def.taskDef, entry, def.workflow.stateVariables);
  } catch {
    return undefined;
  }
}
