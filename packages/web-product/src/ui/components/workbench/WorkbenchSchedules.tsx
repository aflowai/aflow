'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@aflow/design-system';
import { CHAT_SCHEDULE_LIST_LIMIT, CHAT_SCHEDULE_NEWS_WINDOW_MS } from '@aflow/schemas';

import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { spaceSchedulesKey, useSpaceSchedules } from '../../hooks/use-space-schedules.js';
import { ScheduleCard, type ScheduleRow } from '../schedule-card.js';
import { WorkbenchSection } from './WorkbenchSection.js';

/**
 * The schedules an agent set up in chat lately: set up during a conversation
 * and not a renewal of one already shown, created within the news window,
 * newest first. The same rule picks the Action Center's trigger_armed notices.
 */
export function chatSchedules(rows: readonly ScheduleRow[], now = Date.now()): ScheduleRow[] {
  const since = now - CHAT_SCHEDULE_NEWS_WINDOW_MS;
  return rows
    .filter(
      (row) =>
        row.createdByRunId !== null &&
        row.renewsScheduleId === null &&
        row.status !== 'deleted' &&
        new Date(row.createdAt).getTime() >= since,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, CHAT_SCHEDULE_LIST_LIMIT);
}

/**
 * Schedules an agent set up in chat, each as the Triggers page shows it,
 * trimmed to this column's width.
 *
 * Kept out of Needs attention deliberately: that section's badge is a count of
 * work waiting on this person, and a schedule that only runs on its own would
 * inflate it into a queue nobody can empty. The operator still has to learn
 * that an agent scheduled a run, so it is shown, plainly, next to the section
 * that does claim attention, and it disappears when there is nothing to say.
 *
 * The trigger_armed notice still reaches the Action Center's notices lane. Here
 * it only tells this section to read the schedules again, because the notice
 * arrives live and the schedule list does not.
 */
export function WorkbenchSchedules({
  state,
  spaceId,
  spaceSlug,
}: {
  state: UseActionCenterResult;
  spaceId: string;
  spaceSlug: string;
}) {
  const { data } = useSpaceSchedules(spaceId);
  const schedules = useMemo(() => chatSchedules(data?.schedules ?? []), [data]);

  const queryClient = useQueryClient();
  const noticeIds = state.lanes.notices.map((item) => item.id).join(',');
  const seenNoticeIds = useRef(noticeIds);
  useEffect(() => {
    if (seenNoticeIds.current === noticeIds) return;
    seenNoticeIds.current = noticeIds;
    void queryClient.invalidateQueries({ queryKey: spaceSchedulesKey(spaceId) });
  }, [noticeIds, queryClient, spaceId]);

  if (schedules.length === 0) return null;

  return (
    <WorkbenchSection
      title="Schedules"
      icon="clock"
      link={{ href: `/s/${spaceSlug}/triggers`, label: 'Schedules' }}
    >
      <Column gap="xs">
        {schedules.map((schedule) => (
          <ScheduleCard key={schedule.id} schedule={schedule} variant="compact" />
        ))}
      </Column>
    </WorkbenchSection>
  );
}
