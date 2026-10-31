'use client';

import type { QueryKey } from '@tanstack/react-query';

import type { ScheduleRow } from '../components/schedule-card.js';
import { useApiQuery } from './useApiQuery.js';

export function spaceSchedulesKey(spaceId: string): QueryKey {
  return ['space', spaceId, 'schedules'];
}

/**
 * The space's schedules, one read for every surface that lists them, so the
 * Triggers page and the Workbench share a cache entry and cannot disagree.
 *
 * Cursor-paginated, and this takes the first page. A `nextCursor` coming back
 * says more exist, which the page says out loud rather than dropping.
 */
export function useSpaceSchedules(spaceId: string) {
  return useApiQuery<{ schedules: ScheduleRow[]; nextCursor?: string | null }>({
    key: spaceSchedulesKey(spaceId),
    path: '/schedules?limit=100',
    spaceId,
    enabled: spaceId.length > 0,
  });
}
