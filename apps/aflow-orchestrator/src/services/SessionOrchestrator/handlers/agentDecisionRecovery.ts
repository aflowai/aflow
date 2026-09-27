import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  TraceId,
  AgentDefinition,
  StepDefinition,
} from '@aflow/schemas';
import { AGENT_DECISION_INVALID_CODE, resolveAgentPoliciesFromConfig } from '@aflow/schemas';
import type { SessionHotState, StepHotState } from '@aflow/redis';
import { updateSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import {
  parseOverlay,
  readInlineVar,
  serializeOverlay,
  writeInlineVar,
} from '../helpers/runtimeState.js';
import { waitForInput as stepServiceWaitForInput } from '../../StepService/index.js';
import { routeSessionPauseToSubscribers } from './pausedSessionRouting.js';
import type { RequiredVariable } from '../../StepService/index.js';
import type { ScheduleStepParams } from '../types.js';

/**
 * Consecutive invalid-decision retries an interactive agent gets before the
 * turn is escalated to an operator pause. Deliberately small and distinct from
 * the completion-contract budget (MAX_OUTPUT_CONTRACT_RETRIES) — an invalid
 * tool-args decision is a "guide it once or twice" event, not a long negotiation.
 */
export const MAX_INVALID_DECISION_RETRIES = 3;

const CHAT_INPUT_PREFIX = 'ai.agent.chatInput.';
const RETRY_VAR_PREFIX = 'ai.agent.invalidDecisionRetries.';

/** Does a FAILED agent-turn result carry the agent-fixable invalid-decision signal. */
export function isAgentDecisionInvalidFailure(
  error: { code?: string } | null | undefined,
): boolean {
  return error?.code === AGENT_DECISION_INVALID_CODE;
}

function extractToolName(details: unknown): string | undefined {
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const t = (details as Record<string, unknown>)['toolName'];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return undefined;
}

/**
 * An agent can turn an invalid-decision escalation into an operator pause only
 * if it is allowed to ask the user — the same signal that makes an assistant's
 * `complete` pause conversationally (assistant role) rather than hand off /
 * fail (subagent). Subagents (Runner, Coach) stay on their `onFailure` routing.
 */
function isInteractiveAgent(
  stepDef: StepDefinition,
  agentRoleOverride: 'assistant' | 'subagent' | undefined,
  trigger: string | undefined,
): boolean {
  const policies = resolveAgentPoliciesFromConfig(
    stepDef.config as Record<string, unknown> | undefined,
    { agentRoleOverride, trigger },
  );
  return policies.agentRole === 'assistant' && policies.requestInputPolicy !== 'never';
}

function buildRetryGuidance(toolName: string | undefined, reason: string, attempt: number): string {
  const toolClause = toolName ? ` to \`${toolName}\`` : '';
  return (
    `[INVALID TOOL CALL] Your previous tool call${toolClause} was rejected by the platform and was NOT executed:\n\n` +
    `${reason}\n\n` +
    'Call the tool again with every required argument populated to match its parameter schema, ' +
    'choose a different tool, or reply to the user. ' +
    `(attempt ${String(attempt)} of ${String(MAX_INVALID_DECISION_RETRIES)})`
  );
}

export type InvalidAgentDecisionRecovery = 'retried' | 'paused' | 'not_interactive';

export interface RecoverInvalidAgentDecisionArgs {
  redis: Redis;
  payloadStore: PayloadStore;
  db?: PostgresJsDatabase | undefined;
  result: {
    tenantId: string;
    sessionId: string;
    stepId: string;
    stepExecutionId: string;
    attempt: number;
    traceId: string;
  };
  /** The invalid-decision failure — `message` is the full, agent-legible reason. */
  error: { message: string; details?: unknown };
  /** Original step input, so the same turn is re-run verbatim on a guided retry. */
  inputRef: string;
  agentDef: AgentDefinition;
  stepDef: StepDefinition;
  currentRuntimeState: NonNullable<SessionHotState['runtimeState']>;
  agentRoleOverride?: 'assistant' | 'subagent';
  /** How the run started — an unattended agent takes no interactive recovery. */
  trigger?: string | undefined;
  scheduleStep: (params: ScheduleStepParams) => Promise<StepExecutionId>;
  now: number;
}

/**
 * Recover an `ai.agent.turn` step that FAILED with an agent-fixable invalid
 * decision (a tool-args schema violation the executor could not repair in-turn).
 *
 * Bounded, terminating-by-construction:
 *   invalid → (guided retry with the specific validation error)×N → operator pause.
 *
 * Each guided retry injects the exact validation reason as the agent's next
 * user message and increments a per-step counter that is durably persisted
 * BEFORE the turn is rescheduled — so the cap is always seen on the next turn
 * and the loop cannot exceed MAX_INVALID_DECISION_RETRIES. On the (N+1)th
 * invalid decision the turn is converted to an operator pause that waits for a
 * human message (no automatic re-dispatch), and the counter is cleared so an
 * operator-driven retry gets a fresh budget rather than an exhausted one.
 *
 * Non-interactive agents (subagents: Runner, Coach) are left untouched
 * (`'not_interactive'`) so the caller's existing `onFailure` routing runs.
 */
export async function recoverInvalidAgentDecision(
  args: RecoverInvalidAgentDecisionArgs,
): Promise<InvalidAgentDecisionRecovery> {
  const {
    redis,
    payloadStore,
    db,
    result,
    error,
    inputRef,
    agentDef,
    stepDef,
    currentRuntimeState,
    agentRoleOverride,
    scheduleStep,
    now,
  } = args;

  if (!isInteractiveAgent(stepDef, agentRoleOverride, args.trigger)) return 'not_interactive';

  const retryVarKey = `${RETRY_VAR_PREFIX}${result.stepId}`;
  const priorRetries = readInlineVar(currentRuntimeState, retryVarKey, 0);
  const newRetryCount = priorRetries + 1;
  const toolName = extractToolName(error.details);

  if (newRetryCount > MAX_INVALID_DECISION_RETRIES) {
    await pauseForOperatorGuidance({
      redis,
      payloadStore,
      ...(db !== undefined ? { db } : {}),
      result,
      error,
      toolName,
      agentDef,
      stepDef,
      currentRuntimeState,
      now,
    });
    return 'paused';
  }

  // Persist-or-abort: the guided-retry counter must be durable before the turn
  // is rescheduled, or the next turn re-reads a stale count, the cap is never
  // hit, and the agent loops. A persist failure therefore propagates (the
  // result consumer's safety net fails the run) instead of scheduling the turn.
  const vars = { ...currentRuntimeState.variables };
  writeInlineVar(
    vars,
    `${CHAT_INPUT_PREFIX}${result.stepId}`,
    buildRetryGuidance(toolName, error.message, newRetryCount),
    {
      nowMs: now,
      stepExecutionId: result.stepExecutionId,
      stepId: result.stepId,
    },
  );
  writeInlineVar(vars, retryVarKey, newRetryCount, {
    nowMs: now,
    stepExecutionId: result.stepExecutionId,
    stepId: result.stepId,
    version: newRetryCount,
  });

  await updateSessionState(redis, result.tenantId as TenantId, result.sessionId as SessionId, {
    runtimeState: {
      ...currentRuntimeState,
      variables: vars,
      version: currentRuntimeState.version + 1,
      updatedAtMs: now,
    },
  });

  await scheduleStep({
    context: {
      tenantId: result.tenantId as TenantId,
      runId: result.sessionId as SessionId,
      agentDefinition: agentDef,
      traceId: result.traceId as TraceId,
    },
    stepId: result.stepId as StepId,
    inputRef,
  });

  console.warn(
    `[agentDecisionRecovery] invalid agent decision for run ${result.sessionId}; ` +
      `guided retry ${String(newRetryCount)}/${String(MAX_INVALID_DECISION_RETRIES)}`,
  );
  return 'retried';
}

/**
 * Thin `applyResult` FAILED-path entry: recovers only an `ai.agent.turn` that
 * failed with the agent-fixable invalid-decision signal, and only for an
 * interactive agent. Returns `true` when the failure was handled (the caller
 * must return), `false` to fall through to the normal failure/`onFailure` path.
 */
export async function recoverFailedAgentDecision(params: {
  redis: Redis;
  payloadStore: PayloadStore;
  db?: PostgresJsDatabase | undefined;
  result: {
    tenantId: string;
    sessionId?: string | undefined;
    stepId: string;
    stepExecutionId: string;
    attempt: number;
    traceId: string;
    error?: { code?: string; message?: string; details?: unknown } | null | undefined;
  };
  stepDef: StepDefinition;
  agentDef: AgentDefinition;
  runState: Pick<SessionHotState, 'runtimeState' | 'agentRoleOverride' | 'trigger'>;
  stepState: Pick<StepHotState, 'inputRef'>;
  scheduleStep: (params: ScheduleStepParams) => Promise<StepExecutionId>;
  now: number;
}): Promise<boolean> {
  const { result, stepDef, runState, stepState, now } = params;
  if (stepDef.operation !== 'ai.agent.turn') return false;
  if (!result.sessionId) return false;
  if (!isAgentDecisionInvalidFailure(result.error)) return false;

  const recovery = await recoverInvalidAgentDecision({
    redis: params.redis,
    payloadStore: params.payloadStore,
    ...(params.db !== undefined ? { db: params.db } : {}),
    ...(runState.trigger !== undefined ? { trigger: runState.trigger } : {}),
    result: {
      tenantId: result.tenantId,
      sessionId: result.sessionId,
      stepId: result.stepId,
      stepExecutionId: result.stepExecutionId,
      attempt: result.attempt,
      traceId: result.traceId,
    },
    error: {
      message: result.error?.message ?? 'Agent decision was invalid.',
      ...(result.error?.details !== undefined ? { details: result.error.details } : {}),
    },
    inputRef: stepState.inputRef,
    agentDef: params.agentDef,
    stepDef,
    currentRuntimeState: runState.runtimeState ?? {
      schemaVersion: 1 as const,
      variables: {},
      version: 0,
      updatedAtMs: now,
    },
    ...(runState.agentRoleOverride ? { agentRoleOverride: runState.agentRoleOverride } : {}),
    scheduleStep: params.scheduleStep,
    now,
  });

  return recovery !== 'not_interactive';
}

async function pauseForOperatorGuidance(args: {
  redis: Redis;
  payloadStore: PayloadStore;
  db?: PostgresJsDatabase | undefined;
  result: RecoverInvalidAgentDecisionArgs['result'];
  error: { message: string };
  toolName: string | undefined;
  agentDef: AgentDefinition;
  stepDef: StepDefinition;
  currentRuntimeState: NonNullable<SessionHotState['runtimeState']>;
  now: number;
}): Promise<void> {
  const {
    redis,
    payloadStore,
    db,
    result,
    error,
    toolName,
    agentDef,
    stepDef,
    currentRuntimeState,
    now,
  } = args;

  const toolLabel = toolName ? `\`${toolName}\`` : 'the requested tool';
  const prompt =
    `I couldn't form a valid call to ${toolLabel} after ${String(MAX_INVALID_DECISION_RETRIES)} attempts: ` +
    `${error.message} How should I proceed?`;

  const chatVarId = `${CHAT_INPUT_PREFIX}${result.stepId}`;

  // Clear the counter (fresh budget for an operator-driven retry) and any stale
  // guidance message before pausing.
  const vars = { ...currentRuntimeState.variables };
  delete vars[`${RETRY_VAR_PREFIX}${result.stepId}`];
  delete vars[chatVarId];
  const resetRuntimeState = {
    ...currentRuntimeState,
    variables: vars,
    version: currentRuntimeState.version + 1,
    updatedAtMs: now,
  };

  const overlay = parseOverlay({});
  overlay[chatVarId] = {
    variableId: chatVarId,
    name: 'Message',
    description: 'Tell the assistant how to proceed',
    typeSchema: { type: 'string' },
    semanticType: 'text',
    lifecycle: { isInput: true, isOutput: false },
    required: true,
  };

  const requiredVars: RequiredVariable[] = [
    {
      variableId: chatVarId,
      name: 'Message',
      description: 'Tell the assistant how to proceed',
      required: true,
    },
  ];

  const operatorPause = await stepServiceWaitForInput(
    { redis, payloadStore },
    {
      tenantId: result.tenantId as TenantId,
      runId: result.sessionId as SessionId,
      agentDef,
      traceId: result.traceId as TraceId,
      stepDef,
      stepExecutionId: result.stepExecutionId as StepExecutionId,
      attempt: result.attempt,
      runState: {} as SessionHotState,
    },
    requiredVars,
    {
      prompt,
      stepStateUpdates: { status: 'PAUSED' as const, endedAt: now },
      runStateUpdates: { variableDefsOverlay: serializeOverlay(overlay) },
      runtimeState: resetRuntimeState,
      pauseType: 'invalid_decision',
    },
  );

  await routeSessionPauseToSubscribers(
    { redis, payloadStore, ...(db !== undefined ? { db } : {}) },
    {
      tenantId: result.tenantId,
      runId: result.sessionId,
      traceId: result.traceId,
      contractRef:
        operatorPause.kind === 'paused' ? (operatorPause.requestedInputRef ?? null) : null,
      pauseReason: prompt,
    },
  );

  console.warn(
    `[agentDecisionRecovery] retry budget exhausted for run ${result.sessionId}; ` +
      `paused for operator guidance`,
  );
}
