'use client';

import { useEffect, useRef } from 'react';
import type { WorkflowRunSurfaceState } from '../../lib/types.js';
import {
  workflowRunDetailToSurfaceState,
  TERMINAL_RUN_STATUSES,
  type WorkflowRunDetailResponse,
} from './workflowRunDetailToState.js';

interface UseWorkflowRunRehydrationArgs {
  runId: string;
  enabled?: boolean;
  /**
   * Current reducer state for this run, or `undefined` if no entry exists.
   * The hook fires the BFF fetch when either:
   *   - state is undefined (nothing yet from any source), or
   *   - state.needsHydration is true (partial mount state — e.g. Rule A's
   *     sparse seed from `pauseContract`, or a task update that landed
   *     before any `WorkflowRunUpdate`).
   *
   * Passing `state` (not a precomputed boolean) lets the hook re-fire on
   * the partial→needs-hydration transition without the surface having to
   * derive a separate prop.
   */
  state: WorkflowRunSurfaceState | undefined;
  /** Current space id (from the chat page). */
  spaceId: string | null;
  /** Reducer action to populate `workflowRuns[runId]` after a successful fetch. */
  onHydrate: (state: WorkflowRunSurfaceState) => void;
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

export function useWorkflowRunRehydration({
  runId,
  enabled = true,
  state,
  spaceId,
  onHydrate,
}: UseWorkflowRunRehydrationArgs): void {
  // Permanently settled keys — never refetched. Set on success, 4xx, or
  // exhausted retry budget.
  const settledRef = useRef<Set<string>>(new Set());
  // Per-instance reentrancy guard so two render cycles can't race the
  // same fetch.
  const inFlightRef = useRef<Set<string>>(new Set());
  // Per-key attempt counter (0-based). Used to pick the next backoff
  // delay; cleared on success.
  const attemptCountRef = useRef<Map<string, number>>(new Map());
  // Per-key pending retry timer so cleanup can cancel it on unmount or
  // when the run hydrates from a different source (live SSE).
  const retryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const onHydrateRef = useRef(onHydrate);
  useEffect(() => {
    onHydrateRef.current = onHydrate;
  }, [onHydrate]);

  // The live SSE event stream — including SSE catch-up replay — does not
  // carry `workflowGraph` / `graphFidelity`. Only the BFF endpoint resolves
  // the workflow definition and emits those fields, so any state populated
  // purely from live events lacks the forward-DAG render data even after
  // `needsHydration` has been cleared by a live `WorkflowRunUpdate`. Fire
  // the BFF fetch when the graph hasn't been resolved yet — `settledRef`
  // makes this one-shot per key.
  const needsHydration =
    state === undefined || state.needsHydration || state.graphFidelity === undefined;

  useEffect(() => {
    if (!enabled || !needsHydration || !spaceId) return;
    const key = `${spaceId}:${runId}`;
    if (state?.needsHydration && settledRef.current.has(key)) {
      settledRef.current.delete(key);
      attemptCountRef.current.delete(key);
    }
    if (settledRef.current.has(key) || inFlightRef.current.has(key)) return;

    // Capture refs locally so the inner closure sees a stable handle
    // across hook re-runs.
    const settled = settledRef.current;
    const inFlight = inFlightRef.current;
    const attemptCount = attemptCountRef.current;
    const retryTimers = retryTimersRef.current;

    let cancelled = false;

    const scheduleRetry = (): void => {
      const tried = attemptCount.get(key) ?? 0;
      if (tried >= RETRY_DELAYS_MS.length) {
        // Budget exhausted — give up. A live SSE event can still
        // hydrate via the reducer.
        settled.add(key);
        return;
      }
      const delay = RETRY_DELAYS_MS[tried];
      attemptCount.set(key, tried + 1);
      const timer = setTimeout(() => {
        retryTimers.delete(key);
        if (cancelled || settled.has(key) || inFlight.has(key)) return;
        // Re-issue the fetch; same path as the initial attempt.
        void runFetch();
      }, delay);
      retryTimers.set(key, timer);
    };

    const runFetch = async (): Promise<void> => {
      if (inFlight.has(key)) return;
      inFlight.add(key);
      try {
        const res = await fetch(`/api/spaces/${spaceId}/workflow-runs/${runId}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'include',
        });
        if (!res.ok) {
          // 4xx is a definitive answer (run gone, no permission); 5xx is
          // a server hiccup — schedule a backoff retry.
          if (res.status >= 400 && res.status < 500) {
            settled.add(key);
          } else if (!cancelled) {
            scheduleRetry();
          }
          return;
        }
        const detail = (await res.json()) as WorkflowRunDetailResponse;
        // The `cancelled` flag is set whenever the effect's cleanup runs —
        // which happens on a genuine unmount AND on every React Strict Mode
        // double-invocation AND on any legitimate deps change (e.g.
        // `needsHydration` flipping back to true via my graph-trigger
        // condition under a parent re-render). Bailing here would drop a
        // successful BFF response and leave the run permanently without its
        // graph, since `settledRef` adds the key in the success branch
        // either way. The dispatch is idempotent (the reducer's HYDRATE
        // merge handles existing entries safely + keys by runId) and the
        // payload is for the runId we just fetched — so deliver it
        // regardless. The `cancelled` flag below is still used to gate
        // retry scheduling, which IS the wrong thing to do after a real
        // unmount.

        const status = detail.run.status;
        const hydrated = workflowRunDetailToSurfaceState(detail, Date.now());
        const emptyOnRunningRun = detail.tasks.length === 0 && !TERMINAL_RUN_STATUSES.has(status);
        if (emptyOnRunningRun) {
          // Apply what we got, but keep retrying. The reducer's
          // HYDRATE clears needsHydration regardless, so the *next*
          // live `WorkflowTaskUpdate` may also resolve the race —
          // whichever fires first wins.
          onHydrateRef.current(hydrated);
          if (!cancelled) scheduleRetry();
          return;
        }
        settled.add(key);
        attemptCount.delete(key);
        onHydrateRef.current(hydrated);
      } catch {
        // Network failure — schedule a bounded retry. If the run
        // hydrates via SSE in the meantime, the next render's
        // `needsHydration` check returns false and the timer no-ops.
        if (!cancelled) scheduleRetry();
      } finally {
        inFlight.delete(key);
      }
    };

    void runFetch();

    return () => {
      cancelled = true;
      const timer = retryTimers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        retryTimers.delete(key);
      }
    };
    // `onHydrate` intentionally NOT in deps — see the `onHydrateRef`
    // comment above. Effect tears down only on genuine target changes
    // (runId / spaceId / needsHydration / enabled).
  }, [enabled, runId, spaceId, needsHydration]);
}
