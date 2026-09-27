import type { OperationId } from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';
import {
  getOperationCatalog,
  serializeOperationCatalog,
  getToolCatalog,
  serializeToolCatalog,
} from '@aflow/schemas';
import { addStepResult } from '@aflow/redis';
import type { InlineHandlerArgs } from './types.js';
import { encodeInlineOpOutputRef } from './helpers.js';

// ============================================================================
// platform.catalog.export — Catalog Export
// ============================================================================

export async function handleCatalogExportInline(args: InlineHandlerArgs): Promise<void> {
  const {
    redis,
    payloadStore,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    parentStepExecutionId,
  } = args;
  const startTime = Date.now();
  const operationId = stepDef.operation;

  try {
    let input: Record<string, unknown> = {};
    try {
      const data = await payloadStore.retrieve(resolvedInputRef);
      if (typeof data === 'object' && data !== null) {
        input = data as Record<string, unknown>;
      }
    } catch {
      /* empty input */
    }

    const format = (input['format'] as string | undefined) ?? 'operation_catalog_json';
    const stepTypes = input['stepTypes'] as string[] | undefined;
    const operationIds = input['operationIds'] as string[] | undefined;
    const tagsFilter = input['tags'] as string[] | undefined;
    const includeOutputSchema = (input['includeOutputSchema'] as boolean | undefined) ?? true;
    const strictness = (input['strictness'] as string | undefined) ?? 'lenient';

    let catalogJson: string;
    let operationCount: number;
    let includedOperationIds: string[];

    if (format === 'tool_catalog') {
      const toolOpts = {
        ...(stepTypes ? { stepTypes } : {}),
        ...(operationIds ? { operationIds } : {}),
        ...(tagsFilter ? { tags: tagsFilter } : {}),
        strictness: strictness as 'lenient' | 'strictTopLevel' | 'strictAll',
      };
      const catalog = getToolCatalog(toolOpts);
      catalogJson = serializeToolCatalog(catalog);
      operationCount = catalog.tools.length;
      includedOperationIds = catalog.tools.map((t) => t.name);
    } else {
      const catOpts = {
        ...(stepTypes ? { stepTypes } : {}),
        ...(operationIds ? { operationIds } : {}),
        ...(tagsFilter ? { tags: tagsFilter } : {}),
        includeOutputSchema,
      };
      const catalog = getOperationCatalog(catOpts);
      catalogJson = serializeOperationCatalog(catalog);
      operationCount = catalog.operations.length;
      includedOperationIds = catalog.operations.map((op) => op.operationId);
    }

    // Store catalog in PayloadStore (can be large)
    const catalogRef = await payloadStore.store({
      tenantId: context.tenantId,
      runId: context.runId,
      stepExecutionId,
      attempt,
      kind: 'output',
      data: JSON.parse(catalogJson) as unknown,
      contentType: 'application/json',
    });

    const outputData = {
      catalogRef,
      operationCount,
      includedOperationIds,
    };

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
      stepType: stepDef.stepType,
      operationId: operationId as OperationId,
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
      `[SessionOrchestrator] ${operationId} executed inline: ${String(operationCount)} operations exported`,
    );
  } catch (err) {
    const errorData = {
      code: 'CATALOG_EXPORT_FAILED',
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
      stepType: stepDef.stepType,
      operationId: operationId as OperationId,
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
