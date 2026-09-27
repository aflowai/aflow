import {
  computeBlockedDescendantsToClearForRetry,
  commitRetryFailedTaskAndResume,
  RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS,
  emitRunUpdated,
} from '@aflow/cybernetic-runtime';
import { logOrchestratorError } from '../../../../../../lib/orchestratorLogger.js';
import { emitStepError, parkInlineStepForWorkflowWait } from '../../helpers.js';
import { wakeParkedStepWithFailure } from './wakeParked.js';
import type { HandleRetryFailedTaskCtx } from './resumeTypes.js';

export async function handleRetryFailedTask(ctx: HandleRetryFailedTaskCtx): Promise<void> {
  const { args, input, startTime, db, tenantIdStr, spaceId, run, workflow } = ctx;
  // Defensive: the dispatcher only routes here for retry_failed_task,
  // but the type narrowing makes the local resolution typed.
  if (input.resolution.mode !== 'retry_failed_task') return;
  const resolution = input.resolution;
  if (!run) {
    // Should never happen — the caller already validated `run` exists.
    await emitStepError(
      args,
      'WORKFLOW_RUN_NOT_FOUND',
      'Internal: retry handler received null run.',
      startTime,
      'validation',
    );
    return;
  }

  // 1. Run must be in `failed` state. Other states (running, paused,
  //    completed, cancelled) are not retryable via this mode — the
  //    paused-resume modes cover paused; the run-creation path covers
  //    everything else.
  if (run.status !== 'failed') {
    await emitStepError(
      args,
      'RETRY_WRONG_RUN_STATE',
      `Run ${run.runId} is "${run.status}", not "failed". retry_failed_task only applies to terminal failed runs. ` +
        'Inspect via `workflow.run.detail` and pick the right action for the current state.',
      startTime,
      'validation',
    );
    return;
  }

  // 2. Find the task in the workflow definition. Required for
  //    `retryability` + `maxAttempts` lookup.
  const taskDef = workflow.tasks.find((t) => t.taskId === resolution.taskId);
  if (!taskDef) {
    await emitStepError(
      args,
      'RETRY_TASK_NOT_FOUND_OR_NOT_FAILED',
      `Task "${resolution.taskId}" is not present in workflow ${run.workflowSlug}@${String(run.workflowRevision)}. ` +
        'The workflow definition may have changed since the run failed; retry refuses across schema changes.',
      startTime,
      'validation',
    );
    return;
  }
  if (taskDef.failureMode === 'cancel_siblings') {
    await emitStepError(
      args,
      'RETRY_CANCEL_SIBLINGS_NOT_RECOVERABLE',
      `Task "${resolution.taskId}" has failureMode: 'cancel_siblings'. ` +
        'A single-task retry cannot restore the tasks intentionally blocked when it failed; start a new run instead.',
      startTime,
      'validation',
    );
    return;
  }

  const maxAttempts = taskDef.maxAttempts ?? RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS;
  const allowBudgetReset = resolution.remediationConfirmed === true;
  const descendantTaskIds = [
    ...computeBlockedDescendantsToClearForRetry(workflow.tasks, run.tasks, resolution.taskId),
  ];

  // 3. Atomic commit — CAS on (failedAt, attempt), task-row in-place
  //    update with prior_failures append, run-row flip to running, and
  //    stale blocked-descendant cleanup.
  const commitResult = await commitRetryFailedTaskAndResume(db, tenantIdStr, {
    runId: run.runId,
    taskId: resolution.taskId,
    failedAt: new Date(resolution.failedAt),
    attempt: resolution.attempt,
    maxAttempts,
    allowBudgetReset,
    descendantTaskIds,
    ...(resolution.remediationNote !== undefined
      ? { remediationNote: resolution.remediationNote }
      : {}),
  });

  if (commitResult !== 'committed') {
    const errorMap: Record<string, { code: string; message: string }> = {
      wrong_run_state: {
        code: 'RETRY_WRONG_RUN_STATE',
        message: `Run ${run.runId} is not in "failed" state — refresh and re-inspect via workflow.run.detail.`,
      },
      stale_failure_cas: {
        code: 'RETRY_STALE_FAILURE_CAS',
        message:
          `(failedAt, attempt) did not match the live failed-task row on run ${run.runId}. ` +
          'A concurrent retry may have won, or the suggestedAction is stale. Re-fetch the failure event ' +
          'and resubmit with the freshest CAS values.',
      },
      task_not_found_or_not_failed: {
        code: 'RETRY_TASK_NOT_FOUND_OR_NOT_FAILED',
        message:
          `Task "${resolution.taskId}" is not in "failed" state on run ${run.runId}. The run may have been ` +
          'retried already, or the task id is wrong.',
      },
      at_parallel_limit: {
        code: 'RETRY_AT_PARALLEL_LIMIT',
        message:
          `Run ${run.runId} is already at its parallel-task limit, so retrying "${resolution.taskId}" ` +
          'would put it over. Wait for an in-flight task to finish and retry — nothing was changed.',
      },
      attempt_budget_exhausted: {
        code: 'RETRY_ATTEMPT_BUDGET_EXHAUSTED',
        message:
          `Task "${resolution.taskId}" has exhausted its automatic retry budget (maxAttempts=${String(maxAttempts)}). ` +
          'Fix the root cause (binding, credentials, or input), then re-send this resolution with ' +
          '`remediationConfirmed: true` to retry in place (upstream work preserved), or start a fresh run.',
      },
    };
    const mapped = errorMap[commitResult];
    if (mapped) {
      await emitStepError(args, mapped.code, mapped.message, startTime, 'validation');
    } else {
      await emitStepError(
        args,
        'RETRY_HANDLER_ERROR',
        `Internal: unexpected commit result "${commitResult}".`,
        startTime,
        'validation',
      );
    }
    return;
  }

  await emitRunUpdated(args.redis, {
    tenantId: tenantIdStr,
    spaceId,
    runId: run.runId,
    workflowSlug: run.workflowSlug,
    status: 'running',
  });

  // 4. SYNCHRONOUSLY park this step on the workflow run BEFORE
  //    dispatching the retried task. Same race-avoidance pattern as
  //    `workflow.run.start` / `workflow.run.resume`: the dispatch
  //    below can trigger waiter notifications that would race a
  //    queued PAUSED step result. `parkInlineStepForWorkflowWait`
  //    routes through `StepService.waitForInput`, so step + session
  //    are durably PAUSED before any harness work and no queued
  //    PAUSED is left to replay over the wakeup.
  await parkInlineStepForWorkflowWait(args, {
    kind: 'waiting_on_workflow_run' as const,
    runId: run.runId,
    slug: run.workflowSlug,
    status: 'running' as const,
    priorLiveness: 'unknown' as const,
  });

  // 5. Re-bind: insert a new waiter row for the resuming Helmsman.
  //    This is the durable pivot: any harness-side failure after the
  //    waiter row exists can wake the Helmsman via notifyWaiters; before
  //    it exists, the step is PAUSED but no row exists for the wake to
  //    target. If `addWaiter` itself throws (transient DB error), the
  //    parked step would hang indefinitely under the catch path below
  //    because `applyFailureMode → notifyWaiters` has nothing to target.
  //    Mirror `handleWorkflowRunStart`'s split: wrap `addWaiter`
  //    separately and wake the parked step directly with a typed
  //    failure when it throws.
  const callingSessionId = args.context.runId;
  try {
    const { addWaiter } = await import('@aflow/cybernetic-runtime');
    await addWaiter(db, tenantIdStr, {
      runId: run.runId,
      waiterSessionId: callingSessionId,
      waiterStepExecutionId: args.stepExecutionId,
    });
  } catch (waiterErr) {
    const errMsg = waiterErr instanceof Error ? waiterErr.message : String(waiterErr);
    logOrchestratorError(
      `[handleRetryFailedTask] addWaiter failed for run=${run.runId} task=${resolution.taskId}`,
      waiterErr,
      { runId: run.runId, taskId: resolution.taskId },
    );
    // Wake the parked step directly — write a FAILED result that
    // applyResult treats as a step failure. The run row stays
    // 'running' from the atomic commit; the next workflow.run.detail
    // call surfaces the still-running retried task row, which the
    // sweeper will eventually drive forward or mark stalled. The
    // operator's Helmsman session unparks immediately with a typed
    // error rather than hanging.
    await wakeParkedStepWithFailure(
      args,
      'RETRY_WAITER_INSERT_FAILED',
      `Failed to register Helmsman as workflow run waiter for retry: ${errMsg}`,
    );
    return;
  }

  // 6. Dispatch the retried task. The new Runner session gets a fresh
  //    workerSessionId; the existing task row is UPDATE-claimed via
  //    `claimRetriedTask`. From here on, any failure can flow through
  //    `applyFailureMode → notifyWaiters` to wake the parked Helmsman.
  try {
    const harnessModule = await import('../../../../../cybernetic/WorkflowRunHarness.js');
    const { dispatchRetriedTask } = harnessModule;
    const harnessDeps = { db, redis: args.redis, payloadStore: args.payloadStore };
    const retriedAttempt = resolution.attempt + 1;
    await dispatchRetriedTask(harnessDeps, {
      tenantId: args.context.tenantId,
      runId: run.runId,
      taskId: resolution.taskId,
      attempt: retriedAttempt,
      helmsmanSessionId: callingSessionId as never,
    });
  } catch (err) {
    // The atomic commit already landed; the task row is `running` with
    // the new attempt. If dispatchRetriedTask threw POST-claim, its
    // `postClaimFailure` already CASed the row to `failed`. If it threw
    // PRE-claim (e.g. buildTaskInputRef raised before claimRetriedTask
    // landed), the row is still `running` with no worker — applyFailureMode
    // would then `block` it (a non-terminal row) and complete the run
    // failed without ever recording the retried attempt as `failed` or
    // stamping a new (failedAt, attempt) CAS token. The next retry
    // attempt would then have no failure-event to read.
    //
    // Defensive CAS to `failed` here first. The status guard inside
    // `casCompleteTask` makes it a no-op when the row already moved
    // (post-claim path's `postClaimFailure` won the race).
    logOrchestratorError(
      `[handleRetryFailedTask] dispatch failed after atomic commit — run=${run.runId} task=${resolution.taskId}`,
      err,
      { runId: run.runId, taskId: resolution.taskId },
    );
    const retriedAttempt = resolution.attempt + 1;
    const reason = err instanceof Error ? err.message : String(err);
    const cyberneticRuntime = await import('@aflow/cybernetic-runtime');
    try {
      await cyberneticRuntime.casCompleteTask(db, tenantIdStr, {
        runId: run.runId,
        taskId: resolution.taskId,
        attempt: retriedAttempt,
        status: 'failed',
        completedAt: new Date(),
        failedAt: new Date(),
        failureReason: `Retry dispatch failed: ${reason}`,
        errorCode: 'RETRY_DISPATCH_FAILED',
        errorClassification: 'internal',
        errorRetryable: false,
      });
    } catch (casErr) {
      logOrchestratorError(
        `[handleRetryFailedTask] defensive CAS to failed threw — relying on applyFailureMode recovery`,
        casErr,
        { runId: run.runId, taskId: resolution.taskId },
      );
    }
    try {
      const harness = await import('../../../../../cybernetic/WorkflowRunHarness.js');
      await harness.applyFailureMode(
        { db, redis: args.redis, payloadStore: args.payloadStore },
        args.context.tenantId,
        run.runId,
        resolution.taskId,
      );
    } catch (recoveryErr) {
      logOrchestratorError(
        `[handleRetryFailedTask] failure-mode recovery also failed for run=${run.runId} task=${resolution.taskId}`,
        recoveryErr,
        { runId: run.runId, taskId: resolution.taskId },
      );
    }
  }
}
