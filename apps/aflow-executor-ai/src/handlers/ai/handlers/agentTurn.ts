import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError } from '@aflow/executor-runtime';
import { internalError, validationError } from '@aflow/executor-runtime';
import type { AgentTurnDecision, AiMessageV1, ToolSurface } from '@aflow/schemas';
import { createAgentDecisionInvalidError } from '@aflow/schemas';
import type { TenantId, StepExecutionId } from '@aflow/schemas';
import { AIClientError, DEFAULT_AI_MODELS } from '@aflow/ai-client';
import type { AIClient, ChatMessage } from '@aflow/ai-client';
import {
  ConversationHistoryHydrationError,
  ConversationStateCorruptError,
  type ConversationStateStore,
} from '../../conversationStateStore.js';
import { MEMORY_READ_OPERATION_ID, RUN_OUTPUT_READ_OPERATION_ID } from '@aflow/schemas';
import type { AgentTurnInput } from '../schema.js';
import { getAIClientForContext } from '../aiClient.js';
import { buildUsageBreakdown } from '../helpers.js';
import type { HandlerDeps } from './types.js';
import {
  validateAgentDecisionForPersistence,
  repairPersistableAgentDecision,
  InvalidAgentTurnDecisionError,
  mergeCostBreakdown,
} from './agentTurnDecision.js';
import type { AgentModelExecutionResult } from './agentTurnModel.js';
import { executeAgentModel } from './agentTurnModel.js';
import { prepareAgentRequest } from './agentTurnRequest.js';
import { triggerCompaction } from '../../compaction.js';
import { RETENTION_POLICY } from '../../retentionPolicy.js';
import {
  supportsToolLoopContinuity,
  type ReasoningContinuityMode,
  type ReasoningContinuityTurnInfo,
} from '../../reasoningContinuity.js';
import type { ReasoningContinuityContext } from '../../conversationStateStore.js';

interface TokenUsageLike {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  uncachedPromptTokens?: number | undefined;
}

function mergeTokenUsage(a: TokenUsageLike, b: TokenUsageLike): TokenUsageLike {
  // Sum optional fields when either side reports them; drop when both are undefined.
  const sumOptional = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const reasoningTokens = sumOptional(a.reasoningTokens, b.reasoningTokens);
  const cacheReadTokens = sumOptional(a.cacheReadTokens, b.cacheReadTokens);
  const cacheWriteTokens = sumOptional(a.cacheWriteTokens, b.cacheWriteTokens);
  const uncachedPromptTokens = sumOptional(a.uncachedPromptTokens, b.uncachedPromptTokens);
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(uncachedPromptTokens !== undefined ? { uncachedPromptTokens } : {}),
  };
}

/**
 * What continuity this turn actually asks the provider for.
 *
 * `auto` asks for retention where it works and silently accepts none where it
 * does not; only a mode someone named is held to the loud failure at the call
 * site. Exported so a test drives this rather than a copy of it — a test that
 * restates the ternary passes just as happily when the handler stops calling it.
 */
export function resolveContinuityMode(
  authored: ReasoningContinuityMode | undefined,
  provider: string | undefined,
  modelReasons: boolean,
): ReasoningContinuityMode {
  const mode: ReasoningContinuityMode = authored ?? 'auto';
  if (mode !== 'auto') return mode;
  return supportsToolLoopContinuity(provider, modelReasons) ? 'tool_loop' : 'off';
}

/**
 * What to tell a model whose tool call the platform refused.
 *
 * The refused call is invisible. It never ran, so it never enters the
 * transcript — which means "your previous tool call was rejected" points, from
 * where the model is standing, at the last call it CAN see, and that one
 * succeeded. A live run read exactly that way: `suite-shape-1` came back
 * SUCCEEDED with `census: { cases[4] }`, the next attempt was refused for
 * encoding, and the model re-sent all four cases because it believed the
 * rejection referred to them. So the first thing to establish is which call is
 * being talked about.
 *
 * A wrong TYPE and a missing ARGUMENT then need opposite instructions, and both
 * used to get the missing-argument one — advice to "populate every required
 * argument" when nothing was missing, which invites exactly the re-send above.
 */
export function buildToolRepairPrompt(
  reject: { reason: string; code: string },
  truncatedToolArgs?: boolean,
): string {
  const isEncodingError = /must be (?:an? )?(?:array|object|string|number|boolean|integer)/i.test(
    reject.reason,
  );
  const whichCall =
    'The call you were just about to make was not accepted, so it never ran and it does ' +
    'NOT appear in the conversation above.\n\n' +
    'Every tool result you can see above is unaffected and still true — if one of them says ' +
    'SUCCEEDED, that work was applied and is still there. Do not re-send it.\n\n';

  // Cut off mid-argument rather than mis-encoded: reasoning is paid from the
  // same output budget as the answer, so a model that thinks at length before
  // emitting a large call can exhaust it partway through. Telling it to resend
  // the same call would truncate at the same place.
  if (truncatedToolArgs) {
    return (
      whichCall +
      `Reason the call was not accepted: its arguments were cut off partway through — ` +
      `the response ran out of output budget before the call finished.\n\n` +
      'Nothing about the call was wrong; it was too large to finish. Make the same kind of ' +
      'call again with FEWER items in it — one or two at a time — and continue in the calls ' +
      'after it. If you were reasoning at length first, keep it shorter so the call itself ' +
      'has room.'
    );
  }

  return isEncodingError
    ? whichCall +
        `Reason the call was not accepted: ${reject.reason}\n(code: ${reject.code})\n\n` +
        'Only the ENCODING of one argument was wrong — what you were trying to do was fine. ' +
        'Make that same call again with that argument as a real JSON value of the stated type ' +
        '(an array as [...], an object as {...}), not as a quoted string containing JSON. ' +
        'Keep your plan: carry on from where the results above leave off.'
    : whichCall +
        `Reason the call was not accepted: ${reject.reason}\n(code: ${reject.code})\n\n` +
        'Make that same call again with EVERY required argument populated to match the ' +
        'tool\u2019s parameter schema. If you cannot supply a required argument, call a ' +
        'different tool or respond with text to ask the user for it.';
}

/**
 * Repair a rejected decision for native-FC providers by re-issuing the turn
 * through native function calling with an appended correction message.
 *
 * The structured-output repair (`repairPersistableAgentDecision`) drives the
 * model with the generic agent-decision schema, whose `args` is an
 * unconstrained object — so a strict structured-output model (Gemini) returns
 * empty `args` and the per-tool argument check fails again. Re-issuing through
 * native FC puts each tool's required-argument schema back in front of the
 * model, so it is pushed to supply the missing fields. The model keeps the
 * freedom to pick a different tool, pause for input, or complete.
 */
async function repairAgentDecisionViaNativeFC(
  ctx: ExecutorContext,
  params: AgentTurnInput,
  deps: HandlerDeps,
  client: AIClient,
  model: string,
  sanitizedMessages: ChatMessage[],
  reject: { reason: string; code: string },
  cacheableSystemBlockCount: number,
  truncatedToolArgs?: boolean,
): Promise<AgentModelExecutionResult> {
  const repairPrompt = buildToolRepairPrompt(reject, truncatedToolArgs);

  const repairMessages: ChatMessage[] = [
    ...sanitizedMessages,
    { role: 'user', content: repairPrompt },
  ];
  return executeAgentModel(
    ctx,
    params,
    deps,
    client,
    model,
    repairMessages,
    true,
    cacheableSystemBlockCount,
  );
}

/** The tool a rejected decision tried to call, when a single one is identifiable. */
function invalidDecisionToolName(decision: AgentTurnDecision): string | undefined {
  if (decision.action === 'invoke_step') return decision.toolId;
  if (decision.action === 'invoke_steps') return decision.calls[0]?.toolId;
  return undefined;
}

/**
 * Forensic snapshot for the AGENT_DECISION_INVALID payload — the rejected
 * decision's text is the only record of what the agent tried to say.
 */
function rejectedDecisionDetail(decision: AgentTurnDecision): {
  action: string;
  message?: string;
  reasoning?: string;
} {
  return {
    action: decision.action,
    ...(typeof decision.message === 'string' ? { message: decision.message } : {}),
    ...(typeof decision.reasoning === 'string' ? { reasoning: decision.reasoning } : {}),
  };
}

export async function handleAgentTurn(
  ctx: ExecutorContext,
  params: AgentTurnInput,
  deps: HandlerDeps,
): Promise<StepResult> {
  const model = params.model ?? DEFAULT_AI_MODELS.text;

  try {
    const client = await getAIClientForContext(ctx, model);
    const modelDef = client.getModel(model);
    const nativeFCProviders = new Set(['google', 'anthropic', 'openai', 'fireworks', 'xai']);
    const useNativeFC =
      nativeFCProviders.has(modelDef?.provider ?? '') &&
      modelDef?.capabilities.functionCalling === true;

    // Provider-native reasoning continuity (Plan 259). Resolve + capability-gate
    // BEFORE any network I/O — an unsupported authored mode fails loud, never
    // silently downgrades.
    const provider = modelDef?.provider;
    const requestedContinuity = resolveContinuityMode(
      params.reasoningContinuity,
      provider,
      modelDef?.capabilities.reasoning === true,
    );
    if (requestedContinuity !== 'off') {
      const supported =
        requestedContinuity === 'tool_loop' &&
        supportsToolLoopContinuity(provider, modelDef?.capabilities.reasoning === true);
      if (!supported) {
        return await failureWithError(
          ctx,
          validationError(
            `Reasoning continuity mode '${requestedContinuity}' is not supported for model ` +
              `'${model}' (provider ${provider ?? 'unknown'}).`,
            {
              code: 'AI_REASONING_CONTINUITY_UNSUPPORTED',
              requestedMode: requestedContinuity,
              model,
              provider: provider ?? 'unknown',
            },
          ),
        );
      }
    }
    const continuityContext: ReasoningContinuityContext | undefined =
      provider !== undefined
        ? {
            mode: requestedContinuity,
            provider,
            model: modelDef?.providerModelId ?? modelDef?.id ?? model,
          }
        : undefined;

    const prepared = await prepareAgentRequest(ctx, deps, params, {
      useNativeFC,
      provider: provider ?? 'unknown',
      model,
      ...(continuityContext ? { continuity: continuityContext } : {}),
    });

    let modelResult: AgentModelExecutionResult;
    try {
      modelResult = await executeAgentModel(
        ctx,
        params,
        deps,
        client,
        model,
        prepared.sanitizedMessages,
        useNativeFC,
        prepared.cacheableSystemBlockCount,
      );
    } catch (err) {
      if (err instanceof InvalidAgentTurnDecisionError) {
        ctx.log.error('agent_turn_decision_invalid_after_repair', {
          message: err.message,
          tenantId: ctx.job.tenantId,
          runId: ctx.runId,
          stepExecutionId: ctx.job.stepExecutionId,
          turnNumber: params.turnNumber,
          model,
        });
        return await failureWithError(
          ctx,
          createAgentDecisionInvalidError(err.message, { reason: err.message }),
        );
      }
      throw err;
    }

    const attemptSummary = [...(modelResult.decisionAttemptSummary ?? [])];
    let validation = validateAgentDecisionForPersistence(params, deps, modelResult.decision);

    if (validation.kind === 'repairable_reject') {
      ctx.log.warn('agent_turn_persistence_repair_attempted', {
        code: validation.code,
        reason: validation.reason,
        ...(validation.argShapes ? { argShapes: validation.argShapes } : {}),
        tenantId: ctx.job.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.job.stepExecutionId,
        turnNumber: params.turnNumber,
        model: modelResult.model,
        provider: modelResult.provider,
      });
      attemptSummary.push('persistence_validation_repair_attempted');

      try {
        const repaired = useNativeFC
          ? await repairAgentDecisionViaNativeFC(
              ctx,
              params,
              deps,
              client,
              model,
              prepared.sanitizedMessages,
              { reason: validation.reason, code: validation.code },
              prepared.cacheableSystemBlockCount,
              modelResult.truncatedToolArgs,
            )
          : await repairPersistableAgentDecision(
              ctx,
              deps,
              client,
              model,
              prepared.sanitizedMessages,
              params,
              { reason: validation.reason, code: validation.code },
            );

        // Drop the ORIGINAL response's tool signatures / reasoning (they match the
        // rejected decision) and carry the REPAIRED response's own — those align
        // with repaired.decision, so replaying them keeps the accepted tool-use turn
        // wire-valid (e.g. an Anthropic thinking block for the repaired tool call).
        const {
          toolCallSignatures: _omitSig,
          providerReasoning: _omitPr,
          ...modelBase
        } = modelResult;
        const mergedCost = mergeCostBreakdown(modelResult.cost, repaired.cost);
        // Only the native-FC repair re-runs the model and produces fresh
        // signatures/reasoning that match repaired.decision; the generateJson repair
        // (PersistenceRepairOutcome) carries neither.
        const repairedFc: AgentModelExecutionResult | undefined = useNativeFC
          ? (repaired as AgentModelExecutionResult)
          : undefined;
        modelResult = {
          ...modelBase,
          decision: repaired.decision,
          rawContent: repaired.rawContent,
          requestSnapshot: repaired.requestSnapshot,
          usage: mergeTokenUsage(modelResult.usage, repaired.usage),
          ...(mergedCost !== undefined ? { cost: mergedCost } : {}),
          ...(repaired.provider !== undefined ? { provider: repaired.provider } : {}),
          ...(repairedFc?.toolCallSignatures !== undefined
            ? { toolCallSignatures: repairedFc.toolCallSignatures }
            : {}),
          ...(repairedFc?.providerReasoning !== undefined
            ? { providerReasoning: repairedFc.providerReasoning }
            : {}),
        };

        validation = validateAgentDecisionForPersistence(params, deps, modelResult.decision);

        if (validation.kind === 'accepted') {
          attemptSummary.push('persistence_validation_repair_succeeded');
        }
      } catch (repairErr) {
        if (repairErr instanceof InvalidAgentTurnDecisionError) {
          ctx.log.error('agent_turn_persistence_repair_failed', {
            message: repairErr.message,
            tenantId: ctx.job.tenantId,
            runId: ctx.runId,
            stepExecutionId: ctx.job.stepExecutionId,
            turnNumber: params.turnNumber,
            model: modelResult.model,
          });
          const toolName = invalidDecisionToolName(modelResult.decision);
          return await failureWithError(
            ctx,
            createAgentDecisionInvalidError(repairErr.message, {
              reason: repairErr.message,
              ...(toolName !== undefined ? { toolName } : {}),
              rejectedDecision: rejectedDecisionDetail(modelResult.decision),
            }),
          );
        }
        throw repairErr;
      }
    }

    if (validation.kind !== 'accepted') {
      await storeRejectedDecisionLog(ctx, params, deps, modelResult.rawContent, modelResult.model);
      ctx.log.error('agent_decision_invalid_after_persistence_repair', {
        reason: validation.reason,
        code: validation.code,
        tenantId: ctx.job.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.job.stepExecutionId,
        turnNumber: params.turnNumber,
        model: modelResult.model,
        provider: modelResult.provider,
      });
      const toolName = invalidDecisionToolName(modelResult.decision);
      return await failureWithError(
        ctx,
        createAgentDecisionInvalidError(
          `Agent decision remained invalid after one repair attempt: ${validation.reason}`,
          {
            reason: validation.reason,
            ...(toolName !== undefined ? { toolName } : {}),
            rejectedDecision: rejectedDecisionDetail(modelResult.decision),
          },
        ),
      );
    }

    // effectiveMode reflects what actually happened: a non-off request only counts
    // as effective when reasoning was captured this turn or retained from earlier.
    // Authoring `tool_loop` on a reasoning-capable model whose effort never resolves
    // (so no thinking/reasoning is produced) is a no-op — report it as `off`.
    const reasoningApplied =
      modelResult.providerReasoning !== undefined ||
      (prepared.reasoningContinuityStats?.stateItems ?? 0) > 0;
    const effectiveContinuity: ReasoningContinuityMode =
      requestedContinuity !== 'off' && reasoningApplied ? requestedContinuity : 'off';
    const continuityInfo: ReasoningContinuityTurnInfo = {
      requestedMode: requestedContinuity,
      effectiveMode: effectiveContinuity,
      provider: provider ?? 'unknown',
      ...(modelResult.providerReasoning
        ? { providerReasoning: modelResult.providerReasoning }
        : {}),
      ...(prepared.reasoningContinuityStats ? { stats: prepared.reasoningContinuityStats } : {}),
    };

    return await finishAgentTurn(
      ctx,
      params,
      deps,
      prepared.store,
      validation.decision,
      modelResult.rawContent,
      modelResult.usage,
      modelResult.model,
      modelResult.requestSnapshot,
      modelResult.cost,
      modelResult.provider,
      modelResult.toolCallSignatures,
      attemptSummary.length > 0 ? attemptSummary : undefined,
      prepared.tokenBreakdown,
      params.contextWindowOverride ?? modelDef?.contextWindow,
      continuityInfo,
      prepared.toolSurface,
    );
  } catch (error) {
    if (error instanceof ConversationHistoryHydrationError) {
      return await failureWithError(
        ctx,
        internalError(`${error.message} Refs: ${error.failedBatchRefs.join(', ') || '(none)'}`, {
          retryable: true,
        }),
      );
    }
    if (error instanceof ConversationStateCorruptError) {
      return await failureWithError(ctx, internalError(error.message, { retryable: false }));
    }
    // The failure text reaches the model on retry via priorFailures — teach the
    // recovery there. Time-budget prose is useless to a model mid-generation;
    // the guidance depends on WHICH limit fired. A stalled stream is the
    // provider's fault — shortening the turn is the wrong medicine and wastes
    // a retry fighting a transient. Only a ceiling (or flat-clock) cut means
    // the turn itself was too large.
    if (error instanceof AIClientError && error.code === 'timeout') {
      error.message += error.message.includes('stream stalled')
        ? ' The provider stopped sending chunks — this is transient; simply retry the same turn.'
        : ' The generation was cut mid-turn. On retry, keep this turn SHORT: brief reasoning,' +
          ' then one tool call — each tool result starts a fresh turn, so spread long analyses' +
          ' across turns instead of narrating everything in one reply.';
    }
    return await deps.handleError(ctx, 'Agent turn failed', error);
  }
}

async function storeRejectedDecisionLog(
  ctx: ExecutorContext,
  params: AgentTurnInput,
  deps: HandlerDeps,
  rawContent: string,
  responseModel: string,
): Promise<void> {
  try {
    await deps.payloadStore.store({
      tenantId: ctx.job.tenantId as TenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId as StepExecutionId,
      attempt: ctx.job.attempt,
      kind: 'logs',
      data: {
        rejected: true,
        turnNumber: params.turnNumber,
        model: responseModel,
        rawContent,
        createdAtMs: Date.now(),
      },
    });
  } catch {
    // ignore log failures
  }
}

/**
 * Fallback context-pressure estimate that drives history clearing/compaction
 * when the provider reports no prompt usage. Deliberately EXCLUDES the tool
 * surface: tool declarations are re-emitted every turn from `availableTools`
 * and cannot be relieved by clearing history, so they must not trigger it —
 * clearing pressure is a property of system + context + history only.
 */
export function fallbackPressureTokens(
  breakdown: { system: number; context: number; history: number } | undefined,
): number {
  return breakdown ? breakdown.system + breakdown.context + breakdown.history : 0;
}

async function finishAgentTurn(
  ctx: ExecutorContext,
  params: AgentTurnInput,
  deps: HandlerDeps,
  store: ConversationStateStore,
  decision: AgentTurnDecision,
  rawContent: string,
  responseUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    uncachedPromptTokens?: number | undefined;
  },
  responseModel: string,
  modelMessagesV1: AiMessageV1[],
  responseCost?: {
    promptCost: number;
    completionCost: number;
    totalCost: number;
    currency: string;
  },
  responseProvider?: string,
  toolCallSignatures?: string[],
  decisionAttemptSummary?: string[],
  tokenBreakdown?: {
    system: number;
    context: number;
    history: number;
    tools: number;
    total: number;
  },
  modelContextWindow?: number,
  continuity?: ReasoningContinuityTurnInfo,
  toolSurface?: ToolSurface,
): Promise<StepResult> {
  store.recordAssistantResponse(
    decision as unknown as Record<string, unknown>,
    params.turnNumber,
    toolCallSignatures,
    continuity?.providerReasoning,
  );

  const modelWindow = modelContextWindow && modelContextWindow > 0 ? modelContextWindow : 200_000;
  const reservedForCompletion = 4096;
  const safetyMargin = Math.ceil(modelWindow * 0.05);
  const effectiveBudget = modelWindow - reservedForCompletion - safetyMargin;

  const pressureTokens =
    responseUsage.promptTokens > 0
      ? responseUsage.promptTokens
      : fallbackPressureTokens(tokenBreakdown);

  // Which read op the reread notes teach — matched by TOOL ID (native
  // callability), not operationId: the note tells the agent to call
  // `<op> { path: … }`, which only works if that op is a callable tool id on
  // the surface. A virtual/core read tool has toolId === operationId; a read
  // op held only as an authored graph step has toolId = the step id, so the
  // op name is NOT callable and must not be taught (the turn ceiling would
  // reject it). Prefer the full memory read (covers /run/outputs too), else
  // the floor-granted run-output read, else none (honest degrade).
  const hasCallableTool = (opId: string): boolean =>
    params.availableTools.some((tool) => tool.toolId === opId);
  const availableReadOpId = hasCallableTool(MEMORY_READ_OPERATION_ID)
    ? MEMORY_READ_OPERATION_ID
    : hasCallableTool(RUN_OUTPUT_READ_OPERATION_ID)
      ? RUN_OUTPUT_READ_OPERATION_ID
      : undefined;

  // §4.8: this function is the single compaction trigger authority — it calls
  // triggerCompaction only when the post-clearing ledger (or the Tier-4
  // ladder) demands it; the module itself has no gate.
  const runCompaction = async () => {
    const compactionClient = await getAIClientForContext(
      ctx,
      RETENTION_POLICY.compactionSummaryModel,
    );

    // Filter hydrated atoms to only those still in the conversation state —
    // clearing may have removed atoms since assembly time.
    const currentState = store.getState();
    const currentAtomIds = new Set(currentState.history.atoms.map((a) => a.atomId));
    const currentAtoms = store.getHydratedAtoms().filter((a) => currentAtomIds.has(a.atomId));

    return await triggerCompaction(
      {
        payloadStore: deps.payloadStore,
        tenantId: ctx.job.tenantId,
        runId: ctx.runId,
        stepId: ctx.job.stepId,
        stepExecutionId: ctx.job.stepExecutionId,
        attempt: ctx.job.attempt,
        availableReadOpId,
      },
      currentState,
      currentAtoms,
      params.summaryTemplate,
      compactionClient,
      params.flowName,
    );
  };

  let conversationStateRef: string | undefined;
  let clearingSummary: { clearedExchanges: number; atomsSummarized: number } | undefined;
  let compactionSummary:
    { compactionNumber: number; tokensSaved: number; summaryModel: string } | undefined;

  try {
    const turnResult = await store.storeTurn();
    conversationStateRef = turnResult.conversationStateRef;

    let estimatedTokensFreed = 0;
    try {
      const clearResult = await store.clearUnderPressure({
        pressureTokens,
        effectiveBudget,
        availableReadOpId,
      });
      if (clearResult) {
        conversationStateRef = clearResult.conversationStateRef;
        estimatedTokensFreed = clearResult.estimatedTokensFreed;
        if (clearResult.clearedExchangeCount > 0) {
          clearingSummary = {
            clearedExchanges: clearResult.clearedExchangeCount,
            atomsSummarized: clearResult.atomsSummarized,
          };
        }
        ctx.log.info('agent_turn_history_cleared', {
          tenantId: ctx.job.tenantId,
          runId: ctx.runId,
          stepExecutionId: ctx.job.stepExecutionId,
          turnNumber: params.turnNumber,
          clearedExchanges: clearResult.clearedExchangeCount,
          atomsSummarized: clearResult.atomsSummarized,
          pressureTokens,
          estimatedTokensFreed,
          effectiveBudget,
          agent_turn_cleared_reexecution: clearResult.reexecutions,
          agent_turn_cleared_refetch: clearResult.refetches,
        });
      }
    } catch (clearErr) {
      // Clearing is best-effort — log and continue with pre-clearing state
      ctx.log.warn('agent_turn_clearing_failed', {
        turnNumber: params.turnNumber,
        error: clearErr instanceof Error ? clearErr.message : String(clearErr),
      });
    }

    let remainingPressureTokens = Math.max(0, pressureTokens - estimatedTokensFreed);
    if (
      effectiveBudget > 0 &&
      remainingPressureTokens / effectiveBudget > RETENTION_POLICY.compactHighWater
    ) {
      try {
        const compactResult = await runCompaction();
        if (compactResult) {
          conversationStateRef = compactResult.conversationStateRef;
          remainingPressureTokens = Math.max(
            0,
            remainingPressureTokens - compactResult.tokensSaved,
          );
          compactionSummary = {
            compactionNumber: compactResult.compactionNumber,
            tokensSaved: compactResult.tokensSaved,
            summaryModel: RETENTION_POLICY.compactionSummaryModel,
          };
          ctx.log.info('agent_turn_compaction', {
            turnNumber: params.turnNumber,
            compactionNumber: compactResult.compactionNumber,
            tokensSaved: compactResult.tokensSaved,
          });
        }
      } catch (compactErr) {
        // Compaction is best-effort — log warning, continue
        ctx.log.warn('agent_turn_compaction_failed', {
          turnNumber: params.turnNumber,
          error: compactErr instanceof Error ? compactErr.message : String(compactErr),
        });
      }
    }

    const atomExcess = store.structuralAtomExcess();
    const tokenExcess = remainingPressureTokens - effectiveBudget;
    if (atomExcess > 0 || tokenExcess > 0) {
      try {
        const forced = await store.forceClearExcess({
          excessAtoms: Math.max(atomExcess, 0),
          excessTokens: Math.max(tokenExcess, 0),
          availableReadOpId,
        });
        if (forced) {
          conversationStateRef = forced.conversationStateRef;
          remainingPressureTokens = Math.max(
            0,
            remainingPressureTokens - forced.estimatedTokensFreed,
          );
          clearingSummary = {
            clearedExchanges:
              (clearingSummary?.clearedExchanges ?? 0) + forced.clearedExchangeCount,
            atomsSummarized: (clearingSummary?.atomsSummarized ?? 0) + forced.atomsSummarized,
          };
          ctx.log.info('agent_turn_forced_clearing', {
            tenantId: ctx.job.tenantId,
            runId: ctx.runId,
            stepExecutionId: ctx.job.stepExecutionId,
            turnNumber: params.turnNumber,
            clearedExchanges: forced.clearedExchangeCount,
            atomsSummarized: forced.atomsSummarized,
            estimatedTokensFreed: forced.estimatedTokensFreed,
          });
        }

        const remainingAtomExcess = store.structuralAtomExcess();
        const remainingTokenExcess = remainingPressureTokens - effectiveBudget;
        if (remainingAtomExcess > 0 || remainingTokenExcess > 0) {
          // Text-heavy histories have no clearable exchanges — compaction owns
          // the unpinned middle (§4.7 step 2).
          const compactResult = await runCompaction();
          if (compactResult) {
            conversationStateRef = compactResult.conversationStateRef;
            remainingPressureTokens = Math.max(
              0,
              remainingPressureTokens - compactResult.tokensSaved,
            );
            compactionSummary = {
              compactionNumber: compactResult.compactionNumber,
              tokensSaved: (compactionSummary?.tokensSaved ?? 0) + compactResult.tokensSaved,
              summaryModel: RETENTION_POLICY.compactionSummaryModel,
            };
            ctx.log.info('agent_turn_forced_compaction', {
              turnNumber: params.turnNumber,
              compactionNumber: compactResult.compactionNumber,
              tokensSaved: compactResult.tokensSaved,
            });
          }
          // §4.3: pressure is recomputed after every mutation — the unrelieved
          // signal judges the POST-compaction numbers.
          const unrelievedTokenExcess = remainingPressureTokens - effectiveBudget;
          if (store.structuralAtomExcess() > 0 || unrelievedTokenExcess > 0) {
            ctx.log.warn('agent_turn_structural_bound_unrelieved', {
              tenantId: ctx.job.tenantId,
              runId: ctx.runId,
              stepExecutionId: ctx.job.stepExecutionId,
              turnNumber: params.turnNumber,
              atomCount: store.getState().history.atoms.length,
              maxAtomsStructural: store.getState().history.maxAtomsStructural,
              remainingTokenExcess: Math.max(unrelievedTokenExcess, 0),
            });
          }
        }
      } catch (forcedErr) {
        const msg = forcedErr instanceof Error ? forcedErr.message : String(forcedErr);
        ctx.log.error('agent_turn_forced_shedding_failed', {
          tenantId: ctx.job.tenantId,
          runId: ctx.runId,
          stepExecutionId: ctx.job.stepExecutionId,
          turnNumber: params.turnNumber,
          error: msg,
        });
        return await failureWithError(
          ctx,
          internalError(
            `Forced history shedding failed: ${msg}. The step will be retried rather than ship truncated or oversized history.`,
            { retryable: true },
          ),
        );
      }
    }
  } catch (storeErr) {
    ctx.log.error('Failed to store conversation state — failing step for retry', {
      error: storeErr instanceof Error ? storeErr.message : String(storeErr),
    });
    return await failureWithError(
      ctx,
      internalError(
        `Conversation state storage failed: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}. ` +
          `The step will be retried to prevent history loss.`,
        { retryable: true },
      ),
    );
  }

  if (clearingSummary && availableReadOpId === undefined) {
    ctx.log.warn('agent_turn_note_readop_missing', {
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      turnNumber: params.turnNumber,
      clearedExchanges: clearingSummary.clearedExchanges,
    });
  }

  const tokenEstimateOutput = tokenBreakdown
    ? {
        tokenEstimate: {
          system: tokenBreakdown.system,
          context: tokenBreakdown.context,
          history: tokenBreakdown.history,
          tools: tokenBreakdown.tools,
          total: tokenBreakdown.total,
          modelWindow,
          reservedForCompletion,
          effectiveBudget,
          utilization:
            effectiveBudget > 0
              ? Math.round((tokenBreakdown.total / effectiveBudget) * 1000) / 1000
              : 0,
        },
      }
    : {};

  if (tokenBreakdown) {
    ctx.log.debug('agent_turn_tokens', {
      turnNumber: params.turnNumber,
      system: tokenBreakdown.system,
      context: tokenBreakdown.context,
      history: tokenBreakdown.history,
      tools: tokenBreakdown.tools,
      total: tokenBreakdown.total,
      modelWindow,
      effectiveBudget,
      utilization:
        effectiveBudget > 0
          ? Math.round((tokenBreakdown.total / effectiveBudget) * 1000) / 1000
          : 0,
    });
  }

  const contextEngineering =
    clearingSummary || compactionSummary
      ? {
          contextEngineering: {
            ...(clearingSummary ? { clearing: clearingSummary } : {}),
            ...(compactionSummary ? { compaction: compactionSummary } : {}),
          },
        }
      : {};

  const cacheObservability =
    responseUsage.cacheReadTokens !== undefined && responseUsage.promptTokens > 0
      ? {
          promptCaching: {
            cacheReadTokens: responseUsage.cacheReadTokens,
            cacheWriteTokens: responseUsage.cacheWriteTokens ?? 0,
            uncachedPromptTokens: responseUsage.uncachedPromptTokens ?? 0,
            cacheHitRatio: responseUsage.cacheReadTokens / responseUsage.promptTokens,
          },
        }
      : {};

  // Non-sensitive reasoning-continuity diagnostics (Plan 259). Emitted only when
  // continuity is materially active this request — a non-off effective mode,
  // reasoning retained onto the wire, or a reset. NOT gated on whether the model
  // happened to reason (that would flip the block on/off per turn while doing
  // nothing). Never carries reasoning content.
  const reasoningContinuityOutput =
    continuity &&
    (continuity.effectiveMode !== 'off' ||
      (continuity.stats?.stateItems ?? 0) > 0 ||
      continuity.stats?.resetReason !== undefined)
      ? {
          reasoningContinuity: {
            requestedMode: continuity.requestedMode,
            effectiveMode: continuity.effectiveMode,
            provider: continuity.provider,
            stateBytes: continuity.stats?.stateBytes ?? 0,
            ...(continuity.stats?.stateItems !== undefined
              ? { stateItems: continuity.stats.stateItems }
              : {}),
            ...(continuity.stats?.resetReason ? { resetReason: continuity.stats.resetReason } : {}),
          },
        }
      : {};

  const output = {
    decision,
    usage: {
      promptTokens: responseUsage.promptTokens,
      completionTokens: responseUsage.completionTokens,
      totalTokens: responseUsage.totalTokens,
      // Optional fields — only include when populated. Lets the inspector
      // surface reasoning-token and cache-token breakdowns when the provider
      // reports them, without forcing zeros into the schema.
      ...(responseUsage.reasoningTokens !== undefined
        ? { reasoningTokens: responseUsage.reasoningTokens }
        : {}),
      ...(responseUsage.cacheReadTokens !== undefined
        ? { cacheReadTokens: responseUsage.cacheReadTokens }
        : {}),
      ...(responseUsage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: responseUsage.cacheWriteTokens }
        : {}),
      ...(responseUsage.uncachedPromptTokens !== undefined
        ? { uncachedPromptTokens: responseUsage.uncachedPromptTokens }
        : {}),
    },
    model: responseModel,
    turnNumber: params.turnNumber,
    modelMessages: modelMessagesV1,
    modelOutput: rawContent,
    ...(conversationStateRef ? { conversationStateRef } : {}),
    ...(decisionAttemptSummary && decisionAttemptSummary.length > 0
      ? { decisionAttemptSummary }
      : {}),
    ...tokenEstimateOutput,
    ...(toolSurface ? { toolSurface } : {}),
    ...contextEngineering,
    ...cacheObservability,
    ...reasoningContinuityOutput,
  };

  const usage = buildUsageBreakdown({
    ...(responseProvider ? { provider: responseProvider } : {}),
    model: responseModel,
    usage: responseUsage,
    cost: responseCost,
  });
  if (usage) {
    return await successWithData(ctx, output, { costJson: usage });
  }
  return await successWithData(ctx, output);
}
