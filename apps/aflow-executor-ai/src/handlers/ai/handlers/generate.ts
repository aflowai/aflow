/**
 * ai.generate - Text generation (chat).
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData } from '@aflow/executor-runtime';
import type { AiConversationRecord } from '@aflow/schemas';
import type { TenantId, StepExecutionId } from '@aflow/schemas';
import type { ToolDefinition } from '@aflow/ai-client';
import type { AiGenerateInput } from '../schema.js';
import { DEFAULT_AI_MODELS } from '@aflow/ai-client';
import { getAIClientForContext } from '../aiClient.js';
import { buildMessages, buildMessagesFromHistory, buildUsageBreakdown } from '../helpers.js';
import type { HandlerDeps } from './types.js';

export async function handleGenerate(
  ctx: ExecutorContext,
  params: AiGenerateInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  try {
    const model = params.model ?? DEFAULT_AI_MODELS.text;
    const client = await getAIClientForContext(ctx, model);

    let messages;
    if (params.historyRef) {
      try {
        const history = await ctx.readPayload<AiConversationRecord>(params.historyRef as never);
        if (history.messages) {
          messages = buildMessagesFromHistory(history, params.prompt, params.systemPrompt);
        } else {
          messages = buildMessages(params);
        }
      } catch (historyErr) {
        ctx.log.warn('Failed to load history, falling back to direct messages', {
          error: historyErr instanceof Error ? historyErr.message : String(historyErr),
        });
        messages = buildMessages(params);
      }
    } else {
      messages = buildMessages(params);
    }

    if (messages.length === 0) {
      throw new Error(
        'ai.text.generate requires at least a prompt or messages. ' +
          'Pass { prompt: "..." } or { messages: [...] } in the inputs.',
      );
    }

    const response = await client.generateText({
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

    const output = {
      content: response.content ?? '',
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
    return await deps.handleError(ctx, 'AI generation failed', error);
  }
}
