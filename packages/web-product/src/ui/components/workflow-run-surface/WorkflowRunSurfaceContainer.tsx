'use client';

import { useCallback, useEffect, useReducer } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { runViewReducer, initialRunViewState } from '@aflow/run-view';
import type { SessionEvent } from '../../lib/types.js';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useSessionEventListener } from '../../hooks/use-session-events.js';
import { WorkflowRunSurface } from './WorkflowRunSurface.js';
import { useWorkflowRunUsageRefresh } from './useWorkflowRunUsageRefresh.js';
import { useWorkflowRunPauseRefresh } from './useWorkflowRunPauseRefresh.js';
import {
  workflowRunDetailToSurfaceState,
  type WorkflowRunDetailResponse,
} from './workflowRunDetailToState.js';

interface WorkflowRunSurfaceContainerProps {
  runId: string;
  spaceId: string;
}

export function WorkflowRunSurfaceContainer({ runId, spaceId }: WorkflowRunSurfaceContainerProps) {
  const [reducerState, dispatch] = useReducer(runViewReducer, initialRunViewState);

  // 1. Hydrate — one-shot snapshot through the shared cache. SSE is the live
  //    channel (below). A finite staleTime (not Infinity) keeps SSE as the
  //    live driver while still letting a remount / window-refocus refetch the
  //    snapshot — a safety net that corrects a terminal update the live tail
  //    missed (e.g. a run cancelled out-of-band by Helmsman). Control failures
  //    also invalidate this key (see WorkflowRunControls).
  const { data, error } = useApiQuery<WorkflowRunDetailResponse>({
    key: ['space', spaceId, 'workflow-run', runId],
    path: `/spaces/${spaceId}/workflow-runs/${runId}`,
    spaceId,
    staleTime: 30_000,
  });

  const originatingSessionId = data?.originatingSessionId ?? null;
  const tailCursor = data?.tailCursor ?? null;

  // 2. Seed the run-scoped reducer from the snapshot. Idempotent — the
  //    reducer's HYDRATE_WORKFLOW_RUN merges by runId, so a refetch is safe.
  useEffect(() => {
    if (!data) return;
    dispatch({
      type: 'HYDRATE_WORKFLOW_RUN',
      state: workflowRunDetailToSurfaceState(data, Date.now()),
    });
  }, [data]);

  // 3. Live tail of the originating session, gated until the snapshot resolves
  //    so the cursor is real (broker first-acquire-wins on the cursor). Folds
  //    every event for THIS run into the reducer; events for other runs on the
  //    same session land in `workflowRuns[otherRunId]` and are simply not read.
  const onEvent = useCallback((event: SessionEvent) => {
    dispatch({ type: 'SSE_EVENT', event });
  }, []);

  const { isConnected } = useSessionEventListener(data ? originatingSessionId : null, onEvent, {
    initialCursor: tailCursor,
    skipCatchup: true,
    replayHistory: true,
  });

  const runState = reducerState.workflowRuns[runId];

  const queryClient = useQueryClient();
  const refreshUsage = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['space', spaceId, 'workflow-run', runId] });
  }, [queryClient, spaceId, runId]);
  useWorkflowRunUsageRefresh({ enabled: true, state: runState, onRefresh: refreshUsage });
  // When the run pauses mid-tail, the live SSE WorkflowRunUpdate flips status to
  // 'paused' but carries no resumeContract (it lives behind the BFF detail).
  // Re-fetch the snapshot so PauseExplanation gets its contract instead of
  // sitting on "Loading pause details…". `selfHydrate={false}` disables the
  // surface's own copy of this hook, so the container must own it.
  useWorkflowRunPauseRefresh({ enabled: true, state: runState, onRefresh: refreshUsage });

  if (error && !runState) {
    return (
      <div className="workflow-run-surface workflow-run-surface--loading">
        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          {error.status === 404
            ? 'This run no longer exists.'
            : 'Could not load this run. Retry shortly.'}
        </span>
      </div>
    );
  }

  return (
    <WorkflowRunSurface
      runId={runId}
      // While the snapshot loads, `runState` is undefined → the surface shows
      // its own loading skeleton.
      state={runState}
      spaceId={spaceId}
      selfHydrate={false}
      // Hydration is owned by this container; the surface never self-hydrates.
      onHydrate={() => undefined}
      // Only surface a connection state when we actually have a session to
      // tail; a run with no originating session is a static snapshot.
      {...(originatingSessionId ? { sseConnected: isConnected } : {})}
    />
  );
}
