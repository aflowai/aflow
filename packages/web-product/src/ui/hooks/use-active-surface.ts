'use client';

import { useApi } from '../components/providers.js';
import * as coachSurfaceBroker from './coach-surface-broker.js';
import { useResumeOnUnblock } from './use-resume-on-unblock.js';
import { useSessionEventListener } from './use-session-events.js';
import { useApiQuery } from './useApiQuery.js';
import type {
  ActiveSurfaceRun,
  ActiveSurfaceRunLifecycle,
  ActiveSurfaceSnapshot,
  CoachSurfaceSnapshot,
} from '@aflow/schemas';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TERMINAL_LIFECYCLES = new Set<ActiveSurfaceRunLifecycle>([
  'cancelled',
  'failed',
  'completed',
]);

// ============================================================================
// Types
// ============================================================================

export type ActiveSurfaceStatus = 'loading' | 'fresh' | 'degraded' | 'fallback' | 'error';

export interface UseActiveSurfaceResult {
  snapshot: ActiveSurfaceSnapshot | null;
  status: ActiveSurfaceStatus;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Current Helmsman activity ("Used tools · API Call", "Asked for input"…)
   * derived from the root session's SSE. Null when unscoped or nothing
   * meaningful has streamed yet. Updates in place at chat cadence.
   */
  helmsmanActivity: string | null;
}

// ============================================================================
// Helmsman activity label vocabulary
// ============================================================================

/**
 * Friendly labels for the most common Helmsman tool operations. Same vocabulary
 * the Activity timeline uses so users see consistent wording across surfaces.
 * Unknown ops fall back to a titleized last-segment of the operation id.
 */
const OPERATION_LABELS: Record<string, string> = {
  'ai.agent.turn': 'Turn',
  'ai.text.generate': 'AI Generate',
  'ai.text.generate_json': 'AI Generate JSON',
  'ai.text.generate_stream': 'AI Generate Stream',
  'api.http.call': 'API Call',
  'agent.control.run_step': 'Run Step',
  'agent.control.delegate': 'Delegate',
  'agent.control.dispatch': 'Dispatch',
  'agent.control.resume': 'Resume',
  'agent.control.submit_output': 'Submit Output',
  'memory.store.query': 'Memory Query',
  'memory.store.get': 'Memory Read',
  'memory.store.put': 'Memory Write',
  'memory.store.vector_search': 'Vector Search',
  'search.web.search': 'Web Search',
  'compute.sandbox.exec': 'Run Code',
};

function friendlyOpLabel(operationId: string): string {
  if (OPERATION_LABELS[operationId]) return OPERATION_LABELS[operationId];
  const last = operationId.split('.').at(-1) ?? operationId;
  return last
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Cache key — sits under `['space', spaceId, ...]` so the §4.4
 * space-switch invalidation prefix drops it. The `rootSessionId`
 * segment distinguishes the scoped (chat inspector) and unscoped
 * (sidebar / indicator) variants — they share nothing because the
 * server returns different snapshots for each.
 */
function activeSurfaceQueryKey(spaceId: string, rootSessionId: string | null): QueryKey {
  return ['space', spaceId, 'active-surface', rootSessionId ?? 'unscoped'];
}

/**
 * Minimal `ActiveSurfaceSnapshot` used when the broker delivers state
 * before the REST bootstrap has written `queryKey`. Matches the server's
 * fallback shape (`activeSurface.ts`) so partial deltas have valid fields
 * to merge into.
 */
function brokerBaseActiveSurfaceSnapshot(spaceId: string): ActiveSurfaceSnapshot {
  return {
    spaceId,
    capturedAt: new Date().toISOString(),
    activeSurfaceVersion: 'broker',
    capturedFrom: 'live',
    freshnessReason: 'coach_surface topic',
    helmsman: {
      sessionId: null,
      lifecycle: 'unknown',
      mode: null,
      triggerSource: null,
      lastInteractionAt: null,
    },
    surfacedRuns: [],
    coach: {
      lifecycle: 'idle',
      pendingProposals: 0,
      pendingPlatformIssues: 0,
      pendingAnomalies: 0,
    },
    recentTransitions: [],
  };
}

/** Merge a wire `CoachSurfaceSnapshot` into the TanStack cache entry. */
function applyCoachBrokerSnapshot(
  spaceId: string,
  prev: ActiveSurfaceSnapshot | undefined,
  snap: CoachSurfaceSnapshot,
  isScoped: boolean,
): ActiveSurfaceSnapshot {
  const base = prev ?? brokerBaseActiveSurfaceSnapshot(spaceId);
  return {
    ...base,
    capturedAt: new Date().toISOString(),
    capturedFrom: 'live',
    coach: snap.coach,
    helmsman: snap.helmsman,
    recentTransitions: snap.recentTransitions,
    ...(isScoped ? {} : { surfacedRuns: snap.surfacedRuns }),
  };
}

export function useActiveSurface(
  spaceId: string,
  rootSessionId?: string | null,
): UseActiveSurfaceResult {
  const { apiUrl, headers, authFetch, blockedSession } = useApi();
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  // Sticky cache of terminal runs the operator has seen during this mount.
  // The server's `surfacedRuns` only retains terminal runs for ~120s
  const [terminalCache, setTerminalCache] = useState<ReadonlyMap<string, ActiveSurfaceRun>>(
    () => new Map(),
  );

  const [helmsmanActivity, setHelmsmanActivity] = useState<string | null>(null);

  const queryKey = useMemo(
    () => activeSurfaceQueryKey(spaceId, rootSessionId ?? null),
    [spaceId, rootSessionId],
  );

  const surfaceQuery = useApiQuery<ActiveSurfaceSnapshot>({
    key: queryKey,
    path: rootSessionId
      ? `/spaces/${spaceId}/cybernetic/active-surface?sessionId=${encodeURIComponent(rootSessionId)}`
      : `/spaces/${spaceId}/cybernetic/active-surface`,
    staleTime: 0,
    spaceId,
  });

  const snapshot = surfaceQuery.data ?? null;
  const queryError = surfaceQuery.error ? surfaceQuery.error.message : null;

  const status: ActiveSurfaceStatus = useMemo(() => {
    if (surfaceQuery.isLoading && !snapshot) return 'loading';
    if (surfaceQuery.isError) return 'error';
    if (!snapshot) return 'loading';
    if (snapshot.capturedFrom === 'fallback-static') return 'fallback';
    if (snapshot.capturedFrom === 'degraded') return 'degraded';
    return 'fresh';
  }, [snapshot, surfaceQuery.isLoading, surfaceQuery.isError]);

  // Reset the sticky terminal cache when the scope changes — a fresh
  // (space, session) shouldn't inherit terminal runs from the
  // previous mount.
  useEffect(() => {
    setTerminalCache(new Map());
  }, [spaceId, rootSessionId]);

  // The canonical "go re-read the active surface" primitive — used by
  // the visibility refresh + the broker-fallback effect.
  const refresh = useCallback(async () => {
    await queryClientRef.current.invalidateQueries({ queryKey });
  }, [queryKey]);

  // --------------------------------------------------------------------------
  const isScoped = rootSessionId != null;
  const apiRef = useRef({ apiUrl, headers, authFetch, blockedSession });
  apiRef.current = { apiUrl, headers, authFetch, blockedSession };
  useResumeOnUnblock(coachSurfaceBroker.resume);
  useEffect(() => {
    const ctx: coachSurfaceBroker.BrokerContext = {
      apiUrl: apiRef.current.apiUrl,
      headers: () => apiRef.current.headers(),
      authFetch: (input, init) => apiRef.current.authFetch(input, init),
      isSessionExpired: () => apiRef.current.blockedSession !== null,
    };
    coachSurfaceBroker.acquire(spaceId, ctx);

    const setSlice = (updater: (prev: ActiveSurfaceSnapshot) => ActiveSurfaceSnapshot): void => {
      queryClientRef.current.setQueryData<ActiveSurfaceSnapshot>(queryKey, (prev) =>
        updater(prev ?? brokerBaseActiveSurfaceSnapshot(spaceId)),
      );
    };
    const invalidateSurface = (): void => {
      void queryClientRef.current.invalidateQueries({ queryKey });
    };

    const unsubSnapshot = coachSurfaceBroker.subscribeSnapshot(spaceId, (snap) => {
      void (async () => {
        await queryClientRef.current.cancelQueries({ queryKey, exact: true });
        queryClientRef.current.setQueryData<ActiveSurfaceSnapshot>(queryKey, (prev) =>
          applyCoachBrokerSnapshot(spaceId, prev, snap, isScoped),
        );
        if (isScoped) invalidateSurface();
      })();
    });

    const unsubLifecycle = coachSurfaceBroker.subscribeLifecycle(spaceId, (coach) => {
      setSlice((prev) => ({ ...prev, coach }));
    });

    const unsubSurfacedRuns = coachSurfaceBroker.subscribeSurfacedRuns(spaceId, (runs) => {
      if (isScoped) {
        invalidateSurface();
        return;
      }
      setSlice((prev) => ({ ...prev, surfacedRuns: runs }));
    });

    const unsubHelmsman = coachSurfaceBroker.subscribeHelmsman(spaceId, (helmsman) => {
      setSlice((prev) => ({ ...prev, helmsman }));
    });

    const unsubTransitions = coachSurfaceBroker.subscribeTransitions(
      spaceId,
      (recentTransitions) => {
        setSlice((prev) => ({ ...prev, recentTransitions }));
      },
    );

    let hadConnected = false;
    const unsubError = coachSurfaceBroker.subscribeStreamError(spaceId, invalidateSurface);
    const unsubReconcile = coachSurfaceBroker.subscribeReconcileRequired(
      spaceId,
      invalidateSurface,
    );
    const unsubBrokerStatus = coachSurfaceBroker.subscribeStatus(spaceId, (st) => {
      if (st.isConnected) {
        if (hadConnected) invalidateSurface();
        hadConnected = true;
      } else if (hadConnected) {
        invalidateSurface();
      }
    });

    return () => {
      unsubSnapshot();
      unsubLifecycle();
      unsubSurfacedRuns();
      unsubHelmsman();
      unsubTransitions();
      unsubError();
      unsubReconcile();
      unsubBrokerStatus();
      coachSurfaceBroker.release(spaceId);
    };
  }, [spaceId, queryKey, isScoped]);

  // Scoped-mode Helmsman activity label.
  //
  // Piggy-back on the root session's live events (shared session-events
  useEffect(() => {
    if (!rootSessionId) setHelmsmanActivity(null);
  }, [rootSessionId]);

  useSessionEventListener(
    rootSessionId ?? null,
    (event) => {
      if (event.eventType === 'SurfaceUpdate') return;

      // Internal control ops (`agent.control.*`, `ai.agent.turn`) are wrapper
      // steps the operator doesn't think of as "doing something" — skip them
      // so the label reflects the user-visible operation (e.g. `api.http.call`
      // rather than the agent.turn wrapping it).
      const INTERNAL_OPS = new Set([
        'ai.agent.turn',
        'agent.control.run_step',
        'agent.control.dispatch',
        'agent.control.resume',
        'agent.control.submit_output',
      ]);

      const deriveActivity = (): string | null => {
        const t = event.eventType;
        if (!t) return null;
        if (t === 'StepStarted') {
          const op = event.metadata?.['operationId'];
          if (typeof op === 'string' && !INTERNAL_OPS.has(op)) {
            return `Used tools · ${friendlyOpLabel(op)}`;
          }
          return null;
        }
        if (t === 'SessionPaused') {
          const reason = event.metadata?.['reason'];
          if (reason === 'input_required') return 'Asked for input';
          if (reason === 'approval_required') return 'Awaiting approval';
          return 'Paused';
        }
        if (t === 'SessionResumed') return 'Resuming';
        if (t === 'AgentMessage') return 'Responded';
        if (t === 'SessionCompleted' || t === 'SessionFailed' || t === 'SessionCancelled') {
          return null;
        }
        return null;
      };

      const activity = deriveActivity();
      if (activity !== null) {
        setHelmsmanActivity(activity);
      } else if (
        event.eventType === 'SessionCompleted' ||
        event.eventType === 'SessionFailed' ||
        event.eventType === 'SessionCancelled'
      ) {
        setHelmsmanActivity(null);
      }
    },
    {
      passive: true,
    },
  );

  // Tab focus refetch — invalidate so TanStack drives the refetch.
  //
  const lastVisibilityRefreshRef = useRef(0);
  const VISIBILITY_REFRESH_THROTTLE_MS = 10_000;
  useEffect(() => {
    const handler = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastVisibilityRefreshRef.current < VISIBILITY_REFRESH_THROTTLE_MS) return;
      lastVisibilityRefreshRef.current = Date.now();
      void refresh();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handler);
      return () => {
        document.removeEventListener('visibilitychange', handler);
      };
    }
    return undefined;
  }, [refresh]);

  // Update the sticky terminal cache from each new snapshot. Insertion order
  // matches first-seen-terminal order, which becomes the rendering order for
  // cached runs the server no longer surfaces.
  useEffect(() => {
    if (!snapshot) return;
    setTerminalCache((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const run of snapshot.surfacedRuns) {
        if (!TERMINAL_LIFECYCLES.has(run.lifecycle)) continue;
        const existing = next.get(run.runId);
        if (existing?.lifecycle !== run.lifecycle) {
          next.set(run.runId, run);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [snapshot]);

  // Merge cached terminal runs onto the live snapshot. Live wins on runId
  // collision. Cached runs append after live ones, preserving insertion
  // order so older completions render last.
  const mergedSnapshot = useMemo<ActiveSurfaceSnapshot | null>(() => {
    if (!snapshot) return null;
    if (terminalCache.size === 0) return snapshot;
    const liveIds = new Set(snapshot.surfacedRuns.map((r) => r.runId));
    const extra: ActiveSurfaceRun[] = [];
    for (const run of terminalCache.values()) {
      if (!liveIds.has(run.runId)) extra.push(run);
    }
    if (extra.length === 0) return snapshot;
    return {
      ...snapshot,
      surfacedRuns: [...snapshot.surfacedRuns, ...extra],
    };
  }, [snapshot, terminalCache]);

  return {
    snapshot: mergedSnapshot,
    status,
    error: queryError,
    refresh,
    helmsmanActivity,
  };
}
