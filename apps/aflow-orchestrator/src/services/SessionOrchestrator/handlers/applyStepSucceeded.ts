/**
 * Normal step-success handler
 *
 * Handles the SUCCEEDED path for non-agent steps (and agent steps that fell
 * through decision handling). Responsibilities:
 *   1. Determine if flow is terminal (no next step / endFlow op)
 *   2. Apply output mapping → runtime state
 *   3. If next step is an agent turn: build tool result summary + update agent history
 *   4. Emit StepSucceeded event (+ SessionCompleted if terminal, or schedule next step)
 */
import type { Redis } from 'ioredis';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type {
  TenantId,
  SessionId,
  TraceId,
  StepId,
  StepExecutionId,
  AgentDefinition,
  SimulatedFulfillmentReport,
  StepDefinition,
  StepOutputPresentation,
  StepUsageBreakdown,
} from '@aflow/schemas';
import {
  resolveNextStep,
  getOperation,
  findStepImages,
  StepOutputPresentationSchema,
  UI_APPLET_GET_OPERATION_ID,
  UI_APPLET_INSTANTIATE_OPERATION_ID,
  UiAppletGetOutputSchema,
  UiAppletInstantiateOutputSchema,
} from '@aflow/schemas';
import type { SessionHotState, StepHotState, SessionEvent } from '@aflow/redis';
import {
  atomicCompleteStep,
  markRunInactive,
  removeBarrierWatchdog,
  setAppletFocus,
} from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { detectOutputFields, type ToolOutputEntry } from '@aflow/memory-paths';
import { buildStepCompletedRecoveryEvents } from '../helpers/recoveryEmitter.js';
import { createMessage, type AiToolResult } from '@aflow/schemas';
import type { ScheduleStepParams, ToolResultSummary } from '../types.js';
import type { GuardrailGate } from '../../GuardrailGate/index.js';
import { routeRunnerTerminalToHarness } from '../../cybernetic/WorkflowRunHarness.js';
import { routeSessionPauseToSubscribers } from './pausedSessionRouting.js';
import {
  accumulateUsageSummary,
  applyOutputMapping,
  buildOutputVariables,
  readInlineVar,
  writeInlineVar,
} from '../helpers/runtimeState.js';
import { buildToolResultSummaryWithMeta, type ToolSummaryMeta } from '../helpers/outputSummary.js';
import {
  isHistoryEnabled,
  loadOrCreateConversation,
  storeConversation,
} from '../helpers/aiHistory.js';
import {
  matchToolCallIdFromAssistantHistory,
  toolCallIdFromRuntimeMap,
  toolCallIdFromStepTags,
} from '../helpers/resolveToolCallId.js';
import { getClearedDelegationStatePatch } from '../helpers/delegationState.js';
import {
  enqueuePendingAndReconcile,
  isDelegationUpsertFailure,
} from './enqueueDelegationCompletion.js';
import { simulatedFulfillmentEventMeta } from '../../simulatedStepMarking.js';

function eventId(): string {
  return crypto.randomUUID();
}

function extractPresentation(output: unknown): StepOutputPresentation | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const candidate = (output as Record<string, unknown>)['presentation'];
  if (!candidate) return undefined;
  const parsed = StepOutputPresentationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export interface ApplyStepSucceededParams {
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
    simulatedFulfillment?: SimulatedFulfillmentReport | null | undefined;
  };
  runHotState: SessionHotState;
  stepDef: StepDefinition | undefined;
  stepState: StepHotState;
  agentDef: AgentDefinition;
  stepUpdates: Partial<StepHotState> & { stepExecutionId: string };
  currentRuntimeState: NonNullable<SessionHotState['runtimeState']>;
  /** Callback to schedule the next step — avoids circular dep on index.ts */
  scheduleStep: (params: ScheduleStepParams) => Promise<StepExecutionId>;
  guardrailGate?: GuardrailGate;
}

export async function applyStepSucceeded(params: ApplyStepSucceededParams): Promise<void> {
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
    currentRuntimeState,
    scheduleStep,
    guardrailGate,
  } = params;
  const now = result.nowMs;
  const fulfillmentMeta = simulatedFulfillmentEventMeta(result.simulatedFulfillment);

  const stepUsage: StepUsageBreakdown | undefined = result.usage ?? undefined;

  // ── Guardrail: on_tool_output ────────────────────────────────────────────
  if (guardrailGate && result.outputRef) {
    const gr = await guardrailGate.check('on_tool_output', result.outputRef, {
      tenantId: result.tenantId,
      runId: result.sessionId,
      target: runHotState.target,
      stepExecutionId: result.stepExecutionId,
      operationId: result.operationId,
    });
    if (!gr.passed) {
      if (gr.action === 'block') {
        const { GuardrailBlockedError } = await import('../../GuardrailGate/index.js');
        throw new GuardrailBlockedError(gr.violations);
      }
      if (gr.action === 'redact' && gr.redactedPayload !== undefined) {
        // Replace the output with the redacted version
        const redactedRef = await payloadStore.store({
          tenantId: result.tenantId as TenantId,
          runId: result.sessionId as SessionId,
          stepExecutionId: result.stepExecutionId as StepExecutionId,
          attempt: result.attempt,
          kind: 'output',
          data: gr.redactedPayload,
        });
        result.outputRef = redactedRef;
      }
    }
  }

  // ── Determine if flow is terminal ─────────────────────────────────────────

  const isEndFlowOp =
    result.operationId === 'agent.control.end' || stepDef?.operation === 'agent.control.end';

  // Per-execution routing for agent.control.run_step: look up the dynamic step
  // tagged with `_routing:<stepExecutionId>`. This avoids the shared-mutation
  // bug where parallel invoke_steps calls would all patch onSuccess and the
  // last writer wins, misrouting all results to one dynamic step.
  let nextStepId: StepId | null;
  if (result.operationId === 'agent.control.run_step' || result.operationId === 'human.chat.ask') {
    const routingTarget = agentDef.steps.find((s) =>
      s.tags.includes(`_routing:${result.stepExecutionId}`),
    );
    nextStepId = routingTarget?.stepId ?? null;
    if (!nextStepId) {
      console.warn(
        `[applyStepSucceeded] No dynamic step found with _routing:${result.stepExecutionId} — ` +
          `falling back to normal routing`,
      );
      nextStepId = resolveNextStep(
        agentDef.steps.find((s) => s.stepId === result.stepId) ??
          ({ onSuccess: { next: [] }, onFailure: { next: [] } } as unknown as StepDefinition),
        'success',
      );
    }
  } else if (isEndFlowOp) {
    nextStepId = null;
  } else {
    nextStepId = resolveNextStep(
      agentDef.steps.find((s) => s.stepId === result.stepId) ??
        ({ onSuccess: { next: [] }, onFailure: { next: [] } } as unknown as StepDefinition),
      'success',
    );
  }
  const isTerminal = nextStepId === null;

  // ── Apply output mapping → runtime state ──────────────────────────────────
  // Skip output mapping for the inline "spawn a child step" ops. Their
  // synthetic SUCCESS output is metadata (the child's stepExecutionId,
  // the resolved tool inputs) — not the real domain result. The child
  // step inherits any output mapping and applies it when the actual
  // tool output arrives.
  const skipOutputMapping =
    result.operationId === 'agent.control.run_step' || result.operationId === 'human.chat.ask';

  const mappingResult = skipOutputMapping
    ? {
        updatedState: currentRuntimeState,
        patch: {
          version: currentRuntimeState.version,
          changed: [] as Array<{ key: string; value: unknown }>,
        },
      }
    : await applyOutputMapping(
        payloadStore,
        currentRuntimeState,
        agentDef,
        result.stepId,
        result.stepExecutionId,
        result.outputRef ?? undefined,
        isTerminal,
        now,
      );
  let { updatedState } = mappingResult;
  const { patch } = mappingResult;

  if (result.stepId.startsWith('wf_task_') && result.outputRef) {
    const taskIdMatch = /^wf_task_(.+?)_[a-f0-9]{8}$/.exec(result.stepId);
    if (taskIdMatch?.[1]) {
      const taskId = taskIdMatch[1];
      const stateKey = `taskOutputs.${taskId}`;
      try {
        const outputData = await payloadStore.retrieve(result.outputRef);
        // Store a summary (up to 4KB) rather than the full payload to avoid bloating state
        const summary =
          typeof outputData === 'string'
            ? outputData.slice(0, 4096)
            : JSON.stringify(outputData).slice(0, 4096);
        writeInlineVar(updatedState.variables, stateKey, summary, {
          nowMs: now,
          stepExecutionId: result.stepExecutionId,
          stepId: result.stepId,
          version: updatedState.version + 1,
        });
      } catch {
        // Best-effort — if payload retrieval fails, write the ref as a pointer
        writeInlineVar(updatedState.variables, stateKey, result.outputRef, {
          nowMs: now,
          stepExecutionId: result.stepExecutionId,
          stepId: result.stepId,
          version: updatedState.version + 1,
        });
      }
    }
  }

  // ── Build tool result summary if next step is an agent turn ───────────────

  let toolResultsForAgent: ToolResultSummary[] | undefined;
  let toolSummaryMeta: ToolSummaryMeta | undefined;
  let resolvedOutputForDisplay: unknown = undefined;
  let presentationForEvent: StepOutputPresentation | undefined;
  let retrievedOutput: unknown = undefined;
  if (result.outputRef) {
    try {
      retrievedOutput = await payloadStore.retrieve(result.outputRef);
      presentationForEvent = extractPresentation(retrievedOutput);
    } catch {
      /* best-effort — missing presentation just means the reducer treats
         the output as `summarize` (the default). */
    }
  }

  // Plan 264 §4.13: a successful ui.applet.get is an explicit act of attention,
  // so it points the session's applet focus at that instance — set here, where
  // the true returned stateVersion exists, because the executor cannot reach
  // the session-scoped focus store. Best-effort: focus is an affordance, and
  // losing a write only costs the sole-active fallback on the next turn.
  const appletFocusOp = stepDef?.operation ?? result.operationId;
  if (appletFocusOp === UI_APPLET_GET_OPERATION_ID) {
    const parsedGet = UiAppletGetOutputSchema.safeParse(retrievedOutput);
    if (parsedGet.success && parsedGet.data.instance.status === 'active') {
      try {
        await setAppletFocus(redis, result.tenantId, {
          sessionId: result.sessionId,
          instanceId: parsedGet.data.instance.instanceId,
          source: 'explicit_agent_focus',
          version: parsedGet.data.stateVersion,
        });
      } catch {
        /* swallowed */
      }
    }
  }
  // A freshly instantiated applet is the current one by any reading of intent
  // — without this, a stale explicit focus from a pre-instantiate read keeps
  // routing lowered actions at the OLD instance once two are active, and the
  // sole-active fallback can no longer break the tie.
  if (appletFocusOp === UI_APPLET_INSTANTIATE_OPERATION_ID) {
    const parsedNew = UiAppletInstantiateOutputSchema.safeParse(retrievedOutput);
    if (parsedNew.success) {
      try {
        await setAppletFocus(redis, result.tenantId, {
          sessionId: result.sessionId,
          instanceId: parsedNew.data.instance.instanceId,
          source: 'explicit_agent_focus',
          version: parsedNew.data.stateVersion,
        });
      } catch {
        /* swallowed */
      }
    }
  }
  if (nextStepId) {
    const nextStepDef = agentDef.steps.find((s) => s.stepId === nextStepId);
    if (nextStepDef?.operation === 'ai.agent.turn' && shouldPassResultToAgent(stepState, stepDef)) {
      // For dynamic steps (created by agent.control.run_step), attribute the tool
      // result to the parent run_step's stepId so it matches the agent's tool call.
      const isDynamic = stepDef?.tags.includes('dynamic');
      const toolIdTag = isDynamic ? stepDef?.tags.find((t) => t.startsWith('_toolId:')) : undefined;
      const parentTag = isDynamic ? stepDef?.tags.find((t) => t.startsWith('parent:')) : undefined;
      const attributionStepId = toolIdTag
        ? toolIdTag.slice('_toolId:'.length)
        : parentTag
          ? parentTag.slice('parent:'.length)
          : (stepDef?.stepId ?? result.stepId);

      // Determine the actual operation that executed (not agent.control.run_step)
      const actualOperationId = stepDef?.operation ?? result.operationId;

      // Determine which state variables the output was stored in via outputMapping
      const outputStoredIn: string[] = [];
      if (stepDef?.outputMapping && !skipOutputMapping) {
        for (const statePath of Object.values(stepDef.outputMapping)) {
          const varKey = statePath.startsWith('state.') ? statePath.slice(6) : statePath;
          outputStoredIn.push(varKey);
        }
      }

      const displayedToUser = stepDef?.outputOptions?.displayToUser === true;

      // Calculate duration from step hot state timestamps
      const stepStartedAt = stepUpdates.startedAt;
      const durationMs = stepStartedAt ? now - stepStartedAt : undefined;

      // Virtual tools stamp `_toolCallId:` on step tags; graph tools persist
      // their compact id in the `ai.agent._toolCallIdByStepExecution` runtime
      // map. Either yields the agent's recorded compact id for Gemini pairing.
      const preResolvedToolCallId =
        toolCallIdFromStepTags(stepDef) ??
        toolCallIdFromRuntimeMap(updatedState, result.stepExecutionId);
      let matchedToolCallId = preResolvedToolCallId ?? result.stepExecutionId;

      let resolvedOutput: unknown = undefined;
      if (result.outputRef) {
        try {
          resolvedOutput = await payloadStore.retrieve(result.outputRef);
        } catch {
          /* ignore */
        }
      }

      if (displayedToUser && resolvedOutput != null) {
        resolvedOutputForDisplay = resolvedOutput;
      }

      // Both the history entry and the agent tool result carry the SAME
      // summary — memoized so the pipeline runs once per step. Safe because
      // matchedToolCallId is final before either consumer runs.
      let memoizedSummary: { text: string; meta: ToolSummaryMeta } | undefined;
      const summarizeOutput = (): { text: string; meta: ToolSummaryMeta } | undefined => {
        if (memoizedSummary === undefined && resolvedOutput != null) {
          memoizedSummary = buildToolResultSummaryWithMeta(
            resolvedOutput,
            matchedToolCallId,
            actualOperationId,
          );
        }
        return memoizedSummary;
      };

      // Update agent conversation history with this tool result.
      // IMPORTANT: Capture the updated state from storeConversation so the
      // history ref is included in the runtime state passed to the next step
      // and in the runtimeStatePatch emitted with the StepSucceeded event.
      if (isHistoryEnabled(nextStepDef)) {
        try {
          const agentConversation = await loadOrCreateConversation(
            payloadStore,
            result.tenantId,
            result.sessionId,
            nextStepId,
            updatedState,
          );

          // Last fallback: name-match against the assistant's recorded calls.
          // recordAssistantResponse writes deterministic IDs (compactStepExecId_N).
          // For parallel same-tool calls (invoke_steps calling the same step
          // twice), skip IDs already consumed by existing tool result messages.
          const historyMatchedId =
            matchToolCallIdFromAssistantHistory(agentConversation, attributionStepId) ??
            result.stepExecutionId;
          const toolCallId = preResolvedToolCallId ?? historyMatchedId;
          matchedToolCallId = toolCallId;

          const historySummary = summarizeOutput()?.text;
          const historyToolResult: AiToolResult = {
            toolCallId,
            name: attributionStepId,
            status: 'SUCCEEDED',
            summary: historySummary ? { text: historySummary } : undefined,
            resultMeta: {
              operationId: actualOperationId,
              ...(outputStoredIn.length > 0 ? { outputStoredIn } : {}),
              displayedToUser,
              ...(durationMs != null ? { durationMs } : {}),
            },
            ...(result.outputRef ? { outputRef: result.outputRef } : {}),
          };
          agentConversation.messages.push(
            createMessage('tool', undefined, {
              toolResult: historyToolResult,
            }),
          );
          agentConversation.updatedAtMs = now;

          const historyResult = await storeConversation(
            payloadStore,
            agentConversation,
            updatedState,
            nextStepId,
            result.stepExecutionId,
            now,
          );
          // Propagate the updated state (with fresh history ref) so scheduleStep
          // and the StepSucceeded event both carry the latest history variable.
          updatedState = historyResult.updatedState;

          // Append history entries to the runtimeStatePatch for the event
          for (const entry of historyResult.patchEntries) {
            // Check if patch already has this key
            const existing = patch.changed.findIndex((c: { key: string }) => c.key === entry.key);
            if (existing >= 0) {
              patch.changed[existing] = entry;
            } else {
              patch.changed.push(entry);
            }
          }
        } catch (err) {
          logOrchestratorError(
            `[SessionOrchestrator] Failed to update agent history with tool result:`,
            err,
            {
              tenantId: result.tenantId,
              sessionId: result.sessionId,
              stepExecutionId: result.stepExecutionId,
              stepId: result.stepId,
            },
          );
        }
      }

      if (result.outputRef && matchedToolCallId) {
        const indexVarKey = '_tool_outputs';
        const currentIndex = readInlineVar(
          updatedState,
          indexVarKey,
          {} as Record<string, string | ToolOutputEntry>,
        );
        // Detect available output fields for virtual path listing
        const fields = resolvedOutput != null ? detectOutputFields(resolvedOutput) : [];
        const enrichedEntry: ToolOutputEntry = {
          ref: result.outputRef,
          stepId: stepDef?.stepId ?? result.stepId,
          operation: actualOperationId,
          fields,
        };
        const newIndex = { ...currentIndex, [matchedToolCallId]: enrichedEntry };
        updatedState.variables[indexVarKey] = {
          ref: { kind: 'inline', value: newIndex },
          updatedAtMs: now,
          updatedBy: {
            stepExecutionId: result.stepExecutionId,
            stepId: result.stepId,
            actor: 'orchestrator' as const,
          },
        };
        patch.changed.push({ key: indexVarKey, value: updatedState.variables[indexVarKey] });
      }

      const toolSummary = summarizeOutput()?.text;
      toolSummaryMeta = summarizeOutput()?.meta;
      const toolResult: ToolResultSummary = {
        toolCallId: matchedToolCallId,
        toolId: attributionStepId,
        name: attributionStepId,
        status: 'SUCCEEDED',
        ...(toolSummary != null ? { summary: toolSummary } : {}),
        operationId: actualOperationId,
        displayedToUser,
      };
      if (outputStoredIn.length > 0) toolResult.outputStoredIn = outputStoredIn;
      if (durationMs != null) toolResult.durationMs = durationMs;
      if (result.outputRef) {
        toolResult.hasOutputRef = true;
        // Surface detected fields so agents know exact virtual paths available
        const outputFields =
          resolvedOutput != null ? detectOutputFields(resolvedOutput) : undefined;
        if (outputFields && outputFields.length > 0) {
          toolResult.outputFields = outputFields;
        }
      }
      const images = resolvedOutput != null ? findStepImages(resolvedOutput) : [];
      if (images.length > 0) toolResult.images = images;
      const opDescriptor = getOperation(actualOperationId);
      const followUp = opDescriptor?.usage.followUp;
      if (followUp && followUp.length > 0) {
        const steps: Array<{ action: string; note: string }> = [];
        for (const f of followUp) {
          if (steps.length >= 3) break;
          if (f.condition === 'always') {
            steps.push({ action: f.operationId, note: f.note });
          } else {
            // 'when_available' — check the operation exists and is agent-facing.
            // We don't have the agent's actual tool surface here, so this is a
            // best-effort filter. Privileged/scoped ops may still appear. The
            // note should guide the agent to discover via catalog if needed.
            const targetOp = getOperation(f.operationId);
            if (targetOp && targetOp.agentTool && !targetOp.internal) {
              steps.push({
                action: f.operationId,
                note:
                  f.note +
                  (targetOp.privileged ? ' (use catalog.tool.search to check availability)' : ''),
              });
            }
          }
        }
        if (steps.length > 0) toolResult.nextSteps = steps;
      }

      toolResultsForAgent = [toolResult];

      const failuresVarKey = `ai.agent.toolFailures.${nextStepId}`;
      const toolFailures = readInlineVar(
        updatedState,
        failuresVarKey,
        {} as Record<string, number>,
      );
      if (toolFailures[attributionStepId] != null && toolFailures[attributionStepId] > 0) {
        const resetFailures = { ...toolFailures };
        delete resetFailures[attributionStepId];
        const failVars = { ...updatedState.variables };
        writeInlineVar(failVars, failuresVarKey, resetFailures, {
          nowMs: now,
          stepExecutionId: result.stepExecutionId,
          stepId: result.stepId,
        });
        updatedState = {
          ...updatedState,
          variables: failVars,
        };
      }
    }
  }

  // ── Check if this step's output should be displayed to the user ──────────
  const hasDisplayTag = stepDef?.outputOptions?.displayToUser === true;

  // ── Parallel barrier: accumulate tool results until all parallel calls complete ──
  // When the agent uses invoke_steps to dispatch N parallel tool calls,
  // applyAgentDecision sets pendingToolCallCount = N. Each completion
  // decrements the count and accumulates its result. The agent turn is only
  // scheduled when the last result arrives (count reaches 0).
  let barrierActive = false;
  let barrierRemaining = 0;
  let allAccumulatedResults: ToolResultSummary[] | undefined;

  if (nextStepId && toolResultsForAgent && toolResultsForAgent.length > 0) {
    const nextStepDef = agentDef.steps.find((s) => s.stepId === nextStepId);
    if (nextStepDef?.operation === 'ai.agent.turn') {
      const pendingCountKey = `ai.agent.pendingToolCallCount.${nextStepId}`;
      const pendingResultsKey = `ai.agent.pendingToolResults.${nextStepId}`;
      const currentCount = readInlineVar<number>(updatedState, pendingCountKey, 0);

      if (currentCount > 0) {
        barrierActive = true;
        const newCount = currentCount - 1;
        barrierRemaining = newCount;

        const accumulated: ToolResultSummary[] = readInlineVar(
          updatedState,
          pendingResultsKey,
          [] as ToolResultSummary[],
        );
        accumulated.push(...toolResultsForAgent);

        const newVars = { ...updatedState.variables };
        newVars[pendingCountKey] = {
          ref: { kind: 'inline', value: newCount },
          updatedAtMs: now,
          updatedBy: { actor: 'orchestrator', stepId: result.stepId },
          version: currentCount + 1,
        };
        newVars[pendingResultsKey] = {
          ref: { kind: 'inline', value: accumulated },
          updatedAtMs: now,
          updatedBy: { actor: 'orchestrator', stepId: result.stepId },
          version: accumulated.length,
        };
        updatedState = {
          ...updatedState,
          variables: newVars,
          version: updatedState.version + 1,
          updatedAtMs: now,
        };

        if (newCount === 0) {
          allAccumulatedResults = accumulated;
          await removeBarrierWatchdog(redis, result.tenantId, result.sessionId, nextStepId).catch(
            () => {},
          );
        }
      }
    }
  }

  // ── Guardrail: on_run_output (only for terminal) ──────────────────────────
  if (isTerminal && guardrailGate && result.outputRef) {
    const gr = await guardrailGate.check('on_run_output', result.outputRef, {
      tenantId: result.tenantId,
      runId: result.sessionId,
      target: runHotState.target,
    });
    if (!gr.passed && gr.action === 'block') {
      const { GuardrailBlockedError } = await import('../../GuardrailGate/index.js');
      throw new GuardrailBlockedError(gr.violations);
    }
  }

  const updatedUsageSummary = accumulateUsageSummary(runHotState.usageSummary, stepUsage);

  // ── Terminal: emit StepSucceeded + SessionCompleted ───────────────────────

  if (isTerminal) {
    const outputVariables = buildOutputVariables(updatedState, agentDef);

    const runUpdates: Partial<SessionHotState> & { sessionId: string } = {
      sessionId: result.sessionId,
      status: 'SUCCEEDED',
      endedAt: now,
      finalOutputRef: result.outputRef ?? undefined,
      runtimeState: updatedState,
      usageSummary: updatedUsageSummary,
      ...getClearedDelegationStatePatch(),
    };

    const stepSucceededEvent: SessionEvent = {
      eventId: eventId(),
      eventType: 'StepSucceeded',
      timestamp: now,
      sessionId: result.sessionId,
      stepId: result.stepId,
      stepExecutionId: result.stepExecutionId,
      stepType: result.stepType,
      attempt: result.attempt,
      outputRef: result.outputRef ?? undefined,
      runtimeStatePatch: patch.changed.length > 0 ? patch : undefined,
      usage: stepUsage,
      ...(presentationForEvent ? { presentation: presentationForEvent } : {}),
      metadata: {
        stepName: stepDef?.name ?? result.stepId,
        operationId: stepDef?.operation ?? result.operationId,
        ...(hasDisplayTag ? { displayOutput: true } : {}),
        ...(stepUsage ? { costJson: stepUsage } : {}),
        ...fulfillmentMeta,
      },
    };

    const flowSucceededEvent: SessionEvent = {
      eventId: eventId(),
      eventType: 'SessionCompleted',
      timestamp: now,
      sessionId: result.sessionId,
      stepId: result.stepId,
      stepExecutionId: result.stepExecutionId,
      outputRef: result.outputRef ?? undefined,
      outputVariables: outputVariables.length > 0 ? outputVariables : undefined,
      usageSummary: updatedUsageSummary,
      metadata: {
        stepName: stepDef?.name ?? result.stepId,
        operationId: stepDef?.operation ?? result.operationId,
      },
    };

    // Build recovery events for terminal step completion + run succeeded
    const terminalRecoveryEvents = await buildStepCompletedRecoveryEvents(
      redis,
      result.tenantId,
      result.sessionId,
      result.stepExecutionId,
      'SUCCEEDED',
      { outputRef: result.outputRef },
      { from: 'RUNNING', to: 'SUCCEEDED' },
    );

    await atomicCompleteStep(
      redis,
      result.tenantId,
      stepUpdates,
      runUpdates,
      [stepSucceededEvent, flowSucceededEvent],
      undefined,
      terminalRecoveryEvents,
    );

    await markRunInactive(redis, result.tenantId, result.sessionId).catch(() => {});

    try {
      const { forwardEventToParent } = await import('./forwardChildEvent.js');
      // Forward StepSucceeded first (carries outputRef + usage for unified timeline)
      await forwardEventToParent(redis, result.tenantId, result.sessionId, stepSucceededEvent);
      await forwardEventToParent(redis, result.tenantId, result.sessionId, flowSucceededEvent);
    } catch {
      // Best-effort forwarding
    }

    // Emit guardrail run summary at run completion
    if (guardrailGate) {
      await guardrailGate.emitRunSummary(result.tenantId, result.sessionId).catch(() => {});
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
          { outputRef: result.outputRef ?? null },
        );
      } catch (harnessErr) {
        logOrchestratorError(
          `[applyStepSucceeded] Runner-terminal harness route failed for ${result.sessionId}:`,
          harnessErr,
          {
            tenantId: result.tenantId,
            sessionId: result.sessionId,
            workflowExecution: runHotState.workflowExecution,
          },
        );
      }
      return;
    }

    // If this run is a subflow with a waiting parent, enqueue the
    try {
      await enqueuePendingAndReconcile({
        redis,
        payloadStore,
        tenantId: result.tenantId,
        childRunId: result.sessionId,
        reason: 'applyStepSucceeded:terminal_success',
      });
    } catch (resumeErr) {
      if (isDelegationUpsertFailure(resumeErr)) throw resumeErr;
      logOrchestratorError(
        `[applyStepSucceeded] Failed to resume parent after child ${result.sessionId} succeeded:`,
        resumeErr,
        { tenantId: result.tenantId, sessionId: result.sessionId },
      );
    }

    return;
  }

  // ── Continuing: emit StepSucceeded then schedule next ────────────────────

  const continueStepEvent: SessionEvent = {
    eventId: eventId(),
    eventType: 'StepSucceeded',
    timestamp: now,
    sessionId: result.sessionId,
    stepId: result.stepId,
    stepExecutionId: result.stepExecutionId,
    stepType: result.stepType,
    attempt: result.attempt,
    outputRef: result.outputRef ?? undefined,
    runtimeStatePatch: patch.changed.length > 0 ? patch : undefined,
    usage: stepUsage,
    ...(presentationForEvent ? { presentation: presentationForEvent } : {}),
    metadata: {
      stepName: stepDef?.name ?? result.stepId,
      operationId: stepDef?.operation ?? result.operationId,
      ...(hasDisplayTag ? { displayOutput: true } : {}),
      ...(stepUsage ? { costJson: stepUsage } : {}),
      ...(toolSummaryMeta ? { toolSummary: toolSummaryMeta } : {}),
      ...fulfillmentMeta,
      ...(hasDisplayTag && resolvedOutputForDisplay != null
        ? (() => {
            const opDesc = getOperation(stepDef.operation);
            return {
              resolvedOutput: {
                kind: 'inline' as const,
                value: resolvedOutputForDisplay,
                ...(opDesc?.outputSemanticType ? { semanticType: opDesc.outputSemanticType } : {}),
              },
            };
          })()
        : {}),
    },
  };

  const runUpdatesForContinue: Partial<SessionHotState> & { sessionId: string } = {
    sessionId: result.sessionId,
    runtimeState: updatedState,
    usageSummary: updatedUsageSummary,
  };

  // Build recovery events for non-terminal step completion
  const continueRecoveryEvents = await buildStepCompletedRecoveryEvents(
    redis,
    result.tenantId,
    result.sessionId,
    result.stepExecutionId,
    'SUCCEEDED',
    { outputRef: result.outputRef },
  );

  await atomicCompleteStep(
    redis,
    result.tenantId,
    stepUpdates,
    runUpdatesForContinue,
    continueStepEvent,
    undefined,
    continueRecoveryEvents,
  );

  try {
    const { forwardEventToParent } = await import('./forwardChildEvent.js');
    await forwardEventToParent(redis, result.tenantId, result.sessionId, continueStepEvent);
  } catch {
    // Best-effort forwarding
  }

  // ── Parallel barrier gate: hold scheduling until all results arrive ──────
  if (barrierActive && barrierRemaining > 0) {
    return;
  }

  if (!result.outputRef) {
    console.warn(`No output ref for step ${result.stepExecutionId}, skipping next step scheduling`);
    return;
  }

  if (nextStepId === null) {
    console.warn(`[applyStepSucceeded] Invariant: nextStepId must be defined when continuing`);
    return;
  }

  if (runHotState.interruptRequested) {
    const now = Date.now();

    // Check if the next step is an agent turn — build a resumeContract
    // so resumeRun() maps the user's input correctly.
    const nextStepDef = agentDef.steps.find((s) => s.stepId === nextStepId);
    let requestedInputRef: string | undefined;
    if (nextStepDef?.operation === 'ai.agent.turn') {
      const chatVarId = `ai.agent.chatInput.${nextStepId}`;
      const payload = {
        reason: 'input_required',
        stepId: nextStepId,
        missingVariables: [{ variableId: chatVarId, name: 'Message', required: true }],
        resumeContract: {
          reason: 'input_required' as const,
          mode: 'primary' as const,
          stepId: nextStepId,
          targetVariableId: chatVarId,
          requiredFields: [{ variableId: chatVarId, name: 'Message', required: true }],
          prompt: 'Flow was interrupted. Send a message to continue.',
        },
        prompt: 'Flow was interrupted. Send a message to continue.',
      };
      requestedInputRef = `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
    }

    await atomicCompleteStep(
      redis,
      result.tenantId,
      { stepExecutionId: result.stepExecutionId },
      {
        sessionId: result.sessionId,
        status: 'PAUSED',
        pauseReason: 'interrupted',
        interruptRequested: false,
        pauseType: 'interrupted',
        pauseMetadataJson: JSON.stringify({ pauseType: 'interrupted' }),
        currentStepId: nextStepId,
        currentStepExecutionId: result.stepExecutionId,
        ...(requestedInputRef ? { requestedInputRef } : {}),
      },
      {
        eventId: eventId(),
        eventType: 'SessionPaused',
        timestamp: now,
        sessionId: result.sessionId,
        stepId: result.stepId,
        stepExecutionId: result.stepExecutionId,
        stepType: result.stepType,
        attempt: result.attempt,
        ...(requestedInputRef ? { requestedInputRef } : {}),
        metadata: {
          pauseReason: 'interrupted',
          pauseType: 'interrupted',
        },
      },
    );

    await routeSessionPauseToSubscribers(
      { redis, payloadStore, db, ...(guardrailGate ? { guardrailGate } : {}) },
      {
        tenantId: result.tenantId,
        runId: result.sessionId,
        traceId: result.traceId,
        runState: runHotState,
        contractRef: requestedInputRef ?? null,
        pauseReason: 'Session was interrupted mid-flow',
      },
    );
    return;
  }

  const resolvedInputRef = result.outputRef;

  const scheduleParams: ScheduleStepParams = {
    context: {
      tenantId: result.tenantId as TenantId,
      runId: result.sessionId as SessionId,
      agentDefinition: agentDef,
      traceId: result.traceId as TraceId,
    },
    stepId: nextStepId,
    inputRef: resolvedInputRef,
  };
  if (allAccumulatedResults) {
    scheduleParams.lastToolResults = allAccumulatedResults;
  } else if (toolResultsForAgent) {
    scheduleParams.lastToolResults = toolResultsForAgent;
  }
  await scheduleStep(scheduleParams);
}

function shouldPassResultToAgent(
  stepState: StepHotState,
  stepDef: StepDefinition | undefined,
): boolean {
  if (stepState.parentStepExecutionId) {
    return true;
  }

  return (
    stepDef != null &&
    stepDef.tags.includes('dynamic') &&
    stepDef.tags.some((tag) => tag.startsWith('parent:'))
  );
}
