'use client';

import type { QueryKey } from '@tanstack/react-query';

import type { ScheduleRow } from '../components/schedule-card.js';
import { useApiQuery } from './useApiQuery.js';

export function spaceSchedulesKey(spaceId: string): QueryKey {
  return ['space', spaceId, 'schedules'];
}

/**
 * Under the space's schedules key, so a write that refreshes the Triggers page
 * refreshes the Workbench's section too.
 */
export function upcomingSchedulesKey(spaceId: string): QueryKey {
  return [...spaceSchedulesKey(spaceId), 'upcoming'];
}

/**
 * The space's schedules that will fire again, soonest first, whoever created
 * them. An operator-created schedule runs on its own as much as an agent-armed
 * one, so both are listed. A schedule whose firing is due or past is listed
 * first, because it has not fired yet. A page of the whole list cannot serve here, because
 * expired renewals and one-shots fill it. The server lists a capped number and
 * counts them all in `total`, so the section can say what the cap leaves out.
 */
export function useUpcomingSchedules(spaceId: string) {
  return useApiQuery<{ schedules: ScheduleRow[]; total: number }>({
    key: upcomingSchedulesKey(spaceId),
    path: '/schedules/upcoming',
    spaceId,
    enabled: spaceId.length > 0,
  });
}

/**
 * The space's schedules, as the Triggers page lists them.
 *
 * Cursor-paginated, and this takes the first page. The server puts every row
 * that can still run before the expired ones, so expired renewals cannot push
 * an upcoming schedule off this page. The Workbench's count line relies on
 * that. A `nextCursor` coming back says more exist, which the page says out
 * loud rather than dropping.
 */
export function useSpaceSchedules(spaceId: string) {
  return useApiQuery<{ schedules: ScheduleRow[]; nextCursor?: string | null }>({
    key: spaceSchedulesKey(spaceId),
    path: '/schedules?limit=100',
    spaceId,
    enabled: spaceId.length > 0,
  });
}
