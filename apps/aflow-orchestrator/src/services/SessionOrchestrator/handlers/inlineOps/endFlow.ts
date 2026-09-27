import type { Redis } from 'ioredis';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import type {
  StepExecutionId,
  OperationId,
  StepType,
  StepDefinition,
  IdempotencyKey,
} from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { encodeInlineOpOutputRef } from './helpers.js';
import type { FlowExecutionContext } from '../../types.js';

/**
 * Handle agent.control.end inline: emit a synthetic SUCCESS result so
 * applyResult detects isEndFlowOp and terminates the run cleanly.
 */
export async function handleEndFlowInline(
  redis: Redis,
  payloadStore: PayloadStore,
  context: FlowExecutionContext,
  stepDef: StepDefinition,
  stepExecutionId: StepExecutionId,
  idempotencyKey: IdempotencyKey,
  resolvedInputRef: string,
  attempt: number,
  _scheduledAtMs: number,
  parentStepExecutionId?: StepExecutionId,
): Promise<void> {
  const startTime = Date.now();
  try {
    // Read resolved input to extract reason/result
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input — end with no result */
    }

    const outputData = {
      ended: true as const,
      ...(typeof input['reason'] === 'string' ? { reason: input['reason'] } : {}),
    };

    // If the step provided a 'result' field, use that as the output payload
    // so it's available as the run's final output via output mapping
    const outputPayload = input['result'] !== undefined ? input['result'] : outputData;
    const outputRef = await encodeInlineOpOutputRef(
      payloadStore,
      context,
      stepExecutionId,
      attempt,
      outputPayload,
    );

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: 'agent' as StepType,
      operationId: 'agent.control.end' as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef: outputRef,
      resolvedInputRef: resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });

    getOrchestratorLogger().debug(
      `[SessionOrchestrator] agent.control.end executed inline: run will terminate`,
    );
  } catch (err) {
    const errorData = {
      code: 'END_FLOW_FAILED',
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    };
    const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: 'agent' as StepType,
      operationId: 'agent.control.end' as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef: errorRef,
      error: errorData,
      resolvedInputRef: resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}
