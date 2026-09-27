import type { Redis } from 'ioredis';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import type {
  StepExecutionId,
  StepType,
  OperationId,
  StepDefinition,
  IdempotencyKey,
} from '@aflow/schemas';
import { buildDefinitionSchemaBundle, isDefinitionType } from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { FlowExecutionContext } from '../../types.js';
import { encodeInlineOpOutputRef } from './helpers.js';

export async function handleGetDefinitionSchemaInline(
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
    // Read resolved input
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    const definitionType = input['definitionType'] as string | undefined;
    if (!definitionType || !isDefinitionType(definitionType)) {
      const errorData = {
        code: 'INVALID_DEFINITION_TYPE',
        message: `Unknown definition type: "${String(definitionType)}". Supported: flow_definition`,
        classification: 'validation' as const,
        retryable: false,
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
        operationId: 'agent.manage.get_definition_schema' as OperationId,
        attempt,
        idempotencyKey,
        status: 'FAILED',
        errorRef,
        error: errorData,
        resolvedInputRef,
        durationMs: Date.now() - startTime,
        traceId: context.traceId,
        finishedAtMs: Date.now(),
      });
      return;
    }

    const includeJsonSchema = input['includeJsonSchema'] === true;
    const includeValidationRules = input['includeValidationRules'] !== false;
    const includeCompactText = input['includeCompactText'] !== false;
    const includeGuidance = input['includeGuidance'] !== false;

    const bundle = buildDefinitionSchemaBundle(definitionType);

    // Build output respecting requested inclusions
    const outputData: Record<string, unknown> = {
      definitionType: bundle.definitionType,
      schemaHash: bundle.schemaHash,
      zodSchemaName: bundle.zodSchemaName,
    };

    if (includeJsonSchema) {
      outputData['jsonSchema'] = bundle.jsonSchema;
      outputData['subSchemas'] = bundle.subSchemas;
    }
    if (includeCompactText) {
      outputData['compactText'] = bundle.compactText;
    }
    if (includeValidationRules) {
      outputData['validationRules'] = bundle.validationRules;
    }
    if (includeGuidance) {
      outputData['guidance'] = bundle.guidance;
    }

    const outputRef = await encodeInlineOpOutputRef(
      payloadStore,
      context,
      stepExecutionId,
      attempt,
      outputData,
    );

    await addStepResult(redis, {
      messageVersion: 1,
      tenantId: context.tenantId,
      sessionId: context.runId,
      stepExecutionId,
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: 'agent' as StepType,
      operationId: 'agent.manage.get_definition_schema' as OperationId,
      attempt,
      idempotencyKey,
      status: 'SUCCEEDED',
      outputRef,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });

    getOrchestratorLogger().debug(
      `[SessionOrchestrator] agent.manage.get_definition_schema: returned ${definitionType} bundle (hash=${bundle.schemaHash.slice(0, 8)}…)`,
    );
  } catch (err) {
    const errorData = {
      code: 'GET_DEFINITION_SCHEMA_FAILED',
      message: err instanceof Error ? err.message : String(err),
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
      parentStepExecutionId: parentStepExecutionId ?? null,
      stepId: stepDef.stepId,
      stepType: 'agent' as StepType,
      operationId: 'agent.manage.get_definition_schema' as OperationId,
      attempt,
      idempotencyKey,
      status: 'FAILED',
      errorRef,
      error: errorData,
      resolvedInputRef,
      durationMs: Date.now() - startTime,
      traceId: context.traceId,
      finishedAtMs: Date.now(),
    });
  }
}
