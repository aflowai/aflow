import type {
  InlineAppletItem,
  InlineArtifactItem,
  InlineSurfaceItem,
  SessionEvent,
  WorkflowRunSurfaceState,
  WorkflowSurfaceRunStatus,
  WorkflowSurfaceTaskState,
  WorkflowSurfaceTaskStatus,
} from '../../types.js';
import { THINKING_CLASS_OPS } from '../../op-labels.js';
import type { RunViewState } from '../state.js';
import {
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
  shouldAcceptTaskUpdate,
  bumpSurfaceRevision,
  ensureSurfaceMounted,
  placeAppletCard,
} from '../helpers.js';

import type { SseEventContext } from './sessionLifecycle.js';

export function applyWorkflowEvents(
  state: RunViewState,
  event: SessionEvent,
  ctx: SseEventContext,
): RunViewState {
  const { eventTimestampMs } = ctx;
  let next = state;
  if (event.eventType === 'WorkflowRunUpdate') {
    const payload = event.data.workflowRunUpdate;
    if (payload?.runId) {
      const runId = payload.runId;
      const baseline: WorkflowRunSurfaceState =
        runId in next.workflowRuns
          ? next.workflowRuns[runId]
          : {
              runId,
              slug: payload.slug,
              status: payload.status as WorkflowSurfaceRunStatus,
              pauseVersion: payload.pauseVersion,
              startedAt: payload.startedAt,
              tasks: {},
              isFrozen: false,
              needsHydration: false,
            };
      const tasksTruncated = event.metadata?.tasksTruncated === true;
      // If the run is already frozen, drop subsequent updates.
      if (!baseline.isFrozen) {
        const isTerminal = TERMINAL_RUN_STATUSES.has(payload.status as WorkflowSurfaceRunStatus);
        const runState: WorkflowRunSurfaceState = {
          ...baseline,
          slug: payload.slug,
          status: payload.status as WorkflowSurfaceRunStatus,
          pauseVersion: payload.pauseVersion,
          startedAt: payload.startedAt,
          isFrozen: isTerminal,
          // Authoritative live signal for run-level state. Keep
          // `needsHydration: true` only when the catch-up emission
          // truncated the per-run task list — the BFF fill is the
          // detail-repair path for omitted rows.
          needsHydration: tasksTruncated,
          ...(payload.workflowTitle ? { workflowTitle: payload.workflowTitle } : {}),
          ...(payload.pausedReason ? { pausedReason: payload.pausedReason } : {}),
          ...(payload.completedAt ? { completedAt: payload.completedAt } : {}),
          // Structured run result on terminal transitions. `result.output`
          // supersedes the incrementally-accumulated `outputs` bag (same
          // promotion source, fully re-derived at terminal time); the
          // baseline spread preserves prior `outputs` when absent.
          ...(payload.result ? { result: payload.result } : {}),
          ...(payload.result?.output ? { outputs: payload.result.output } : {}),
        };
        // The rich pause contract is BFF-hydrated and only meaningful while
        // paused; a live resume/terminal transition spreads the prior one
        // forward via `...baseline`, so drop it once the run leaves paused.
        if (runState.status !== 'paused' && runState.resumeContract !== undefined) {
          delete runState.resumeContract;
        }
        // Mount rule B: catch-up emission with waiterStepExecutionId.
        let surfaceItems = next.workflowSurfaceItems;
        if (payload.waiterStepExecutionId && !surfaceItems.some((it) => it.runId === runId)) {
          surfaceItems = ensureSurfaceMounted(
            surfaceItems,
            runId,
            payload.waiterStepExecutionId,
            eventTimestampMs,
          );
        }
        // Bump revision if the run is already mounted.
        surfaceItems = bumpSurfaceRevision(surfaceItems, runId);
        next = {
          ...next,
          workflowRuns: { ...next.workflowRuns, [runId]: runState },
          workflowSurfaceItems: surfaceItems,
        };
      }
    }
  }

  // WorkflowTaskUpdate handler. Merges task-level state with
  // replay-safety (lower attempts dropped; status regressions
  // dropped unless attempt increased).
  //
  if (event.eventType === 'WorkflowTaskUpdate') {
    const payload = event.data.workflowTaskUpdate;
    if (payload?.runId && payload.taskId) {
      const runId = payload.runId;
      const taskId = payload.taskId;
      // Producer-rerun cleared this descendant — drop the recorded row so it
      // reverts to a forward-DAG queued node (the server deleted it; the
      // scheduler re-dispatches fresh once the producer re-succeeds). This
      // bypasses `shouldAcceptTaskUpdate`, which would otherwise reject the
      // `running → scheduled` regression and leave the row stuck "running".
      if (payload.cleared) {
        const run = next.workflowRuns[runId];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- run/task may be absent if the clear lands first
        if (run?.tasks[taskId]) {
          const rest = { ...run.tasks };
          delete rest[taskId];
          next = {
            ...next,
            workflowRuns: { ...next.workflowRuns, [runId]: { ...run, tasks: rest } },
            workflowSurfaceItems: bumpSurfaceRevision(next.workflowSurfaceItems, runId),
          };
        }
        return next;
      }
      // Sparse seed when the run isn't yet known. The helmsman session's
      // event stream lands `WorkflowTaskUpdate(running)` BEFORE the
      // `SessionPaused` that Mount Rule A keys on, because
      // `emitStepPaused` writes a result that the orchestrator consumes
      // asynchronously, while `dispatchTask` writes the running event
      // directly. Without this seed, the first task's row is dropped
      // and the surface sits at "Loading tasks…" until the first task
      // succeeds. Mount Rule A's update below preserves these tasks
      // when SessionPaused finally arrives and fills in slug/anchor.
      const run: WorkflowRunSurfaceState =
        runId in next.workflowRuns
          ? next.workflowRuns[runId]
          : {
              runId,
              slug: '',
              status: 'running' as WorkflowSurfaceRunStatus,
              pauseVersion: 0,
              startedAt: payload.startedAt ?? event.timestamp,
              tasks: {},
              isFrozen: false,
              needsHydration: true,
            };
      const prev = run.tasks[taskId];
      const incomingStatus = payload.status as WorkflowSurfaceTaskStatus;
      const isTerminal = TERMINAL_TASK_STATUSES.has(incomingStatus);
      const incoming: WorkflowSurfaceTaskState = {
        taskId,
        label: payload.label,
        status: incomingStatus,
        attempt: payload.attempt,
        // Identity fields (workerSessionId / operationId / taskType /
        // humanIntent) are stable for a task's whole life but aren't re-stamped
        // on every lifecycle emit. Fall back to the prior row's value when an
        // update omits them so a later `succeeded`/`failed` event doesn't blink
        // the task-row icon back to the generic cube, or drop the step the live
        // feed is keyed by. The BFF detail hydration carries them
        // authoritatively. (`prev` is absent on first insert.)
        /* eslint-disable @typescript-eslint/no-unnecessary-condition -- tasks[taskId] absent on first insert */
        ...(payload.workerSessionId
          ? { workerSessionId: payload.workerSessionId }
          : prev?.workerSessionId
            ? { workerSessionId: prev.workerSessionId }
            : {}),
        ...(payload.operationId
          ? { operationId: payload.operationId }
          : prev?.operationId
            ? { operationId: prev.operationId }
            : {}),
        ...(payload.taskType
          ? { taskType: payload.taskType }
          : prev?.taskType
            ? { taskType: prev.taskType }
            : {}),
        ...(prev?.stepCount != null ? { stepCount: prev.stepCount } : {}),
        ...(prev?.totalTokens != null ? { totalTokens: prev.totalTokens } : {}),
        ...(prev?.inputRef ? { inputRef: prev.inputRef } : {}),
        ...(prev?.outputRef ? { outputRef: prev.outputRef } : {}),
        ...(prev?.errorRef ? { errorRef: prev.errorRef } : {}),
        /* eslint-enable @typescript-eslint/no-unnecessary-condition */
        ...(payload.startedAt ? { startedAt: payload.startedAt } : {}),
        ...(payload.completedAt ? { completedAt: payload.completedAt } : {}),
        ...(payload.failureReason ? { failureReason: payload.failureReason } : {}),
        ...(payload.failure ? { failure: payload.failure } : {}),
        ...(payload.summary ? { summary: payload.summary } : {}),
        /* eslint-disable @typescript-eslint/no-unnecessary-condition -- tasks[taskId] absent on first insert */
        ...(payload.humanIntent
          ? { humanIntent: payload.humanIntent }
          : prev?.humanIntent
            ? { humanIntent: prev.humanIntent }
            : {}),
        ...(payload.humanDecision
          ? { humanDecision: payload.humanDecision }
          : prev?.humanDecision
            ? { humanDecision: prev.humanDecision }
            : {}),
        /* eslint-enable @typescript-eslint/no-unnecessary-condition */
        ...(payload.resolutionSchema ? { resolutionSchema: payload.resolutionSchema } : {}),
        ...(payload.actionPreview
          ? {
              actionPreview: {
                op: payload.actionPreview.op,
                input: payload.actionPreview.input ?? null,
              },
            }
          : {}),
        ...(payload.resumeContract !== undefined ? { resumeContract: payload.resumeContract } : {}),
        ...(payload.pauseVersion !== undefined ? { pauseVersion: payload.pauseVersion } : {}),
        ...(payload.failureMode ? { failureMode: payload.failureMode } : {}),
        /* eslint-disable @typescript-eslint/no-unnecessary-condition -- tasks[taskId] absent on first insert */
        ...(!isTerminal && prev?.activeOp ? { activeOp: prev.activeOp } : {}),
        ...(!isTerminal && prev?.activeStepName ? { activeStepName: prev.activeStepName } : {}),
        ...(!isTerminal && prev?.activeDetail ? { activeDetail: prev.activeDetail } : {}),
        ...(!isTerminal && prev?.activeOpUpdatedAtMs !== undefined
          ? { activeOpUpdatedAtMs: prev.activeOpUpdatedAtMs }
          : {}),
        ...(!isTerminal && prev?.activeOpSequence !== undefined
          ? { activeOpSequence: prev.activeOpSequence }
          : {}),
        ...(!isTerminal && prev?.lastSubstantiveOp
          ? { lastSubstantiveOp: prev.lastSubstantiveOp }
          : {}),
        ...(!isTerminal && prev?.lastSubstantiveDetail
          ? { lastSubstantiveDetail: prev.lastSubstantiveDetail }
          : {}),
        ...(!isTerminal && prev?.lastSubstantiveOpUpdatedAtMs !== undefined
          ? { lastSubstantiveOpUpdatedAtMs: prev.lastSubstantiveOpUpdatedAtMs }
          : {}),
        /* eslint-enable @typescript-eslint/no-unnecessary-condition */
        lastMutatedAtMs: eventTimestampMs,
      };
      if (shouldAcceptTaskUpdate(prev, incoming)) {
        // First-class output: a succeeded promoting task carries the
        // sanitized run-level state slice it just filled. Accumulate
        // (later tasks win on key collisions, matching the promotion
        // semantics) so the surface shows live output values mid-run.
        const mergedOutputs =
          payload.promotedState && Object.keys(payload.promotedState).length > 0
            ? { ...run.outputs, ...payload.promotedState }
            : undefined;
        const updatedRun: WorkflowRunSurfaceState = {
          ...run,
          tasks: { ...run.tasks, [taskId]: incoming },
          ...(mergedOutputs ? { outputs: mergedOutputs } : {}),
        };
        next = {
          ...next,
          workflowRuns: { ...next.workflowRuns, [runId]: updatedRun },
          workflowSurfaceItems: bumpSurfaceRevision(next.workflowSurfaceItems, runId),
        };
      }

      if (
        payload.presentation?.mode === 'rendered_inline' &&
        payload.presentation.substrate !== 'workflow_run'
      ) {
        const inlineId = `workflow:${runId}:${taskId}`;
        const anchorStepExecutionId = event.stepExecutionId ?? `${runId}:${taskId}`;
        // Preserve the original mount timestamp if the streaming
        // `WorkflowTaskSurfaceUpdate` path mounted this item first.
        const existingItem: InlineAppletItem | InlineArtifactItem | InlineSurfaceItem | undefined =
          next.inlineItems[inlineId];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- inline item absent before first mount
        const createdAtMs = existingItem?.createdAtMs ?? eventTimestampMs;
        if (payload.presentation.substrate === 'applet') {
          // One card per instance, moved on re-reference — see the
          // session-path rule in stepEvents.ts.
          const appletItem: InlineAppletItem = {
            kind: 'inline_applet',
            itemId: inlineId,
            anchorStepExecutionId,
            instanceId: payload.presentation.instanceId,
            workflowRunId: runId,
            createdAtMs,
          };
          return { ...next, inlineItems: placeAppletCard(next.inlineItems, appletItem) };
        }
        const inlineItem =
          payload.presentation.substrate === 'artifact'
            ? ({
                kind: 'inline_artifact',
                itemId: inlineId,
                anchorStepExecutionId,
                artifactId: payload.presentation.artifactId,
                versionId: payload.presentation.versionId,
                ...(payload.presentation.data !== undefined
                  ? { data: payload.presentation.data }
                  : {}),
                workflowRunId: runId,
                createdAtMs,
              } satisfies InlineArtifactItem)
            : ({
                kind: 'inline_surface',
                itemId: inlineId,
                anchorStepExecutionId,
                surfaceId: payload.presentation.surfaceId,
                // Surfaces complete with the task — by the time we see
                // the terminal `WorkflowTaskUpdate`, the mutation
                // stream is closed. Mid-task surface mounts (the
                // streaming path) come through `WorkflowTaskSurfaceUpdate`
                // below and set `isStreaming: true`.
                isStreaming: false,
                // Preserve mutations accumulated by the streaming
                // path (`WorkflowTaskSurfaceUpdate` handler below).
                mutations: (() => {
                  const existing = next.inlineItems[inlineId];
                  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- inline mount may be first for this id
                  return existing?.kind === 'inline_surface' ? existing.mutations : [];
                })(),
                workflowRunId: runId,
                createdAtMs,
              } satisfies InlineSurfaceItem);
        next = {
          ...next,
          inlineItems: { ...next.inlineItems, [inlineId]: inlineItem },
        };
      }
    }
  }

  if (event.eventType === 'WorkflowTaskSurfaceUpdate') {
    const payload = event.data.workflowTaskSurfaceUpdate;
    if (payload?.runId && payload.taskId && payload.surfaceId) {
      const inlineId = `workflow:${payload.runId}:${payload.taskId}`;
      const anchor =
        (payload.stepExecutionId as string | undefined) ?? `${payload.runId}:${payload.taskId}`;
      const existing = next.inlineItems[inlineId];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- first surface batch may mount inline item
      const existingSurface = existing?.kind === 'inline_surface' ? existing : null;

      const isNewAttempt =
        existingSurface?.lastSurfaceStepExecutionId !== undefined &&
        existingSurface.lastSurfaceStepExecutionId !== payload.stepExecutionId;

      const lastSeq = isNewAttempt ? undefined : existingSurface?.lastSurfaceSequence;
      const isFresh = lastSeq === undefined || payload.sequence > lastSeq;
      if (isFresh) {
        const batchEndsStream = payload.surfaceMutations.some(
          (m) => (m as { type?: string }).type === 'completeSurface',
        );
        // Accumulate mutations into the inline item so
        // `<InlineSurfaceCard>` can replay them through SurfaceRenderer.
        // On retry (`isNewAttempt`), start from empty so the
        // previous attempt's failed-mid-stream mutations don't leak
        // into the new render.
        const priorMutations = !isNewAttempt && existingSurface ? existingSurface.mutations : [];
        const priorStreaming =
          !isNewAttempt && existingSurface
            ? existingSurface.isStreaming && !batchEndsStream
            : !batchEndsStream;
        const inlineItem: InlineSurfaceItem = {
          kind: 'inline_surface',
          itemId: inlineId,
          anchorStepExecutionId: anchor,
          surfaceId: payload.surfaceId,
          isStreaming: priorStreaming,
          mutations: [...priorMutations, ...payload.surfaceMutations],
          lastSurfaceSequence: payload.sequence,
          lastSurfaceStepExecutionId: payload.stepExecutionId,
          workflowRunId: payload.runId,
          // Preserve the original mount timestamp across streaming
          // batches so the inline card keeps its chronological slot in
          // `appendInlineUiItems` when both lookups miss on later turns.
          createdAtMs: existingSurface?.createdAtMs ?? eventTimestampMs,
        };
        next = {
          ...next,
          inlineItems: { ...next.inlineItems, [inlineId]: inlineItem },
        };
      }
    }
  }

  if (event.eventType === 'WorkflowTaskActivity') {
    const payload = event.data.workflowTaskActivity;
    if (payload?.runId && payload.taskId) {
      const runId = payload.runId;
      const taskId = payload.taskId;
      if (runId in next.workflowRuns) {
        const run = next.workflowRuns[runId];
        if (taskId in run.tasks) {
          const prev = run.tasks[taskId];
          // Drop if it's already terminal — activity is moot.
          // Drop on out-of-order sequence.
          const canApply =
            !TERMINAL_TASK_STATUSES.has(prev.status) &&
            (prev.activeOpSequence === undefined || payload.sequence > prev.activeOpSequence);
          if (canApply) {
            const nowMs = eventTimestampMs;
            const isThinkingClass = THINKING_CLASS_OPS.has(payload.operationId);
            const updatedTask: WorkflowSurfaceTaskState = {
              ...prev,
              activeOp: payload.operationId,
              activeStepName: payload.stepName,
              activeDetail: payload.stepDetail,
              activeOpUpdatedAtMs: nowMs,
              activeOpSequence: payload.sequence,
              ...(isThinkingClass
                ? {}
                : {
                    lastSubstantiveOp: payload.operationId,
                    lastSubstantiveDetail: payload.stepDetail,
                    lastSubstantiveOpUpdatedAtMs: nowMs,
                  }),
              lastMutatedAtMs: nowMs,
            };
            const updatedRun: WorkflowRunSurfaceState = {
              ...run,
              tasks: { ...run.tasks, [taskId]: updatedTask },
            };
            next = {
              ...next,
              workflowRuns: { ...next.workflowRuns, [runId]: updatedRun },
              workflowSurfaceItems: bumpSurfaceRevision(next.workflowSurfaceItems, runId),
            };
          }
        }
      }
    }
  }
  return next;
}
