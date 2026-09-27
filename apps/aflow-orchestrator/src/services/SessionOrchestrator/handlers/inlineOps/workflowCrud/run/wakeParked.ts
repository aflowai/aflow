import type { InlineHandlerArgs } from '../../types.js';

export async function wakeParkedStepWithFailure(
  args: InlineHandlerArgs,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const { redis, context, stepDef, stepExecutionId, idempotencyKey, attempt } = args;
  const { updateStepState, addStepResult } = await import('@aflow/redis');

  // Reset to STARTED so applyResult's already-terminal guard accepts
  // the FAILED result.
  try {
    await updateStepState(redis, context.tenantId, stepExecutionId, {
      sessionId: context.runId,
      status: 'STARTED',
    });
  } catch {
    // Best-effort.
  }

  const errorData = {
    code: errorCode,
    message: errorMessage,
    classification: 'internal' as const,
    retryable: false,
    timestamp: new Date().toISOString(),
  };
  const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;
  await addStepResult(redis, {
    messageVersion: 1,
    tenantId: context.tenantId,
    sessionId: context.runId,
    stepExecutionId,
    parentStepExecutionId: null,
    stepId: stepDef.stepId,
    stepType: stepDef.stepType,
    operationId: stepDef.operation as never,
    attempt,
    idempotencyKey,
    status: 'FAILED',
    errorRef,
    error: errorData,
    durationMs: 0,
    traceId: context.traceId,
    finishedAtMs: Date.now(),
  });
}
