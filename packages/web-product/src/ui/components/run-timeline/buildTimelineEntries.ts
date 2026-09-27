import { hueFromRunId } from '../../lib/display-utils.js';
import type { SessionEvent, UserFacingError } from '../../lib/types.js';

import { ev } from './eventAccessor';
import type { RunSummary } from './RunSummaryBar';
import type { StepGroup, TimelineEntry } from './types';

/** Aggregated run-level summary computed from all step groups */

export function computeRunSummary(entries: TimelineEntry[]): RunSummary {
  const summary: RunSummary = {
    totalSteps: 0,
    completedSteps: 0,
    failedSteps: 0,
    totalDurationMs: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    models: new Set(),
    totalCacheReadTokens: 0,
  };

  // Check for server-side usageSummary from a terminal event
  for (const entry of entries) {
    if (entry.kind === 'flow') {
      const evt = entry.event;
      if (
        (evt.eventType === 'SessionSucceeded' || evt.eventType === 'SessionCompleted') &&
        evt.usageSummary
      ) {
        const us = evt.usageSummary as {
          totalPromptTokens: number;
          totalCompletionTokens: number;
          totalTokens: number;
          totalCostUsd: number;
          models: string[];
        };
        // Use server-side aggregate but still count steps
        for (const e2 of entries) {
          if (e2.kind !== 'step') continue;
          summary.totalSteps++;
          if (e2.group.status === 'succeeded') summary.completedSteps++;
          if (e2.group.status === 'failed') summary.failedSteps++;
          if (e2.group.durationMs != null) summary.totalDurationMs += e2.group.durationMs;
        }
        summary.totalPromptTokens = us.totalPromptTokens;
        summary.totalCompletionTokens = us.totalCompletionTokens;
        summary.totalTokens = us.totalTokens;
        summary.totalCostUsd = us.totalCostUsd;
        for (const m of us.models) summary.models.add(m);
        for (const e3 of entries) {
          if (e3.kind === 'step' && e3.group.costInfo) {
            summary.totalCacheReadTokens += e3.group.costInfo.cacheReadTokens ?? 0;
          }
        }
        return summary;
      }
    }
  }

  // Fallback: client-side aggregation from per-step data
  for (const entry of entries) {
    if (entry.kind !== 'step') continue;
    const g = entry.group;
    summary.totalSteps++;
    if (g.status === 'succeeded') summary.completedSteps++;
    if (g.status === 'failed') summary.failedSteps++;
    if (g.durationMs != null) summary.totalDurationMs += g.durationMs;
    if (g.costInfo) {
      summary.totalPromptTokens += g.costInfo.promptTokens ?? 0;
      summary.totalCompletionTokens += g.costInfo.completionTokens ?? 0;
      summary.totalTokens += g.costInfo.totalTokens ?? 0;
      summary.totalCostUsd += g.costInfo.totalCostUsd ?? 0;
      summary.totalCacheReadTokens += g.costInfo.cacheReadTokens ?? 0;
      if (g.costInfo.model) summary.models.add(g.costInfo.model);
    }
  }
  return summary;
}

// =============================================================================
// Delegate role resolution
// =============================================================================

const DELEGATE_STEP_ROLES: Record<string, string> = {
  'run-coach': 'coach',
};

/**
 * Resolve a human-readable role label for a delegate step.
 * Uses the parent's step name (which triggered the delegation) as the primary
 * signal. Falls back to pattern-matching on the agent ID for known cybernetic roles.
 */
export function resolveDelegateRole(
  subflowStepName: string | undefined,
  sourceAgentId: string | undefined,
): string {
  if (subflowStepName) {
    const known = DELEGATE_STEP_ROLES[subflowStepName];
    if (known) return known;
  }
  // Pattern-match on agent IDs that contain cybernetic role hints.
  if (sourceAgentId) {
    if (sourceAgentId.includes('runner')) return 'runner';
    if (sourceAgentId.includes('coach')) return 'coach';
    if (sourceAgentId.includes('helmsman')) return 'helmsman';
  }
  return 'delegate';
}

// =============================================================================
// Helpers — build timeline entries
// =============================================================================

export const AGENT_TURN_OPERATION = 'ai.agent.turn';

/** Agent actions that dispatch tool steps — every other action ends the turn. */
const TOOL_DISPATCH_ACTIONS = new Set(['invoke_step', 'invoke_steps']);

export function stepGroupKey(group: StepGroup): string {
  return `${group.stepExecutionId ?? group.stepId}-t${String(group.turn)}`;
}

export function buildTimelineEntries(events: SessionEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  // Group by stepExecutionId (unique per execution cycle)
  const stepGroups = new Map<string, StepGroup>();
  // Already-flushed groups — allows late-arriving events (e.g. SessionPaused
  // after a flush) to update the existing group instead of creating a duplicate.
  const flushedGroups = new Map<string, StepGroup>();
  // Track how many times each stepId has been executed (for turn numbering)
  const stepTurnCounter = new Map<string, number>();
  // Track the last group key for each stepId so we can merge paused→resumed
  const lastGroupKeyByStepId = new Map<string, string>();
  // Defer SessionPaused flow-level entries until after step groups are flushed.
  // This prevents the pause event from appearing above the step groups it follows.
  const deferredPauseEvents: SessionEvent[] = [];
  // The agent turn whose decision is currently dispatching tools. Its action is
  // known before any of its tool steps are scheduled, so a group created while
  // this is set belongs to it.
  let openTurn: StepGroup | undefined;

  const attributeToOpenTurn = (group: StepGroup) => {
    if (group.operationId === AGENT_TURN_OPERATION) {
      openTurn = group;
      return;
    }
    if (openTurn && TOOL_DISPATCH_ACTIONS.has(openTurn.agentAction ?? '')) {
      group.parentTurnKey = stepGroupKey(openTurn);
    }
  };

  // Ephemeral event types — for real-time streaming only, not shown in timeline.
  const EPHEMERAL_EVENTS = new Set([
    'SurfaceUpdate',
    'WorkflowTaskUpdate',
    'WorkflowRunUpdate',
    'WorkflowTaskActivity',
    'WorkflowTaskSurfaceUpdate',
  ]);

  for (const event of events) {
    // Skip ephemeral streaming events — they're noise in the execution timeline
    if (EPHEMERAL_EVENTS.has(event.eventType)) continue;
    // Handle SubflowEventForwarded — convert child step events to StepGroup entries
    // for unified timeline, keep session-level events as subflow cards.
    if (event.eventType === 'SubflowEventForwarded') {
      const sourceEventType = (event.data?.['sourceEventType'] ??
        event.metadata?.['sourceEventType']) as string | undefined;
      if (sourceEventType && EPHEMERAL_EVENTS.has(sourceEventType)) continue;
      const meta = { ...(event.metadata ?? {}), ...(event.data ?? {}) };

      // Step-level child events → unified StepGroup rendering
      const STEP_SOURCE_EVENTS = new Set([
        'StepScheduled',
        'StepSucceeded',
        'StepCompleted',
        'StepFailed',
      ]);
      if (sourceEventType && STEP_SOURCE_EVENTS.has(sourceEventType)) {
        const sourceStepExecId = meta['sourceStepExecutionId'] as string | undefined;
        const sourceStepId = meta['sourceStepId'] as string | undefined;
        const sourceRunKey =
          typeof meta['sourceRunId'] === 'string'
            ? meta['sourceRunId']
            : typeof meta['sourceRunId'] === 'number'
              ? String(meta['sourceRunId'])
              : '';
        const groupKey =
          sourceStepExecId ?? `subflow-${sourceRunKey}-${sourceStepId ?? event.eventId}`;

        // Find or create step group for this child step
        let group = stepGroups.get(groupKey) ?? flushedGroups.get(groupKey);
        if (!group) {
          const delegateRole = resolveDelegateRole(
            meta['subflowStepName'] as string | undefined,
            meta['sourceAgentId'] as string | undefined,
          );
          const sourceRunIdStr = meta['sourceRunId'] as string | undefined;
          group = {
            stepId: sourceStepId ?? 'unknown',
            stepExecutionId: sourceStepExecId,
            stepName: (meta['stepName'] as string) ?? sourceStepId ?? 'Delegate step',
            stepType: typeof meta.stepType === 'string' ? meta.stepType : 'unknown',
            operationId: (meta['operationId'] as string) ?? '',
            stepDetail: meta['stepDetail'] as string | undefined,
            status: 'scheduled',
            events: [event],
            attempt: 1,
            turn: 1,
            delegateInfo: {
              subflowStepName: meta['subflowStepName'] as string | undefined,
              sourceAgentId: meta['sourceAgentId'] as string | undefined,
              sourceRunId: sourceRunIdStr,
              role: delegateRole,
              workflowSlug: meta['displayWorkflowSlug'] as string | undefined,
              taskName: meta['displayTaskName'] as string | undefined,
              accentHue: hueFromRunId(sourceRunIdStr),
            },
          };
          stepGroups.set(groupKey, group);
          attributeToOpenTurn(group);
        } else {
          group.events.push(event);
          if (meta['stepName']) group.stepName = meta['stepName'] as string;
          if (meta['operationId']) group.operationId = meta['operationId'] as string;
          if (meta['stepDetail']) group.stepDetail = meta['stepDetail'] as string;
          if (group.delegateInfo) {
            if (!group.delegateInfo.workflowSlug && meta['displayWorkflowSlug']) {
              group.delegateInfo.workflowSlug = meta['displayWorkflowSlug'] as string;
            }
            if (!group.delegateInfo.taskName && meta['displayTaskName']) {
              group.delegateInfo.taskName = meta['displayTaskName'] as string;
            }
          }
        }

        // Extract payload refs from forwarded metadata
        if (meta['inputRef']) group.inputRef = meta['inputRef'] as string;
        if (meta['outputRef']) group.outputRef = meta['outputRef'] as string;

        // Extract cost/token data from forwarded usage
        const fwdUsage = meta['usage'] as
          | {
              provider?: string;
              model?: string;
              promptTokens?: number;
              completionTokens?: number;
              totalTokens?: number;
              totalCostUsd?: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
              uncachedPromptTokens?: number;
              reasoningTokens?: number;
            }
          | undefined;
        if (fwdUsage) {
          group.costInfo = {
            provider: fwdUsage.provider,
            model: fwdUsage.model,
            promptTokens: fwdUsage.promptTokens,
            completionTokens: fwdUsage.completionTokens,
            totalTokens: fwdUsage.totalTokens,
            totalCostUsd: fwdUsage.totalCostUsd,
            cacheReadTokens: fwdUsage.cacheReadTokens,
            cacheWriteTokens: fwdUsage.cacheWriteTokens,
            uncachedPromptTokens: fwdUsage.uncachedPromptTokens,
            reasoningTokens: fwdUsage.reasoningTokens,
          };
        }

        // Update status based on source event type
        if (sourceEventType === 'StepScheduled') {
          group.scheduledAt = event.timestamp;
          group.status = 'scheduled';
        } else if (sourceEventType === 'StepSucceeded' || sourceEventType === 'StepCompleted') {
          group.completedAt = event.timestamp;
          group.status = 'succeeded';
          if (meta['agentMessage']) group.agentAction = 'complete';
        } else if (sourceEventType === 'StepFailed') {
          group.completedAt = event.timestamp;
          group.status = (meta['willRetry'] as boolean) ? 'retrying' : 'failed';
          group.errorMessage = meta['errorMessage'] as string | undefined;
          if (meta['userError']) group.userError = meta['userError'] as UserFacingError;
        }

        // Compute duration
        if (group.scheduledAt && group.completedAt) {
          group.durationMs =
            new Date(group.completedAt).getTime() - new Date(group.scheduledAt).getTime();
        }
        continue;
      }

      // Session-level events (SessionCompleted, SessionFailed) + StepSucceeded with
      // agentMessage but no prior StepScheduled → keep as subflow cards
      flushStepGroups(stepGroups, entries, flushedGroups);
      entries.push({
        kind: 'subflow',
        entry: {
          sourceRunId: meta['sourceRunId'] as string,
          sourceEventType: sourceEventType ?? '',
          sourceStepId: meta['sourceStepId'] as string | undefined,
          sourceAgentId: meta['sourceAgentId'] as string | undefined,
          subflowStepName: meta['subflowStepName'] as string | undefined,
          stepName: meta['stepName'] as string | undefined,
          operationId: meta['operationId'] as string | undefined,
          agentMessage: meta['agentMessage'] as string | undefined,
          timestamp: event.timestamp,
          event,
        },
      });
      continue;
    }

    const stepId = event.data?.stepId;
    const stepExecId = event.stepExecutionId;
    const isStepEvent = isStepRelatedEvent(event.eventType) && stepId;

    if (!isStepEvent) {
      // Flush any open step groups before flow events
      flushStepGroups(stepGroups, entries, flushedGroups);
      entries.push({ kind: 'flow', event });
      continue;
    }

    // SessionPaused updates the step group AND gets a deferred flow-level entry.
    // We defer the flow entry so it appears after the step groups it's associated with.
    if (event.eventType === 'SessionPaused') {
      deferredPauseEvents.push(event);
    }

    // Determine group key — prefer stepExecutionId for accurate grouping.
    // Fall back to stepId + attempt if stepExecutionId is not available.
    const attempt = event.data?.attempt ?? 1;
    const groupKey = stepExecId ?? `${stepId}-${attempt}`;
    // Check active groups first, then already-flushed groups (late events)
    let group = stepGroups.get(groupKey) ?? flushedGroups.get(groupKey);

    if (!group) {
      // Check if the previous execution of this stepId was paused — if so, merge
      // into that group so the user sees a single entry that transitions from
      // "Awaiting input" to "Completed" rather than two separate cards.
      const prevGroupKey = lastGroupKeyByStepId.get(stepId);
      const prevGroupInActive = prevGroupKey ? stepGroups.get(prevGroupKey) : undefined;
      const prevGroupInFlushed = prevGroupKey ? flushedGroups.get(prevGroupKey) : undefined;
      const prevGroup = prevGroupInActive ?? prevGroupInFlushed;
      if (prevGroup?.status === 'paused' || prevGroup?.status === 'waiting_on_child') {
        group = prevGroup;
        group.stepExecutionId = stepExecId;
        if (prevGroupInFlushed) {
          // Group is already in entries — register under the new key in
          // flushedGroups so later events find it, but do NOT add to
          // stepGroups (which would cause a second flush to entries).
          flushedGroups.set(groupKey, group);
        } else {
          // Move from old key to new key within stepGroups so the same
          // object isn't flushed twice under both keys.
          if (prevGroupKey && prevGroupKey !== groupKey) {
            stepGroups.delete(prevGroupKey);
          }
          stepGroups.set(groupKey, group);
        }
        // Don't increment turn counter — this is a continuation, not a new turn
      } else {
        const turn = (stepTurnCounter.get(stepId) ?? 0) + 1;
        stepTurnCounter.set(stepId, turn);

        const e0 = ev(event);
        group = {
          stepId,
          stepExecutionId: stepExecId,
          stepName: e0.stepName ?? stepId,
          stepType: e0.stepType ?? 'unknown',
          operationId: e0.operationId ?? '',
          stepDetail: e0.stepDetail,
          status: 'scheduled',
          events: [],
          attempt,
          turn,
        };
        stepGroups.set(groupKey, group);
        attributeToOpenTurn(group);
      }
      lastGroupKeyByStepId.set(stepId, groupKey);
    }

    // Update group metadata from this event
    group.events.push(event);

    const ef = ev(event);
    if (ef.stepName) group.stepName = ef.stepName;
    if (ef.operationId) group.operationId = ef.operationId;
    if (ef.stepDetail) group.stepDetail = ef.stepDetail;
    if (ef.agentAction) group.agentAction = ef.agentAction;
    if (ef.invokedTools) group.invokedTools = ef.invokedTools;
    if (ef.responseOptions) group.responseOptions = ef.responseOptions;
    if (ef.inputRef) group.inputRef = ef.inputRef;
    if (ef.dispatchWrapper !== undefined) group.dispatchWrapper = ef.dispatchWrapper;

    // Update status
    if (event.eventType === 'StepScheduled') {
      group.scheduledAt = event.timestamp;
      group.status = 'scheduled';
    } else if (event.eventType === 'StepStarted') {
      group.startedAt = event.timestamp;
      group.status = 'running';
    } else if (event.eventType === 'StepSucceeded' || event.eventType === 'StepCompleted') {
      group.completedAt = event.timestamp;
      group.status = 'succeeded';
      group.outputRef = ef.outputRef ?? group.outputRef;

      // Extract variable changes
      const patch = ef.runtimeStatePatch;
      if (patch?.changed) {
        group.variableChanges = patch.changed;
      }

      const typedUsage = event.usage as
        | {
            provider?: string;
            model?: string;
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
            totalCostUsd?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
            uncachedPromptTokens?: number;
            reasoningTokens?: number;
          }
        | undefined;
      if (typedUsage) {
        group.costInfo = {
          provider: typedUsage.provider,
          model: typedUsage.model,
          promptTokens: typedUsage.promptTokens,
          completionTokens: typedUsage.completionTokens,
          totalTokens: typedUsage.totalTokens,
          totalCostUsd: typedUsage.totalCostUsd,
          cacheReadTokens: typedUsage.cacheReadTokens,
          cacheWriteTokens: typedUsage.cacheWriteTokens,
          uncachedPromptTokens: typedUsage.uncachedPromptTokens,
          reasoningTokens: typedUsage.reasoningTokens,
        };
      }
    } else if (event.eventType === 'StepFailed') {
      group.completedAt = event.timestamp;
      group.status = ef.willRetry ? 'retrying' : 'failed';
      group.errorRef = ef.errorRef ?? group.errorRef;
      group.errorMessage = ef.errorMessage ?? group.errorMessage;
      if (ef.userError) group.userError = ef.userError;
    } else if (event.eventType === 'StepPaused' || event.eventType === 'SessionPaused') {
      group.completedAt = event.timestamp;
      const pt = (event.metadata?.['pauseType'] ?? event.data?.['pauseType']) as string | undefined;
      group.status = pt === 'subflow_waiting' ? 'waiting_on_child' : 'paused';
      const pk = (event.metadata?.['payloadKind'] ?? event.data?.['payloadKind']) as
        string | undefined;
      if (pk) group.pauseKind = pk;
    }

    // Compute duration
    if (group.scheduledAt && group.completedAt) {
      group.durationMs =
        new Date(group.completedAt).getTime() - new Date(group.scheduledAt).getTime();
    }
  }

  // Flush remaining step groups
  flushStepGroups(stepGroups, entries, flushedGroups);

  // SessionPaused events that were absorbed into a step group (as 'paused' status)
  // are NOT emitted as separate flow-level entries — the step card already shows
  // "Awaiting input". Only emit SessionPaused as a flow-level entry if it wasn't
  // associated with any step group (unusual, but handle gracefully).
  for (const pauseEvent of deferredPauseEvents) {
    const pauseStepId = pauseEvent.data?.stepId;
    const pauseExecId =
      pauseEvent.stepExecutionId ?? (pauseEvent.data?.['stepExecutionId'] as string);
    const pauseKey = pauseExecId ?? (pauseStepId ? `${pauseStepId}-1` : null);
    const absorbedByGroup = pauseKey && (flushedGroups.has(pauseKey) || stepGroups.has(pauseKey));
    if (!absorbedByGroup) {
      entries.push({ kind: 'flow', event: pauseEvent });
    }
  }

  return entries.filter(
    (entry) =>
      !(entry.kind === 'step' && entry.group.dispatchWrapper && entry.group.status === 'succeeded'),
  );
}

function flushStepGroups(
  stepGroups: Map<string, StepGroup>,
  entries: TimelineEntry[],
  flushedGroups?: Map<string, StepGroup>,
) {
  for (const [key, group] of stepGroups) {
    entries.push({ kind: 'step', group });
    flushedGroups?.set(key, group);
  }
  stepGroups.clear();
}

function isStepRelatedEvent(eventType: string): boolean {
  // SessionPaused with a stepExecutionId is also step-related (agent request_input)
  return eventType.startsWith('Step') || eventType === 'SessionPaused';
}
