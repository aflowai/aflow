/**
 * Run-input pause helpers — state variable gating, requested input payload building,
 * agent chat input overlay, and pause-for-missing-variables orchestration.
 */
import type { Redis } from 'ioredis';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  IdempotencyKey,
  AgentDefinition,
  StepDefinition,
  SessionStatus,
  SessionAgentTarget,
} from '@aflow/schemas';
import type { SessionHotState, StepHotState, SessionEvent } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { atomicCreateSession } from '@aflow/redis';
import { buildRunCreatedRecoveryEvents } from './recoveryEmitter.js';
import {
  getEffectiveStateVariables,
  parseOverlay,
  type OverlayVariableDef,
} from './runtimeState.js';
import { generateEventId } from './ids.js';

/**
 * Filter unresolved state ref variable IDs to only those that are required.
 * Uses effective state variables (base + overlay) for lookup.
 */
export function filterRequiredUnresolved(
  unresolvedVarIds: string[],
  agentDef: AgentDefinition,
  runState?: { variableDefsOverlay?: string | undefined },
): string[] {
  const effectiveVars = getEffectiveStateVariables(agentDef, runState ?? {});
  return unresolvedVarIds.filter((varId) => {
    const varDef = effectiveVars.find((v) => v.variableId === varId);
    if (!varDef) return true;
    return varDef.required;
  });
}

export function buildRequestedInputPayload(
  stepId: string,
  missingVarIds: string[],
  agentDef: AgentDefinition,
  runState?: { variableDefsOverlay?: string | undefined },
  extraMeta?: Record<string, unknown>,
): Record<string, unknown> {
  const effectiveVars = getEffectiveStateVariables(agentDef, runState ?? {});
  const missingVariables = missingVarIds.map((varId) => {
    const varDef = effectiveVars.find((v) => v.variableId === varId);
    return {
      variableId: varId,
      ...(varDef?.name ? { name: varDef.name } : {}),
      ...(varDef?.description ? { description: varDef.description } : {}),
      ...(varDef?.typeSchema ? { typeSchema: varDef.typeSchema } : {}),
      ...(varDef?.semanticType ? { semanticType: varDef.semanticType } : {}),
      required: true,
    };
  });

  const varNames = missingVariables.map((v) => v.name ?? v.variableId).join(', ');

  const isSingleVar = missingVarIds.length === 1;
  const resumeContract = isSingleVar
    ? {
        reason: 'input_required' as const,
        mode: 'primary' as const,
        stepId,
        targetVariableId: missingVarIds[0],
        requiredFields: missingVariables,
        prompt: `Please provide: ${varNames}`,
      }
    : {
        reason: 'input_required' as const,
        mode: 'fields' as const,
        stepId,
        requiredFields: missingVariables,
        prompt: `Please provide: ${varNames}`,
      };

  return {
    reason: 'input_required',
    stepId,
    missingVariables, // legacy compat
    resumeContract,
    prompt: `Please provide: ${varNames}`,
    ...extraMeta,
  };
}

/**
 * Extract a user-facing message from parsed input for event metadata.
 * Uses effective state variables (base + overlay). Looks for the first
 * text-typed input variable that has a value in the input.
 */
export function extractUserMessageFromInput(
  parsedInput: Record<string, unknown> | undefined,
  agentDef: AgentDefinition,
  runState?: { variableDefsOverlay?: string | undefined },
): string | undefined {
  if (!parsedInput) return undefined;
  const effectiveVars = getEffectiveStateVariables(agentDef, runState ?? {});
  // Check all text-type input variables to find one that has a value in parsedInput
  for (const v of effectiveVars) {
    if (
      v.lifecycle.isInput &&
      (v.semanticType === 'text' ||
        v.semanticType === 'markdown' ||
        (v.semanticType as string | undefined) === undefined) &&
      typeof parsedInput[v.variableId] === 'string'
    ) {
      return parsedInput[v.variableId] as string;
    }
  }
  return undefined;
}

/**
 * Build the canonical agent chat input variable ID for a step.
 */
export function agentChatInputVarId(stepId: string): string {
  return `ai.agent.chatInput.${stepId}`;
}

/**
 * Build the overlay variable definition for agent chat input.
 */
export function buildAgentChatInputOverlayDef(stepId: string): OverlayVariableDef {
  return {
    variableId: agentChatInputVarId(stepId),
    name: 'Message',
    description: 'Your reply to the agent',
    typeSchema: { type: 'string' },
    semanticType: 'text',
    lifecycle: { isInput: true, isOutput: false },
    required: true,
  };
}

/**
 * Ensure the agent chat input overlay definition exists in the run state.
 * Returns the updated overlay (caller must persist).
 */
export function ensureAgentChatInputOverlay(
  runState: Pick<SessionHotState, 'variableDefsOverlay'>,
  stepId: string,
): Record<string, OverlayVariableDef> {
  const overlay = parseOverlay(runState);
  const varId = agentChatInputVarId(stepId);
  if (!overlay[varId]) {
    overlay[varId] = buildAgentChatInputOverlayDef(stepId);
  }
  return overlay;
}

/**
 * Seed an agent's turn-0 chat input with the configured prompt — but only when
 * the chat input is not already populated. A populated turn-0 chat input means
 * a caller has a pending message that MUST reach the model on this turn (guided
 * retry guidance after an invalid tool-args decision, or an operator's resume
 * reply), and turnNumber only advances on a valid decision — so the turn-0 seed
 * would otherwise clobber that message on every retry/resume and defeat it.
 * Returns the updated runtime state, or `undefined` when nothing was seeded.
 */
export function seedTurn0ChatInput(
  runtimeState: NonNullable<SessionHotState['runtimeState']>,
  promptText: string,
  stepId: string,
  now: number,
): NonNullable<SessionHotState['runtimeState']> | undefined {
  const chatVarId = agentChatInputVarId(stepId);
  const existing = runtimeState.variables[chatVarId] as
    { ref?: { kind?: string; value?: unknown } } | undefined;
  const alreadyPopulated =
    existing?.ref?.kind === 'inline' &&
    typeof existing.ref.value === 'string' &&
    existing.ref.value.length > 0;
  if (alreadyPopulated) return undefined;

  return {
    ...runtimeState,
    variables: {
      ...runtimeState.variables,
      [chatVarId]: {
        ref: { kind: 'inline' as const, value: promptText },
        updatedAtMs: now,
        updatedBy: { actor: 'orchestrator' as const, stepId },
        version: 1,
      },
    },
    version: runtimeState.version + 1,
    updatedAtMs: now,
  };
}

/**
 * Pause a run at start time because required state variables are missing.
 * Creates the run in PAUSED state with a requestedInputRef containing
 * the missing variable metadata.
 */
export async function pauseForMissingVariables(
  redis: Redis,
  _payloadStore: PayloadStore,
  tenantId: TenantId,
  runId: SessionId,
  stepExecutionId: StepExecutionId,
  startStepId: StepId,
  target: SessionAgentTarget,
  agentVersion: string,
  inputRef: string | undefined,
  createdBy: string | undefined,
  traceId: string | undefined,
  idempotencyKey: IdempotencyKey | undefined,
  stepDef: StepDefinition,
  runtimeState: SessionHotState['runtimeState'],
  requiredUnresolved: string[],
  agentDef: AgentDefinition,
  now: number,
  parsedInput: Record<string, unknown> | undefined,
  spaceId?: string,
  clientMessageId?: string,
  linkageCarryover?: Partial<
    Pick<
      SessionHotState,
      'parentSessionId' | 'parentStepExecutionId' | 'workflowExecution' | 'activatedByPerson'
    >
  >,
): Promise<{ runId: SessionId; status: SessionStatus; requestedInputRef: string }> {
  getOrchestratorLogger().debug(
    `[SessionOrchestrator] Start step ${startStepId} has unresolved required state vars: ${requiredUnresolved.join(', ')} — pausing run`,
  );

  const requestedInputPayload = buildRequestedInputPayload(
    startStepId,
    requiredUnresolved,
    agentDef,
  );
  const requestedInputRefStr = `inline:${Buffer.from(JSON.stringify(requestedInputPayload)).toString('base64')}`;

  const startUserMessage = extractUserMessageFromInput(parsedInput, agentDef);

  const pausedRunState: SessionHotState = {
    sessionId: runId,
    tenantId,
    target,
    agentVersion,
    status: 'PAUSED',
    currentStepId: startStepId,
    currentStepExecutionId: stepExecutionId,
    createdAt: now,
    startedAt: now,
    inputRef,
    pauseReason: 'input_required' as SessionHotState['pauseReason'],
    requestedInputRef: requestedInputRefStr,
    createdBy,
    traceId,
    idempotencyKey,
    ...(spaceId ? { spaceId } : {}),
    // Parent/workflow linkage from the QUEUED state. This write goes through
    // atomicCreateSession, which DELs the hash first — anything not carried in
    // this literal is destroyed, and a delegated child or workflow-task runner
    // that pauses here without its linkage is an orphan no reconcile can find.
    ...(linkageCarryover ?? {}),
    // The message that opens a room takes the first position in it, and starts
    // the conversation's activity clock. Pausing for a variable the starter did
    // not supply does not make it less of an opening message: without the clock
    // this conversation is absent from the list and from the metadata plane
    // until someone resumes it.
    ...(startUserMessage ? { lastMessageSeq: 1, lastActivityAt: now } : {}),
    lastUpdatedAt: now,
    runtimeState,
  };

  const pausedStepState: StepHotState = {
    stepExecutionId,
    tenantId,
    sessionId: runId,
    stepId: startStepId,
    stepType: stepDef.stepType,
    operationId: stepDef.operation,
    attempt: 1,
    status: 'PAUSED' as StepHotState['status'],
    scheduledAt: now,
    inputRef: inputRef ?? '',
    idempotencyKey: `${runId}:${stepExecutionId}:1` as IdempotencyKey,
    traceId,
  };

  const startEvent: SessionEvent = {
    eventId: generateEventId(),
    eventType: 'SessionStarted',
    timestamp: now,
    sessionId: runId,
    metadata: {
      target,
      agentVersion,
      inputRef,
      ...(startUserMessage ? { userMessage: startUserMessage, messageSeq: 1 } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    },
  };

  const pauseEvent: SessionEvent = {
    eventId: generateEventId(),
    eventType: 'SessionPaused',
    timestamp: now,
    sessionId: runId,
    stepId: startStepId,
    stepExecutionId,
    stepType: stepDef.stepType,
    attempt: 1,
    requestedInputRef: requestedInputRefStr,
    metadata: {
      pauseReason: 'input_required',
      // Emit structured missingVariables so the web UI can resume by variableId.
      missingVariables: requestedInputPayload['missingVariables'],
      prompt: requestedInputPayload['prompt'] as string,
    },
  };

  // Build recovery events for the paused-at-creation run
  const recoveryEvents = await buildRunCreatedRecoveryEvents(
    redis,
    pausedRunState,
    pausedStepState,
  );

  await atomicCreateSession(
    redis,
    pausedRunState,
    pausedStepState,
    startEvent,
    pauseEvent,
    undefined,
    recoveryEvents,
  );

  return { runId, status: 'PAUSED' as SessionStatus, requestedInputRef: requestedInputRefStr };
}
