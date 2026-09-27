'use client';

import { useEffect, useRef } from 'react';
import type { WorkflowRunSurfaceState } from '../../lib/types.js';
import { selectPendingUsageTaskIds } from './workflowRunSurfaceHelpers.js';

/**
 * Bounded backoff for the re-fetch, mirroring `RETRY_DELAYS_MS` in
 * `useWorkflowRunRehydration`. First attempt ~1.5s after a task goes terminal
 * (enough for the next `ProjectionWorker` flush), then widening retries if the
 * usage still hasn't landed. After the last entry the wave is given up on — a
 * manual refresh or a later task completing still re-triggers.
 */
const USAGE_REFRESH_DELAYS_MS = [1_500, 3_500, 7_000];

interface UseWorkflowRunUsageRefreshArgs {
  /** When `false`, the hook no-ops (the mount doesn't own hydration). */
  enabled: boolean;
  /** Current reducer state for this run, or `undefined` if no entry exists. */
  state: WorkflowRunSurfaceState | undefined;
  /**
   * Re-fetch the BFF detail and feed it back into the reducer. Called with no
   * args; its identity may change per render (stored in a ref so it never
   * re-arms the schedule on its own).
   */
  onRefresh: () => void;
}

export function useWorkflowRunUsageRefresh({
  enabled,
  state,
  onRefresh,
}: UseWorkflowRunUsageRefreshArgs): void {
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  // Agent tasks that are terminal but still missing usage. Sorted, so the
  // signature below is stable across renders for the same set.
  const pendingIds = enabled && state ? selectPendingUsageTaskIds(state.tasks) : [];
  const signature = pendingIds.join(',');

  useEffect(() => {
    if (signature.length === 0) return;
    let cancelled = false;
    let idx = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (cancelled || idx >= USAGE_REFRESH_DELAYS_MS.length) return;
      const delay = USAGE_REFRESH_DELAYS_MS[idx] ?? 0;
      idx += 1;
      timer = setTimeout(() => {
        if (cancelled) return;
        onRefreshRef.current();
        // Chain the next attempt. A successful refresh re-renders with a
        // different `signature` (the now-covered tasks drop out), which tears
        // this effect down via cleanup before the next tick fires.
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // Re-arm only when the pending set itself changes — not on `onRefresh`
    // identity (held in a ref above) or unrelated re-renders.
  }, [signature]);
}
