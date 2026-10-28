'use client';

import type { QueryKey } from '@tanstack/react-query';

import { useCoalescedInvalidation } from './use-coalesced-invalidation.js';
import { useSpaceEntityEventListener } from './use-space-entity-events.js';

/** The least time between two refetches of the plan the space's events cause. */
export const PLAN_REFRESH_WINDOW_MS = 1_000;

/** Every read of the space's plan — the board and the rail's reads of a step — nests under it. */
export function spacePlanKey(spaceId: string): QueryKey {
  return ['space', spaceId, 'plan'];
}

/**
 * Keep the plan page live (Plan 332 D9): re-read the whole plan when a node is
 * written (`entity.plan.updated`) or a run changes (`entity.run.updated`) —
 * a run's start or end moves its step's column, and a node's column hangs on
 * its ancestors and descendants, so no single node is re-read alone. At most
 * one refetch a second, however many events arrive.
 */
export function usePlanLiveRefresh(spaceId: string | null): void {
  const invalidate = useCoalescedInvalidation(PLAN_REFRESH_WINDOW_MS);
  useSpaceEntityEventListener(spaceId, (event) => {
    if (!spaceId) return;
    if (event.eventType !== 'entity.plan.updated' && event.eventType !== 'entity.run.updated') {
      return;
    }
    invalidate(spacePlanKey(spaceId));
  });
}
