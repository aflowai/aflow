/**
 * ai.text.generate_json - Structured JSON output.
 */
import { z } from 'zod';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError } from '@aflow/executor-runtime';
import { validationError } from '@aflow/executor-runtime';
import type { TenantId, StepExecutionId } from '@aflow/schemas';
import { DEFAULT_AI_MODELS } from '@aflow/ai-client';
import type { AiGenerateJsonInput } from '../schema.js';
import { getAIClientForContext } from '../aiClient.js';
import { buildMessages, buildUsageBreakdown } from '../helpers.js';
import { ajv } from '../ajv.js';
import type { HandlerDeps } from './types.js';

export async function handleGenerateJson(
  ctx: ExecutorContext,
  params: AiGenerateJsonInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  try {
    const model = params.model ?? DEFAULT_AI_MODELS.text;
    const client = await getAIClientForContext(ctx, model);

    const messages = buildMessages(params);

    const response = await client.generateJson({
      model,
      messages,
      schema: z.unknown(),
      schemaName: params.schemaName ?? 'output',
      rawJsonSchema: params.outputSchema,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    });

    if (Object.keys(params.outputSchema).length > 0) {
      try {
        const validate = ajv.compile(params.outputSchema);
        const valid = validate(response.data);
        if (!valid) {
          const errorPaths = (validate.errors ?? [])
            .map(
              (e: { instancePath?: string; message?: string }) =>
                `${e.instancePath?.length ? e.instancePath : '/'}: ${e.message ?? 'unknown'}`,
            )
            .join('; ');
          ctx.log.warn('AI JSON output failed schema validation', {
            errors: validate.errors,
            rawContentPreview: response.rawContent.slice(0, 500),
          });
          return await failureWithError(
            ctx,
            validationError(`AI output does not match outputSchema: ${errorPaths}`),
          );
        }
      } catch (schemaError) {
        ctx.log.warn('Failed to compile outputSchema for validation', {
          error: schemaError instanceof Error ? schemaError.message : String(schemaError),
        });
      }
    }

    const output = {
      content: response.data,
      rawContent: response.rawContent,
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      },
      model: response.model,
      finishReason: response.finishReason,
    };

    const usage = buildUsageBreakdown(response);
    if (usage) {
      return await successWithData(ctx, output, { costJson: usage });
    }
    return await successWithData(ctx, output);
  } catch (error) {
    return await deps.handleError(ctx, 'Structured AI generation failed', error);
  }
}
