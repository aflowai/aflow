import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  IdempotencyKey,
  OperationId,
  SessionId,
  TimerItem,
  WorkflowExecutionRef,
} from '@aflow/schemas';
import { addStepJob } from '@aflow/redis';
import { isInlineOperation } from '../helpers/inlineOperations.js';
import { dispatchInlineOp } from '../handlers/dispatchInlineOp.js';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { buildWorkflowTimerStepJob } from './workflowTimerJob.js';

/**
 * Process a popped workflow-correlated timer. Best-effort: errors are
 * logged, never thrown — a failed re-dispatch is reaped by the
 * completion_pending sweeper.
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

    await addStepJob(redis, buildWorkflowTimerStepJob(timer, workflowExecution, Date.now()));
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
