/**
 * ai.text.generate_stream - Streaming text with durable NDJSON persistence.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData } from '@aflow/executor-runtime';
import type { TenantId, StepExecutionId } from '@aflow/schemas';
import { DEFAULT_AI_MODELS, createStreamWriter, type StreamWriterConfig } from '@aflow/ai-client';
import type { ToolDefinition } from '@aflow/ai-client';
import type { AiGenerateStreamInput } from '../schema.js';
import { getAIClientForContext } from '../aiClient.js';
import { buildMessages, buildUsageBreakdown } from '../helpers.js';
import type { HandlerDeps } from './types.js';

export async function handleGenerateStream(
  ctx: ExecutorContext,
  params: AiGenerateStreamInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  try {
    const model = params.model ?? DEFAULT_AI_MODELS.text;
    const client = await getAIClientForContext(ctx, model);

    const messages = buildMessages(params);

    const streamingResponse = client.generateTextStream({
      model,
      messages,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      stopSequences: params.stopSequences,
      tools: params.tools as ToolDefinition[] | undefined,
      toolChoice: params.toolChoice,
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    });

    const streamWriterConfig: StreamWriterConfig = {
      payloadStore: deps.payloadStore,
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    };

    const streamWriter = createStreamWriter(streamWriterConfig);

    let chunkCount = 0;
    for await (const chunk of streamingResponse.stream) {
      chunkCount++;
      streamWriter.writeChunk(chunk);
    }

    const response = await streamingResponse.response;

    const { streamRef, summaryRef } = await streamWriter.finalize(response);

    const output = {
      content: response.content ?? '',
      streamRef,
      summaryRef,
      chunkCount,
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      },
      model: response.model,
      finishReason: response.finishReason,
      toolCalls: response.toolCalls,
    };

    const usage = buildUsageBreakdown(response);
    if (usage) {
      return await successWithData(ctx, output, { costJson: usage });
    }
    return await successWithData(ctx, output);
  } catch (error) {
    return await deps.handleError(ctx, 'Streaming AI generation failed', error);
  }
}
