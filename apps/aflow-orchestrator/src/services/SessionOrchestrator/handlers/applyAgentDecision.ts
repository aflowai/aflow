/**
 * Agent turn decision handler (state-variable-first architecture)
 *
 * Processes the output of an ai.agent_turn step. The agent's decision drives
 * one of four outcomes:
 *   - complete        → pause for input (assistant); subagent: hand off to the
 *                       graph's completion successor, else finish the run
 *   - pause_for_input → pause (unified: input_required + missingVariables)
 *   - invoke_step     → schedule a single tool step
 *   - invoke_steps    → schedule multiple tool steps in parallel
 *
 * All pauses use the canonical `input_required` mechanism with
 * `missingVariables: ["ai.agent.chatInput.<stepId>"]`.
 *
 * After every decision, `ai.agent.chatInput.<stepId>` is cleared from
 * runtime state so tool-result-only turns do not replay stale input.
 *
 * Returns true if the decision was handled (caller should return), false to
 * fall through to normal step processing.
 */
import type { Redis } from 'ioredis';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  StepType,
  OperationId,
  TraceId,
  AgentDefinition,
  StepDefinition,
  AgentTurnDecision,
  AgentTurnOutput,
  AgentRole,
  RequestInputPolicy,
  CompletionPolicy,
  StepUsageBreakdown,
} from '@aflow/schemas';
import {
  AgentTurnOutputSchema,
  DECISION_MESSAGE_MAX,
  DECISION_REASONING_MAX,
  resolveAgentPoliciesFromConfig,
} from '@aflow/schemas';
import type { SessionHotState, StepHotState, SessionEvent } from '@aflow/redis';
import { updateSessionState, atomicCompleteStep, registerBarrierWatchdog } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { routeRunnerTerminalToHarness } from '../../cybernetic/WorkflowRunHarness.js';
import { pauseForGuardrailEscalation } from './guardrailEscalationPause.js';
import { clearStaleCredentialBlock } from './credentialBlockScope.js';
import { buildStepCompletedRecoveryEvents } from '../helpers/recoveryEmitter.js';
import type { ScheduleStepParams } from '../types.js';
import type { GuardrailGate } from '../../GuardrailGate/index.js';
import {
  accumulateUsageSummary,
  getVariableVersion,
  parseOverlay,
  serializeOverlay,
  buildOutputVariables,
  readInlineVar,
  writeInlineVar,
} from '../helpers/runtimeState.js';
import {
  waitForInput as stepServiceWaitForInput,
  completeStep as stepServiceCompleteStep,
  failStep as stepServiceFailStep,
} from '../../StepService/index.js';
import type { RequiredVariable } from '../../StepService/index.js';
import { createMessage } from '@aflow/schemas';
import { loadOrCreateConversation, storeConversation } from '../helpers/aiHistory.js';
import { getClearedDelegationStatePatch } from '../helpers/delegationState.js';
import {
  enqueuePendingAndReconcile,
  isDelegationUpsertFailure,
} from './enqueueDelegationCompletion.js';
import { maybeFailWorkflowRunnerComplete } from './workflowRunnerCompleteValidation.js';
import {
  completionContinuationEdges,
  decodeStringifiedCompletionResult,
  rescheduleMalformedCompletionResult,
  resolveCompletionSuccessor,
} from './completionResultContract.js';

/**
 * A step id carrying a name this platform did not choose.
 *
 * `StepId` is lowercase letters, digits, `_` and `-`. A tool's name comes from
 * whoever wrote the server — camel case, a space, a slash are all ordinary
 * there — so interpolating it produces an id the schema rejects, and the
 * agent's call cannot be scheduled at all. Replacing only dots covered the
 * names that happened to be seen first.
 */
function stepIdSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export { resolveCompletionSuccessor } from './completionResultContract.js';
import { applyStepSucceeded } from './applyStepSucceeded.js';
import { persistToolCallIdByStepExecutionMap } from '../helpers/resolveToolCallId.js';
import { TOOL_SURFACE_VAR } from '../helpers/agentTurn.js';
import { PINNED_CONNECTION_TOOLS_VAR } from '../helpers/pinnedConnectionTools.js';
import { LOCAL_MCP_TOOLS_VAR } from '../helpers/turnToolSurface.js';
import { normalizeDecisionForRole } from './decisionRoleNormalization.js';
import {
  buildAppletActInput,
  buildLoweredAppletStep,
  findCachedAppletToolSpec,
} from '../helpers/appletToolMapper.js';
import { persistDynamicStep } from '../helpers/dynamicSteps.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

function evtId(): string {
  return crypto.randomUUID();
}

function agentChatInputVarId(stepId: string): string {
  return `ai.agent.chatInput.${stepId}`;
}

function makeStepSucceededEvent(
  result: ApplyAgentDecisionParams['result'],
  stepDef: StepDefinition | undefined,
  runtimeStatePatch?: SessionEvent['runtimeStatePatch'],
  extraMeta?: Record<string, unknown>,
  stepUsage?: StepUsageBreakdown,
): SessionEvent {
  return {
    eventId: evtId(),
    eventType: 'StepSucceeded',
    timestamp: result.nowMs,
    sessionId: result.sessionId,
    stepId: result.stepId,
    stepExecutionId: result.stepExecutionId,
    stepType: result.stepType,
    attempt: result.attempt,
    outputRef: result.outputRef ?? undefined,
    runtimeStatePatch,
    usage: stepUsage,
    metadata: {
      stepName: stepDef?.name ?? result.stepId,
      operationId: stepDef?.operation ?? result.operationId,
      ...extraMeta,
    },
  };
}

/**
 * Arguments a tool requires to DIFFER on every call, so that a replay can be
 * told from a fresh attempt. They are the opposite of identity: including them
 * in the loop signature makes every repeat look novel.
 *
 * A Runner sent the identical draft_patch 130 times, each with a fresh
 * `mutationId`, and the repeat detector counted one consecutive call every
 * time. Extend this set when a new op adds a replay key.
 */
const REPLAY_KEY_ARG_NAMES: ReadonlySet<string> = new Set(['mutationId']);

function withoutReplayKeys(args: unknown): Record<string, unknown> {
  const record = (args as Record<string, unknown> | undefined) ?? {};
  const entries = Object.entries(record).filter(([k]) => !REPLAY_KEY_ARG_NAMES.has(k));
  return Object.fromEntries(entries);
}

/** What the loop detector compares one turn's tool calls against the last. */
export function buildCallSignature(
  calls: ReadonlyArray<{ toolId: string; args?: unknown }>,
): string {
  return calls
    .map((c) => `${c.toolId}:${JSON.stringify(withoutReplayKeys(c.args))}`)
    .sort()
    .join('|');
}

function fallbackStepDef(result: ApplyAgentDecisionParams['result']): StepDefinition {
  return {
    stepId: result.stepId as StepId,
    stepType: result.stepType,
    operation: result.operationId,
    name: result.stepId,
    config: {},
    tags: [],
    optional: false,
    onSuccess: { next: [] },
    onFailure: { next: [] },
  } as unknown as StepDefinition;
}

/**
 * A graph step is "terminal-on-success" when its onSuccess routing has no
 * next steps. The Runner's `submit_output` is the canonical example: success
 * ends the Runner branch, so an agent-turn parallel barrier on this call
 * would never be decremented (no return to the agent step) and would orphan
 * until the watchdog/sweeper rescued it.
 *
 * Virtual tools (synthetic steps not yet pushed into agentDef.steps) are
 * always constructed to route back to the agent — treat them as non-terminal.
 *
 * Exported for unit testing.
 */
export function isTerminalOnSuccessGraphTool(toolId: string, agentDef: AgentDefinition): boolean {
  const toolStepDef = agentDef.steps.find((s) => s.stepId === toolId);
  if (!toolStepDef) return false;
  return toolStepDef.onSuccess.next.length === 0;
}

/**
 * A call is barrier-tracked iff its tool, on success, routes back to the
 * agent step. Virtual tools always route back; graph tools whose onSuccess
 * is empty (terminal) do not.
 *
 * Exported for unit testing.
 */
export function tracksBarrierForAgentReturn(
  toolId: string,
  agentDef: AgentDefinition,
  agentStepId: string,
): boolean {
  const toolStepDef = agentDef.steps.find((s) => s.stepId === toolId);
  if (!toolStepDef) {
    return true;
  }
  return toolStepDef.onSuccess.next.some((n) => n.stepId === agentStepId);
}

/**
 * Validate that `invoke_steps` does not include any terminal-on-success
 * graph tool. A terminal tool ends the agent branch on success, so it
 * cannot share a parallel barrier with siblings — the parent agent would
 * never observe its result, and the barrier would orphan.
 *
 * Returns `null` if the call set is valid; otherwise returns a descriptive
 * error message naming the offending tool ids.
 *
 * Exported for unit testing.
 */
export function validateNoTerminalToolsInParallel(
  calls: ReadonlyArray<{ toolId: string }>,
  agentDef: AgentDefinition,
): string | null {
  const terminal = calls.filter((c) => isTerminalOnSuccessGraphTool(c.toolId, agentDef));
  if (terminal.length === 0) return null;
  const ids = terminal.map((c) => c.toolId).join(', ');
  return (
    `Terminal graph tool(s) [${ids}] cannot be invoked via invoke_steps; ` +
    `they end the agent branch on success and must be called exclusively via invoke_step.`
  );
}

// ── Parameter types ───────────────────────────────────────────────────────────

export interface ApplyAgentDecisionParams {
  redis: Redis;
  payloadStore: PayloadStore;
  db?: PostgresJsDatabase;
  result: {
    tenantId: string;
    sessionId: string;
    stepId: string;
    stepExecutionId: string;
    stepType: string;
    operationId: string;
    attempt: number;
    outputRef: string | null | undefined;
    traceId: string;
    nowMs: number;
    usage?: StepUsageBreakdown | null | undefined;
  };
  runHotState: SessionHotState;
  stepDef: StepDefinition | undefined;
  stepState: StepHotState;
  agentDef: AgentDefinition;
  stepUpdates: Partial<StepHotState> & { stepExecutionId: string };
  currentRuntimeState: NonNullable<SessionHotState['runtimeState']>;
  scheduleStep: (params: ScheduleStepParams) => Promise<StepExecutionId>;
  guardrailGate?: GuardrailGate;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function applyAgentDecision(params: ApplyAgentDecisionParams): Promise<boolean> {
  const {
    redis,
    payloadStore,
    db,
    result,
    runHotState,
    stepDef,
    stepState,
    agentDef,
    stepUpdates,
    scheduleStep,
    guardrailGate,
  } = params;

  let { currentRuntimeState } = params;
  const now = result.nowMs;

  const stepUsage: StepUsageBreakdown | undefined = result.usage ?? undefined;

  const updatedUsageSummary = accumulateUsageSummary(runHotState.usageSummary, stepUsage);

  if (!result.outputRef) return false;

  let agentOutput: AgentTurnOutput;
  let decision: AgentTurnDecision;
  try {
    let raw = await payloadStore.retrieve(result.outputRef);
    // Gracefully truncate display-only string fields before validation so an
    // over-limit message from the model doesn't crash the entire result pipeline.
    if (raw && typeof raw === 'object' && 'decision' in raw) {
      const d = (raw as Record<string, unknown>)['decision'];
      if (d && typeof d === 'object') {
        const dec = d as Record<string, unknown>;
        const SUFFIX = '\n…(truncated)';
        const clip = (v: unknown, max: number): string | null =>
          typeof v === 'string' && v.length > max ? v.slice(0, max - SUFFIX.length) + SUFFIX : null;
        const msg = clip(dec['message'], DECISION_MESSAGE_MAX);
        const rsn = clip(dec['reasoning'], DECISION_REASONING_MAX);
        if (msg !== null || rsn !== null) {
          const patched = { ...dec };
          if (msg !== null) patched['message'] = msg;
          if (rsn !== null) patched['reasoning'] = rsn;
          raw = { ...(raw as Record<string, unknown>), decision: patched };
        }
      }
    }
    agentOutput = AgentTurnOutputSchema.parse(raw);
    decision = agentOutput.decision;
  } catch (err) {
    logOrchestratorError(`[SessionOrchestrator] Failed to read agent turn output:`, err, {
      tenantId: result.tenantId,
      sessionId: result.sessionId,
      stepExecutionId: result.stepExecutionId,
    });
    return false;
  }

  const agentRoleConfig = resolveAgentPoliciesFromStep(
    stepDef,
    agentOutput,
    runHotState.agentRoleOverride,
    runHotState.trigger,
  );
  const normalizedDecision = normalizeDecisionForRole({
    decision,
    requestInputPolicy: agentRoleConfig.requestInputPolicy,
    completionPolicy: agentRoleConfig.completionPolicy,
    agentDef,
    agentStepId: result.stepId,
    runState: runHotState,
  });
  if (decision.action === 'pause_for_input' && normalizedDecision.action !== 'pause_for_input') {
    console.warn(
      `[applyAgentDecision] Converted forbidden pause_for_input into ${normalizedDecision.action} for run ${result.sessionId}`,
    );
  }
  decision = normalizedDecision;
  const roleValidationError = validateDecisionForRole(decision, agentRoleConfig);
  if (roleValidationError) {
    logOrchestratorError(
      `[applyAgentDecision] Role validation failed for run ${result.sessionId}: ${roleValidationError}`,
      new Error(roleValidationError),
      { tenantId: result.tenantId, sessionId: result.sessionId },
    );
    // For missing blockingReason: log warning but allow (soft enforcement in v1)
    // For fatal violations: fail the step
    if (roleValidationError.startsWith('FATAL:')) {
      throw new Error(roleValidationError.slice(6).trim());
    }
    // Non-fatal: log and continue
    console.warn(`[applyAgentDecision] Role validation warning: ${roleValidationError}`);
  }

  // ── Guardrail: on_agent_turn_output ──────────────────────────────────────
  if (guardrailGate && (decision.action === 'invoke_step' || decision.action === 'invoke_steps')) {
    const gr = await guardrailGate.check('on_agent_turn_output', decision, {
      tenantId: result.tenantId,
      runId: result.sessionId,
      target: runHotState.target,
      stepExecutionId: result.stepExecutionId,
    });
    if (!gr.passed) {
      if (gr.action === 'block') {
        const { GuardrailBlockedError } = await import('../../GuardrailGate/index.js');
        throw new GuardrailBlockedError(gr.violations);
      }

      if (gr.action === 'retry') {
        // block_with_retry: append feedback to agent history, re-schedule turn
        const MAX_GUARDRAIL_RETRIES = 2;
        const retryCountKey = `ai.agent.guardrailRetryCount.${result.stepId}`;
        const retryCount = readInlineVar(currentRuntimeState, retryCountKey, 0 as number);

        if (retryCount >= MAX_GUARDRAIL_RETRIES) {
          // Max retries exceeded — escalate to human
          console.warn(
            `[applyAgentDecision] Guardrail retry limit (${String(MAX_GUARDRAIL_RETRIES)}) exceeded ` +
              `for run ${result.sessionId} — escalating to human`,
          );
          // Fall through to escalate handling below
        } else {
          // Append guardrail feedback to agent history and re-schedule turn
          const violationMessages = gr.violations
            .map((v) => v.message ?? `${v.type}: ${v.railId}`)
            .join('; ');
          const feedbackText =
            `[GUARDRAIL VIOLATION] Your last action was blocked: ${violationMessages}. ` +
            `Please choose a different approach that complies with the policy.`;

          try {
            const conversation = await loadOrCreateConversation(
              payloadStore,
              result.tenantId,
              result.sessionId,
              result.stepId,
              currentRuntimeState,
            );
            conversation.messages.push(createMessage('system', feedbackText));
            conversation.updatedAtMs = now;

            const historyResult = await storeConversation(
              payloadStore,
              conversation,
              currentRuntimeState,
              result.stepId,
              result.stepExecutionId,
              now,
            );
            currentRuntimeState = historyResult.updatedState;
          } catch (err) {
            logOrchestratorError(
              `[applyAgentDecision] Failed to append guardrail feedback to history:`,
              err,
              { tenantId: result.tenantId, sessionId: result.sessionId },
            );
          }

          // Update retry count in runtime state
          const retryVars = { ...currentRuntimeState.variables };
          writeInlineVar(retryVars, retryCountKey, retryCount + 1, {
            nowMs: now,
            stepExecutionId: result.stepExecutionId,
            stepId: result.stepId,
            version: retryCount + 1,
          });
          currentRuntimeState = {
            ...currentRuntimeState,
            variables: retryVars,
            version: currentRuntimeState.version + 1,
            updatedAtMs: now,
          };
          await updateSessionState(
            redis,
            result.tenantId as TenantId,
            result.sessionId as SessionId,
            {
              runtimeState: currentRuntimeState,
              usageSummary: updatedUsageSummary,
            },
          );

          // Re-schedule the agent turn
          await scheduleStep({
            context: {
              tenantId: result.tenantId as TenantId,
              runId: result.sessionId as SessionId,
              agentDefinition: agentDef,
              traceId: result.traceId as TraceId,
            },
            stepId: result.stepId as StepId,
            inputRef: result.outputRef,
          });

          return true;
        }
      }

      // escalate: pause the run for human review (also reached when retry limit exceeded)
      if (gr.action === 'escalate' || gr.action === 'retry') {
        await pauseForGuardrailEscalation({
          redis,
          payloadStore,
          result,
          gr,
          agentDef,
          stepDef: stepDef ?? fallbackStepDef(result),
          runHotState,
          currentRuntimeState,
          now,
        });
        return true;
      }
    }
  }

  await clearStaleCredentialBlock(redis, result, runHotState, decision, agentDef);

  // ── Update turn tracking in runtime state ─────────────────────────────────

  const turnVarKey = `ai.agent.turnNumber.${result.stepId}`;
  const callsVarKey = `ai.agent.totalCalls.${result.stepId}`;
  const tokensVarKey = `ai.agent.totalTokens.${result.stepId}`;
  const turnNumber = agentOutput.turnNumber + 1;
  const varMeta = { nowMs: now, stepExecutionId: result.stepExecutionId, stepId: result.stepId };

  let totalCalls = readInlineVar(currentRuntimeState, callsVarKey, 0);
  if (decision.action === 'invoke_step') totalCalls += 1;
  if (decision.action === 'invoke_steps') totalCalls += decision.calls.length;

  const prevTokens = readInlineVar(currentRuntimeState, tokensVarKey, 0);
  const turnTokens = agentOutput.usage.totalTokens;
  const totalTokens = prevTokens + turnTokens;

  // Clear consumed chat input so tool-result-only turns don't replay stale input
  const chatInputKey = agentChatInputVarId(result.stepId);
  const newVariables = { ...currentRuntimeState.variables };
  delete newVariables[chatInputKey];

  const interruptVarKey = `ai.agent.wasInterrupted.${result.stepId}`;
  delete newVariables[interruptVarKey];

  // A valid decision clears the invalid-decision retry budget (agentDecisionRecovery),
  // so a later malformed decision starts fresh rather than instantly exhausted.
  delete newVariables[`ai.agent.invalidDecisionRetries.${result.stepId}`];

  writeInlineVar(newVariables, turnVarKey, turnNumber, { ...varMeta, version: turnNumber });
  writeInlineVar(newVariables, callsVarKey, totalCalls, { ...varMeta, version: totalCalls });
  writeInlineVar(newVariables, tokensVarKey, totalTokens, { ...varMeta, version: turnNumber });
  writeInlineVar(newVariables, `ai.agent.lastTurnCompletedAtMs.${result.stepId}`, now, {
    ...varMeta,
    version: turnNumber,
  });

  if (decision.message) {
    const msgVarKey = `chat.assistant_message`;
    writeInlineVar(newVariables, msgVarKey, decision.message, {
      ...varMeta,
      version: getVariableVersion(currentRuntimeState.variables[msgVarKey]) + 1,
    });
  }

  currentRuntimeState = {
    ...currentRuntimeState,
    variables: newVariables,
    version: currentRuntimeState.version + 1,
    updatedAtMs: now,
  };

  const budgetHints = stepDef?.config['turnPolicy'] as
    | {
        budgetHints?: {
          maxTotalTurns?: number;
          maxTotalToolCalls?: number;
          maxTotalTokens?: number;
        };
      }
    | undefined;
  const maxTurns = budgetHints?.budgetHints?.maxTotalTurns;
  const maxCalls = budgetHints?.budgetHints?.maxTotalToolCalls;
  const maxTokens = budgetHints?.budgetHints?.maxTotalTokens;

  let budgetExceededReason: string | undefined;
  if (maxTurns && turnNumber >= maxTurns) {
    budgetExceededReason = `Turn budget exceeded: ${String(turnNumber)} turns used (limit: ${String(maxTurns)}).`;
  } else if (maxCalls && totalCalls >= maxCalls) {
    budgetExceededReason = `Tool call budget exceeded: ${String(totalCalls)} calls made (limit: ${String(maxCalls)}).`;
  } else if (maxTokens && totalTokens >= maxTokens) {
    budgetExceededReason = `Token budget exceeded: ${String(totalTokens)} tokens used (limit: ${String(maxTokens)}).`;
  }

  if (budgetExceededReason) {
    // Override the agent's decision — force a pause regardless of what the agent wanted
    console.warn(
      `[applyAgentDecision] Budget exceeded for run ${result.sessionId}: ${budgetExceededReason}`,
    );

    const budgetMessage =
      (decision.message ? `${decision.message}\n\n` : '') +
      `⚠️ ${budgetExceededReason} The agent has been paused. ` +
      `You can reply to continue (the budget is a soft limit).`;

    const overlay = parseOverlay({});
    const chatVarId = agentChatInputVarId(result.stepId);
    if (!overlay[chatVarId]) {
      overlay[chatVarId] = {
        variableId: chatVarId,
        name: 'Message',
        description: 'Continue the agent after budget exceeded',
        typeSchema: { type: 'string' },
        semanticType: 'text',
        lifecycle: { isInput: true, isOutput: false },
        required: true,
      };
    }

    const budgetEvent = makeStepSucceededEvent(
      result,
      stepDef,
      undefined,
      {
        agentAction: decision.action,
        budgetExceeded: true,
        budgetExceededReason,
        ...(stepUsage ? { costJson: stepUsage } : {}),
      },
      stepUsage,
    );

    await stepServiceWaitForInput(
      { redis, payloadStore },
      {
        tenantId: result.tenantId as TenantId,
        runId: result.sessionId as SessionId,
        agentDef,
        traceId: result.traceId as TraceId,
        stepDef: stepDef ?? fallbackStepDef(result),
        stepExecutionId: result.stepExecutionId as StepExecutionId,
        attempt: result.attempt,
        runState: runHotState,
      },
      [
        {
          variableId: chatVarId,
          name: 'Message',
          description: budgetExceededReason,
          required: true,
        },
      ],
      {
        prompt: budgetMessage,
        stepStateUpdates: {
          status: 'PAUSED' as const,
          endedAt: now,
          ...(result.outputRef ? { outputRef: result.outputRef } : {}),
        },
        runStateUpdates: {
          variableDefsOverlay: serializeOverlay(overlay),
        },
        runtimeState: currentRuntimeState,
        additionalEvents: [budgetEvent],
        pauseType: 'budget_exceeded',
      },
    );

    return true;
  }

  // ── complete ───────────────────────────────────────────────────────────────
  // Two modes:
  // - assistant: pause for user to continue or stop (existing behavior)

  if (decision.action === 'complete') {
    const handled = await maybeFailWorkflowRunnerComplete({
      redis,
      payloadStore,
      result,
      agentDef,
      runtimeState: currentRuntimeState,
      runHotState,
      agentRoleConfig,
      decision,
      now,
      scheduleStep,
      stepDef: stepDef ?? fallbackStepDef(result),
    });
    if (handled !== null) return true;

    const completionSuccessorId =
      agentRoleConfig.agentRole === 'subagent'
        ? resolveCompletionSuccessor(stepDef, agentDef, agentRoleConfig.completionPolicy)
        : null;

    // A contract-bound completion feeds a structured successor input. A model
    // that stringifies the result object is decoded here; a string that is
    // not a JSON container loops back with teaching feedback instead of
    // persisting a payload the successor's input schema rejects.
    let completionResult = decision.result;
    if (completionSuccessorId !== null && typeof completionResult === 'string') {
      const decoded = decodeStringifiedCompletionResult(completionResult);
      if (decoded === undefined) {
        return await rescheduleMalformedCompletionResult({
          redis,
          payloadStore,
          result,
          outputRef: result.outputRef,
          agentDef,
          stepDef: stepDef ?? fallbackStepDef(result),
          currentRuntimeState,
          updatedUsageSummary,
          scheduleStep,
          now,
        });
      }
      completionResult = decoded;
    }

    // Store the result in runtime state
    let finalOutputRef: string | undefined;
    if (completionResult !== undefined) {
      const resultRef = await payloadStore.store({
        tenantId: result.tenantId as TenantId,
        runId: result.sessionId as SessionId,
        stepExecutionId: result.stepExecutionId as StepExecutionId,
        attempt: result.attempt,
        kind: 'state_variable',
        data: completionResult,
      });
      finalOutputRef = resultRef;
      currentRuntimeState = {
        ...currentRuntimeState,
        variables: {
          ...currentRuntimeState.variables,
          result: {
            ref: { kind: 'ref', payloadRef: resultRef },
            updatedAtMs: now,
            updatedBy: {
              stepExecutionId: result.stepExecutionId,
              stepId: result.stepId,
              actor: 'orchestrator',
            },
            version: 1,
          },
        },
      };
    }

    if (agentRoleConfig.agentRole === 'subagent') {
      // A contract-bound completion hands off to the graph's completion
      // successor (e.g. an outcome-validation step) through the normal
      // step-success path — the session stays alive until the graph ends.
      if (completionSuccessorId !== null && stepDef !== undefined) {
        // applyStepSucceeded re-resolves routing from agentDef over the raw
        // edge list, so both defs must carry the continuation-only edge view —
        // otherwise a higher-priority tool edge could win the re-resolution
        // and diverge from the resolved successor.
        const routedStepDef: StepDefinition = {
          ...stepDef,
          onSuccess: { next: completionContinuationEdges(stepDef, agentDef) },
        };
        const routedAgentDef: AgentDefinition = {
          ...agentDef,
          steps: agentDef.steps.map((s) => (s.stepId === stepDef.stepId ? routedStepDef : s)),
        };
        await applyStepSucceeded({
          redis,
          payloadStore,
          ...(db !== undefined ? { db } : {}),
          result: { ...result, outputRef: finalOutputRef ?? result.outputRef },
          runHotState,
          stepDef: routedStepDef,
          stepState,
          agentDef: routedAgentDef,
          stepUpdates,
          currentRuntimeState,
          scheduleStep,
          ...(guardrailGate ? { guardrailGate } : {}),
        });
        return true;
      }

      const outputVariables = buildOutputVariables(currentRuntimeState, agentDef);

      const stepSucceededEvent: SessionEvent = {
        eventId: evtId(),
        eventType: 'StepSucceeded',
        timestamp: now,
        sessionId: result.sessionId,
        stepId: result.stepId,
        stepExecutionId: result.stepExecutionId,
        stepType: result.stepType,
        attempt: result.attempt,
        outputRef: finalOutputRef ?? result.outputRef,
        usage: stepUsage,
        metadata: {
          stepName: stepDef?.name ?? result.stepId,
          operationId: stepDef?.operation ?? result.operationId,
          agentAction: 'complete',
          agentRole: 'subagent',
          ...(stepUsage ? { costJson: stepUsage } : {}),
        },
      };

      const flowSucceededEvent: SessionEvent = {
        eventId: evtId(),
        eventType: 'SessionCompleted',
        timestamp: now,
        sessionId: result.sessionId,
        stepId: result.stepId,
        stepExecutionId: result.stepExecutionId,
        outputRef: finalOutputRef ?? result.outputRef,
        outputVariables: outputVariables.length > 0 ? outputVariables : undefined,
        usageSummary: updatedUsageSummary,
        metadata: {
          stepName: stepDef?.name ?? result.stepId,
          operationId: stepDef?.operation ?? result.operationId,
          agentRole: 'subagent',
          ...(decision.message ? { agentMessage: decision.message } : {}),
        },
      };

      const runUpdates: Partial<SessionHotState> & { sessionId: string } = {
        sessionId: result.sessionId,
        status: 'SUCCEEDED',
        endedAt: now,
        finalOutputRef: finalOutputRef ?? result.outputRef,
        runtimeState: currentRuntimeState,
        usageSummary: updatedUsageSummary,
        ...getClearedDelegationStatePatch(),
      };

      // Build recovery events for subagent completion + run succeeded
      const subagentRecoveryEvents = await buildStepCompletedRecoveryEvents(
        redis,
        result.tenantId,
        result.sessionId,
        result.stepExecutionId,
        'SUCCEEDED',
        { outputRef: finalOutputRef ?? result.outputRef },
        { from: 'RUNNING', to: 'SUCCEEDED' },
      );

      await atomicCompleteStep(
        redis,
        result.tenantId,
        stepUpdates,
        runUpdates,
        [stepSucceededEvent, flowSucceededEvent],
        undefined,
        subagentRecoveryEvents,
      );

      try {
        const { forwardEventToParent } = await import('./forwardChildEvent.js');
        // Forward StepSucceeded first (carries outputRef + usage for unified timeline)
        await forwardEventToParent(redis, result.tenantId, result.sessionId, stepSucceededEvent);
        await forwardEventToParent(redis, result.tenantId, result.sessionId, flowSucceededEvent);
      } catch {
        // Best-effort forwarding
      }

      if (decision.message) {
        try {
          const { forwardEventToParent } = await import('./forwardChildEvent.js');
          const agentMsgEvent: SessionEvent = {
            eventId: evtId(),
            eventType: 'StepSucceeded',
            timestamp: now,
            sessionId: result.sessionId,
            stepId: result.stepId,
            stepExecutionId: result.stepExecutionId,
            stepType: result.stepType,
            attempt: result.attempt,
            metadata: { agentMessage: decision.message },
          };
          await forwardEventToParent(redis, result.tenantId, result.sessionId, agentMsgEvent);
        } catch {
          // Best-effort
        }
      }

      if (runHotState.workflowExecution !== undefined && db !== undefined) {
        try {
          await routeRunnerTerminalToHarness(
            { db, redis, payloadStore },
            {
              tenantId: result.tenantId,
              traceId: result.traceId,
              workflowExecution: runHotState.workflowExecution,
            },
            'SUCCEEDED',
            { outputRef: finalOutputRef ?? result.outputRef },
          );
        } catch (harnessErr) {
          logOrchestratorError(
            `[applyAgentDecision] Runner-terminal harness route failed for ${result.sessionId}:`,
            harnessErr,
            {
              tenantId: result.tenantId,
              sessionId: result.sessionId,
              workflowExecution: runHotState.workflowExecution,
            },
          );
        }
        return true;
      }

      try {
        await enqueuePendingAndReconcile({
          redis,
          payloadStore,
          tenantId: result.tenantId,
          childRunId: result.sessionId,
          reason: 'applyAgentDecision:subagent_complete',
        });
      } catch (resumeErr) {
        if (isDelegationUpsertFailure(resumeErr)) throw resumeErr;
        logOrchestratorError(
          `[applyAgentDecision] Failed to resume parent after subagent ${result.sessionId} completed:`,
          resumeErr,
          { tenantId: result.tenantId, sessionId: result.sessionId },
        );
      }

      return true;
    }

    // ── Assistant complete: fall through to unified pause logic ────────────
    // Agent declares task done; we show the message and pause. User can respond
    // to continue the conversation or use the stop button to end the run.
  }

  // ── pause_for_input / complete — unified pause via StepService ──────────

  if (decision.action === 'pause_for_input' || decision.action === 'complete') {
    const overlay = parseOverlay({});
    const chatVarId = agentChatInputVarId(result.stepId);
    if (!overlay[chatVarId]) {
      const inputSchema = decision.action === 'pause_for_input' ? decision.inputSchema : undefined;
      const responseOptions =
        decision.action === 'pause_for_input' ? decision.responseOptions : undefined;

      // responseOptions takes precedence over inputSchema for typeSchema derivation
      let effectiveTypeSchema: Record<string, unknown>;
      if (responseOptions) {
        const enumValues = responseOptions.options.map((o) => o.value);
        effectiveTypeSchema =
          responseOptions.type === 'multi'
            ? { type: 'array', items: { type: 'string', enum: enumValues } }
            : { type: 'string', enum: enumValues };
      } else {
        effectiveTypeSchema = inputSchema ?? { type: 'string' };
      }

      const schemaType =
        effectiveTypeSchema['type'] && typeof effectiveTypeSchema['type'] === 'string'
          ? effectiveTypeSchema['type']
          : undefined;
      const semanticType = schemaType === 'object' || schemaType === 'array' ? 'json' : 'text';
      overlay[chatVarId] = {
        variableId: chatVarId,
        name: 'Message',
        description: 'Your reply to the agent',
        typeSchema: effectiveTypeSchema,
        semanticType,
        lifecycle: { isInput: true, isOutput: false },
        required: true,
      };
    }

    const responseOptions =
      decision.action === 'pause_for_input' ? decision.responseOptions : undefined;

    const chatOverlay = overlay[chatVarId];
    const requiredVars: RequiredVariable[] = [
      {
        variableId: chatVarId,
        name: chatOverlay.name,
        description: chatOverlay.description ?? 'Your reply to the agent',
        typeSchema: chatOverlay.typeSchema,
        semanticType: chatOverlay.semanticType ?? 'text',
        required: true,
        ...(responseOptions ? { responseOptions } : {}),
      },
    ];

    const promptText = decision.message;

    const runtimeStatePatch = {
      version: currentRuntimeState.version,
      changed: Object.entries(currentRuntimeState.variables)
        .filter(([k]) => k.startsWith('chat.') || k.startsWith('ai.'))
        .map(([k, v]) => ({ key: k, value: v })),
    };

    const blockingMeta =
      decision.action === 'pause_for_input' && decision.blockingReason
        ? {
            blockingReason: decision.blockingReason,
            ...(decision.blockingCategory ? { blockingCategory: decision.blockingCategory } : {}),
          }
        : {};

    const stepSucceededEvent = makeStepSucceededEvent(
      result,
      stepDef,
      undefined,
      {
        agentAction: decision.action,
        ...(agentRoleConfig.agentRole === 'subagent' ? { agentRole: 'subagent' } : {}),
        ...blockingMeta,
        ...(stepUsage ? { costJson: stepUsage } : {}),
      },
      stepUsage,
    );

    await stepServiceWaitForInput(
      { redis, payloadStore },
      {
        tenantId: result.tenantId as TenantId,
        runId: result.sessionId as SessionId,
        agentDef,
        traceId: result.traceId as TraceId,
        stepDef: stepDef ?? fallbackStepDef(result),
        stepExecutionId: result.stepExecutionId as StepExecutionId,
        attempt: result.attempt,
        runState: {} as SessionHotState,
      },
      requiredVars,
      {
        ...(promptText ? { prompt: promptText } : {}),
        eventMeta: {
          ...(decision.message ? { agentResponse: decision.message } : {}),
          ...('voiceMessage' in decision && decision.voiceMessage
            ? { voiceMessage: decision.voiceMessage }
            : {}),
          ...(responseOptions ? { responseOptions } : {}),
          ...(stepUsage ? { costJson: stepUsage } : {}),
        },
        runStateUpdates: {
          variableDefsOverlay: serializeOverlay(overlay),
          usageSummary: updatedUsageSummary,
          // The answer closes the exchange the person opened, so it advances
          // the conversation's clock — but only in a session that already has
          // one. A Runner turn completing is a task finishing, and giving it a
          // clock here would enrol every skill task in the conversation list.
          ...(runHotState.lastActivityAt !== undefined ? { lastActivityAt: now } : {}),
        },
        runtimeState: currentRuntimeState,
        runtimeStatePatch: runtimeStatePatch.changed.length > 0 ? runtimeStatePatch : undefined,
        additionalEvents: [stepSucceededEvent],
        stepStateUpdates: {
          status: 'SUCCEEDED' as const,
          endedAt: now,
          ...(result.outputRef ? { outputRef: result.outputRef } : {}),
        },
        pauseType: 'user_input',
        ...(decision.action === 'pause_for_input' &&
        (decision.responseOptions || decision.inputSchema)
          ? {
              resumeSchema: chatOverlay.typeSchema,
            }
          : {}),
      },
    );

    if (decision.message) {
      try {
        const { forwardEventToParent } = await import('./forwardChildEvent.js');
        const agentResponseEvent: SessionEvent = {
          eventId: evtId(),
          eventType: 'StepSucceeded',
          timestamp: now,
          sessionId: result.sessionId,
          stepId: result.stepId,
          stepExecutionId: result.stepExecutionId,
          stepType: result.stepType,
          attempt: result.attempt,
          metadata: { agentMessage: decision.message },
        };
        await forwardEventToParent(redis, result.tenantId, result.sessionId, agentResponseEvent);
      } catch {
        // Best-effort forwarding
      }
    }

    return true;
  }

  // ── invoke_step / invoke_steps ────────────────────────────────────────────
  // Only invoke_* remain here (pause_for_input and complete returned above).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhaustiveness check for readers
  if (decision.action === 'invoke_step' || decision.action === 'invoke_steps') {
    if (decision.action === 'invoke_steps') {
      const terminalErr = validateNoTerminalToolsInParallel(decision.calls, agentDef);
      if (terminalErr) {
        throw new Error(terminalErr);
      }
    }

    // ── Loop detection ──────────────────────────────────────────────────────
    // Track recent tool call signatures. If the same pattern repeats
    // consecutively, warn the model first so it can self-correct. Only force
    // a pause after the exact same action repeats 5 times in a row. This keeps
    // legitimate retries working while still protecting against stale-input or
    // history-sync bugs that make the agent see the same turn repeatedly.
    const SOFT_WARNING_IDENTICAL_CONSECUTIVE = 3;
    const HARD_PAUSE_IDENTICAL_CONSECUTIVE = 5;
    const SIGNATURE_WINDOW = 8;
    const loopVarKey = `ai.agent.recentCallSignatures.${result.stepId}`;
    const loopWarningVarKey = `ai.agent.loopWarning.${result.stepId}`;

    const sigCalls =
      decision.action === 'invoke_step'
        ? [{ toolId: decision.toolId, args: decision.args }]
        : decision.calls.map((c) => ({ toolId: c.toolId, args: c.args }));
    const callSignature = buildCallSignature(sigCalls);

    const recentSignatures: string[] = readInlineVar(
      currentRuntimeState,
      loopVarKey,
      [] as string[],
    );

    recentSignatures.push(callSignature);
    if (recentSignatures.length > SIGNATURE_WINDOW) {
      recentSignatures.splice(0, recentSignatures.length - SIGNATURE_WINDOW);
    }

    // Count how many of the most recent entries match the current signature
    let consecutiveCount = 0;
    for (let i = recentSignatures.length - 1; i >= 0; i--) {
      if (recentSignatures[i] === callSignature) consecutiveCount++;
      else break;
    }

    // Persist updated signatures and refresh any pending loop warning that
    // should be surfaced to the next agent turn.
    const newVarsWithSig = { ...currentRuntimeState.variables };
    writeInlineVar(newVarsWithSig, loopVarKey, recentSignatures, {
      ...varMeta,
      version: recentSignatures.length,
    });
    delete newVarsWithSig[loopWarningVarKey];
    if (
      consecutiveCount >= SOFT_WARNING_IDENTICAL_CONSECUTIVE &&
      consecutiveCount < HARD_PAUSE_IDENTICAL_CONSECUTIVE
    ) {
      const remainingBeforePause = HARD_PAUSE_IDENTICAL_CONSECUTIVE - consecutiveCount;
      const isFinalWarning = remainingBeforePause === 1;
      writeInlineVar(
        newVarsWithSig,
        loopWarningVarKey,
        {
          repeatedActionCount: consecutiveCount,
          repeatedActionSignature: callSignature,
          severity: isFinalWarning ? 'final_warning' : 'warning',
          message:
            `You have invoked the exact same tool call ${String(consecutiveCount)} times in a row. ` +
            'Do not repeat it again unless the input has materially changed.',
          instruction:
            remainingBeforePause > 1
              ? `Choose a meaningfully different next action. ${String(remainingBeforePause)} more identical repeats will pause the run for user input.`
              : 'Choose a meaningfully different next action now. The next identical repeat will pause the run for user input.',
        },
        {
          ...varMeta,
          version: getVariableVersion(currentRuntimeState.variables[loopWarningVarKey]) + 1,
        },
      );
      console.warn(
        `[SessionOrchestrator] Loop warning for run ${result.sessionId}: ` +
          `agent invoked "${callSignature}" ${String(consecutiveCount)} times consecutively. ` +
          `Giving model a chance to recover before pause at ${String(HARD_PAUSE_IDENTICAL_CONSECUTIVE)} repeats.`,
      );
    }
    currentRuntimeState = {
      ...currentRuntimeState,
      variables: newVarsWithSig,
    };

    if (consecutiveCount >= HARD_PAUSE_IDENTICAL_CONSECUTIVE) {
      console.warn(
        `[SessionOrchestrator] Loop detected for run ${result.sessionId}: ` +
          `agent invoked "${callSignature}" ${String(consecutiveCount)} times consecutively. ` +
          `Failing run — harness blocked the agent.`,
      );

      const loopErrorRef = `inline:${Buffer.from(
        JSON.stringify({
          code: 'AGENT_LOOP_DETECTED',
          message:
            `The assistant attempted the same action ${String(consecutiveCount)} times in a row without progress. ` +
            'The run has been failed — start a new run with different instructions or fix the underlying issue.',
          classification: 'loop',
          retryable: false,
          timestamp: new Date().toISOString(),
        }),
      ).toString('base64')}`;

      await stepServiceFailStep(
        { redis, payloadStore },
        {
          tenantId: result.tenantId as TenantId,
          runId: result.sessionId as SessionId,
          agentDef,
          traceId: result.traceId as TraceId,
          stepDef: stepDef ?? fallbackStepDef(result),
          stepExecutionId: result.stepExecutionId as StepExecutionId,
          attempt: result.attempt,
          runState: {} as SessionHotState,
        },
        {
          code: 'AGENT_LOOP_DETECTED',
          message:
            `The assistant attempted the same action ${String(consecutiveCount)} times in a row without progress. ` +
            'The run has been failed — start a new run with different instructions or fix the underlying issue.',
        },
        {
          errorRef: loopErrorRef,
          classification: 'budget',
          retryable: false,
          runStateUpdates: { status: 'FAILED' as const, errorRef: loopErrorRef },
        },
      );
      return true;
    }

    const MAX_CONSECUTIVE_TOOL_FAILURES = 5;
    const MAX_TOTAL_TOOL_FAILURES = 12;
    const failuresVarKey = `ai.agent.toolFailures.${result.stepId}`;
    const totalFailuresVarKey = `ai.agent.toolTotalFailures.${result.stepId}`;
    const toolFailures = readInlineVar(
      currentRuntimeState,
      failuresVarKey,
      {} as Record<string, number>,
    );
    const toolTotalFailures = readInlineVar(
      currentRuntimeState,
      totalFailuresVarKey,
      {} as Record<string, number>,
    );
    const requestedToolIds = sigCalls.map((c) => c.toolId);
    // A tool is "failing" if it hit the consecutive-identical-error limit OR the
    // total-failure limit (guards against cycling between a set of distinct errors).
    const failingTools = requestedToolIds.filter(
      (toolId) =>
        (toolFailures[toolId] ?? 0) >= MAX_CONSECUTIVE_TOOL_FAILURES ||
        (toolTotalFailures[toolId] ?? 0) >= MAX_TOTAL_TOOL_FAILURES,
    );
    if (failingTools.length > 0) {
      const toolList = failingTools
        .map((t) => {
          const consec = toolFailures[t] ?? 0;
          const total = toolTotalFailures[t] ?? 0;
          return `"${t}" (${String(consec)} consecutive, ${String(total)} total)`;
        })
        .join(', ');
      console.warn(
        `[applyAgentDecision] Tool failure limit reached for run ${result.sessionId}: ${toolList}. ` +
          `Failing run — harness blocked the agent.`,
      );

      const failureMessage =
        `Tool(s) ${toolList} have exceeded the failure limit. ` +
        'The run has been failed — inspect workflow.run.detail for the tool error details and fix the skill or start a new run.';
      const failureErrorRef = `inline:${Buffer.from(
        JSON.stringify({
          code: 'TOOL_FAILURE_LIMIT',
          message: failureMessage,
          classification: 'tool_failure',
          retryable: false,
          timestamp: new Date().toISOString(),
        }),
      ).toString('base64')}`;

      await stepServiceFailStep(
        { redis, payloadStore },
        {
          tenantId: result.tenantId as TenantId,
          runId: result.sessionId as SessionId,
          agentDef,
          traceId: result.traceId as TraceId,
          stepDef: stepDef ?? fallbackStepDef(result),
          stepExecutionId: result.stepExecutionId as StepExecutionId,
          attempt: result.attempt,
          runState: {} as SessionHotState,
        },
        {
          code: 'TOOL_FAILURE_LIMIT',
          message: failureMessage,
        },
        {
          errorRef: failureErrorRef,
          classification: 'budget',
          retryable: false,
          runStateUpdates: { status: 'FAILED' as const, errorRef: failureErrorRef },
        },
      );
      return true;
    }

    const agentInvokePatch = {
      version: currentRuntimeState.version,
      changed: Object.entries(currentRuntimeState.variables)
        .filter(([k]) => k.startsWith('ai.') || k.startsWith('chat.'))
        .map(([k, v]) => ({ key: k, value: v })),
    };

    const invokeMetadata: Record<string, unknown> = {
      agentAction: decision.action,
    };
    if (decision.message) invokeMetadata['agentMessage'] = decision.message;
    if (decision.reasoning) invokeMetadata['agentReasoning'] = decision.reasoning;
    if (stepUsage) invokeMetadata['costJson'] = stepUsage;

    if (decision.action === 'invoke_step') {
      const toolStepDef = agentDef.steps.find((s) => s.stepId === decision.toolId);
      invokeMetadata['invokedTools'] = [
        {
          toolId: decision.toolId,
          name: toolStepDef?.name ?? decision.toolId,
          operation: toolStepDef?.operation ?? decision.toolId,
        },
      ];
    } else {
      invokeMetadata['invokedTools'] = decision.calls.map((c) => {
        const toolDef = agentDef.steps.find((s) => s.stepId === c.toolId);
        return {
          toolId: c.toolId,
          name: toolDef?.name ?? c.toolId,
          operation: toolDef?.operation ?? c.toolId,
        };
      });
    }

    await stepServiceCompleteStep(
      { redis, payloadStore },
      {
        tenantId: result.tenantId as TenantId,
        runId: result.sessionId as SessionId,
        agentDef,
        traceId: result.traceId as TraceId,
        stepDef: stepDef ?? fallbackStepDef(result),
        stepExecutionId: result.stepExecutionId as StepExecutionId,
        attempt: result.attempt,
        runState: {} as SessionHotState,
      },
      {
        ...(result.outputRef ? { outputRef: result.outputRef } : {}),
        runtimeState: currentRuntimeState,
        ...(agentInvokePatch.changed.length > 0 ? { runtimeStatePatch: agentInvokePatch } : {}),
        eventMeta: invokeMetadata,
        ...(stepUsage ? { usage: stepUsage } : {}),
      },
    );

    if (decision.message) {
      try {
        const { forwardEventToParent } = await import('./forwardChildEvent.js');
        // Construct a StepSucceeded-like event for forwarding
        const agentMsgEvent: SessionEvent = {
          eventId: evtId(),
          eventType: 'StepSucceeded',
          timestamp: now,
          sessionId: result.sessionId,
          stepId: result.stepId,
          stepExecutionId: result.stepExecutionId,
          stepType: result.stepType,
          attempt: result.attempt,
          metadata: { agentMessage: decision.message },
        };
        await forwardEventToParent(redis, result.tenantId, result.sessionId, agentMsgEvent);
      } catch {
        // Best-effort forwarding
      }
    }

    if (runHotState.interruptRequested) {
      const iNow = Date.now();

      // Build requestedInputRef with resumeContract so resumeRun() maps
      // the user's input to the agent's chatInput variable correctly.
      const chatVarId = agentChatInputVarId(result.stepId);
      const interruptPausePayload = {
        reason: 'input_required',
        stepId: result.stepId,
        missingVariables: [{ variableId: chatVarId, name: 'Message', required: true }],
        resumeContract: {
          reason: 'input_required' as const,
          mode: 'primary' as const,
          stepId: result.stepId,
          targetVariableId: chatVarId,
          requiredFields: [{ variableId: chatVarId, name: 'Message', required: true }],
          prompt: 'Flow was interrupted. Send a message to continue.',
        },
        prompt: 'Flow was interrupted. Send a message to continue.',
      };
      const requestedInputRef = `inline:${Buffer.from(JSON.stringify(interruptPausePayload)).toString('base64')}`;

      await atomicCompleteStep(
        redis,
        result.tenantId,
        { stepExecutionId: result.stepExecutionId },
        {
          sessionId: result.sessionId,
          status: 'PAUSED',
          pauseReason: 'interrupted',
          requestedInputRef,
          interruptRequested: false,
          pauseType: 'interrupted',
          pauseMetadataJson: JSON.stringify({ pauseType: 'interrupted' }),
          currentStepId: result.stepId,
          currentStepExecutionId: result.stepExecutionId,
          runtimeState: currentRuntimeState,
        },
        {
          eventId: evtId(),
          eventType: 'SessionPaused',
          timestamp: iNow,
          sessionId: result.sessionId,
          stepId: result.stepId,
          stepExecutionId: result.stepExecutionId,
          stepType: result.stepType,
          attempt: result.attempt,
          requestedInputRef,
          metadata: {
            pauseReason: 'interrupted',
            pauseType: 'interrupted',
            agentDecision: decision.action,
            missingVariables: [{ variableId: chatVarId, name: 'Message', required: true }],
          },
        },
      );
      return true;
    }

    // Schedule the tool steps the agent requested
    const calls =
      decision.action === 'invoke_step'
        ? [{ toolId: decision.toolId, args: decision.args }]
        : decision.calls;

    // Parallel barrier: write pending tool call count so the result consumer
    // knows to wait for ALL dynamic steps before scheduling the next agent turn.
    // The count is stored in runtime state; results are serialized per-run in
    // the ResultConsumer, so there's no race condition on decrement.
    //
    const barrierTrackedCount = calls.reduce(
      (n, c) => n + (tracksBarrierForAgentReturn(c.toolId, agentDef, result.stepId) ? 1 : 0),
      0,
    );

    const pendingCountKey = `ai.agent.pendingToolCallCount.${result.stepId}`;
    const pendingResultsKey = `ai.agent.pendingToolResults.${result.stepId}`;
    const barrierCreatedKey = `ai.agent.barrierCreatedAtMs.${result.stepId}`;
    const scheduledKeysKey = `ai.agent.scheduledIdempotencyKeys.${result.stepId}`;
    const barrierVars = { ...currentRuntimeState.variables };
    if (barrierTrackedCount > 0) {
      writeInlineVar(barrierVars, pendingCountKey, barrierTrackedCount, varMeta);
      writeInlineVar(barrierVars, pendingResultsKey, [], varMeta);
      writeInlineVar(barrierVars, barrierCreatedKey, now, varMeta);
    }

    const idempotencyKeys = calls.map((call, i) => {
      const callObj = call as { idempotencyKey?: string };
      return callObj.idempotencyKey ?? `${result.stepExecutionId}:call:${String(i)}`;
    });
    const previouslyScheduled = readInlineVar(
      currentRuntimeState,
      scheduledKeysKey,
      [] as string[],
    );
    const previousSet = new Set(previouslyScheduled);
    writeInlineVar(
      barrierVars,
      scheduledKeysKey,
      [...previouslyScheduled, ...idempotencyKeys],
      varMeta,
    );

    currentRuntimeState = {
      ...currentRuntimeState,
      variables: barrierVars,
      version: currentRuntimeState.version + 1,
      updatedAtMs: now,
    };
    await updateSessionState(redis, result.tenantId as TenantId, result.sessionId as SessionId, {
      runtimeState: currentRuntimeState,
      usageSummary: updatedUsageSummary,
    });

    if (barrierTrackedCount > 0) {
      await registerBarrierWatchdog(
        redis,
        result.tenantId,
        result.sessionId,
        result.stepId,
        now,
      ).catch(() => {}); // Best-effort — barrier still works without watchdog
    }

    const toolCallIdByStepExecutionUpdates: Record<string, string> = {};

    for (const [i, call] of calls.entries()) {
      const idemKey = idempotencyKeys[i]!;
      if (previousSet.has(idemKey)) {
        continue;
      }
      // Mirror conversationStateStore.recordAssistantResponse compact id format.
      const compactCallId = `${result.stepExecutionId.replaceAll('-', '')}_${String(i)}`;
      const argsData: Record<string, unknown> = { ...call.args };
      const toolInputRef = `inline:${Buffer.from(JSON.stringify(argsData)).toString('base64')}`;

      // Resolve toolId: graph tools use stepId directly, virtual tools need
      // to be lowered via handleRunStepInline (operationId-based).
      const isGraphStep = agentDef.steps.some((s) => s.stepId === call.toolId);

      try {
        if (isGraphStep) {
          const childStepExecutionId = await scheduleStep({
            context: {
              tenantId: result.tenantId as TenantId,
              runId: result.sessionId as SessionId,
              agentDefinition: agentDef,
              traceId: result.traceId as TraceId,
            },
            stepId: call.toolId as StepId,
            inputRef: toolInputRef,
            parentStepExecutionId: result.stepExecutionId as StepExecutionId,
          });
          toolCallIdByStepExecutionUpdates[childStepExecutionId] = compactCallId;
        } else {
          // Virtual tool: determine lowering strategy.
          const agentStepDef = stepDef ?? fallbackStepDef(result);
          const catalogConfig = agentStepDef.config['catalog'] as
            { coreAgents?: string[]; coreApis?: string[] } | undefined;

          // Turn-surface membership. Out-of-surface api:/mcp: toolIds must not
          // reach their lowering branches — the api branch's spec-cache
          // fallback would otherwise resolve an agent-crafted toolId into an
          // api.http.call against an arbitrary apiId/endpoint. Instead they
          // fall through to the synthetic run_step, whose handler rejects
          // off-surface tools with a teaching error routed back to the agent.
          const surfaceEntry = currentRuntimeState.variables[
            `${TOOL_SURFACE_VAR}.${result.stepId}`
          ] as { ref?: { kind: string; value?: unknown } } | undefined;
          const turnSurface =
            surfaceEntry?.ref?.kind === 'inline' && Array.isArray(surfaceEntry.ref.value)
              ? new Set(
                  (surfaceEntry.ref.value as unknown[]).filter(
                    (t): t is string => typeof t === 'string',
                  ),
                )
              : undefined;
          const onSurface = turnSurface?.has(call.toolId) === true;

          const isApiTool = call.toolId.startsWith('api:') && onSurface;
          const appletSpec = onSurface
            ? findCachedAppletToolSpec(currentRuntimeState, call.toolId)
            : undefined;

          if (isApiTool) {
            // API virtual tool: lower to api.http.call
            // Parse apiMeta from the toolId: 'api:{apiId}/{endpointId}' or 'api:{bindingId}/{endpointId}'
            const apiToolIdBody = call.toolId.slice('api:'.length);
            const slashIdx = apiToolIdBody.indexOf('/');
            const toolIdPrefix = slashIdx >= 0 ? apiToolIdBody.slice(0, slashIdx) : apiToolIdBody;
            const endpointId = slashIdx >= 0 ? apiToolIdBody.slice(slashIdx + 1) : '';

            // 104n: Look up apiMeta from cached tool specs for binding identity.
            // Grant-based tools have bindingId in apiMeta; legacy tools don't.
            let apiId = toolIdPrefix;
            let bindingId: string | undefined;
            const cachedGrantSpecs = currentRuntimeState.variables[
              'ai.agent._grantApiToolSpecs'
            ] as { ref?: { kind: string; value?: unknown } } | undefined;
            const cachedCoreSpecs = currentRuntimeState.variables['ai.agent._coreApiToolSpecs'] as
              { ref?: { kind: string; value?: unknown } } | undefined;
            // Discovery-promoted API tools cache their spec (with apiMeta.apiId,
            // distinct from the binding id in the toolId prefix) here. The lookup
            // MUST include it or a Helmsman-discovered integration tool resolves
            // its apiId to the binding id and api.http.call 404s the definition.
            // (The mcp: branch below already reads its discovered cache.)
            const cachedDiscoveredSpecs = currentRuntimeState.variables[
              'ai.agent._discoveredApiToolSpecs'
            ] as { ref?: { kind: string; value?: unknown } } | undefined;
            const cachedPinnedConnectionSpecs = currentRuntimeState.variables[
              PINNED_CONNECTION_TOOLS_VAR
            ] as { ref?: { kind: string; value?: unknown } } | undefined;
            const allCachedSpecs = [
              ...(cachedGrantSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedGrantSpecs.ref.value)
                ? (cachedGrantSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
              ...(cachedPinnedConnectionSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedPinnedConnectionSpecs.ref.value)
                ? (cachedPinnedConnectionSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
              ...(cachedCoreSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedCoreSpecs.ref.value)
                ? (cachedCoreSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
              ...(cachedDiscoveredSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedDiscoveredSpecs.ref.value)
                ? (cachedDiscoveredSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
            ];
            const matchedSpec = allCachedSpecs.find((s) => s['toolId'] === call.toolId);
            let bindingOpTaskOnly = false;
            if (
              matchedSpec &&
              typeof matchedSpec['apiMeta'] === 'object' &&
              matchedSpec['apiMeta']
            ) {
              const meta = matchedSpec['apiMeta'] as Record<string, unknown>;
              if (typeof meta['apiId'] === 'string') apiId = meta['apiId'];
              if (typeof meta['bindingId'] === 'string') bindingId = meta['bindingId'];
              const gov = matchedSpec['governance'] as Record<string, unknown> | undefined;
              if (gov?.['opTaskOnly'] === true) bindingOpTaskOnly = true;
            }

            const apiCallInputData = {
              apiId,
              endpointId,
              ...(bindingId ? { bindingId } : {}),
              params: argsData,
            };
            const apiCallInputRef = `inline:${Buffer.from(JSON.stringify(apiCallInputData)).toString('base64')}`;

            // stepIds must match StepIdSchema (^[a-z][a-z0-9_-]*$). Endpoint ids
            // can be dotted (`charges.create`) OR camelCase (github
            // `getPullRequest`), so lowercase + collapse any non-alphanumeric run
            // to `_` — a bare `.replace(/\./g, '_')` left camelCase uppercase in
            // the id and the child step failed to enqueue.
            const syntheticStepId =
              `virtual_api_${stepIdSlug(apiId)}_${stepIdSlug(endpointId)}_${crypto.randomUUID().slice(0, 8)}` as StepId;
            const syntheticApiCallDef: StepDefinition = {
              stepId: syntheticStepId,
              stepType: 'api' as StepType,
              operation: 'api.http.call' as OperationId,
              name: `↪ API ${apiId}.${endpointId}${bindingId ? ` (${bindingId})` : ''}`,
              config: {},
              tags: [
                'dynamic',
                'virtual_api_tool',
                `parent:${agentStepDef.stepId}`,
                `_toolId:${call.toolId}`,
                `_toolCallId:${compactCallId}`,
                `_apiId:${apiId}`,
                `_endpointId:${endpointId}`,
                ...(bindingId ? [`_bindingId:${bindingId}`] : []),
                ...(bindingOpTaskOnly ? ['_opTaskOnly'] : []),
              ],
              optional: false,
              outputOptions: { displayToUser: true },
              onSuccess: { next: [{ stepId: agentStepDef.stepId, priority: 50 }] },
              onFailure: { next: [{ stepId: agentStepDef.stepId, priority: 50 }] },
            };

            agentDef.steps.push(syntheticApiCallDef);

            await persistDynamicStep(
              redis,
              result.tenantId as TenantId,
              result.sessionId as SessionId,
              syntheticApiCallDef,
            );

            await scheduleStep({
              context: {
                tenantId: result.tenantId as TenantId,
                runId: result.sessionId as SessionId,
                agentDefinition: agentDef,
                traceId: result.traceId as TraceId,
              },
              stepId: syntheticStepId,
              inputRef: apiCallInputRef,
              parentStepExecutionId: result.stepExecutionId as StepExecutionId,
            });
          } else if (call.toolId.startsWith('mcp:') && onSurface) {
            const mcpToolIdBody = call.toolId.slice('mcp:'.length);
            const slashIdx = mcpToolIdBody.indexOf('/');
            const toolName = slashIdx >= 0 ? mcpToolIdBody.slice(slashIdx + 1) : '';

            let serverId = '';
            let bindingId: string | undefined;
            // Set when the server runs on the operator's machine, which decides
            // which lane the call is lowered onto — the tool is otherwise the
            // same tool, with the same name and the same schema.
            let hostBindingId: string | undefined;
            const cachedMcpGrantSpecs = currentRuntimeState.variables[
              'ai.agent._grantMcpToolSpecs'
            ] as { ref?: { kind: string; value?: unknown } } | undefined;
            const cachedMcpCoreSpecs = currentRuntimeState.variables[
              'ai.agent._coreMcpToolSpecs'
            ] as { ref?: { kind: string; value?: unknown } } | undefined;
            const cachedMcpDiscoveredSpecs = currentRuntimeState.variables[
              'ai.agent._discoveredMcpToolSpecs'
            ] as { ref?: { kind: string; value?: unknown } } | undefined;
            const cachedMcpPinnedConnectionSpecs = currentRuntimeState.variables[
              PINNED_CONNECTION_TOOLS_VAR
            ] as { ref?: { kind: string; value?: unknown } } | undefined;
            const cachedLocalMcpSpecs = currentRuntimeState.variables[LOCAL_MCP_TOOLS_VAR] as
              { ref?: { kind: string; value?: unknown } } | undefined;
            const allCachedMcpSpecs = [
              ...(cachedLocalMcpSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedLocalMcpSpecs.ref.value)
                ? (cachedLocalMcpSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
              ...(cachedMcpGrantSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedMcpGrantSpecs.ref.value)
                ? (cachedMcpGrantSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
              ...(cachedMcpPinnedConnectionSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedMcpPinnedConnectionSpecs.ref.value)
                ? (cachedMcpPinnedConnectionSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
              ...(cachedMcpCoreSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedMcpCoreSpecs.ref.value)
                ? (cachedMcpCoreSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
              ...(cachedMcpDiscoveredSpecs?.ref?.kind === 'inline' &&
              Array.isArray(cachedMcpDiscoveredSpecs.ref.value)
                ? (cachedMcpDiscoveredSpecs.ref.value as Array<Record<string, unknown>>)
                : []),
            ];
            const matchedMcpSpec = allCachedMcpSpecs.find((s) => s['toolId'] === call.toolId);
            let bindingOpTaskOnly = false;
            if (
              matchedMcpSpec &&
              typeof matchedMcpSpec['mcpMeta'] === 'object' &&
              matchedMcpSpec['mcpMeta']
            ) {
              const meta = matchedMcpSpec['mcpMeta'] as Record<string, unknown>;
              if (typeof meta['serverId'] === 'string') serverId = meta['serverId'];
              if (typeof meta['bindingId'] === 'string') bindingId = meta['bindingId'];
              if (typeof meta['hostBindingId'] === 'string') hostBindingId = meta['hostBindingId'];
              const gov = matchedMcpSpec['governance'] as Record<string, unknown> | undefined;
              if (gov?.['opTaskOnly'] === true) bindingOpTaskOnly = true;
            }
            if (!serverId) {
              // Fallback: if no spec match (stale cache?), assume toolId prefix is serverId.
              // The executor will still verify via its tenant-loaded binding store.
              serverId = slashIdx >= 0 ? mcpToolIdBody.slice(0, slashIdx) : mcpToolIdBody;
            }

            const mcpStepId =
              `virtual_mcp_${stepIdSlug(serverId)}_${stepIdSlug(toolName)}_${crypto.randomUUID().slice(0, 8)}` as StepId;

            // A server on the operator's machine is reached by the host lane,
            // which is where the process, its sandbox and its binding live. The
            // tool the model called is the same either way; only the step that
            // carries it out differs, so this is the one place that branches.
            const isLocal = hostBindingId !== undefined;

            const mcpCallInputData = isLocal
              ? {
                  bindingId: hostBindingId,
                  serverId,
                  toolName,
                  arguments: argsData,
                }
              : {
                  serverId,
                  toolName,
                  ...(bindingId ? { bindingId } : {}),
                  arguments: argsData,
                };
            const mcpCallInputRef = `inline:${Buffer.from(JSON.stringify(mcpCallInputData)).toString('base64')}`;

            const syntheticMcpStep: StepDefinition = {
              stepId: mcpStepId,
              stepType: (isLocal ? 'host' : 'mcp') as StepType,
              operation: (isLocal ? 'host.mcp.call' : 'mcp.tool.call') as OperationId,
              name: isLocal
                ? `↪ ${serverId}.${toolName} (this computer)`
                : `↪ MCP ${serverId}.${toolName}${bindingId ? ` (${bindingId})` : ''}`,
              config: {},
              tags: [
                'dynamic',
                'virtual_mcp_tool',
                `parent:${agentStepDef.stepId}`,
                `_toolId:${call.toolId}`,
                `_toolCallId:${compactCallId}`,
                `_serverId:${serverId}`,
                `_toolName:${toolName}`,
                ...(bindingId ? [`_bindingId:${bindingId}`] : []),
                ...(hostBindingId ? [`_hostBindingId:${hostBindingId}`] : []),
                ...(bindingOpTaskOnly ? ['_opTaskOnly'] : []),
              ],
              optional: false,
              outputOptions: { displayToUser: true },
              onSuccess: { next: [{ stepId: agentStepDef.stepId, priority: 50 }] },
              onFailure: { next: [{ stepId: agentStepDef.stepId, priority: 50 }] },
            };

            agentDef.steps.push(syntheticMcpStep);

            await persistDynamicStep(
              redis,
              result.tenantId as TenantId,
              result.sessionId as SessionId,
              syntheticMcpStep,
            );

            await scheduleStep({
              context: {
                tenantId: result.tenantId as TenantId,
                runId: result.sessionId as SessionId,
                agentDefinition: agentDef,
                traceId: result.traceId as TraceId,
              },
              stepId: mcpStepId,
              inputRef: mcpCallInputRef,
              parentStepExecutionId: result.stepExecutionId as StepExecutionId,
            });
          } else if (appletSpec?.appletMeta) {
            // Applet action lowered over ui.applet.act (Plan 264 §4.14).
            // Same shape as the API lowering: recover the meta from this
            // turn's cached specs, synthesize the operation step directly.
            // Surface-gated like api:/mcp: — an off-surface toolId falls to
            // the run_step handler's TOOL_NOT_ON_SURFACE teaching error.
            const appletMeta = appletSpec.appletMeta;
            const actInputData = buildAppletActInput(appletMeta, argsData);
            const actInputRef = `inline:${Buffer.from(JSON.stringify(actInputData)).toString('base64')}`;
            const { stepId: appletStepId, stepDef: syntheticAppletStep } = buildLoweredAppletStep(
              call.toolId,
              compactCallId,
              agentStepDef.stepId,
              appletMeta,
            );

            agentDef.steps.push(syntheticAppletStep);

            await persistDynamicStep(
              redis,
              result.tenantId as TenantId,
              result.sessionId as SessionId,
              syntheticAppletStep,
            );

            await scheduleStep({
              context: {
                tenantId: result.tenantId as TenantId,
                runId: result.sessionId as SessionId,
                agentDefinition: agentDef,
                traceId: result.traceId as TraceId,
              },
              stepId: appletStepId,
              inputRef: actInputRef,
              parentStepExecutionId: result.stepExecutionId as StepExecutionId,
            });
          } else {
            const coreAgentIds = new Set(
              (catalogConfig?.coreAgents ?? []).map((id: string) => id.replace(/[-\s]/g, '_')),
            );
            // Check both coreAgents and discovered agents (from _virtualTools with 'agent:' prefix).
            // Surface-gated like api:/mcp: (Plan 233 D3 — all non-graph branches): a delegate
            // toolId LRU-evicted from the turn surface (still in _virtualTools/coreAgentIds but
            // dropped past MAX_TOTAL_TOOLS/MAX_VIRTUAL_TOOLS) falls through to the run_step
            // handler, which fails it with the TOOL_NOT_ON_SURFACE teaching error.
            const isDelegateAgent =
              onSurface &&
              (coreAgentIds.has(call.toolId) ||
                // Discovered agent: check if _virtualTools has an 'agent:' entry for this toolId
                (() => {
                  const vtVar = runHotState.runtimeState?.variables['ai.agent._virtualTools'] as
                    { ref?: { kind: string; value?: unknown } } | undefined;
                  if (
                    vtVar?.ref?.kind === 'inline' &&
                    typeof vtVar.ref.value === 'object' &&
                    vtVar.ref.value !== null
                  ) {
                    const vt = vtVar.ref.value as Record<string, unknown>;
                    // Look for 'agent:<id>' where id with dashes→underscores matches toolId
                    return Object.keys(vt).some(
                      (k) =>
                        k.startsWith('agent:') &&
                        k.slice('agent:'.length).replace(/[-\s]/g, '_') === call.toolId,
                    );
                  }
                  return false;
                })());

            if (isDelegateAgent) {
              // Agent virtual tool: lower to agent.control.delegate.
              const originalAgentHandle =
                catalogConfig?.coreAgents?.find(
                  (id: string) => id.replace(/[-\s]/g, '_') === call.toolId,
                ) ?? call.toolId.replace(/_/g, '-');

              // Resolve the tagged target. Prefer the stamped agentRef from
              // _virtualTools (carries UUID for custom-agent kind); fall
              // back to assuming a platform-role systemRole for coreAgents.
              let delegateTarget:
                | { kind: 'platform-role'; systemRole: string }
                | { kind: 'custom-agent'; agentId: string };
              const vtVar = runHotState.runtimeState?.variables['ai.agent._virtualTools'] as
                { ref?: { kind: string; value?: unknown } } | undefined;
              const vtMap =
                vtVar?.ref?.kind === 'inline' && typeof vtVar.ref.value === 'object'
                  ? (vtVar.ref.value as Record<string, unknown>)
                  : undefined;
              const vtEntry = vtMap?.[`agent:${originalAgentHandle}`] as
                { agentRef?: { kind: string; systemRole?: string; agentId?: string } } | undefined;
              if (
                vtEntry?.agentRef?.kind === 'platform-role' &&
                typeof vtEntry.agentRef.systemRole === 'string'
              ) {
                delegateTarget = {
                  kind: 'platform-role',
                  systemRole: vtEntry.agentRef.systemRole,
                };
              } else if (
                vtEntry?.agentRef?.kind === 'custom-agent' &&
                typeof vtEntry.agentRef.agentId === 'string'
              ) {
                delegateTarget = { kind: 'custom-agent', agentId: vtEntry.agentRef.agentId };
              } else {
                // Fallback for coreAgents without a stamped ref — assume the
                // handle is a platform-role systemRole.
                delegateTarget = { kind: 'platform-role', systemRole: originalAgentHandle };
              }

              // Agent virtual tools default to wait='until_pause' so the parent
              // agent always gets control back — even if the subagent pauses
              // unnecessarily. The parent can then ignore and move on.
              const delegateInputData = {
                target: delegateTarget,
                input: argsData['task'],
                wait: 'until_pause',
                ...(typeof argsData['context'] === 'object'
                  ? { context: argsData['context'] }
                  : {}),
              };
              const delegateInputRef = `inline:${Buffer.from(JSON.stringify(delegateInputData)).toString('base64')}`;

              const syntheticStepId =
                `virtual_agent_${call.toolId}_${crypto.randomUUID().slice(0, 8)}` as StepId;
              const syntheticDelegateDef: StepDefinition = {
                stepId: syntheticStepId,
                stepType: 'agent' as StepType,
                operation: 'agent.control.delegate' as OperationId,
                name: `↪ ${call.toolId}`,
                config: {},
                tags: [
                  'dynamic',
                  'virtual_agent',
                  `parent:${agentStepDef.stepId}`,
                  `_toolId:${call.toolId}`,
                  `_toolCallId:${compactCallId}`,
                  `_agentHandle:${originalAgentHandle}`,
                ],
                optional: false,
                outputOptions: { displayToUser: true },
                onSuccess: { next: [{ stepId: agentStepDef.stepId, priority: 50 }] },
                onFailure: { next: [{ stepId: agentStepDef.stepId, priority: 50 }] },
              };

              agentDef.steps.push(syntheticDelegateDef);

              await persistDynamicStep(
                redis,
                result.tenantId as TenantId,
                result.sessionId as SessionId,
                syntheticDelegateDef,
              );

              await scheduleStep({
                context: {
                  tenantId: result.tenantId as TenantId,
                  runId: result.sessionId as SessionId,
                  agentDefinition: agentDef,
                  traceId: result.traceId as TraceId,
                },
                stepId: syntheticStepId,
                inputRef: delegateInputRef,
                parentStepExecutionId: result.stepExecutionId as StepExecutionId,
              });
            } else {
              // Operation virtual tool: toolId is an operationId — inject a synthetic run_step
              const runStepInputData = {
                operationId: call.toolId,
                inputs: argsData,
              };
              const runStepInputRef = `inline:${Buffer.from(JSON.stringify(runStepInputData)).toString('base64')}`;

              const syntheticStepId =
                `virtual_${call.toolId.replace(/\./g, '_')}_${crypto.randomUUID().slice(0, 8)}` as StepId;
              const syntheticRunStepDef: StepDefinition = {
                stepId: syntheticStepId,
                stepType: 'agent' as StepType,
                operation: 'agent.control.run_step' as OperationId,
                name: `↪ ${call.toolId}`,
                config: {},
                tags: [
                  'dynamic',
                  'virtual_tool',
                  `parent:${agentStepDef.stepId}`,
                  `_toolId:${call.toolId}`,
                  `_toolCallId:${compactCallId}`,
                ],
                optional: false,
                outputOptions: { displayToUser: true },
                onSuccess: { next: [{ stepId: agentStepDef.stepId, priority: 50 }] },
                onFailure: { next: [{ stepId: agentStepDef.stepId, priority: 50 }] },
              };

              agentDef.steps.push(syntheticRunStepDef);

              // A THROWN failure (unknown op) is processed in a later consumer
              // iteration that re-reads the flow — without the persisted def
              // there is no onFailure edge and the session dies instead of
              // routing the error back to the agent.
              await persistDynamicStep(
                redis,
                result.tenantId as TenantId,
                result.sessionId as SessionId,
                syntheticRunStepDef,
              );

              await scheduleStep({
                context: {
                  tenantId: result.tenantId as TenantId,
                  runId: result.sessionId as SessionId,
                  agentDefinition: agentDef,
                  traceId: result.traceId as TraceId,
                },
                stepId: syntheticStepId,
                inputRef: runStepInputRef,
                parentStepExecutionId: result.stepExecutionId as StepExecutionId,
              });
            }
          }
        }
      } catch (scheduleErr) {
        const errMsg = scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr);
        logOrchestratorError(
          `[applyAgentDecision] Failed to schedule tool "${call.toolId}": ${errMsg}`,
          scheduleErr instanceof Error ? scheduleErr : new Error(errMsg),
          {
            tenantId: result.tenantId,
            sessionId: result.sessionId,
            toolId: call.toolId,
            stepExecutionId: result.stepExecutionId,
          },
        );

        // For virtual tools, the synthetic run_step step has onFailure → agent,
        // so failures during execution route back automatically. But if scheduleStep
        // itself fails (before the step even starts), we need to throw to surface it.
        throw scheduleErr;
      }
    }

    await persistToolCallIdByStepExecutionMap(
      redis,
      result.tenantId as TenantId,
      result.sessionId as SessionId,
      toolCallIdByStepExecutionUpdates,
      varMeta,
    );

    return true;
  }

  return false;
}

interface AgentRoleConfig {
  agentRole: AgentRole;
  requestInputPolicy: RequestInputPolicy;
  completionPolicy: CompletionPolicy;
  finalOutputSchema: Record<string, unknown> | undefined;
}

/**
 * Resolve effective agent role policies from the step definition and agent output.
 * Reads from the agent turn output (which carries the policies from input assembly).
 */
function resolveAgentPoliciesFromStep(
  stepDef: StepDefinition | undefined,
  _agentOutput: AgentTurnOutput,
  agentRoleOverride?: 'assistant' | 'subagent',
  trigger?: string,
): AgentRoleConfig {
  // The orchestrator assembles agentRole into the AgentTurnInput payload.
  // At decision time, we re-derive from the step config.
  // agentRoleOverride (from agent.control.delegate) takes precedence.
  //
  // The trigger comes with it: the turn was assembled under an unattended
  // policy, and judging its answer under the standing one is what let a
  // scheduled assistant be told not to ask and then parked for asking.
  const config = stepDef?.config;

  const policies = resolveAgentPoliciesFromConfig(config, {
    agentRoleOverride,
    trigger,
  });

  return {
    ...policies,
    finalOutputSchema: config?.['finalOutputSchema'] as Record<string, unknown> | undefined,
  };
}

/**
 * Validate an agent decision against role policies.
 * Returns null if valid, or an error string if invalid.
 * Prefix with "FATAL:" for hard failures that should fail the step.
 */
function validateDecisionForRole(
  decision: AgentTurnDecision,
  config: AgentRoleConfig,
): string | null {
  const { requestInputPolicy } = config;

  // Never policy: input requests are forbidden
  if (requestInputPolicy === 'never' && decision.action === 'pause_for_input') {
    return 'FATAL: Agent attempted to request user input but requestInputPolicy is "never".';
  }

  return null;
}
