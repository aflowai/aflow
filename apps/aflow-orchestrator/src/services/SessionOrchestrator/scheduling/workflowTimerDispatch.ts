import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  IdempotencyKey,
  OperationId,
  SessionId,
  TimerItem,
  WorkflowExecutionRef,
} from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import { isInlineOperation } from '../helpers/inlineOperations.js';
import { dispatchInlineOp } from '../handlers/dispatchInlineOp.js';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { buildWorkflowTimerStepJob } from './workflowTimerJob.js';
import {
  dispatchOrWaitOnExecutor,
  failedDispatchResult,
  lookAgainForExecutor,
} from './executorWait.js';

/**
 * Process a popped workflow-correlated timer. Best-effort: errors are
 * logged, never thrown — a failed re-dispatch is reaped by the
 * completion_pending sweeper. A missing executor is neither: the task waits
 * for it on an `executor_wait` timer, and one that spent its looks is
 * answered with the FAILED result its executor would have sent, so the task's
 * own retry policy reads the outage as transient.
 */
export async function processWorkflowCorrelatedTimer(
  redis: Redis,
  payloadStore: PayloadStore,
  timer: TimerItem,
  workflowExecution: WorkflowExecutionRef,
): Promise<void> {
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

    const now = Date.now();
    if (timer.executorWait === undefined) {
      await dispatchOrWaitOnExecutor(
        redis,
        buildWorkflowTimerStepJob(timer, workflowExecution, now),
      );
      return;
    }
    const { job: waitingJob, sinceMs, looks } = timer.executorWait;
    const job = { ...waitingJob, scheduledAtMs: now };
    const dispatched = await lookAgainForExecutor(
      redis,
      job,
      { sinceMs, looks, dueAtMs: timer.dueAtMs },
      now,
    );
    if (dispatched.kind === 'gave_up') {
      await addStepResult(redis, failedDispatchResult(job, dispatched.failure, now));
    }
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
