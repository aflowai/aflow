'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@aflow/design-system';

import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { chatSchedulesKey, useChatSchedules } from '../../hooks/use-space-schedules.js';
import { ScheduleCard } from '../schedule-card.js';
import { WorkbenchSection } from './WorkbenchSection.js';

/**
 * Schedules an agent set up in chat, each as the Triggers page shows it,
 * trimmed to this column's width. Each is the renewal that now carries its
 * trigger, because a renewal expires its predecessor and the predecessor would
 * read a firing trigger as expired. The server picks them through the read the
 * trigger_armed notices use, so the two list the same arrivals.
 *
 * Kept out of Pending deliberately: that section's badge is a count of
 * work waiting on this person, and a schedule that only runs on its own would
 * inflate it into a queue nobody can empty. The operator still has to learn
 * that an agent scheduled a run, so it is shown, plainly, next to the section
 * that does claim attention, and it disappears when there is nothing to say.
 *
 * The trigger_armed notice still reaches the Action Center's notices lane. Here
 * it only tells this section to read the schedules again, because the notice
 * arrives live and the schedules read does not.
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
  const { data } = useChatSchedules(spaceId);
  const schedules = data?.schedules ?? [];

  const queryClient = useQueryClient();
  const noticeIds = state.lanes.notices.map((item) => item.id).join(',');
  const seenNoticeIds = useRef(noticeIds);
  useEffect(() => {
    if (seenNoticeIds.current === noticeIds) return;
    seenNoticeIds.current = noticeIds;
    void queryClient.invalidateQueries({ queryKey: chatSchedulesKey(spaceId) });
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
