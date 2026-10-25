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
type InconclusiveReason = InconclusiveRung['reason'];

const CLASSIFICATION_FOR_REASON: Record<InconclusiveReason, AflowError['classification']> = {
  credential: 'configuration',
  transient: 'transient',
  model_unavailable: 'configuration',
  content_filter: 'content_policy',
};

/**
 * When the efforts failed for different reasons, the one a retry cannot clear
 * names the failure: a refused credential or an unserved model id outlasts a
 * filtered answer, which outlasts a moment of provider unavailability.
 */
const REASON_PRECEDENCE: readonly InconclusiveReason[] = [
  'credential',
  'model_unavailable',
  'content_filter',
  'transient',
];

const PROVIDER_MESSAGE_LIMIT = 500;

function explain(reason: InconclusiveReason, result: ReasoningProbeResult): string {
  switch (reason) {
    case 'credential':
      return `The provider refused the credential this space stores for ${result.provider}; update it in Settings → Credentials.`;
    case 'model_unavailable':
      return `The provider does not serve "${result.providerModelId}"; the catalog entry's provider model id may be wrong.`;
    case 'transient':
      return 'The provider was unavailable; measure again later.';
    case 'content_filter':
      return 'The provider filtered the answer.';
  }
}

/**
 * A probe where no effort gave evidence measured nothing, and reporting it as
 * a success would read as a measurement. It fails, naming every reason the
 * efforts gave, so the caller's failure accounting sees it. It is retryable
 * only when every effort was merely transient.
 */
function nothingMeasured(result: ReasoningProbeResult): AflowError | null {
  const inconclusive = result.rungs.filter(
    (r): r is InconclusiveRung => r.outcome === 'inconclusive',
  );
  if (inconclusive.length === 0 || inconclusive.length !== result.rungs.length) return null;

  const byReason = new Map<InconclusiveReason, InconclusiveRung[]>();
  for (const rung of inconclusive) {
    byReason.set(rung.reason, [...(byReason.get(rung.reason) ?? []), rung]);
  }
  const reasons = REASON_PRECEDENCE.filter((r) => byReason.has(r));
  const lead = reasons[0];
  if (lead === undefined) return null;

  const explanation = reasons
    .map((reason) => {
      const rungs = byReason.get(reason) ?? [];
      const said = [...new Set(rungs.map((r) => r.error.message.slice(0, PROVIDER_MESSAGE_LIMIT)))];
      const scope = reasons.length > 1 ? `[${rungs.map((r) => r.effort).join(', ')}] ` : '';
      return `${scope}${explain(reason, result)} Provider said: ${said.join(' | ')}`;
    })
    .join(' ');

  return {
    code: 'REASONING_PROBE_NOTHING_MEASURED',
    message: `No effort of ${result.modelId}'s reasoning ladder gave evidence. ${explanation}`,
    classification: CLASSIFICATION_FOR_REASON[lead],
    retryable: reasons.every((r) => r === 'transient'),
    timestamp: new Date().toISOString(),
    details: { modelId: result.modelId, provider: result.provider, reasons, rungs: result.rungs },
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

    const usage = reasoningProbeUsage(result);
    const costJson = usage
      ? buildUsageBreakdown({
          provider: model.provider,
          model: model.id,
          usage,
          cost: client.modelCatalog.calculateCost(model.id, usage),
        })
      : undefined;
    const spend = costJson ? { costJson } : undefined;

    const refusal = nothingMeasured(result);
    if (refusal) return await failureWithError(ctx, refusal, spend);

    return await successWithData(ctx, result, spend);
  } catch (error) {
    return await deps.handleError(ctx, 'Reasoning ladder probe failed', error);
  }
}
