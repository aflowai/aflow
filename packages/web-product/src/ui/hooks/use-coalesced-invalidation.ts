'use client';

import { useCallback, useEffect, useRef } from 'react';
import { hashKey, useQueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * How long the first event of a burst waits for the rest. The gateway sends
 * one frame per event, so a burst lands across many tasks rather than one, and
 * only a window can fold them; this one is shorter than a person notices and
 * longer than the gap between frames of one drain.
 */
export const ENTITY_EVENT_REFETCH_WINDOW_MS = 250;

/**
 * Invalidate queries on space events at most once per key per burst.
 *
 * Every invalidation of an observed query is a request, and one that lands
 * while the previous is in flight cancels and reissues it — so a refetch per
 * event turns a burst of events into a burst of requests the rate limit then
 * refuses, along with everything else the operator is doing.
 *
 * The window opens on the first event and the next opens only after it has
 * fired, so `windowMs` is also the least time between two refetches.
 */
export function useCoalescedInvalidation(
  windowMs: number = ENTITY_EVENT_REFETCH_WINDOW_MS,
): (queryKey: QueryKey) => void {
  const queryClient = useQueryClient();
  const pending = useRef(new Map<string, QueryKey>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current.clear();
    },
    [],
  );

  return useCallback(
    (queryKey: QueryKey) => {
      pending.current.set(hashKey(queryKey), queryKey);
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const keys = [...pending.current.values()];
        pending.current.clear();
        for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
      }, windowMs);
    },
    [queryClient, windowMs],
  );
}
