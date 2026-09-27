import type {
  Message,
  SessionEvent,
  StateValueRef,
  WorkflowRunSurfaceState,
  WorkflowSurfaceRunStatus,
} from '../../types.js';
import { extractDisplayContent } from '../../content-extraction.js';
import type { RunViewState } from '../state.js';
import { toISOTimestamp, ensureSurfaceMounted, freezePreviousSurfaceForRun } from '../helpers.js';

import type { SseEventContext } from './sessionLifecycle.js';

export function applySurfaceEvents(
  state: RunViewState,
  event: SessionEvent,
  ctx: SseEventContext,
): RunViewState {
  const { stepSenderName, eventTimestampMs } = ctx;
  let next = state;
  if (event.eventType === 'SurfaceUpdate' && event.surfaceMutations) {
    const surfaceId = event.surfaceId ?? 'unknown';
    const msgId = `surface-${surfaceId}`;
    const existingIdx = next.messages.findIndex((m) => m.id === msgId);

    // Accumulate mutations into an existing surface message or create a new one
    const existingMutations =
      existingIdx >= 0
        ? ((next.messages[existingIdx]?.richContent as { mutations?: unknown[] } | undefined)
            ?.mutations ?? [])
        : [];
    const allMutations = [...existingMutations, ...event.surfaceMutations];
    const isComplete = event.surfaceMutations.some(
      (m) => (m as { type?: string }).type === 'completeSurface',
    );

    const surfaceMsg: Message = {
      id: msgId,
      role: 'assistant',
      content: 'Generated surface',
      richContent: { mutations: allMutations },
      timestamp: toISOTimestamp(event.timestamp),
      senderName: stepSenderName,
      semanticType: isComplete ? 'surface' : 'streamable_surface',
    };

    if (existingIdx >= 0) {
      const msgs = [...next.messages];
      msgs[existingIdx] = surfaceMsg;
      next = { ...next, messages: msgs };
    } else {
      next = { ...next, messages: [...next.messages, surfaceMsg] };
    }
  }

  if (event.eventType === 'SubflowEventForwarded' && event.metadata) {
    const sourceEventType = event.metadata.sourceEventType as string | undefined;
    const meta = event.metadata;
    // Derive a label for the subflow source. When two parallel runners
    // are active (e.g. helmsman runs compose-skill + bind-capability in
    // the same turn), the agentId alone — "cybernetic-runner" — collides;
    // workflow + task disambiguates. Falls back to agent/step names.
    const subflowAgentId = typeof meta.sourceAgentId === 'string' ? meta.sourceAgentId : undefined;
    // Friendly name the delegate op stamped for custom agents (absent for
    // platform roles, which resolve to a role label below).
    const subflowDisplayAgentName =
      typeof meta.displayAgentName === 'string' ? meta.displayAgentName : undefined;
    const subflowStepNameMeta =
      typeof meta.subflowStepName === 'string' ? meta.subflowStepName : undefined;
    const subflowWorkflowSlug =
      typeof meta.displayWorkflowSlug === 'string' ? meta.displayWorkflowSlug : undefined;
    const subflowTaskName =
      typeof meta.displayTaskName === 'string' ? meta.displayTaskName : undefined;
    const subflowRole = ((): string | undefined => {
      if (subflowStepNameMeta === 'run-coach') return 'coach';
      if (subflowAgentId?.includes('runner')) return 'runner';
      if (subflowAgentId?.includes('coach')) return 'coach';
      if (subflowAgentId?.includes('helmsman')) return 'helmsman';
      return undefined;
    })();
    // Two-axis label: the bubble's senderName is *who* is speaking
    // (the role — concise), while the branch-icon header above the
    // bubble is *what context* they're in (workflow › task). Splitting
    // them removes the "cybernetic-runner / cybernetic-runner"
    // duplication and makes parallel runs trivially distinguishable.
    const workflowContextLabel =
      subflowWorkflowSlug && subflowTaskName
        ? `${subflowWorkflowSlug} › ${subflowTaskName}`
        : subflowWorkflowSlug;
    // subflowSource doubles as the grouping key in groupConversationItems —
    // workflow-as-source means two parallel runners on different workflows
    // naturally cluster apart. Falls back to agent/step when no workflow.
    const subflowSourceLabel =
      workflowContextLabel ??
      subflowAgentId ??
      subflowStepNameMeta ??
      (typeof meta.stepName === 'string' ? meta.stepName : undefined) ??
      (typeof meta.sourceStepId === 'string' ? meta.sourceStepId : undefined) ??
      'Subagent';
    // senderName: custom-agent name when stamped, else the resolved role,
    // else the agent ID.
    const senderNameLabel = subflowDisplayAgentName ?? subflowRole ?? subflowAgentId ?? 'Subagent';

    // Friendly header label for a plain delegation (no workflow context):
    // custom-agent name when the delegate op stamped one, else the capitalized
    // platform role (Helmsman/Runner/Coach), else the humanized systemRole.
    // Workflow subflows keep their `slug › task` header, so this stays unset
    // for them and the grouping key (`subflowSourceLabel`) remains stable.
    const subflowTarget = meta.sourceTarget as { kind?: string; systemRole?: string } | undefined;
    const capitalize = (s: string): string => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);
    const subflowFriendlyLabel: string | undefined =
      workflowContextLabel !== undefined
        ? undefined
        : (subflowDisplayAgentName ??
          (subflowRole ? capitalize(subflowRole) : undefined) ??
          (subflowTarget?.kind === 'platform-role' && typeof subflowTarget.systemRole === 'string'
            ? capitalize(subflowTarget.systemRole.replace(/^cybernetic-/, ''))
            : undefined));
    const subflowLabelField = subflowFriendlyLabel ? { subflowLabel: subflowFriendlyLabel } : {};

    // Child step succeeded — render its final message as a fresh entry under
    // the same visibility/collapse rules as the main agent (only style
    // differs). A subflow carries no live streaming placeholder to promote, so
    // unlike the main agent's path this only ever creates, never promotes.
    if (sourceEventType === 'StepSucceeded') {
      const childAgentMsg = meta.agentMessage as string | undefined;

      if (childAgentMsg) {
        const subflowMsg: Message = {
          id: `subflow-msg-${event.eventId}`,
          role: 'assistant',
          content: childAgentMsg,
          timestamp: toISOTimestamp(event.timestamp),
          senderName: senderNameLabel,
          subflowSource: subflowSourceLabel,
          ...subflowLabelField,
          isInterim: true,
        };
        if (!next.messages.some((m) => m.id === subflowMsg.id)) {
          next = { ...next, messages: [...next.messages, subflowMsg] };
        }
      }
    }

    // Display output from child — render media/content forwarded with displayOutput.
    if (sourceEventType === 'StepSucceeded' && meta.displayOutput === true) {
      const resolvedOutput = meta.resolvedOutput as StateValueRef | undefined;
      if (resolvedOutput) {
        const extracted = extractDisplayContent(resolvedOutput);
        if (extracted) {
          const childStepName = typeof meta.stepName === 'string' ? meta.stepName : undefined;
          const outputMsg: Message = {
            id: `subflow-output-${event.eventId}`,
            role: 'assistant',
            content: extracted.text,
            richContent: extracted.richData,
            mediaItems: extracted.mediaItems,
            timestamp: toISOTimestamp(event.timestamp),
            senderName: senderNameLabel,
            subflowSource: subflowSourceLabel,
            ...subflowLabelField,
            isInterim: true,
            ...(childStepName ? { stepDetail: childStepName } : {}),
            ...(extracted.payloadRef ? { payloadRef: extracted.payloadRef } : {}),
            ...(extracted.semanticType ? { semanticType: extracted.semanticType } : {}),
          };
          if (!next.messages.some((m) => m.id === outputMsg.id)) {
            next = { ...next, messages: [...next.messages, outputMsg] };
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------

  // Mount rule A: SessionPaused with pauseContract.kind ===
  // 'waiting_on_workflow_run' → insert idempotent surface item
  // anchored at pausedAtStepExecutionId AND seed a sparse run state
  // marked `needsHydration: true`.
  //
  if (event.eventType === 'SessionPaused') {
    const pc = event.data.pauseContract;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pauseContract kind narrows for mounts; keep explicit for forward compat
    if (pc && typeof pc === 'object' && 'kind' in pc && pc.kind === 'waiting_on_workflow_run') {
      const runId = pc.runId;
      const anchor =
        (event.data as { pausedAtStepExecutionId?: string }).pausedAtStepExecutionId ??
        event.stepExecutionId ??
        '';
      if (runId && anchor) {
        const beforeMount = next.workflowSurfaceItems;
        const sameAnchorExists = beforeMount.some(
          (it) => it.runId === runId && it.anchorStepExecutionId === anchor,
        );
        const itemsAfterFreeze = sameAnchorExists
          ? beforeMount
          : freezePreviousSurfaceForRun(beforeMount, runId, next.workflowRuns[runId]);
        const afterMount = ensureSurfaceMounted(itemsAfterFreeze, runId, anchor, eventTimestampMs);
        // Server-side stream order can land `WorkflowTaskUpdate(running)`
        // BEFORE `SessionPaused` on the helmsman session's events stream:
        // `emitStepPaused` writes to the results stream (consumed
        // asynchronously by the orchestrator's result loop), while
        // `dispatchTask` writes the running update directly to the
        // session events stream. If the WorkflowTaskUpdate handler
        // already created a sparse seed for this runId, preserve its
        // tasks here and merge in the pauseContract metadata
        // (slug/status). Without this, the first task's row would be
        // lost and the surface would sit at "Loading tasks…" until the
        // first task's succeeded event arrives.
        const runs = next.workflowRuns;
        const seeded: WorkflowRunSurfaceState =
          runId in runs
            ? {
                ...runs[runId],
                slug: runs[runId].slug || pc.slug,
                status:
                  runs[runId].status === 'running'
                    ? runs[runId].status
                    : (pc.status as WorkflowSurfaceRunStatus),
              }
            : {
                runId,
                slug: pc.slug,
                status: pc.status as WorkflowSurfaceRunStatus,
                pauseVersion: 0,
                startedAt: event.timestamp,
                tasks: {},
                isFrozen: false,
                needsHydration: true,
              };
        const nextRuns = { ...runs, [runId]: seeded };
        if (afterMount !== beforeMount || nextRuns !== runs) {
          next = { ...next, workflowSurfaceItems: afterMount, workflowRuns: nextRuns };
        }
      }
    }
  }

  // WorkflowRunUpdate handler. Merges run-level state, freezes on
  // terminal, and applies mount rule B (catch-up emissions carry
  // `waiterStepExecutionId` as the mount anchor). Authoritative for
  // run-level lifecycle — clears `needsHydration` to false unless
  // the server marked the catch-up emission as task-list truncated
  // (run has more tasks than the catch-up cap), in which case we
  // keep `needsHydration: true` so the BFF merge can fill the
  return next;
}
