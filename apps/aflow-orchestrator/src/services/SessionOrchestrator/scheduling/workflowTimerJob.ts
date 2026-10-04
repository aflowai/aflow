import type {
  IdempotencyKey,
  StepJobMessage,
  TimerItem,
  WorkflowExecutionRef,
} from '@aflow/schemas';

/**
 * Build the StepJobMessage that re-enqueues a workflow-correlated timer.
 * Mirrors the `addStepJob` call shape in
 * `cybernetic/harness/dispatchTask.ts` — `workflowExecution` envelope, no
 * `sessionId`, idempotency key = the claim's dispatchAttemptToken.
 */
export function buildWorkflowTimerStepJob(
  timer: TimerItem,
  workflowExecution: WorkflowExecutionRef,
  nowMs: number,
): StepJobMessage {
  return {
    messageVersion: 1,
    tenantId: timer.tenantId,
    workflowExecution,
    stepExecutionId: timer.stepExecutionId,
    stepId: timer.stepId,
    stepType: timer.stepType,
    operationId: timer.operationId,
    attempt: timer.attempt,
    idempotencyKey: workflowExecution.dispatchAttemptToken as IdempotencyKey,
    inputRef: timer.inputRef,
    traceId: timer.traceId,
    scheduledAtMs: nowMs,
    ...(timer.credentialOwnerId !== undefined
      ? { credentialOwnerId: timer.credentialOwnerId }
      : {}),
    ...(timer.spaceId !== undefined ? { spaceId: timer.spaceId } : {}),
    ...(timer.rootTrigger !== undefined ? { rootTrigger: timer.rootTrigger } : {}),
  };
}
