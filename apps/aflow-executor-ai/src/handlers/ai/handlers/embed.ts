/**
 * ai.embedding.generate - Embedding generation.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData } from '@aflow/executor-runtime';
import type { TenantId, StepExecutionId } from '@aflow/schemas';
import { DEFAULT_AI_MODELS } from '@aflow/ai-client';
import type { AiEmbedInput } from '../schema.js';
import { getAIClientForContext } from '../aiClient.js';
import { buildUsageBreakdown } from '../helpers.js';
import type { HandlerDeps } from './types.js';

export async function handleEmbed(
  ctx: ExecutorContext,
  params: AiEmbedInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  try {
    const model = params.model ?? DEFAULT_AI_MODELS.embedding;
    const client = await getAIClientForContext(ctx, model);

    const response = await client.generateEmbedding({
      model,
      input: params.text,
      dimensions: params.dimensions,
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    });

    const output = {
      embeddings: response.embeddings,
      model: response.model,
      dimensions: response.dimensions,
      usage: {
        totalTokens: response.usage.totalTokens,
      },
    };

    const usage = buildUsageBreakdown(response);
    if (usage) {
      return await successWithData(ctx, output, { costJson: usage });
    }
    return await successWithData(ctx, output);
  } catch (error) {
    return await deps.handleError(ctx, 'Embedding generation failed', error);
  }
}
