/**
 * ai.decision.decide - Typed decisions about a state.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData } from '@aflow/executor-runtime';
import type { AiDecideInput, AiDecideOutput, TenantId, StepExecutionId } from '@aflow/schemas';
import { DEFAULT_AI_MODELS, resolveDecisionAnswers } from '@aflow/ai-client';
import { getAIClientForContext } from '../aiClient.js';
import { buildUsageBreakdown } from '../helpers.js';
import type { HandlerDeps } from './types.js';

export async function handleDecide(
  ctx: ExecutorContext,
  params: AiDecideInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  try {
    const model = params.model ?? DEFAULT_AI_MODELS.decision;
    const client = await getAIClientForContext(ctx, model);

    const startedAt = Date.now();
    const response = await client.decide({
      model,
      state: params.state,
      questions: params.questions,
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    });

    const output: AiDecideOutput = {
      answers: resolveDecisionAnswers(params.questions, response.answers),
      model: response.model,
      usage: response.usage,
      latencyMs: Date.now() - startedAt,
    };

    const usage = buildUsageBreakdown(response);
    if (usage) {
      return await successWithData(ctx, output, { costJson: usage });
    }
    return await successWithData(ctx, output);
  } catch (error) {
    return await deps.handleError(ctx, 'Decision failed', error);
  }
}
