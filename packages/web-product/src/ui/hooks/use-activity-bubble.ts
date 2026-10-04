'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { SessionEvent } from './use-run-events';
import type { LiveStreamActivity } from './use-run-reducer';

const OPTIMISTIC_ACTIVITY_TTL_MS = 10_000;
const ACTIVE_STEP_MAX_AGE_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Action labels – schema-driven lookup from @aflow/schemas.
// We duplicate the map here to avoid pulling the full Zod-heavy schemas
// package into the web bundle. The source of truth remains
// `OperationRegistration.actionLabel` in packages/schemas/src/operations/*.ts.
// If getActionLabels() from @aflow/schemas becomes tree-shakeable
// in the future, we can import it directly.
// ---------------------------------------------------------------------------

import { executorWaitLabel, resolveActionLabel, humanizeToken } from '../lib/op-labels.js';

// ---------------------------------------------------------------------------
// Delegate / cybernetic role fallback labels
// ---------------------------------------------------------------------------

/** Known parent step names → fallback labels for cybernetic agent delegation. */
const DELEGATE_STEP_LABELS: Record<string, string> = {
  'run-coach': 'Reviewing the session...',
};

/**
 * Short role identifier (`runner`/`coach`/…) for the delegate, used to label
 * the activity row when a sub-agent step is active. Mirrors the badge logic
 * in run-timeline.tsx so labels stay consistent across the chat surface.
 */
function resolveDelegateRoleHint(
  subflowStepName: string | undefined,
  sourceAgentId: string | undefined,
): string | undefined {
  if (subflowStepName === 'run-coach') return 'coach';
  if (sourceAgentId) {
    if (sourceAgentId.includes('runner')) return 'runner';
    if (sourceAgentId.includes('coach')) return 'coach';
    if (sourceAgentId.includes('helmsman')) return 'helmsman';
  }
  return undefined;
}

/**
 * Resolve a fallback activity label when delegating to a child session.
 * Used when no step-level detail is available from the forwarded events.
 */
function resolveDelegateRoleLabel(
  subflowStepName: string | undefined,
  sourceAgentId: string | undefined,
): string {
  // Check known cybernetic step names first
  if (subflowStepName) {
    const label = DELEGATE_STEP_LABELS[subflowStepName];
    if (label) return label;
  }
  if (sourceAgentId) {
    if (sourceAgentId.includes('runner')) return 'Executing task…';
    if (sourceAgentId.includes('coach')) return 'Reviewing execution…';
    if (sourceAgentId.includes('helmsman')) return 'Planning…';
  }
  return 'Running delegate…';
}

// ---------------------------------------------------------------------------
// ActivitySignal
// ---------------------------------------------------------------------------

export interface ActivitySignal {
  type: 'activity';
  runId: string;
  stepExecutionId?: string | undefined;
  /** Executor class: ai, memory, api, … */
  stepType?: string | undefined;
  /** Fully qualified operation: ai.generate, memory.put, … */
  operationId?: string | undefined;
  /** Human-readable step name from the flow definition */
  stepName?: string | undefined;
  /** Content-focused detail extracted from input (e.g. document path, query text) */
  stepDetail?: string | undefined;
  /** Short user-facing phrase (schema-driven, e.g. "Generating text…") */
  label: string;
  /**
   * Delegate context — present when the active step is forwarded from a
   * sub-agent session. Lets the chat activity row show which workflow/task
   * a parallel runner is working on (prevents two indistinguishable
   * "Executing task…" rows when the helmsman starts two skills at once).
   */
  delegateRole?: string | undefined;
  /** Friendly custom-agent name stamped by the delegate op (platform roles use delegateRole). */
  delegateAgentName?: string | undefined;
  delegateWorkflowSlug?: string | undefined;
  delegateTaskName?: string | undefined;
  delegateRunId?: string | undefined;
  startedAtMs: number;
  ttlMs: number;
}

interface UseActivityBubbleReturn {
  activity: ActivitySignal | null;
  isConnected: boolean;
}

// ---------------------------------------------------------------------------
// Helpers for reading event metadata
// ---------------------------------------------------------------------------

function eventStr(event: SessionEvent, field: string): string | undefined {
  const fromMeta = event.metadata?.[field];
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  const fromData = event.data?.[field];
  if (typeof fromData === 'string' && fromData) return fromData;
  return undefined;
}

function resolveStepName(event: SessionEvent): string | undefined {
  const explicitStepName = eventStr(event, 'stepName');
  if (explicitStepName) return explicitStepName;

  const operationId = eventStr(event, 'operationId');
  if (operationId) return humanizeToken(operationId);

  return event.data?.stepId;
}

function eventTimestampMs(event: SessionEvent): number {
  const parsed = Date.parse(event.timestamp);
  if (Number.isFinite(parsed)) return parsed;

  return Date.now();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Derive an activity signal from SSE events for the chat loading indicator.
 *
 * Design principles:
 * - Primary source: authoritative SSE events (durable, cross-tab)
 * - Immediate feel: show optimistic label on send
 * - Clears on terminal events or StepPaused
 * - Carries forward metadata from StepScheduled → StepStarted for the
 *   same stepExecutionId (StepStarted doesn't always include stepName)
 */
export function useActivityBubble(
  runId: string | null,
  options?: {
    events?: SessionEvent[] | undefined;
    runStatus?: string | undefined;
    optimisticLabel?: string | undefined;
    /** Most recent live frame from the step in flight, when one is streaming. */
    liveDelta?: LiveStreamActivity | null | undefined;
  },
): UseActivityBubbleReturn {
  const { events = [], runStatus, optimisticLabel, liveDelta = null } = options ?? {};
  const [activity, setActivity] = useState<ActivitySignal | null>(null);
  const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track metadata for the most-recently-seen stepExecutionId so
  // StepStarted can inherit stepName from StepScheduled.
  const stepContextRef = useRef<{
    stepExecutionId?: string | undefined;
    stepName?: string | undefined;
    operationId?: string | undefined;
    stepType?: string | undefined;
    stepDetail?: string | undefined;
  }>({});

  const clearActivityTimeout = useCallback(() => {
    if (activityTimeoutRef.current) {
      clearTimeout(activityTimeoutRef.current);
      activityTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!runId || !events.length) {
      if (optimisticLabel && runId) {
        setActivity({
          type: 'activity',
          runId,
          label: optimisticLabel,
          startedAtMs: Date.now(),
          ttlMs: OPTIMISTIC_ACTIVITY_TTL_MS,
        });
      }
      return;
    }

    const lastEvent = events.at(-1)!;

    const terminalEventTypes = [
      'SessionCompleted',
      'SessionSucceeded',
      'SessionFailed',
      'SessionCancelled',
      'SessionPaused',
      'StepCompleted',
      'StepFailed',
      'StepPaused',
    ];

    const isSubflowWaitingPause =
      lastEvent.eventType === 'SessionPaused' &&
      (lastEvent.metadata?.['subflowWaiting'] === true ||
        lastEvent.data?.['subflowWaiting'] === true);

    if (terminalEventTypes.includes(lastEvent.eventType) && !isSubflowWaitingPause) {
      clearActivityTimeout();
      setActivity(null);
      return;
    }

    const activityEventTypes = ['StepScheduled', 'StepWaitingOnExecutor', 'StepStarted'];

    // SubflowEventForwarded — resolve step-level labels from child events
    if (lastEvent.eventType === 'SubflowEventForwarded') {
      const sourceType = lastEvent.metadata?.['sourceEventType'] as string | undefined;
      const childStepName = eventStr(lastEvent, 'stepName');
      const childOperationId = eventStr(lastEvent, 'operationId');
      const childStepType = eventStr(lastEvent, 'stepType');
      const childStepDetail = eventStr(lastEvent, 'stepDetail');
      const sourceAgentId = eventStr(lastEvent, 'sourceAgentId');
      const subflowStepName = eventStr(lastEvent, 'subflowStepName');
      const sourceRunId = eventStr(lastEvent, 'sourceRunId');
      const displayWorkflowSlug = eventStr(lastEvent, 'displayWorkflowSlug');
      const displayTaskName = eventStr(lastEvent, 'displayTaskName');
      const displayAgentName = eventStr(lastEvent, 'displayAgentName');
      const delegateRole = resolveDelegateRoleHint(subflowStepName, sourceAgentId);
      const delegateFields = {
        ...(delegateRole ? { delegateRole } : {}),
        ...(displayAgentName ? { delegateAgentName: displayAgentName } : {}),
        ...(displayWorkflowSlug ? { delegateWorkflowSlug: displayWorkflowSlug } : {}),
        ...(displayTaskName ? { delegateTaskName: displayTaskName } : {}),
        ...(sourceRunId ? { delegateRunId: sourceRunId } : {}),
      };

      // For step-level forwarded events, resolve the action label the same way
      // we do for direct step events — gives "Thinking…", "Running code…", etc.
      if (
        sourceType === 'StepScheduled' ||
        sourceType === 'StepWaitingOnExecutor' ||
        sourceType === 'StepStarted'
      ) {
        const label =
          sourceType === 'StepWaitingOnExecutor'
            ? `${executorWaitLabel(childStepType)}…`
            : resolveActionLabel(childOperationId, childStepType);
        const signal: ActivitySignal = {
          type: 'activity',
          runId,
          stepExecutionId: eventStr(lastEvent, 'sourceStepExecutionId'),
          operationId: childOperationId,
          stepType: childStepType,
          stepName: childStepName ?? subflowStepName,
          stepDetail: childStepDetail,
          label,
          ...delegateFields,
          startedAtMs: eventTimestampMs(lastEvent),
          ttlMs: ACTIVE_STEP_MAX_AGE_MS,
        };
        setActivity(signal);
        return;
      }

      // Terminal forwarded events
      if (sourceType === 'SessionSucceeded' || sourceType === 'SessionCompleted') {
        // Clear activity — delegate finished
        clearActivityTimeout();
        setActivity(null);
        return;
      }
      if (sourceType === 'SessionFailed' || sourceType === 'StepFailed') {
        clearActivityTimeout();
        setActivity(null);
        return;
      }

      // Fallback for other forwarded events — use role-based label
      const roleLabel = resolveDelegateRoleLabel(subflowStepName, sourceAgentId);
      const signal: ActivitySignal = {
        type: 'activity',
        runId,
        stepName: childStepName ?? subflowStepName,
        label: roleLabel,
        ...delegateFields,
        startedAtMs: eventTimestampMs(lastEvent),
        ttlMs: ACTIVE_STEP_MAX_AGE_MS,
      };
      setActivity(signal);
      return;
    }

    // Subflow-waiting pause — show role-based label instead of generic "Running subflow…"
    if (isSubflowWaitingPause) {
      const subflowStepName =
        eventStr(lastEvent, 'stepName') ?? eventStr(lastEvent, 'subflowStepName');
      const sourceAgentId = eventStr(lastEvent, 'sourceAgentId');
      const label = resolveDelegateRoleLabel(subflowStepName, sourceAgentId);
      const signal: ActivitySignal = {
        type: 'activity',
        runId,
        stepName: subflowStepName,
        label,
        startedAtMs: eventTimestampMs(lastEvent),
        ttlMs: ACTIVE_STEP_MAX_AGE_MS,
      };
      setActivity(signal);
      return;
    }

    // The step in flight is producing output — "Thinking…" while it reasons,
    // "Writing…" once it writes. The producer of this signal clears it the
    // moment a durable event supersedes it (the step ends, the run rests, or a
    // new step takes over), so its mere presence means it is current — no
    // wall-clock comparison, which would be at the mercy of client/server
    // clock skew.
    if (liveDelta) {
      const ctx = stepContextRef.current;
      const isSameStep = liveDelta.stepExecutionId === ctx.stepExecutionId;

      const signal: ActivitySignal = {
        type: 'activity',
        runId,
        stepExecutionId: liveDelta.stepExecutionId,
        operationId: isSameStep ? ctx.operationId : 'ai.agent.turn',
        stepType: isSameStep ? ctx.stepType : 'ai',
        ...(isSameStep && ctx.stepName ? { stepName: ctx.stepName } : {}),
        label: liveDelta.channel === 'thinking' ? 'Thinking…' : 'Writing…',
        startedAtMs: liveDelta.atMs,
        ttlMs: ACTIVE_STEP_MAX_AGE_MS,
      };
      setActivity(signal);
      return;
    }

    if (activityEventTypes.includes(lastEvent.eventType)) {
      const stepType = eventStr(lastEvent, 'stepType') ?? lastEvent.data?.stepType;
      const operationId = eventStr(lastEvent, 'operationId');
      const stepName = resolveStepName(lastEvent);
      const stepDetail = eventStr(lastEvent, 'stepDetail');
      const stepExecutionId = lastEvent.stepExecutionId;

      // Build a merged context: if this event is for the same step execution,
      // carry forward any fields the previous event had that this one lacks.
      const ctx = stepContextRef.current;
      const isSameStep = stepExecutionId && stepExecutionId === ctx.stepExecutionId;

      const resolved = {
        stepExecutionId,
        stepType: stepType ?? (isSameStep ? ctx.stepType : undefined),
        operationId: operationId ?? (isSameStep ? ctx.operationId : undefined),
        stepName: stepName ?? (isSameStep ? ctx.stepName : undefined),
        stepDetail: stepDetail ?? (isSameStep ? ctx.stepDetail : undefined),
      };

      // Persist for the next event
      stepContextRef.current = resolved;

      const label =
        lastEvent.eventType === 'StepWaitingOnExecutor'
          ? `${executorWaitLabel(resolved.stepType)}…`
          : resolveActionLabel(resolved.operationId, resolved.stepType);

      const signal: ActivitySignal = {
        type: 'activity',
        runId,
        stepExecutionId: resolved.stepExecutionId,
        stepType: resolved.stepType,
        operationId: resolved.operationId,
        stepName: resolved.stepName,
        stepDetail: resolved.stepDetail,
        label,
        startedAtMs: eventTimestampMs(lastEvent),
        ttlMs: ACTIVE_STEP_MAX_AGE_MS,
      };

      setActivity(signal);
    }
  }, [runId, events, liveDelta, optimisticLabel, clearActivityTimeout]);

  useEffect(() => {
    const terminalStatuses = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'];
    if (runStatus && terminalStatuses.includes(runStatus)) {
      clearActivityTimeout();
      setActivity(null);
    }
  }, [runStatus, clearActivityTimeout]);

  useEffect(() => {
    clearActivityTimeout();
    if (!activity) return;

    // While the run is genuinely active, keep the indicator alive on TTL expiry
    // instead of clearing. A long sub-agent turn produces no forwarded keepalive
    // event, so the step TTL would otherwise blank the bubble mid-work. Status
    // flips (PAUSED/terminal) clear it via the effect above; here we only re-arm.
    const isRunActive = runStatus === 'RUNNING' || runStatus === 'WAITING_ON_CHILD';
    const rearmOrClear = () => {
      if (isRunActive) {
        setActivity((a) => (a ? { ...a, startedAtMs: Date.now() } : a));
      } else {
        setActivity(null);
      }
    };

    const remainingMs = activity.startedAtMs + activity.ttlMs - Date.now();
    if (remainingMs <= 0) {
      rearmOrClear();
      return;
    }

    activityTimeoutRef.current = setTimeout(rearmOrClear, remainingMs);
  }, [activity, runStatus, clearActivityTimeout]);

  useEffect(() => {
    return () => {
      clearActivityTimeout();
    };
  }, [clearActivityTimeout]);

  return {
    activity,
    isConnected: events.length > 0,
  };
}
