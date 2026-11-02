'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@aflow/design-system';

import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { chatSchedulesKey, useChatSchedules } from '../../hooks/use-space-schedules.js';
import { ScheduleCard } from '../schedule-card.js';
import {
  WorkbenchEmptyRow,
  WorkbenchSection,
  WorkbenchSectionPending,
  useWorkbenchSectionFold,
} from './WorkbenchSection.js';

/**
 * The active schedules an agent set up in chat, each folded to one line: its
 * name and when it runs next. The server picks them from the chains the
 * trigger_armed notices announce, and keeps only those whose newest renewal
 * will fire again. An expired one-shot, a chain at its end and a superseded
 * renewal never reach this section, so it stays as tall as what still runs.
 *
 * Kept out of Pending deliberately: that section's badge is a count of
 * work waiting on this person, and a schedule that only runs on its own would
 * inflate it into a queue nobody can empty. The operator still has to learn
 * that an agent scheduled a run, so it is shown, plainly, next to the section
 * that does claim attention. The Workbench folds it (Plan 338 D3), so it reads
 * the schedules only once the operator opens it. Outside a fold it disappears
 * when there is nothing to say.
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
  const { data, isLoading } = useChatSchedules(spaceId);
  const fold = useWorkbenchSectionFold();
  const schedules = data?.schedules ?? [];

  const queryClient = useQueryClient();
  const noticeIds = state.lanes.notices.map((item) => item.id).join(',');
  const seenNoticeIds = useRef(noticeIds);
  useEffect(() => {
    if (seenNoticeIds.current === noticeIds) return;
    seenNoticeIds.current = noticeIds;
    void queryClient.invalidateQueries({ queryKey: chatSchedulesKey(spaceId) });
  }, [noticeIds, queryClient, spaceId]);

  if (schedules.length === 0 && isLoading)
    return <WorkbenchSectionPending title="Schedules" icon="clock" />;
  // Folded, the header already shows, so an empty list says so instead of
  // taking the header away the moment the operator opened it.
  if (schedules.length === 0 && !fold) return null;

  return (
    <WorkbenchSection
      title="Schedules"
      icon="clock"
      link={{ href: `/s/${spaceSlug}/triggers`, label: 'Schedules' }}
    >
      {schedules.length === 0 ? (
        <WorkbenchEmptyRow label="No schedules set up in chat" />
      ) : (
        <Column gap="xs">
          {schedules.map((schedule) => (
            <ScheduleCard key={schedule.id} schedule={schedule} variant="compact" />
          ))}
        </Column>
      )}
    </WorkbenchSection>
  );
}
