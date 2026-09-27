'use client';

import { useQueryClient, type QueryKey } from '@tanstack/react-query';

import { useApiQuery } from './useApiQuery.js';
import { useSpaceEntityEventListener } from './use-space-entity-events.js';

/** Mirrors the server `WorkflowRunSummarySchema` (Plan 228 §5.1). */
export interface SpaceWorkflowRunSummary {
  runId: string;
  status: string;
  workflowSlug: string;
  workflowRevision: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  totalCostCents: number | null;
  totalTokens: number | null;
  evalScore: number | null;
  evalVerdict: string | null;
  taskCount: number;
  pausedReason: string | null;
  initiatedByUserId: string | null;
  sessionId: string | null;
  rootSessionId: string | null;
}

interface SpaceWorkflowRunsPayload {
  runs: SpaceWorkflowRunSummary[];
  counts: { running: number; paused: number };
  nextCursor: string | null;
}

export function spaceWorkflowRunsKey(spaceId: string): QueryKey {
  return ['space', spaceId, 'workflow-runs', 'active'];
}

export interface UseSpaceWorkflowRunsResult {
  runs: SpaceWorkflowRunSummary[];
  counts: { running: number; paused: number };
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Space-wide **active** run feed for the Workbench (Plan 228 §3.2): paused
 * first, then running — the runs that need attention. Terminal runs are NOT
 * included here (there can be hundreds); each skill loads its own recent
 * history lazily on expand.
 *
 * Event-driven, not polled: the orchestrator emits `entity.run.updated` on run
 * create / pause / terminal transitions, and this hook invalidates on it.
 */
export function useSpaceWorkflowRuns(
  spaceId: string | null,
  opts?: { limit?: number },
): UseSpaceWorkflowRunsResult {
  const limit = opts?.limit ?? 50;
  const queryClient = useQueryClient();

  const query = useApiQuery<SpaceWorkflowRunsPayload>({
    key: spaceId ? spaceWorkflowRunsKey(spaceId) : ['space', '__none__', 'workflow-runs', 'active'],
    path: `/spaces/${spaceId ?? ''}/workflow-runs?status=running,paused&limit=${String(limit)}`,
    staleTime: 4_000,
    enabled: spaceId !== null,
    ...(spaceId ? { spaceId } : {}),
  });

  // Invalidate on a run-lifecycle entity event (create / pause / resume /
  // terminal — see emitRunUpdated) or a runner/procedure task event. Per-event,
  // so a run transition can't be shadowed by a later unrelated event arriving
  // in the same render pass. The event's slug also refreshes that skill's
  // lazily-loaded run history, which has no live channel of its own.
  useSpaceEntityEventListener(spaceId, (event) => {
    if (!spaceId) return;
    const type = event.eventType;
    if (
      !type.startsWith('entity.run.') &&
      !type.startsWith('entity.runner.') &&
      !type.startsWith('entity.procedure.')
    ) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: spaceWorkflowRunsKey(spaceId) });
    if (typeof event.workflowSlug === 'string' && event.workflowSlug.length > 0) {
      void queryClient.invalidateQueries({
        queryKey: ['space', spaceId, 'workflow', event.workflowSlug, 'runs'],
      });
    }
  });

  return {
    runs: query.data?.runs ?? [],
    counts: query.data?.counts ?? { running: 0, paused: 0 },
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: () => void query.refetch(),
  };
}
