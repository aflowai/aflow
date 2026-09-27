/**
 * Resume a parent run when a child subflow completes.
 *
 * When a child run has `parentRunId` and `parentStepExecutionId` in its hot
 * state, this function:
 * 1. Transitions the parent run from PAUSED → RUNNING
 * 2. Emits a FlowRunResumed event on the parent
 * 3. Emits a synthetic step result (SUCCEEDED or FAILED) for the subflow step
 *    which routes through applyResult → onSuccess/onFailure normally
 */
import type { Redis } from 'ioredis';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type {
  OperationId,
  SessionId,
  StepExecutionId,
  StepId,
  StepType,
  TenantId,
  TraceId,
  IdempotencyKey,
  StepResultMessage,
} from '@aflow/schemas';
import {
  addStepResult,
  appendSessionEvent,
  getSessionState,
  getStepState,
  markSessionDirty,
  updateSessionState,
  updateStepState,
  removeWaitingChild,
  type SessionEvent,
  type SessionHotState,
} from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { extractVirtualPathToolCallIds, type ToolOutputIndex } from '@aflow/memory-paths';

/**
 * Structured error info passed from the caller. Preferred over inline-ref
 * parsing because executor errorRefs are payload-store refs (gs://, redis://),
 * not `inline:` — trying to JSON-decode those just loses the classification
 * and defaults everything to `internal` / `SUBFLOW_FAILED`.
 */
export interface ChildErrorInfo {
  code?: string;
  message?: string;
  classification?: string;
  retryable?: boolean;
}

export async function resumeParentOnChildComplete(
  redis: Redis,
  tenantId: string,
  childRunId: string,
  childStatus: 'SUCCEEDED' | 'FAILED',
  _outputOrErrorRef?: string,
  payloadStore?: PayloadStore,
  /**
   * Structured error info from the caller. When provided, used directly —
   * callers should prefer this over relying on inline-ref parsing so that
   * classification (e.g. `provider`) isn't silently lost.
   */
  childError?: ChildErrorInfo,
): Promise<void> {
  const childState = await getSessionState(redis, tenantId, childRunId);
  if (!childState?.parentSessionId || !childState.parentStepExecutionId) {
    return; // Not a subflow — nothing to resume
  }

  const parentRunId = childState.parentSessionId as SessionId;
  const parentStepExecutionId = childState.parentStepExecutionId as StepExecutionId;

  // Verify parent is still waiting (PAUSED or WAITING_ON_CHILD)
  const parentState = await getSessionState(redis, tenantId, parentRunId);
  if (parentState?.status !== 'PAUSED' && parentState?.status !== 'WAITING_ON_CHILD') {
    console.warn(
      `[resumeParentOnChildComplete] Parent run ${parentRunId} is not PAUSED/WAITING_ON_CHILD ` +
        `(status=${parentState?.status ?? 'unknown'}) — skipping resume`,
    );
    return;
  }

  // Get the paused step's state for metadata
  const stepState = await getStepState(redis, tenantId, parentStepExecutionId);
  if (!stepState) {
    logOrchestratorError(
      `[resumeParentOnChildComplete] Step ${parentStepExecutionId} not found ` +
        `in parent run ${parentRunId}`,
      new Error('Parent step state missing'),
      {
        tenantId,
        parentRunId,
        parentStepExecutionId,
        childRunId,
      },
    );
    return;
  }

  const now = Date.now();

  const remaining = await removeWaitingChild(redis, tenantId, parentRunId, childRunId);

  // ── Session-level transition (only when ALL children are done) ──────────────
  //
  // `waitingForChildSessionIds` is a flat per-session list across ALL parallel
  // delegation steps. The parent SESSION can only flip back to RUNNING once
  // every child has terminated. But each child's STEP result must still be
  // emitted now — multi-child delegations have one parent step per child, and
  // the agent's pending-tool-result barrier counts per step. Dropping a step
  // result here leaves the agent's barrier short and forces the 120s watchdog
  // to insert a `_barrier_recovery` placeholder, which the agent can't act on.
  if (remaining === 0) {
    // Canonical leave-child-wait → RUNNING. Clears ALL delegation fields.
    // Done BEFORE addStepResult so the result consumer sees status=RUNNING.
    //
    const { leaveChildWaitToRunning } = await import('../helpers/delegationState.js');
    await leaveChildWaitToRunning(redis, tenantId, parentRunId, {
      fromStatus: parentState.status,
    });

    const resumedEvent: SessionEvent = {
      eventId: crypto.randomUUID(),
      eventType: 'SessionResumed',
      timestamp: now,
      sessionId: parentRunId,
      stepId: stepState.stepId,
      stepExecutionId: parentStepExecutionId,
      stepType: stepState.stepType,
      attempt: stepState.attempt,
      metadata: {
        childRunId,
        childStatus,
      },
    };
    await appendSessionEvent(redis, tenantId as TenantId, parentRunId, resumedEvent);
    await markSessionDirty(redis, tenantId as TenantId, parentRunId);
  } else {
    // Other children still running — keep session in WAITING_ON_CHILD but
    // clear the child-input pause fields in case this was the paused child.
    await updateSessionState(redis, tenantId as TenantId, parentRunId, {
      delegationPauseSource: 'child_running',
      pausedChildSessionId: undefined,
      childPausedStepExecutionId: undefined,
    });
    getOrchestratorLogger().debug(
      `[resumeParentOnChildComplete] Child ${childRunId} completed (${childStatus}); ` +
        `${remaining} other child(ren) still running on parent ${parentRunId}`,
    );
  }

  // ── Per-child step result (always, regardless of `remaining`) ──────────────
  //
  // Reset step status from PAUSED → STARTED so applyResult's idempotency
  // check (which skips PAUSED/SUCCEEDED/FAILED steps) doesn't reject
  // the synthetic result.
  await updateStepState(redis, tenantId, parentStepExecutionId, {
    sessionId: parentRunId,
    status: 'STARTED',
  });

  // Emit synthetic step result for THIS child's parent step.
  // This routes through applyResult → onSuccess/onFailure normally.
  // Include the child's final output so the parent agent gets useful context.
  const outputData: Record<string, unknown> = {
    childSessionId: childRunId,
    status: childStatus,
  };

  if (childStatus === 'SUCCEEDED' && childState.finalOutputRef) {
    let resolvedOutput: unknown;
    if (payloadStore) {
      try {
        resolvedOutput = await payloadStore.retrieve(childState.finalOutputRef);
      } catch (err) {
        console.warn(
          `[resumeParentOnChildComplete] Failed to resolve childOutputRef: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (resolvedOutput !== undefined) {
      // Include the resolved content directly (applyStepSucceeded will
      // truncate the summary to 16KB when building ToolResultSummary)
      outputData['childOutput'] = resolvedOutput;
    } else {
      // Fallback: include the reference if resolution failed
      outputData['childOutputRef'] = childState.finalOutputRef;
    }
  }
  // Also include child's runtime state output variables if available
  // (these are inline values, not references — always safe to include)
  if (childState.runtimeState?.variables) {
    const outputVars: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(childState.runtimeState.variables)) {
      // Skip internal/tracking variables — only pass user-facing output
      if (
        key.startsWith('ai.') ||
        key.startsWith('chat.') ||
        key.startsWith('flow.') ||
        key.startsWith('_')
      )
        continue;
      const v = val as { ref?: { kind?: string; value?: unknown } } | undefined;
      if (v?.ref?.value !== undefined) {
        outputVars[key] = v.ref.value;
      }
    }
    if (Object.keys(outputVars).length > 0) {
      // Merge with childOutput if it was resolved from finalOutputRef.
      // Runtime state vars provide additional context (e.g., the `result`
      // variable set by applyAgentDecision on subagent complete).
      if (!outputData['childOutput']) {
        outputData['childOutput'] = outputVars;
      } else {
        outputData['childStateVariables'] = outputVars;
      }
    }
  }

  if (childStatus === 'SUCCEEDED') {
    await forwardCompletedChildOutputs(
      redis,
      tenantId,
      parentRunId,
      parentStepExecutionId,
      childState,
      now,
      payloadStore,
    );
  }

  const outputRef = `inline:${Buffer.from(JSON.stringify(outputData)).toString('base64')}`;

  const baseResult = {
    messageVersion: 1 as const,
    tenantId: tenantId as TenantId,
    sessionId: parentRunId,
    stepExecutionId: parentStepExecutionId,
    parentStepExecutionId: (stepState.parentStepExecutionId ?? null) as StepExecutionId | null,
    stepId: stepState.stepId as StepId,
    stepType: (stepState.stepType as StepType | undefined) ?? 'agent',
    operationId: ((stepState.operationId as OperationId | undefined) ??
      'agent.control.delegate') as OperationId,
    attempt: (stepState.attempt as number | undefined) ?? 1,
    idempotencyKey: `subflow-complete:${childRunId}` as IdempotencyKey,
    resolvedInputRef: (stepState.inputRef as string | undefined) ?? '',
    durationMs: 0,
    traceId: ((parentState.traceId as TraceId | undefined) ?? '') as TraceId,
    finishedAtMs: now,
  };

  if (childStatus === 'SUCCEEDED') {
    await addStepResult(redis, {
      ...baseResult,
      status: 'SUCCEEDED',
      outputRef,
    } as StepResultMessage);
  } else {
    // Build a descriptive error message for the parent agent.
    // Include: agent name + session ID (for debugging) + error reason.
    // Only hide the raw error message for truly internal/system errors — validation,
    // not_found, permission, provider, and other actionable errors should surface
    // distinctly so the parent agent can reason about recovery.
    const { agentTargetKey } = await import('@aflow/schemas');
    const childAgentId = childState.target ? agentTargetKey(childState.target) : 'unknown';
    let childErrorCode = childError?.code ?? 'SUBFLOW_FAILED';
    let childErrorClassification = childError?.classification ?? 'internal';
    let rawErrorMessage: string | undefined = childError?.message;
    let childRetryable: boolean | undefined = childError?.retryable;

    // Fallback: decode inline error ref when the caller didn't pass structured
    // info. Payload-store refs (gs://, redis://) are intentionally skipped here
    // — callers carrying those MUST pass `childError` directly.
    if (!childError && _outputOrErrorRef?.startsWith('inline:')) {
      try {
        const decoded = JSON.parse(
          Buffer.from(_outputOrErrorRef.slice('inline:'.length), 'base64').toString('utf-8'),
        ) as { message?: string; code?: string; classification?: string; retryable?: boolean };
        if (!rawErrorMessage && decoded.message) rawErrorMessage = decoded.message;
        if (decoded.code) childErrorCode = decoded.code;
        if (decoded.classification) childErrorClassification = decoded.classification;
        if (decoded.retryable !== undefined) childRetryable = decoded.retryable;
      } catch {
        // Best-effort — fall back to generic message
      }
    }

    // Shape the message + retryable flag per classification so the parent agent
    // (via toAgentToolError in packages/schemas/src/runtime/errors.ts) can tell
    // transient/upstream issues apart from hard platform failures.
    let childErrorMessage: string;
    let effectiveRetryable: boolean;
    switch (childErrorClassification) {
      case 'internal':
        // Truly opaque — don't leak SQL / stack traces / implementation details.
        childErrorMessage = `Sub-agent "${childAgentId}" (session ${childRunId}) failed due to an internal error.`;
        effectiveRetryable = false;
        break;
      case 'provider':
        // Surface as upstream provider issue so the agent knows it MAY be
        // transient and retrying is reasonable. Provider errors are retryable
        // by default unless the child explicitly marked them non-retryable.
        childErrorMessage = `Sub-agent "${childAgentId}" (session ${childRunId}) failed due to an upstream provider error: ${rawErrorMessage ?? 'unknown error'}`;
        effectiveRetryable = childRetryable ?? true;
        break;
      case 'transient':
      case 'rate_limit':
      case 'timeout':
        childErrorMessage = `Sub-agent "${childAgentId}" (session ${childRunId}) failed (${childErrorClassification}): ${rawErrorMessage ?? 'unknown error'}`;
        effectiveRetryable = childRetryable ?? true;
        break;
      default:
        // validation / not_found / permission / configuration / etc — surface
        // the raw message; the agent may be able to act on it.
        childErrorMessage = `Sub-agent "${childAgentId}" (session ${childRunId}) failed: ${rawErrorMessage ?? 'unknown error'}`;
        effectiveRetryable = childRetryable ?? false;
        break;
    }

    const errorData = {
      code: childErrorCode,
      message: childErrorMessage,
      classification: childErrorClassification as 'internal',
      retryable: effectiveRetryable,
      timestamp: new Date().toISOString(),
    };
    const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;

    await addStepResult(redis, {
      ...baseResult,
      status: 'FAILED',
      errorRef,
      error: errorData,
    } as StepResultMessage);
  }

  getOrchestratorLogger().debug(
    `[SessionOrchestrator] Child run ${childRunId} completed (${childStatus}), ` +
      `resumed parent run ${parentRunId} step ${parentStepExecutionId}`,
  );
}

// ============================================================================

interface RuntimeStateVarEntry {
  ref?: { kind: string; value?: unknown };
  updatedAtMs?: number;
  updatedBy?: unknown;
}

/**
 * Resolve a completed child's final output and state variables, scan them
 * for /run/outputs/<toolCallId>/... virtual paths, and merge the matching
 * entries from the child's _tool_outputs into the parent's index.
 *
 * Called for EVERY completing child (not just the last one), so the parent
 * can resolve virtual paths from any child in a multi-child delegation.
 *
 * Reads parent state fresh from Redis to handle successive merges safely.
 */
async function forwardCompletedChildOutputs(
  redis: Redis,
  tenantId: string,
  parentRunId: SessionId,
  parentStepExecutionId: StepExecutionId,
  childState: SessionHotState,
  nowMs: number,
  payloadStore?: PayloadStore,
): Promise<void> {
  // Collect all values the parent will see from this child — scan both
  // the final output AND user-facing state variables for virtual paths.
  const valuesToScan: unknown[] = [];

  // 1) Child's final output (resolved from PayloadStore)
  if (childState.finalOutputRef && payloadStore) {
    try {
      const resolved = await payloadStore.retrieve(childState.finalOutputRef);
      if (resolved !== undefined) valuesToScan.push(resolved);
    } catch {
      // Best-effort — if retrieval fails, we can't scan it
    }
  }

  // 2) User-facing state variables (same filter as the main path)
  if (childState.runtimeState?.variables) {
    for (const [key, val] of Object.entries(childState.runtimeState.variables)) {
      if (
        key.startsWith('ai.') ||
        key.startsWith('chat.') ||
        key.startsWith('flow.') ||
        key.startsWith('_')
      )
        continue;
      const v = val as { ref?: { kind?: string; value?: unknown } } | undefined;
      if (v?.ref?.value !== undefined) valuesToScan.push(v.ref.value);
    }
  }

  // Extract all referenced toolCallIds from the values
  const referencedIds = new Set<string>();
  for (const value of valuesToScan) {
    for (const id of extractVirtualPathToolCallIds(value)) {
      referencedIds.add(id);
    }
  }
  if (referencedIds.size === 0) return;

  // Read child's _tool_outputs index
  const childVars = childState.runtimeState?.variables;
  if (!childVars) return;

  const childToolOutputsVar = childVars['_tool_outputs'] as RuntimeStateVarEntry | undefined;
  if (childToolOutputsVar?.ref?.kind !== 'inline' || !childToolOutputsVar.ref.value) return;

  const childIndex = childToolOutputsVar.ref.value as ToolOutputIndex;

  // Collect only the entries referenced in the output/variables
  const entriesToForward: ToolOutputIndex = {};
  for (const id of referencedIds) {
    const entry = childIndex[id];
    if (entry) entriesToForward[id] = entry;
  }
  if (Object.keys(entriesToForward).length === 0) return;

  // Read parent state FRESH from Redis — critical for multi-child delegations
  // where multiple children complete and each merge into the same index.
  const freshParentState = await getSessionState(redis, tenantId, parentRunId);
  const parentRuntime = freshParentState?.runtimeState;
  if (!parentRuntime) return;

  const parentToolOutputsVar = parentRuntime.variables['_tool_outputs'] as
    RuntimeStateVarEntry | undefined;
  const currentParentIndex: ToolOutputIndex =
    parentToolOutputsVar?.ref?.kind === 'inline' &&
    parentToolOutputsVar.ref.value != null &&
    typeof parentToolOutputsVar.ref.value === 'object'
      ? (parentToolOutputsVar.ref.value as ToolOutputIndex)
      : {};

  const mergedIndex: ToolOutputIndex = { ...currentParentIndex, ...entriesToForward };

  // Write merged index back to parent's runtime state, preserving all existing
  // runtimeState fields (version, schemaVersion, updatedAtMs).
  await updateSessionState(redis, tenantId as TenantId, parentRunId, {
    runtimeState: {
      ...parentRuntime,
      version: parentRuntime.version + 1,
      updatedAtMs: nowMs,
      variables: {
        ...parentRuntime.variables,
        _tool_outputs: {
          ref: { kind: 'inline' as const, value: mergedIndex },
          updatedAtMs: nowMs,
          updatedBy: {
            stepExecutionId: parentStepExecutionId,
            stepId: 'delegation-output-forward',
            actor: 'orchestrator' as const,
          },
        },
      },
    },
  });

  getOrchestratorLogger().debug(
    `[forwardCompletedChildOutputs] Forwarded ${Object.keys(entriesToForward).length} child ` +
      `tool output(s) to parent ${parentRunId}: ${Object.keys(entriesToForward).join(', ')}`,
  );
}
