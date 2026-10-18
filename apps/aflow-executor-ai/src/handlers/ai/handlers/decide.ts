/**
 * ai.decision.decide - Typed decisions about a state.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError, successWithData } from '@aflow/executor-runtime';
import {
  type AiDecideInput,
  type AiDecideOutput,
  DECISION_NO_MODEL,
  type TenantId,
  type StepExecutionId,
} from '@aflow/schemas';
import {
  decisionRequestQuestions,
  resolveDecisionAnswers,
  splitDecisionAnswers,
} from '@aflow/ai-client';
import { getAIClientForContext } from '../aiClient.js';
import { buildUsageBreakdown } from '../helpers.js';
import { resolveDecisionModel } from './decisionModel.js';
import { resolveMediaPersistence } from './mediaPersist.js';
import { MediaSourceResolver } from './mediaSourceRef.js';
import type { HandlerDeps } from './types.js';

export async function handleDecide(
  ctx: ExecutorContext,
  params: AiDecideInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  try {
    const questions = decisionRequestQuestions(params);
    // Only an empty `each` asks nothing; the answer is known without a model,
    // and so without the credential resolving one would need.
    if (Object.keys(questions).length === 0) {
      const { answers, each } = splitDecisionAnswers(params, {});
      const output: AiDecideOutput = {
        answers,
        ...(each !== undefined ? { each } : {}),
        model: params.model ?? DECISION_NO_MODEL,
        calibration: 'self_reported',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      };
      return await successWithData(ctx, output);
    }

    const imageRefs = params.images ?? [];
    const model = await resolveDecisionModel(ctx, deps, {
      model: params.model,
      readsImages: imageRefs.length > 0,
    });
    const client = await getAIClientForContext(ctx, model);

    const images: Array<{ data: string; mimeType: string }> = [];
    if (imageRefs.length > 0) {
      const persistence = resolveMediaPersistence(ctx, deps);
      if (!persistence.ok) return await failureWithError(ctx, persistence.error);
      const sources = new MediaSourceResolver(ctx, persistence.target);
      for (const [index, ref] of imageRefs.entries()) {
        const resolved = await sources.resolve({
          ref,
          role: 'source',
          field: `images[${String(index)}]`,
        });
        if (!resolved.ok) return await failureWithError(ctx, resolved.error);
        images.push({ data: resolved.source.data, mimeType: resolved.source.mimeType });
      }
    }

    const startedAt = Date.now();
    const response = await client.decide({
      model,
      state: params.state,
      questions,
      ...(images.length > 0 ? { images } : {}),
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
    });

    const { answers, each } = splitDecisionAnswers(
      params,
      resolveDecisionAnswers(questions, response.answers),
    );
    const output: AiDecideOutput = {
      answers,
      ...(each !== undefined ? { each } : {}),
      model: response.model,
      calibration: client.getModel(model)?.decision?.confidence ?? 'self_reported',
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
