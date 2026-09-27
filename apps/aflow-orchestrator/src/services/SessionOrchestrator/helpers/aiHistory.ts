import type {
  TenantId,
  SessionId,
  StepExecutionId,
  AiConversationRecord,
  HistoryPolicy,
  StepDefinition,
} from '@aflow/schemas';
import { buildConversationKey, createConversationRecord, truncateHistory } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';

// ============================================================================
// History enablement checks
// ============================================================================

/**
 * Check if a step has history enabled (from step config or flow convention).
 */
export function isHistoryEnabled(stepDef: StepDefinition): boolean {
  const config = stepDef.config as Record<string, unknown> | undefined;
  // Agent turns always have history
  if (stepDef.operation === 'ai.agent.turn') return true;
  // Check explicit historyPolicy in config
  const historyPolicy = config?.['historyPolicy'] as { enabled?: boolean } | undefined;
  return historyPolicy?.enabled === true;
}

/**
 * Get history policy from step config.
 */
export function getHistoryPolicy(stepDef: StepDefinition): HistoryPolicy {
  const config = stepDef.config as Record<string, unknown> | undefined;
  if (stepDef.operation === 'ai.agent.turn') {
    // Agent defaults
    const agentConfig = config?.['historyPolicy'] as Partial<HistoryPolicy> | undefined;
    return {
      enabled: true,
      scope: agentConfig?.scope ?? { kind: 'step' },
      maxMessages: agentConfig?.maxMessages ?? 50,
      truncationPolicy: agentConfig?.truncationPolicy ?? 'sliding_window',
      includeToolMessages: agentConfig?.includeToolMessages ?? true,
    };
  }
  const hp = config?.['historyPolicy'] as Partial<HistoryPolicy> | undefined;
  return {
    enabled: hp?.enabled ?? false,
    scope: hp?.scope ?? { kind: 'step' },
    maxMessages: hp?.maxMessages ?? 100,
    truncationPolicy: hp?.truncationPolicy ?? 'sliding_window',
    includeToolMessages: hp?.includeToolMessages ?? false,
  };
}

// ============================================================================
// Conversation load / store
// ============================================================================

/**
 * Load or create a conversation record for a step.
 */
export async function loadOrCreateConversation(
  payloadStore: PayloadStore,
  tenantId: string,
  runId: string,
  stepId: string,
  runtimeState?: SessionHotState['runtimeState'],
  policy?: HistoryPolicy,
): Promise<AiConversationRecord> {
  const historyVarKey = `ai.history.${stepId}`;
  const varEntry = runtimeState?.variables[historyVarKey] as
    | {
        ref?: { kind: string; value?: unknown; payloadRef?: string };
      }
    | undefined;

  // Try to load existing conversation
  if (varEntry?.ref?.kind === 'ref' && varEntry.ref.payloadRef) {
    try {
      const existing = (await payloadStore.retrieve(
        varEntry.ref.payloadRef,
      )) as AiConversationRecord;
      return existing;
    } catch {
      // Fall through to create new
    }
  }

  // Load from inline value
  if (varEntry?.ref?.kind === 'inline' && varEntry.ref.value) {
    return varEntry.ref.value as AiConversationRecord;
  }

  // Create new conversation
  const scope = policy?.scope ?? { kind: 'step' as const };
  const conversationKey = buildConversationKey(runId, stepId, scope);
  const params: Parameters<typeof createConversationRecord>[0] = {
    tenantId,
    runId,
    stepId,
    conversationKey,
  };
  if (policy) {
    params.policy = policy;
  }
  return createConversationRecord(params);
}

/**
 * Store a conversation record and update runtime state.
 * Returns updated runtimeState and the variable patch entries.
 */
export async function storeConversation(
  payloadStore: PayloadStore,
  record: AiConversationRecord,
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  stepId: string,
  stepExecutionId: string,
  nowMs: number,
): Promise<{
  updatedState: NonNullable<SessionHotState['runtimeState']>;
  patchEntries: Array<{ key: string; value: unknown }>;
}> {
  const historyVarKey = `ai.history.${stepId}`;

  // 'conversation', never 'history': the executor writes its atom batches under
  // 'history' for this same step execution, and payload paths are deterministic
  // per (stepExecutionId, attempt, kind).
  const historyRef = await payloadStore.store({
    tenantId: record.tenantId as TenantId,
    runId: record.runId as SessionId,
    stepExecutionId: stepExecutionId as StepExecutionId,
    attempt: 1,
    kind: 'conversation',
    data: record,
  });

  const stateValue = {
    ref: {
      kind: 'ref' as const,
      payloadRef: historyRef,
      contentType: 'application/json',
    },
    updatedAtMs: nowMs,
    updatedBy: { stepExecutionId, stepId, actor: 'orchestrator' as const },
    version:
      (typeof runtimeState.variables[historyVarKey] === 'object' &&
      runtimeState.variables[historyVarKey] !== null &&
      'version' in runtimeState.variables[historyVarKey] &&
      typeof (runtimeState.variables[historyVarKey] as Record<string, unknown>)['version'] ===
        'number'
        ? ((runtimeState.variables[historyVarKey] as Record<string, unknown>)['version'] as number)
        : 0) + 1,
  };

  const newVariables = { ...runtimeState.variables };
  newVariables[historyVarKey] = stateValue;

  return {
    updatedState: {
      ...runtimeState,
      variables: newVariables,
      version: runtimeState.version + 1,
      updatedAtMs: nowMs,
    },
    patchEntries: [{ key: historyVarKey, value: stateValue }],
  };
}

export { truncateHistory };
