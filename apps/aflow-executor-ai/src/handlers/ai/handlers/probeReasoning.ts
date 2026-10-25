/**
 * ai.model.probe_reasoning — measure one catalog model's reasoning ladder
 * against its provider with the space's stored credential.
 *
 * The probe itself is `probeReasoningLadder` in `@aflow/ai-client`, the same
 * code `yarn models:verify-reasoning` runs; this handler only resolves the
 * model and the credential, and reports the spend.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError, successWithData, validationError } from '@aflow/executor-runtime';
import type {
  AflowError,
  AiModelProbeReasoningInput,
  ReasoningProbeResult,
  ReasoningProbeRung,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import {
  probeReasoningLadder,
  reasoningProbeUsage,
  resolveReasoningProbeTarget,
} from '@aflow/ai-client';
import { getAIClientForContext } from '../aiClient.js';
import { buildUsageBreakdown } from '../helpers.js';
import type { HandlerDeps } from './types.js';

type InconclusiveRung = Extract<ReasoningProbeRung, { outcome: 'inconclusive' }>;

const CLASSIFICATION_FOR_REASON: Record<InconclusiveRung['reason'], AflowError['classification']> =
  {
    credential: 'configuration',
    transient: 'transient',
    model_unavailable: 'configuration',
    content_filter: 'content_policy',
  };

/**
 * A probe where no rung gave evidence measured nothing, and reporting it as a
 * success would read as a measurement. It fails, naming why, so the caller's
 * failure accounting sees it.
 */
function nothingMeasured(result: ReasoningProbeResult): AflowError | null {
  const inconclusive = result.rungs.filter(
    (r): r is InconclusiveRung => r.outcome === 'inconclusive',
  );
  if (inconclusive.length !== result.rungs.length) return null;
  const first = inconclusive[0];
  if (!first) return null;
  const why =
    first.reason === 'credential'
      ? `The provider refused the credential this space stores for ${result.provider}; update it in Settings → Credentials.`
      : first.reason === 'model_unavailable'
        ? `The provider does not serve "${result.providerModelId}"; the catalog entry's provider model id may be wrong.`
        : first.reason === 'transient'
          ? 'The provider was unavailable for every rung; measure again later.'
          : 'The provider filtered every answer.';
  return {
    code: 'REASONING_PROBE_NOTHING_MEASURED',
    message: `No rung of ${result.modelId}'s reasoning ladder gave evidence. ${why} Provider said: ${first.error.message}`,
    classification: CLASSIFICATION_FOR_REASON[first.reason],
    retryable: first.reason === 'transient',
    timestamp: new Date().toISOString(),
    details: { modelId: result.modelId, provider: result.provider, rungs: result.rungs },
  };
}

export async function handleProbeReasoning(
  ctx: ExecutorContext,
  params: AiModelProbeReasoningInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  const target = resolveReasoningProbeTarget(params.model);
  if (!target.ok) {
    return await failureWithError(ctx, validationError(target.message));
  }
  const { model } = target;

  try {
    const client = await getAIClientForContext(ctx, model.id);
    const result = await probeReasoningLadder({
      model,
      getAdapter: () => client.getAdapter(model.id, model.provider),
      attribution: {
        tenantId: ctx.job.tenantId as TenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
        attempt: ctx.job.attempt,
      },
    });

    const refusal = nothingMeasured(result);
    if (refusal) return await failureWithError(ctx, refusal);

    const usage = reasoningProbeUsage(result);
    const costJson = usage
      ? buildUsageBreakdown({
          provider: model.provider,
          model: model.id,
          usage,
          cost: client.modelCatalog.calculateCost(model.id, usage),
        })
      : undefined;
    return costJson
      ? await successWithData(ctx, result, { costJson })
      : await successWithData(ctx, result);
  } catch (error) {
    return await deps.handleError(ctx, 'Reasoning ladder probe failed', error);
  }
}
