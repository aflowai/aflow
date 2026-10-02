/**
 * Stage 1 — load conversation state, assemble messages, sanitize for provider submission.
 */
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { ChatMessage } from '@aflow/ai-client';
import {
  ConversationStateStore,
  type ContextBlock,
  type ReasoningContinuityContext,
  type TokenBreakdown,
} from '../../conversationStateStore.js';
import { ConversationHistoryHydrationError } from '../../historyHydrationError.js';
import { appendRunWakeups } from '../../runWakeupsInTurn.js';
import type { ReasoningContinuityResetReason } from '../../reasoningContinuity.js';
import { ESTIMATED_CHARS_PER_TOKEN } from '../../tokenEstimate.js';
import type { AgentTurnInput } from '../schema.js';
import type { ToolSurface } from '@aflow/schemas';
import type { HandlerDeps } from './types.js';
import {
  aiMessageToChatMessage,
  mergeConsecutiveMessages,
  chatMessageToAiMessage,
} from './agentMessageConversion.js';
import {
  buildNativeFCSystemPrompt,
  convertOrphanToolMessages,
  enforceToolResultAdjacency,
  emptySanitizationStats,
} from './agentNativeFunctionCalling.js';
import { buildGenerateJsonSystemPrompt } from './agentTurnPrompts.js';
import { buildToolSurface } from './agentToolSurface.js';

export interface PreparedAgentRequest {
  store: ConversationStateStore;
  fullSystemPrompt: string;
  originalMessages: ChatMessage[];
  mergedMessages: ChatMessage[];
  sanitizedMessages: ChatMessage[];
  modelMessagesSnapshot: Array<ReturnType<typeof chatMessageToAiMessage>>;
  tokenBreakdown: TokenBreakdown;
  toolSurface: ToolSurface;
  /** Leading system blocks worth a cache breakpoint — see `AssembledRequest`. */
  cacheableSystemBlockCount: number;
  /** Provider-native reasoning retained into this request (Plan 259), if any. */
  reasoningContinuityStats?: {
    stateBytes: number;
    stateItems: number;
    resetReason?: ReasoningContinuityResetReason;
  };
}

export async function prepareAgentRequest(
  ctx: ExecutorContext,
  deps: HandlerDeps,
  params: AgentTurnInput,
  options: {
    useNativeFC: boolean;
    provider: string;
    model: string;
    continuity?: ReasoningContinuityContext;
  },
): Promise<PreparedAgentRequest> {
  const contextBlocks: ContextBlock[] = [];
  if (params.contextBlocks && params.contextBlocks.length > 0) {
    for (const block of params.contextBlocks) {
      contextBlocks.push({
        key: block.key,
        content: block.content,
        ...(block.cacheHint ? { cacheHint: block.cacheHint } : {}),
      });
    }
  }

  const store = await ConversationStateStore.loadOrCreate(
    {
      payloadStore: deps.payloadStore,
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepId: ctx.job.stepId,
      stepExecutionId: ctx.job.stepExecutionId,
      attempt: ctx.job.attempt,
    },
    params.conversationStateRef,
  );

  const fullSystemPrompt = options.useNativeFC
    ? buildNativeFCSystemPrompt({
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        ...(params.flowName ? { flowName: params.flowName } : {}),
        ...(params.flowDescription ? { flowDescription: params.flowDescription } : {}),
        turnNumber: params.turnNumber,
        totalToolCallsSoFar: params.totalToolCallsSoFar,
        policy: params.policy,
        agentRole: params.agentRole,
        completionPrompt: params.completionPrompt,
        ...(params.finalOutputSchema ? { finalOutputSchema: params.finalOutputSchema } : {}),
      })
    : buildGenerateJsonSystemPrompt(params);

  store.setTurnNumber(params.turnNumber);

  await store.updateSystem(fullSystemPrompt);
  if (contextBlocks.length > 0) {
    await store.updateContext(contextBlocks);
  }

  if (params.newToolResults && params.newToolResults.length > 0) {
    store.appendToolResults(params.newToolResults);
  }

  // The room first, then whatever the agent was directly asked. A person who
  // wakes the agent is answered in the context of what everyone else said
  // while it was busy, which is the order the exchange actually happened in.
  if (params.newRoomMessages && params.newRoomMessages.length > 0) {
    store.appendRoomMessages(params.newRoomMessages);
  }

  if (params.newRunWakeups && params.newRunWakeups.length > 0) {
    appendRunWakeups(store, params.newRunWakeups);
  }

  if (params.newUserInput) {
    store.appendUserInput(params.newUserInput);
  }

  try {
    const assembledRequest = await store.assembleRequest(
      fullSystemPrompt,
      contextBlocks,
      params.activeMemoryInjection,
      options.continuity,
    );
    if (params.activeMemoryInjection && !assembledRequest.activeMemoryInjected) {
      ctx.log.info('agent_turn_active_memory_skipped_no_user_anchor', {
        tenantId: ctx.job.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.job.stepExecutionId,
        turnNumber: params.turnNumber,
      });
    }
    const messages: ChatMessage[] = assembledRequest.messages.map(aiMessageToChatMessage);

    if (params.turnTimestamp && params.newUserInput) {
      const ts = params.turnTimestamp.slice(0, 19).replace('T', ' '); // "2026-04-07 13:42:56"
      messages.push({
        role: 'user' as const,
        content: `[Current time: ${ts} UTC]`,
      });
    }

    const deliveryMode = options.useNativeFC ? 'native_fc' : 'generate_json';
    const { surface, toolsTokens, toolsChars } = buildToolSurface({
      params,
      provider: options.provider,
      model: options.model,
      deliveryMode,
    });

    const raw = assembledRequest.tokenBreakdown;
    // JSON mode renders tool schemas INTO the system string, so subtract their
    // chars out of `system`; native-FC declarations live outside it, so `system`
    // stays as-is and `tools` is purely additive. Either way system+tools never
    // double-counts.
    const systemTokens =
      deliveryMode === 'generate_json'
        ? Math.ceil(Math.max(0, fullSystemPrompt.length - toolsChars) / ESTIMATED_CHARS_PER_TOKEN)
        : raw.system;
    const tokenBreakdown: TokenBreakdown = {
      system: systemTokens,
      context: raw.context,
      history: raw.history,
      tools: toolsTokens,
      total: systemTokens + raw.context + raw.history + toolsTokens,
    };

    const merged = mergeConsecutiveMessages(messages);
    const stats = emptySanitizationStats();
    const sanitized = convertOrphanToolMessages(merged, stats);
    const patched = enforceToolResultAdjacency(sanitized, stats);

    if (
      stats.orphanToUserConversions > 0 ||
      stats.rawUuidNameRemaps > 0 ||
      stats.syntheticPlaceholders > 0 ||
      stats.resultsRelocatedAcrossNonTool > 0
    ) {
      const logFields = {
        tenantId: ctx.job.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.job.stepExecutionId,
        turnNumber: params.turnNumber,
        ...stats,
      };
      // Placeholders/orphan conversions mean an exchange was split upstream —
      if (stats.syntheticPlaceholders > 0 || stats.orphanToUserConversions > 0) {
        ctx.log.warn('agent_turn_message_sanitization', logFields);
      } else {
        ctx.log.info('agent_turn_message_sanitization', logFields);
      }
    }

    return {
      store,
      fullSystemPrompt,
      originalMessages: messages,
      mergedMessages: merged,
      sanitizedMessages: patched,
      modelMessagesSnapshot: patched.map(chatMessageToAiMessage),
      tokenBreakdown,
      toolSurface: surface,
      cacheableSystemBlockCount: assembledRequest.cacheableSystemBlockCount,
      ...(assembledRequest.reasoningContinuity
        ? { reasoningContinuityStats: assembledRequest.reasoningContinuity }
        : {}),
    };
  } catch (err) {
    if (err instanceof ConversationHistoryHydrationError) {
      ctx.log.error('conversation_history_hydration_failed', {
        tenantId: ctx.job.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.job.stepExecutionId,
        turnNumber: params.turnNumber,
        failedBatches: err.failedBatches,
        integrityIssues: err.integrityIssues,
      });
    }
    throw err;
  }
}
