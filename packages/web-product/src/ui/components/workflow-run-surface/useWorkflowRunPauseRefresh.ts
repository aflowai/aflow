'use client';

import { useEffect, useRef } from 'react';
import type { WorkflowRunSurfaceState } from '../../lib/types.js';

/**
 * Bounded backoff for the pause-detail re-fetch, mirroring
 * `useWorkflowRunUsageRefresh`. The rich pause contract (cause, prompt,
 * contract errors, blocked bindings) lives behind the `workflow.run.detail`
 * BFF endpoint, not on the hot SSE event. `useWorkflowRunRehydration` is
 * one-shot per run (settles after the first graph fetch), so a run that
 * pauses MID-FLIGHT via a live `WorkflowRunUpdate` never re-hydrates and the
 * surface only has the coarse `pausedReason` string. This hook closes that
 * gap: one bounded refetch wave once a run is paused without a contract.
 */
const PAUSE_REFRESH_DELAYS_MS = [800, 2_500, 6_000];

interface UseWorkflowRunPauseRefreshArgs {
  /** When `false`, the hook no-ops (the mount doesn't own hydration). */
  enabled: boolean;
  /** Current reducer state for this run, or `undefined` if no entry exists. */
  state: WorkflowRunSurfaceState | undefined;
  /**
   * Re-fetch the BFF detail and feed it back into the reducer. Identity may
   * change per render (stored in a ref so it never re-arms the schedule).
   */
  onRefresh: () => void;
}

export function useWorkflowRunPauseRefresh({
  enabled,
  state,
  onRefresh,
}: UseWorkflowRunPauseRefreshArgs): void {
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  // Fire only while paused and still missing the contract. Once the refetch
  // lands `resumeContract`, the signature flips false and the wave tears down.
  const needsContract = enabled && state?.status === 'paused' && state.resumeContract === undefined;

  useEffect(() => {
    if (!needsContract) return;
    let cancelled = false;
    let idx = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (cancelled || idx >= PAUSE_REFRESH_DELAYS_MS.length) return;
      const delay = PAUSE_REFRESH_DELAYS_MS[idx] ?? 0;
      idx += 1;
      timer = setTimeout(() => {
        if (cancelled) return;
        onRefreshRef.current();
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [needsContract]);
}
