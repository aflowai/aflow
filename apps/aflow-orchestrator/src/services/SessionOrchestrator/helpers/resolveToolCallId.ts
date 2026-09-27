/**
 * Resolve the compact tool-call id an assistant turn recorded so tool
 * results pair correctly with Gemini / native function-calling history.
 *
 * Virtual tools stamp `_toolCallId:` on synthetic step defs at schedule
 * time. Authored graph tools do not — their mapping lives in
 * `ai.agent._toolCallIdByStepExecution` (written in applyAgentDecision).
 * When both are absent, match the last assistant tool call by tool name.
 */
import type { Redis } from 'ioredis';
import type { AiConversationRecord, SessionId, StepDefinition, TenantId } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { getSessionState, updateSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { isHistoryEnabled, loadOrCreateConversation } from './aiHistory.js';
import { readInlineVar, writeInlineVar } from './runtimeState.js';

/** Runtime map: child stepExecutionId → compact tool-call id. */
export const TOOL_CALL_ID_BY_STEP_EXECUTION_VAR = 'ai.agent._toolCallIdByStepExecution';

export function toolCallIdFromStepTags(stepDef: StepDefinition | undefined): string | undefined {
  const tag = stepDef?.tags.find((t) => t.startsWith('_toolCallId:'));
  return tag ? tag.slice('_toolCallId:'.length) : undefined;
}

export function toolCallIdFromRuntimeMap(
  runtimeState: SessionHotState['runtimeState'] | undefined,
  stepExecutionId: string,
): string | undefined {
  if (!runtimeState) return undefined;
  const map = readInlineVar(
    runtimeState,
    TOOL_CALL_ID_BY_STEP_EXECUTION_VAR,
    {} as Record<string, string>,
  );
  return map[stepExecutionId];
}

/**
 * Match the assistant's recorded tool call by tool name, skipping ids
 * already bound to tool-result messages (parallel invoke_steps).
 */
export function matchToolCallIdFromAssistantHistory(
  conversation: AiConversationRecord,
  attributionStepId: string,
): string | undefined {
  const lastAssistant = conversation.messages
    .filter((m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0)
    .at(-1);
  const usedToolCallIds = new Set(
    conversation.messages
      .filter(
        (m): m is typeof m & { toolResult: NonNullable<typeof m.toolResult> } =>
          m.role === 'tool' && m.toolResult != null,
      )
      .map((m) => m.toolResult.toolCallId),
  );
  const matchingCall = lastAssistant?.toolCalls?.find(
    (tc) => tc.name === attributionStepId && !usedToolCallIds.has(tc.id),
  );
  return matchingCall?.id;
}

/** Persist graph-tool compact ids keyed by child stepExecutionId. */
export async function persistToolCallIdByStepExecutionMap(
  redis: Redis,
  tenantId: TenantId,
  sessionId: SessionId,
  updates: Record<string, string>,
  varMeta: { nowMs: number; stepExecutionId: string; stepId: string },
): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  const stateAfterSchedule = await getSessionState(redis, tenantId, sessionId);
  if (!stateAfterSchedule?.runtimeState) return;
  const vars = { ...stateAfterSchedule.runtimeState.variables };
  const merged = {
    ...readInlineVar(
      stateAfterSchedule.runtimeState,
      TOOL_CALL_ID_BY_STEP_EXECUTION_VAR,
      {} as Record<string, string>,
    ),
    ...updates,
  };
  writeInlineVar(vars, TOOL_CALL_ID_BY_STEP_EXECUTION_VAR, merged, varMeta);
  await updateSessionState(redis, tenantId, sessionId, {
    runtimeState: {
      ...stateAfterSchedule.runtimeState,
      variables: vars,
      version: stateAfterSchedule.runtimeState.version + 1,
      updatedAtMs: Date.now(),
    },
  });
}

/** Resolve toolCallId for onFailure → ai.agent.turn tool-result payloads. */
export async function resolveMatchedToolCallIdForToolFailure(params: {
  payloadStore: PayloadStore;
  stepDef: StepDefinition;
  stepExecutionId: string;
  tenantId: string;
  sessionId: string;
  failureNextStepId: string;
  attributionStepId: string;
  runtimeState: SessionHotState['runtimeState'] | undefined;
  nextStepDef: StepDefinition;
}): Promise<string> {
  const {
    payloadStore,
    stepDef,
    stepExecutionId,
    tenantId,
    sessionId,
    failureNextStepId,
    attributionStepId,
    runtimeState,
    nextStepDef,
  } = params;

  let matched =
    toolCallIdFromStepTags(stepDef) ?? toolCallIdFromRuntimeMap(runtimeState, stepExecutionId);

  if (!matched && isHistoryEnabled(nextStepDef)) {
    try {
      const agentConversation = await loadOrCreateConversation(
        payloadStore,
        tenantId,
        sessionId,
        failureNextStepId,
        runtimeState,
      );
      matched = matchToolCallIdFromAssistantHistory(agentConversation, attributionStepId);
    } catch (historyErr) {
      logOrchestratorError(
        '[SessionOrchestrator] Failed to resolve toolCallId from history on tool failure',
        historyErr,
        { tenantId, sessionId, stepExecutionId, stepId: stepDef.stepId },
      );
    }
  }

  return matched ?? stepExecutionId;
}
