/**
 * Step result emission — writes to results stream via Redis.
 */
import {
  StepResultMessageSchema,
  type StepJobMessage,
  type PayloadRef,
  type AflowError,
  type StepType,
  type TenantId,
  type StepExecutionId,
  type SimulatedFulfillmentReport,
} from '@aflow/schemas';
import { ackStepJob, addStepResult } from '@aflow/redis';
import type { ExecutorDependencies, StepResult } from '../types.js';
import { buildResultCorrelation, deriveExecutionRunId } from './correlation.js';

export async function emitResult(
  deps: ExecutorDependencies,
  job: StepJobMessage,
  result: StepResult,
  durationMs: number,
  simulatedFulfillment?: SimulatedFulfillmentReport,
): Promise<void> {
  switch (result.status) {
    case 'SUCCEEDED':
      await emitSuccess(
        deps,
        job,
        result.outputRef,
        durationMs,
        result.costJson,
        simulatedFulfillment,
      );
      break;
    case 'FAILED':
      await emitFailure(deps, job, result.error, durationMs, simulatedFulfillment);
      break;
    case 'PAUSED':
      await emitPaused(deps, job, result.requestedInputRef, durationMs, simulatedFulfillment);
      break;
  }
}

export async function emitSuccess(
  deps: ExecutorDependencies,
  job: StepJobMessage,
  outputRef: PayloadRef,
  durationMs: number,
  costJson?: Record<string, unknown>,
  simulatedFulfillment?: SimulatedFulfillmentReport,
): Promise<void> {
  const resultMessage = StepResultMessageSchema.parse({
    ...buildResultCorrelation(job),
    stepExecutionId: job.stepExecutionId,
    tenantId: job.tenantId,
    stepId: job.stepId,
    stepType: job.stepType,
    operationId: job.operationId,
    attempt: job.attempt,
    idempotencyKey: job.idempotencyKey,
    traceId: job.traceId,
    status: 'SUCCEEDED',
    outputRef,
    durationMs,
    simulatedFulfillment,
    costJson,
    usage: costJson,
    finishedAtMs: Date.now(),
  });

  await addStepResult(deps.redis, resultMessage);
}

export async function emitFailure(
  deps: ExecutorDependencies,
  job: StepJobMessage,
  error: AflowError,
  durationMs: number,
  simulatedFulfillment?: SimulatedFulfillmentReport,
): Promise<void> {
  const errorRef = await deps.payloadStore.store({
    tenantId: job.tenantId as TenantId,
    runId: deriveExecutionRunId(job),
    stepExecutionId: job.stepExecutionId as StepExecutionId,
    attempt: job.attempt,
    kind: 'error',
    data: error,
  });

  const resultMessage = StepResultMessageSchema.parse({
    ...buildResultCorrelation(job),
    stepExecutionId: job.stepExecutionId,
    tenantId: job.tenantId,
    stepId: job.stepId,
    stepType: job.stepType,
    operationId: job.operationId,
    attempt: job.attempt,
    idempotencyKey: job.idempotencyKey,
    traceId: job.traceId,
    status: 'FAILED',
    errorRef,
    error,
    durationMs,
    simulatedFulfillment,
    finishedAtMs: Date.now(),
  });

  await addStepResult(deps.redis, resultMessage);
}

export async function emitPaused(
  deps: ExecutorDependencies,
  job: StepJobMessage,
  requestedInputRef: PayloadRef,
  durationMs: number,
  simulatedFulfillment?: SimulatedFulfillmentReport,
): Promise<void> {
  const resultMessage = StepResultMessageSchema.parse({
    ...buildResultCorrelation(job),
    stepExecutionId: job.stepExecutionId,
    tenantId: job.tenantId,
    stepId: job.stepId,
    stepType: job.stepType,
    operationId: job.operationId,
    attempt: job.attempt,
    idempotencyKey: job.idempotencyKey,
    traceId: job.traceId,
    status: 'PAUSED',
    requestedInputRef,
    durationMs,
    simulatedFulfillment,
    finishedAtMs: Date.now(),
  });

  await addStepResult(deps.redis, resultMessage);
}

export async function acknowledgeJob(
  deps: ExecutorDependencies,
  stepType: StepType,
  messageId: string,
): Promise<void> {
  await ackStepJob(deps.redis, stepType, messageId);
}
