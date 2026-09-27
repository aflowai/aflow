import type { Redis } from 'ioredis';
import type { EvalTranscript, AgentTurnTranscript, StepTranscript } from '@aflow/schemas/eval';
import { agentTargetKey } from '@aflow/schemas';
import { readSessionEvents, getSessionStateSafe, type SessionEvent } from './hotState.js';

/** Minimal interface for payload retrieval — compatible with PayloadStore. */
export interface PayloadRetriever {
  retrieve(ref: string): Promise<unknown>;
}

/** Maximum bytes to inline in a transcript field. */
const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;
const MAX_INLINE_TOOL_BYTES = 16 * 1024;

export interface TranscriptBuilderDeps {
  redis: Redis;
  payloadRetriever: PayloadRetriever;
}

/**
 * Read ALL events for a run from Redis (paginated reads).
 */
async function readAllRunEvents(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<SessionEvent[]> {
  const allEvents: SessionEvent[] = [];
  let cursor = '0';

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const { events, lastId } = await readSessionEvents(redis, tenantId, runId, cursor, 500);
    allEvents.push(...events);
    if (events.length === 0 || lastId === cursor) break;
    cursor = lastId;
  }

  return allEvents;
}

/**
 * Attempt to inline a payload if it is small enough.
 * Returns undefined if the payload is too large or absent.
 */
async function tryInlinePayload(
  retriever: PayloadRetriever,
  ref: string | undefined,
  maxBytes: number,
): Promise<unknown> {
  if (!ref) return undefined;

  try {
    const data = await retriever.retrieve(ref);
    const serialized = JSON.stringify(data);
    if (serialized.length <= maxBytes) {
      return data;
    }
  } catch {
    // Payload may have expired or be unavailable — skip inlining
  }
  return undefined;
}

/**
 * Build an EvalTranscript from a completed run's events.
 * Returns null if no events found.
 */
export async function buildTranscript(
  deps: TranscriptBuilderDeps,
  tenantId: string,
  runId: string,
): Promise<EvalTranscript | null> {
  const events = await readAllRunEvents(deps.redis, tenantId, runId);

  if (events.length === 0) return null;

  // ---- Extract timing from run lifecycle events ----
  let startedAtMs = 0;
  let finishedAtMs = 0;
  let finalStatus = 'UNKNOWN';
  let finalOutputRef: string | undefined;
  let inputRef: string | undefined;
  let flowId = '';
  let flowVersion: string | undefined;
  let runtimeState: Record<string, unknown> | undefined;

  // Collect step info keyed by stepExecutionId
  const stepMap = new Map<
    string,
    {
      stepId: string;
      stepType: string;
      operationId?: string;
      parentStepExecutionId?: string;
      status: string;
      inputRef?: string;
      outputRef?: string;
      errorRef?: string;
      scheduledAt: number;
      startedAt?: number;
      endedAt?: number;
      attempt?: number;
    }
  >();

  for (const event of events) {
    switch (event.eventType) {
      case 'SessionQueued':
      case 'SessionStarted':
        startedAtMs = event.timestamp;
        break;

      case 'SessionCompleted':
        finishedAtMs = event.timestamp;
        finalStatus = 'SUCCEEDED';
        finalOutputRef = event.outputRef;
        if (event.outputRef) finalOutputRef = event.outputRef;
        break;

      case 'SessionFailed':
        finishedAtMs = event.timestamp;
        finalStatus = 'FAILED';
        break;

      case 'SessionCancelled':
        finishedAtMs = event.timestamp;
        finalStatus = 'CANCELLED';
        break;

      case 'StepScheduled': {
        const seId = event.stepExecutionId;
        if (seId) {
          const md = event.metadata;
          const entry: {
            stepId: string;
            stepType: string;
            operationId?: string;
            parentStepExecutionId?: string;
            status: string;
            inputRef?: string;
            scheduledAt: number;
            startedAt?: number;
            endedAt?: number;
            outputRef?: string;
            errorRef?: string;
            attempt?: number;
          } = {
            stepId: event.stepId ?? '',
            stepType: event.stepType ?? '',
            status: 'SCHEDULED',
            scheduledAt: event.timestamp,
          };
          const opId = md?.['operationId'] as string | undefined;
          if (opId) entry.operationId = opId;
          const parentId = md?.['parentStepExecutionId'] as string | undefined;
          if (parentId) entry.parentStepExecutionId = parentId;
          const inRef = md?.['inputRef'] as string | undefined;
          if (inRef) entry.inputRef = inRef;
          if (event.attempt !== undefined) entry.attempt = event.attempt;
          stepMap.set(seId, entry);
        }
        break;
      }

      case 'StepStarted': {
        const seId = event.stepExecutionId;
        if (seId) {
          const existing = stepMap.get(seId);
          if (existing) {
            existing.startedAt = event.timestamp;
            existing.status = 'STARTED';
          }
        }
        break;
      }

      case 'StepSucceeded': {
        const seId = event.stepExecutionId;
        if (seId) {
          const existing = stepMap.get(seId);
          if (existing) {
            existing.endedAt = event.timestamp;
            existing.status = 'SUCCEEDED';
            if (event.outputRef) existing.outputRef = event.outputRef;
          }
        }
        break;
      }

      case 'StepFailed': {
        const seId = event.stepExecutionId;
        if (seId) {
          const existing = stepMap.get(seId);
          if (existing) {
            existing.endedAt = event.timestamp;
            existing.status = 'FAILED';
            if (event.errorRef) existing.errorRef = event.errorRef;
          }
        }
        break;
      }

      case 'StepPaused':
      case 'SessionPaused':
      case 'SessionResumed':
      case 'SessionRetried':
      case 'SessionStalled':
      case 'RoomMessage':
      case 'ControlRejected':
      case 'AuthorityLost':
      case 'GuardrailViolation':
      case 'GuardrailRunSummary':
      case 'SubflowEventForwarded':
      case 'SurfaceUpdate':
      case 'WorkflowTaskUpdate':
      case 'WorkflowRunUpdate':
      case 'WorkflowTaskActivity':
      case 'WorkflowTaskSurfaceUpdate':
      case 'McpElicitationRequested':
      case 'McpElicitationResolved':
      case 'McpElicitationTimedOut':
      case 'McpElicitationExecutorLost':
        break;

      default:
        break;
    }

    // Track runtime state patches
    if (event.runtimeStatePatch) {
      if (!runtimeState) runtimeState = {};
      for (const change of event.runtimeStatePatch.changed) {
        runtimeState[change.key] = change.value;
      }
    }
  }

  const hotResult = await getSessionStateSafe(deps.redis, tenantId, runId);
  if (hotResult.ok) {
    flowId = agentTargetKey(hotResult.state.target);
    flowVersion = hotResult.state.agentVersion;
    inputRef = hotResult.state.inputRef;
    if (hotResult.state.runtimeState) {
      runtimeState = hotResult.state.runtimeState.variables;
    }
    if (!finalOutputRef) finalOutputRef = hotResult.state.finalOutputRef;
    if (finalStatus === 'UNKNOWN') finalStatus = hotResult.state.status;
  }

  // ---- Build steps array ----
  const steps: StepTranscript[] = [];
  for (const [seId, step] of stepMap) {
    const durationMs = step.endedAt && step.startedAt ? step.endedAt - step.startedAt : 0;
    steps.push({
      stepExecutionId: seId,
      stepId: step.stepId,
      stepType: step.stepType,
      operationId: step.operationId,
      parentStepExecutionId: step.parentStepExecutionId,
      status: step.status,
      inputRef: step.inputRef,
      outputRef: step.outputRef,
      errorRef: step.errorRef,
      durationMs,
      attempt: step.attempt,
    });
  }

  // ---- Build agent turns (only match ai.agent.turn operation) ----
  const agentTurnSteps = steps.filter((s) => s.operationId === 'ai.agent.turn');

  const turns: AgentTurnTranscript[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalToolCalls = 0;
  const modelsUsed = new Set<string>();

  for (let i = 0; i < agentTurnSteps.length; i++) {
    const turnStep = agentTurnSteps[i]!;

    // Load output payload to extract agent decision details
    let decision: Record<string, unknown> = {};
    let reasoning: string | undefined;
    let usage: AgentTurnTranscript['usage'] = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    if (turnStep.outputRef) {
      try {
        const output = (await deps.payloadRetriever.retrieve(turnStep.outputRef)) as
          Record<string, unknown> | undefined;
        if (output) {
          decision = (output['decision'] as Record<string, unknown> | undefined) ?? output;
          reasoning = output['reasoning'] as string | undefined;
          const u = output['usage'] as Record<string, number> | undefined;
          if (u) {
            // The cache split is carried through only when the provider
            // reported it — omitted stays omitted, so a provider that does not
            // cache reads as "unknown" rather than as a zero hit rate.
            usage = {
              promptTokens: u['promptTokens'] ?? u['prompt_tokens'] ?? 0,
              completionTokens: u['completionTokens'] ?? u['completion_tokens'] ?? 0,
              totalTokens: u['totalTokens'] ?? u['total_tokens'] ?? 0,
              ...(u['cacheReadTokens'] !== undefined
                ? { cacheReadTokens: u['cacheReadTokens'] }
                : {}),
              ...(u['cacheWriteTokens'] !== undefined
                ? { cacheWriteTokens: u['cacheWriteTokens'] }
                : {}),
              ...(u['uncachedPromptTokens'] !== undefined
                ? { uncachedPromptTokens: u['uncachedPromptTokens'] }
                : {}),
            };
          }
          const model = output['model'] as string | undefined;
          if (model) modelsUsed.add(model);
        }
      } catch {
        // Payload unavailable — use defaults
      }
    }

    totalPromptTokens += usage.promptTokens;
    totalCompletionTokens += usage.completionTokens;

    // Find child tool call steps
    const childSteps = steps.filter((s) => s.parentStepExecutionId === turnStep.stepExecutionId);

    const toolCalls: AgentTurnTranscript['toolCalls'] = [];
    for (const child of childSteps) {
      const args = await tryInlinePayload(
        deps.payloadRetriever,
        child.inputRef,
        MAX_INLINE_TOOL_BYTES,
      );
      const result = await tryInlinePayload(
        deps.payloadRetriever,
        child.outputRef,
        MAX_INLINE_TOOL_BYTES,
      );

      toolCalls.push({
        stepId: child.stepId,
        operationId: child.operationId,
        args,
        result,
        status: child.status,
        durationMs: child.durationMs,
      });
      totalToolCalls++;
    }

    turns.push({
      stepExecutionId: turnStep.stepExecutionId,
      turnNumber: i,
      decision,
      reasoning,
      toolCalls,
      usage,
      durationMs: turnStep.durationMs,
    });
  }

  // ---- Inline final output if small enough ----
  const finalOutput = await tryInlinePayload(
    deps.payloadRetriever,
    finalOutputRef,
    MAX_INLINE_OUTPUT_BYTES,
  );

  // ---- Inline run input if small enough ----
  const input = await tryInlinePayload(deps.payloadRetriever, inputRef, MAX_INLINE_OUTPUT_BYTES);

  const totalDurationMs = finishedAtMs && startedAtMs ? finishedAtMs - startedAtMs : 0;
  const totalTokensVal = totalPromptTokens + totalCompletionTokens;

  return {
    runId,
    flowId,
    flowVersion,
    startedAtMs,
    finishedAtMs,
    totalDurationMs,
    finalStatus,
    finalOutputRef,
    finalOutput,
    turns,
    steps,
    totalTokens: {
      prompt: totalPromptTokens,
      completion: totalCompletionTokens,
      total: totalTokensVal,
    },
    totalToolCalls,
    totalTurns: turns.length,
    modelsUsed: [...modelsUsed],
    runtimeState,
    inputRef,
    input,
  };
}
