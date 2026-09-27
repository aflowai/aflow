import type { Redis } from 'ioredis';
import { getSessionState, getStepState, appendSessionEvent, type SessionEvent } from '@aflow/redis';

/** Maximum subflow nesting depth for event forwarding. */
const MAX_FORWARD_DEPTH = 3;

/** Event types that qualify for forwarding to the parent stream. */
const FORWARDABLE_EVENT_TYPES = new Set([
  'StepSucceeded',
  'StepScheduled',
  'StepFailed',
  'SessionCompleted',
  'SessionFailed',
  // Allow already-forwarded envelopes to continue up nested subflow chains
  // (e.g. Worker → Driver → Executive). Without this, recursive forwarding
  // always bails at depth 1 and grandparents never see subagent chat.
  'SubflowEventForwarded',
]);

/**
 * Check if a child event qualifies for forwarding.
 *
 * All step lifecycle events (StepScheduled, StepSucceeded, StepFailed) and
 * session terminal events always forward — the parent UI needs them for
 * unified timeline rendering (step cards with input/output, cost data,
 * error details) and activity bubble labels.
 *
 * SubflowEventForwarded envelopes qualify if the wrapped (source) event
 * would itself qualify — this enables multi-level bubbling without nesting.
 */
function shouldForward(event: SessionEvent): boolean {
  if (!FORWARDABLE_EVENT_TYPES.has(event.eventType)) return false;

  if (event.eventType === 'SubflowEventForwarded') {
    const meta = event.metadata;
    if (!meta) return false;
    const sourceEventType = meta['sourceEventType'] as string | undefined;
    return sourceEventType != null && FORWARDABLE_EVENT_TYPES.has(sourceEventType);
  }

  // All other forwardable types (StepScheduled, StepSucceeded, StepFailed,
  // SessionCompleted, SessionFailed) forward unconditionally.
  return true;
}

/**
 * Forward a qualifying child event to the parent's event stream.
 *
 * Wraps the child event in a `SubflowEventForwarded` envelope and appends
 * it to the parent run's event stream. Recursively forwards up the chain
 * for nested subflows (up to MAX_FORWARD_DEPTH).
 */
export async function forwardEventToParent(
  redis: Redis,
  tenantId: string,
  childRunId: string,
  childEvent: SessionEvent,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_FORWARD_DEPTH) {
    console.warn(
      `[forwardSubflowEvent] Max forwarding depth (${MAX_FORWARD_DEPTH}) reached ` +
        `for child run ${childRunId} — skipping`,
    );
    return;
  }

  if (!shouldForward(childEvent)) return;

  const childState = await getSessionState(redis, tenantId, childRunId);
  if (!childState?.parentSessionId) return;

  const parentRunId = childState.parentSessionId;

  // Verify parent is actually waiting for this child
  const parentState = await getSessionState(redis, tenantId, parentRunId);
  if (!parentState) return;

  const waitingIds = parentState.waitingForChildSessionIds ?? [];
  if (!waitingIds.includes(childRunId)) return;

  // Resolve the parent's subflow step name for UI display
  let subflowStepName: string | undefined;
  if (childState.parentStepExecutionId) {
    try {
      const parentStepState = await getStepState(redis, tenantId, childState.parentStepExecutionId);
      subflowStepName = parentStepState?.stepId;
    } catch {
      // Best-effort — step name is cosmetic
    }
  }

  // Display metadata stamped on the child by `agent.control.delegate`.
  // Surfacing these on the envelope lets the chat UI distinguish parallel
  // sub-agent runs (e.g. two cybernetic-runner sessions for different
  // workflows started in the same turn) by workflow + task name, and
  // assign a stable per-child accent color from sourceRunId.
  const displayWorkflowSlug = childState.delegationDisplayWorkflowSlug;
  const displayTaskName = childState.delegationDisplayTaskName;
  const displayTaskId = childState.delegationDisplayTaskId;
  const displayAgentName = childState.delegationDisplayAgentName;

  // When the incoming event is itself a forwarded envelope (recursive bubble),
  // unwrap so the grandparent envelope carries the INNERMOST source info.
  // This keeps the UI label accurate ("Worker said X") and lets the web
  // reducer match on the original sourceEventType rather than nesting envelopes.
  const isWrapped = childEvent.eventType === 'SubflowEventForwarded';
  const innerMeta = isWrapped ? (childEvent.metadata ?? {}) : undefined;

  const sourceEventType = isWrapped
    ? ((innerMeta?.['sourceEventType'] as string | undefined) ?? childEvent.eventType)
    : childEvent.eventType;
  const sourceRunId = isWrapped
    ? ((innerMeta?.['sourceRunId'] as string | undefined) ?? childRunId)
    : childRunId;
  const { agentTargetKey: _agentTargetKey } = await import('@aflow/schemas');
  const sourceTarget = isWrapped
    ? (innerMeta?.['sourceTarget'] ?? childState.target)
    : childState.target;
  const sourceAgentId = isWrapped
    ? ((innerMeta?.['sourceAgentId'] as string | undefined) ?? _agentTargetKey(childState.target))
    : _agentTargetKey(childState.target);
  const sourceStepId = isWrapped
    ? (innerMeta?.['sourceStepId'] as string | undefined)
    : childEvent.stepId;
  const sourceStepExecutionId = isWrapped
    ? (innerMeta?.['sourceStepExecutionId'] as string | undefined)
    : childEvent.stepExecutionId;

  // Extract step-level metadata from the child event for unified timeline rendering.
  // For step events (StepScheduled, StepSucceeded, StepFailed), these fields let
  // the parent UI render child steps as first-class StepGroup cards with proper
  // labels instead of opaque "subagent" cards.
  const childMeta = childEvent.metadata ?? {};
  const stepName = isWrapped
    ? (innerMeta?.['stepName'] as string | undefined)
    : (childMeta['stepName'] as string | undefined);
  const operationId = isWrapped
    ? (innerMeta?.['operationId'] as string | undefined)
    : (childMeta['operationId'] as string | undefined);
  const stepType = isWrapped
    ? (innerMeta?.['stepType'] as string | undefined)
    : childEvent.stepType;
  const stepDetail = isWrapped
    ? (innerMeta?.['stepDetail'] as string | undefined)
    : (childMeta['stepDetail'] as string | undefined);

  // Carry top-level data fields from the child event for unified timeline rendering.
  // outputRef and usage live at the event root (not in metadata) per the SessionEvent schema.
  const outputRef = isWrapped
    ? (innerMeta?.['outputRef'] as string | undefined)
    : childEvent.outputRef;
  const usage = isWrapped
    ? (innerMeta?.['usage'] as SessionEvent['usage'] | undefined)
    : childEvent.usage;
  const inputRef = isWrapped
    ? (innerMeta?.['inputRef'] as string | undefined)
    : (childMeta['inputRef'] as string | undefined);

  // For wrapped envelopes (multi-level subflows), preserve the innermost
  // display metadata so the grandparent badge still names the originating
  // workflow/task — not the intermediate session.
  const displayWorkflowSlugFinal = isWrapped
    ? ((innerMeta?.['displayWorkflowSlug'] as string | undefined) ?? displayWorkflowSlug)
    : displayWorkflowSlug;
  const displayTaskNameFinal = isWrapped
    ? ((innerMeta?.['displayTaskName'] as string | undefined) ?? displayTaskName)
    : displayTaskName;
  const displayTaskIdFinal = isWrapped
    ? ((innerMeta?.['displayTaskId'] as string | undefined) ?? displayTaskId)
    : displayTaskId;
  const displayAgentNameFinal = isWrapped
    ? ((innerMeta?.['displayAgentName'] as string | undefined) ?? displayAgentName)
    : displayAgentName;

  // Build the forwarded event envelope
  const forwardedEvent: SessionEvent = {
    eventId: crypto.randomUUID(),
    eventType: 'SubflowEventForwarded',
    timestamp: Date.now(),
    sessionId: parentRunId,
    metadata: {
      sourceRunId,
      sourceEventType,
      ...(sourceAgentId ? { sourceAgentId } : {}),
      ...(sourceTarget ? { sourceTarget } : {}),
      ...(sourceStepId ? { sourceStepId } : {}),
      ...(sourceStepExecutionId ? { sourceStepExecutionId } : {}),
      ...(subflowStepName ? { subflowStepName } : {}),
      // Step-level metadata for unified timeline rendering
      ...(stepName ? { stepName } : {}),
      ...(operationId ? { operationId } : {}),
      ...(stepType ? { stepType } : {}),
      ...(stepDetail ? { stepDetail } : {}),
      // Payload refs for input/output viewer
      ...(inputRef ? { inputRef } : {}),
      ...(outputRef ? { outputRef } : {}),
      // Usage/cost data for step card cost row
      ...(usage ? { usage } : {}),
      // Display metadata for parallel-runner disambiguation in chat UI
      ...(displayWorkflowSlugFinal ? { displayWorkflowSlug: displayWorkflowSlugFinal } : {}),
      ...(displayTaskNameFinal ? { displayTaskName: displayTaskNameFinal } : {}),
      ...(displayTaskIdFinal ? { displayTaskId: displayTaskIdFinal } : {}),
      ...(displayAgentNameFinal ? { displayAgentName: displayAgentNameFinal } : {}),
      // Carry through the original metadata (agentMessage, displayOutput, etc.).
      // For wrapped envelopes this is already the innermost metadata — no double nesting.
      ...(childEvent.metadata ?? {}),
    },
  };

  await appendSessionEvent(redis, tenantId, parentRunId, forwardedEvent);

  // Recursively forward up for nested subflows
  if (parentState.parentSessionId) {
    await forwardEventToParent(redis, tenantId, parentRunId, forwardedEvent, depth + 1);
  }
}
