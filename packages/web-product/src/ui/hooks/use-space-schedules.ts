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
export function chatSchedulesKey(spaceId: string): QueryKey {
  return [...spaceSchedulesKey(spaceId), 'chat'];
}

/**
 * The schedules an agent set up in chat lately, each as the renewal that now
 * carries it, newest arrival first. The server picks them through the read the
 * Action Center's trigger_armed notices use, so a card and its notice agree. A
 * page of the whole list cannot serve here: a renewing schedule's renewals push
 * its original off the page.
 */
export function useChatSchedules(spaceId: string) {
  return useApiQuery<{ schedules: ScheduleRow[] }>({
    key: chatSchedulesKey(spaceId),
    path: '/schedules/chat',
    spaceId,
    enabled: spaceId.length > 0,
  });
}

/**
 * The space's schedules, as the Triggers page lists them.
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
