import type { Message, WorkflowRunSurfaceState, WorkflowSurfaceTaskState } from '../types.js';
import { INITIAL_STATE, type RunViewState, type RunViewAction } from './state.js';
import { shouldAcceptTaskUpdate, bumpSurfaceRevision } from './helpers.js';

export function applyLocalAction(state: RunViewState, action: RunViewAction): RunViewState | null {
  switch (action.type) {
    case 'RESET':
      return INITIAL_STATE;

    case 'HYDRATE_SNAPSHOT':
      // Deltas are not durable, so a snapshot folded from events carries no
      // harness feed and hydrating over one would blank a step still running.
      // Whatever the snapshot does carry wins; the rest is kept.
      return {
        ...action.snapshot,
        harnessActivity: { ...state.harnessActivity, ...action.snapshot.harnessActivity },
      };

    case 'INLINE_PROPOSAL_FOCUS': {
      const id = `inline-focus-${action.itemId}`;
      if (state.messages.some((m) => m.id === id)) {
        // SSE reconnect re-delivered the same focus message — ignore.
        return state;
      }
      const msg: Message = {
        id,
        role: 'assistant',
        content: '',
        semanticType: 'inline_proposal_focus',
        richContent: { itemId: action.itemId, reason: action.reason },
        timestamp: action.timestamp,
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case 'USER_MESSAGE': {
      const msg: Message = {
        id: action.id,
        role: 'user',
        content: action.content,
        timestamp: action.timestamp,
        ...(action.deliveryState ? { deliveryState: action.deliveryState } : {}),
      };
      return {
        ...state,
        messages: [...state.messages, msg],
      };
    }

    case 'SET_MESSAGE_DELIVERY': {
      const idx = state.messages.findIndex((m) => m.id === action.id);
      const existing = idx >= 0 ? state.messages[idx] : undefined;
      if (!existing) return state;
      if ((existing.deliveryState ?? null) === action.deliveryState) return state;
      const messages = [...state.messages];
      if (action.deliveryState === null) {
        const { deliveryState: _stripped, ...kept } = existing;
        messages[idx] = kept;
      } else {
        messages[idx] = { ...existing, deliveryState: action.deliveryState };
      }
      return { ...state, messages };
    }

    case 'REMOVE_MESSAGE': {
      if (!state.messages.some((m) => m.id === action.id)) return state;
      return { ...state, messages: state.messages.filter((m) => m.id !== action.id) };
    }

    case 'SUBMIT_ERROR': {
      const msg: Message = {
        id: action.id,
        role: 'system',
        content: action.error,
        timestamp: action.timestamp,
      };
      return {
        ...state,
        messages: [...state.messages, msg],
      };
    }

    case 'LOCAL_RUN_STATE':
      return {
        ...state,
        status: action.status,
        requiredInput:
          action.requiredInput !== undefined ? action.requiredInput : state.requiredInput,
        blockedOn:
          action.status === 'PAUSED' || action.status === 'WAITING_ON_CHILD'
            ? state.blockedOn
            : null,
        ...(action.clearError
          ? {
              errorMessage: null,
              errorDetail: null,
              userError: null,
            }
          : {}),
      };

    case 'SSE_EVENT':
    case 'LIVE_DELTA':
      return null;

    case 'MARK_WORKFLOW_RUN_NEEDS_HYDRATION': {
      const { runId } = action;
      const existing: WorkflowRunSurfaceState | undefined = state.workflowRuns[runId];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- run entry absent when nothing mounted it
      if (!existing || existing.needsHydration) return state;
      return {
        ...state,
        workflowRuns: {
          ...state.workflowRuns,
          [runId]: { ...existing, needsHydration: true },
        },
        workflowSurfaceItems: bumpSurfaceRevision(state.workflowSurfaceItems, runId),
      };
    }

    case 'HYDRATE_WORKFLOW_RUN': {
      const runId = action.state.runId;
      if (!(runId in state.workflowRuns)) {
        return {
          ...state,
          workflowRuns: {
            ...state.workflowRuns,
            [runId]: { ...action.state, needsHydration: false },
          },
          workflowSurfaceItems: bumpSurfaceRevision(state.workflowSurfaceItems, runId),
        };
      }
      const existing = state.workflowRuns[runId];
      const mergedTasks: Record<string, WorkflowSurfaceTaskState> = { ...existing.tasks };
      for (const [taskId, incoming] of Object.entries(action.state.tasks)) {
        const prev: WorkflowSurfaceTaskState | undefined = mergedTasks[taskId];
        if (shouldAcceptTaskUpdate(prev, incoming)) {
          // The BFF snapshot can land paused-without-
          // hydration for a task that the live SSE has already populated
          // with humanIntent + actionPreview + resumeContract (race: BFF
          // detail read happened before the workflow def re-resolution,
          // OR the workflow definition lookup failed at detail-build
          // time so `buildHumanTaskHydrationFields` was never called).
          // `shouldAcceptTaskUpdate` returns true because status rank +
          // attempt match, but a wholesale replace silently wipes the
          // live human-task fields — leaving the operator looking at a
          // paused row with no Approve/Reject controls.
          //
          // Field-merge when prev and incoming agree on (status,
          // attempt): keep whichever side carries each human-task
          // hydration field. The BFF snapshot is authoritative for
          // bookkeeping (label, timestamps, summary) but live wins on
          // hydration that only the dispatcher's pause emit populates.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tasks[taskId] absent on first insert
          if (prev?.attempt === incoming.attempt && prev?.status === incoming.status) {
            mergedTasks[taskId] = {
              ...incoming,
              ...(prev.humanIntent && !incoming.humanIntent
                ? { humanIntent: prev.humanIntent }
                : {}),
              ...(prev.actionPreview && !incoming.actionPreview
                ? { actionPreview: prev.actionPreview }
                : {}),
              ...(prev.resumeContract !== undefined && incoming.resumeContract === undefined
                ? { resumeContract: prev.resumeContract }
                : {}),
              ...(prev.pauseVersion !== undefined && incoming.pauseVersion === undefined
                ? { pauseVersion: prev.pauseVersion }
                : {}),
              ...(prev.failureMode && !incoming.failureMode
                ? { failureMode: prev.failureMode }
                : {}),
              ...(prev.resolutionSchema && !incoming.resolutionSchema
                ? { resolutionSchema: prev.resolutionSchema }
                : {}),
            };
          } else {
            mergedTasks[taskId] = incoming;
          }
        }
      }
      // When existing entry is still sparse (no authoritative
      // WorkflowRunUpdate has landed), the BFF is the authoritative
      // source for run-level lifecycle. Otherwise, existing wins.
      const liveAuthoritative = !existing.needsHydration;
      const mergedStatus = liveAuthoritative ? existing.status : action.state.status;
      const merged: WorkflowRunSurfaceState = {
        runId,
        slug: liveAuthoritative ? existing.slug || action.state.slug : action.state.slug,
        ...(existing.workflowTitle || action.state.workflowTitle
          ? {
              workflowTitle: liveAuthoritative
                ? (existing.workflowTitle ?? action.state.workflowTitle)
                : (action.state.workflowTitle ?? existing.workflowTitle),
            }
          : {}),
        status: mergedStatus,
        pauseVersion: liveAuthoritative
          ? Math.max(existing.pauseVersion, action.state.pauseVersion)
          : action.state.pauseVersion,
        ...(existing.pausedReason || action.state.pausedReason
          ? {
              pausedReason: liveAuthoritative
                ? (existing.pausedReason ?? action.state.pausedReason)
                : (action.state.pausedReason ?? existing.pausedReason),
            }
          : {}),
        startedAt: liveAuthoritative
          ? existing.startedAt || action.state.startedAt
          : action.state.startedAt,
        ...(existing.completedAt || action.state.completedAt
          ? {
              completedAt: liveAuthoritative
                ? (existing.completedAt ?? action.state.completedAt)
                : (action.state.completedAt ?? existing.completedAt),
            }
          : {}),
        tasks: mergedTasks,
        ...(action.state.graphFidelity ? { graphFidelity: action.state.graphFidelity } : {}),
        ...(action.state.workflowGraph ? { workflowGraph: action.state.workflowGraph } : {}),
        ...(action.state.allowedResumeModes
          ? { allowedResumeModes: action.state.allowedResumeModes }
          : {}),
        // Rich pause contract — BFF snapshot is authoritative when present
        // (freshly surfaced for the current pause); keep the existing one
        // only while still paused, and never carry it onto a resumed run.
        ...(mergedStatus === 'paused'
          ? action.state.resumeContract
            ? { resumeContract: action.state.resumeContract }
            : existing.resumeContract
              ? { resumeContract: existing.resumeContract }
              : {}
          : {}),
        // First-class output: the BFF snapshot's `result` (built by
        // `buildWorkflowRunResult`) is authoritative when present — it
        // re-derives the full bag from the rows, superseding the live
        // incremental accumulation. Keep live values otherwise.
        ...(action.state.result
          ? { result: action.state.result }
          : existing.result
            ? { result: existing.result }
            : {}),
        ...(action.state.outputs
          ? { outputs: action.state.outputs }
          : existing.outputs
            ? { outputs: existing.outputs }
            : {}),
        isFrozen: liveAuthoritative ? existing.isFrozen : action.state.isFrozen,
        // Hydration completed — drop the flag so subsequent renders
        // don't refire the BFF fetch.
        needsHydration: false,
      };
      return {
        ...state,
        workflowRuns: { ...state.workflowRuns, [runId]: merged },
        workflowSurfaceItems: bumpSurfaceRevision(state.workflowSurfaceItems, runId),
      };
    }
    default:
      return null;
  }
}
