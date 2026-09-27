/**
 * V1 Architecture: History update handler
 *
 * After a step succeeds, updates runtime state with:
 * - chatHistory ref (step output ref — contains modelMessages + modelOutput)
 * - conversationStateRef (from executor output — the executor is the canonical author)
 *
 * For non-agent AI steps, falls back to legacy conversation record management.
 *
 * Non-fatal — errors are logged and execution continues.
 */
import type { StepDefinition } from '@aflow/schemas';
import { createMessage } from '@aflow/schemas';
import type { SessionHotState, StepHotState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import {
  isHistoryEnabled,
  getHistoryPolicy,
  loadOrCreateConversation,
  storeConversation,
  truncateHistory,
} from '../helpers/aiHistory.js';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';

export async function applyHistoryUpdate(
  payloadStore: PayloadStore,
  stepDef: StepDefinition,
  stepState: StepHotState,
  outputRef: string,
  tenantId: string,
  runId: string,
  stepExecutionId: string,
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  nowMs: number,
): Promise<NonNullable<SessionHotState['runtimeState']>> {
  if (!isHistoryEnabled(stepDef)) return runtimeState;

  const isAgentTurn = stepDef.operation === 'ai.agent.turn';

  // ── V1 Architecture: Agent turns use executor-produced conversation state ──
  if (isAgentTurn) {
    return applyAgentTurnHistoryV1(
      payloadStore,
      stepDef,
      outputRef,
      stepExecutionId,
      runtimeState,
      nowMs,
      tenantId,
      runId,
    );
  }

  // ── Non-agent AI steps (ai.text.generate, ai.text.generate_json, etc.) ──
  return applyLegacyHistoryUpdate(
    payloadStore,
    stepDef,
    stepState,
    outputRef,
    tenantId,
    runId,
    stepExecutionId,
    runtimeState,
    nowMs,
  );
}

/**
 * V1: For agent turns, store the step output ref as the chat history variable
 * (modelMessages + modelOutput are embedded in the output) and store the
 * conversationStateRef from the executor.
 */
async function applyAgentTurnHistoryV1(
  payloadStore: PayloadStore,
  stepDef: StepDefinition,
  outputRef: string,
  stepExecutionId: string,
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  nowMs: number,
  tenantId: string,
  runId: string,
): Promise<NonNullable<SessionHotState['runtimeState']>> {
  try {
    const stepOutput = (await payloadStore.retrieve(outputRef as never)) as Record<string, unknown>;

    const conversationStateRef = stepOutput['conversationStateRef'] as string | undefined;

    let updatedState = runtimeState;

    // Store the step output ref as the chat history variable.
    // modelMessages and modelOutput are embedded in the step output directly,
    // so the output ref IS the chat history ref — no separate payload needed.
    {
      const histKey = `ai.agent.chatHistory.${stepDef.stepId}`;
      const newVariables = { ...updatedState.variables };
      newVariables[histKey] = {
        ref: { kind: 'ref' as const, payloadRef: outputRef },
        updatedAtMs: nowMs,
        updatedBy: { stepExecutionId, stepId: stepDef.stepId, actor: 'orchestrator' as const },
        version: getVarVersion(newVariables[histKey]) + 1,
      };
      updatedState = { ...updatedState, variables: newVariables };
    }

    // Store conversationStateRef — this is the V1 conversation state
    if (conversationStateRef) {
      const convKey = `ai.agent.conversation.${stepDef.stepId}`;
      const newVariables = { ...updatedState.variables };
      newVariables[convKey] = {
        ref: { kind: 'ref' as const, payloadRef: conversationStateRef },
        updatedAtMs: nowMs,
        updatedBy: { stepExecutionId, stepId: stepDef.stepId, actor: 'orchestrator' as const },
        version: getVarVersion(newVariables[convKey]) + 1,
      };
      updatedState = { ...updatedState, variables: newVariables };
    }

    return {
      ...updatedState,
      version: updatedState.version + 1,
      updatedAtMs: nowMs,
    };
  } catch (err) {
    logOrchestratorError(
      `[SessionOrchestrator] Failed to update V1 agent state for step ${stepDef.stepId}:`,
      err,
      { tenantId, runId, stepId: stepDef.stepId, stepExecutionId },
    );
    return runtimeState; // Non-fatal
  }
}

/**
 * Legacy: For non-agent AI steps (ai.generate, etc.), continue using the old
 * AiConversationRecord approach.
 */
async function applyLegacyHistoryUpdate(
  payloadStore: PayloadStore,
  stepDef: StepDefinition,
  stepState: StepHotState,
  outputRef: string,
  tenantId: string,
  runId: string,
  stepExecutionId: string,
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  nowMs: number,
): Promise<NonNullable<SessionHotState['runtimeState']>> {
  try {
    const historyPolicy = getHistoryPolicy(stepDef);
    const conversation = await loadOrCreateConversation(
      payloadStore,
      tenantId,
      runId,
      stepDef.stepId,
      runtimeState,
      historyPolicy,
    );

    // Read step input to get the user message / system prompt
    let stepInput: Record<string, unknown> | undefined;
    if (stepState.inputRef) {
      try {
        stepInput = (await payloadStore.retrieve(stepState.inputRef as never)) as Record<
          string,
          unknown
        >;
        const userContent = (stepInput['prompt'] ??
          stepInput['goal'] ??
          stepInput['message'] ??
          '') as string;
        if (userContent) {
          conversation.messages.push(createMessage('user', userContent));
        }
      } catch {
        /* ignore */
      }
    }

    // Prepend system message if missing
    const hasSystem = conversation.messages.some((m) => m.role === 'system');
    const systemPrompt = stepInput?.['systemPrompt'] as string | undefined;
    if (!hasSystem && systemPrompt) {
      conversation.messages.unshift(createMessage('system', systemPrompt));
    }

    // Read step output to get the assistant message
    try {
      const stepOutput = (await payloadStore.retrieve(outputRef as never)) as Record<
        string,
        unknown
      >;
      const content = (stepOutput['content'] ?? '') as string;
      if (content) {
        conversation.messages.push(createMessage('assistant', content));
      }
    } catch {
      /* ignore */
    }

    const truncated = truncateHistory(conversation, historyPolicy);
    truncated.updatedAtMs = nowMs;

    const { updatedState } = await storeConversation(
      payloadStore,
      truncated,
      runtimeState,
      stepDef.stepId,
      stepExecutionId,
      nowMs,
    );

    return updatedState;
  } catch (err) {
    logOrchestratorError(
      `[SessionOrchestrator] Failed to update legacy history for step ${stepDef.stepId}:`,
      err,
      { tenantId, runId, stepId: stepDef.stepId, stepExecutionId },
    );
    return runtimeState; // Non-fatal
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Safely get the version number from a runtime variable entry. */
function getVarVersion(entry: unknown): number {
  if (
    typeof entry === 'object' &&
    entry !== null &&
    'version' in entry &&
    typeof (entry as Record<string, unknown>)['version'] === 'number'
  ) {
    return (entry as Record<string, unknown>)['version'] as number;
  }
  return 0;
}
