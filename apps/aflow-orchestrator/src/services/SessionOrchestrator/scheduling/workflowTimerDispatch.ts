import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  IdempotencyKey,
  OperationId,
  SessionId,
  TimerItem,
  WorkflowExecutionRef,
} from '@aflow/schemas';
import { CodeLaneDisabledError, errorContext } from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import { isInlineOperation } from '../helpers/inlineOperations.js';
import { dispatchInlineOp } from '../handlers/dispatchInlineOp.js';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { describeEnqueueFailure } from '../../../lib/enqueueFailure.js';
import { buildWorkflowTimerStepJob } from './workflowTimerJob.js';
import {
  dispatchOrWaitOnExecutor,
  failedDispatchResult,
  lookAgainForExecutor,
  type ExecutorDispatch,
} from './executorWait.js';

/**
 * Process a popped workflow-correlated timer. A dispatch is best-effort: its
 * errors are logged, never thrown, and a failed re-dispatch is reaped by the
 * completion_pending sweeper. A missing executor is neither: the task waits
 * for it on an `executor_wait` timer, and a look that fails throws, so the
 * timer is left for redelivery rather than acknowledged.
 */
export async function processWorkflowCorrelatedTimer(
  redis: Redis,
  payloadStore: PayloadStore,
  timer: TimerItem,
  workflowExecution: WorkflowExecutionRef,
): Promise<void> {
  if (timer.executorWait !== undefined) {
    await lookAgainForTaskExecutor(redis, timer, timer.executorWait, workflowExecution);
    return;
  }
  try {
    if (isInlineOperation(timer.operationId)) {
      // Inline workflow-task op (snooze). The synthetic context mirrors
      // `dispatchTask`'s inline dispatch: `runId` carries the worker
      // session id (= the step execution id allocated at claim time);
      // handlers that need the workflow run id read
      // `args.workflowExecution.runId`.
      await dispatchInlineOp(
        redis,
        payloadStore,
        {
          tenantId: timer.tenantId,
          runId: timer.stepExecutionId as string as SessionId,
          agentDefinition: {
            flowId: 'workflow-task-inline',
            flowVersion: '1',
            steps: [],
            metadata: { name: '', description: '' },
          } as never,
          traceId: timer.traceId,
          ...(timer.spaceId !== undefined ? { spaceId: timer.spaceId } : {}),
        },
        {
          stepId: timer.stepId,
          stepType: timer.stepType,
          operation: timer.operationId as OperationId,
          config: {},
          tags: ['dynamic', `_taskId:${workflowExecution.taskId}`],
          optional: false,
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
        timer.stepExecutionId,
        workflowExecution.dispatchAttemptToken as IdempotencyKey,
        timer.inputRef,
        timer.attempt,
        Date.now(),
        undefined,
        workflowExecution,
      );
      return;
    }

    await dispatchOrWaitOnExecutor(
      redis,
      buildWorkflowTimerStepJob(timer, workflowExecution, Date.now()),
    );
  } catch (error) {
    logOrchestratorError(
      `[SessionOrchestrator] Failed to re-dispatch workflow-correlated timer (${timer.operationId})`,
      error,
      {
        tenantId: timer.tenantId,
        runId: workflowExecution.runId,
        taskId: workflowExecution.taskId,
        attempt: workflowExecution.attempt,
        stepExecutionId: timer.stepExecutionId,
      },
    );
  }
}

/**
 * A lane breaker's refusal and a wait that spent its looks are answered with the
 * FAILED result the task's executor would have sent. Anything else is logged
 * under the classification the task would carry and thrown, so the timer is
 * redelivered and its next look is still this wait's to take.
 */
async function lookAgainForTaskExecutor(
  redis: Redis,
  timer: TimerItem,
  wait: NonNullable<TimerItem['executorWait']>,
  workflowExecution: WorkflowExecutionRef,
): Promise<void> {
  const now = Date.now();
  const job = { ...wait.job, scheduledAtMs: now };
  const logContext = {
    tenantId: job.tenantId,
    runId: workflowExecution.runId,
    taskId: workflowExecution.taskId,
    attempt: workflowExecution.attempt,
    stepExecutionId: job.stepExecutionId,
    stepType: job.stepType,
    operationId: job.operationId,
    traceId: job.traceId,
  };
  let dispatched: ExecutorDispatch;
  try {
    dispatched = await lookAgainForExecutor(
      redis,
      job,
      { sinceMs: wait.sinceMs, looks: wait.looks, dueAtMs: timer.dueAtMs },
      now,
    );
  } catch (error) {
    if (!(error instanceof CodeLaneDisabledError)) {
      getOrchestratorLogger().error(
        `[SessionOrchestrator] Look for the ${job.stepType} executor of task ${workflowExecution.taskId} failed; its timer is left for redelivery`,
        error instanceof Error ? error : undefined,
        errorContext(describeEnqueueFailure(error), logContext),
      );
      throw error;
    }
    dispatched = { kind: 'gave_up', failure: error.toAflowError() };
  }
  if (dispatched.kind !== 'gave_up') return;
  try {
    await addStepResult(redis, failedDispatchResult(job, dispatched.failure, now));
  } catch (error) {
    getOrchestratorLogger().error(
      `[SessionOrchestrator] The FAILED result of task ${workflowExecution.taskId} was not recorded; its timer is left for redelivery`,
      error instanceof Error ? error : undefined,
      errorContext(dispatched.failure, logContext),
    );
    throw error;
  }
}
