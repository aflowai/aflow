'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column, Text } from '@aflow/design-system';

import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { upcomingSchedulesKey, useUpcomingSchedules } from '../../hooks/use-space-schedules.js';
import { ScheduleCard } from '../schedule-card.js';
import {
  WorkbenchEmptyRow,
  WorkbenchSection,
  WorkbenchSectionPending,
  useWorkbenchSectionFold,
} from './WorkbenchSection.js';

/**
 * The space's upcoming schedules, each folded to one line: its name and when it
 * runs next. The server lists every active schedule with a next firing ahead,
 * whoever created it, soonest first. An operator-created schedule runs on its
 * own as much as an agent-armed one, so it belongs here too. An expired
 * one-shot, a chain at its end and a superseded renewal never reach this
 * section, so it stays as tall as what still runs. The server lists the
 * soonest few and counts the rest, and a line under the list names that count.
 * Nothing caps how many schedules an operator creates, so the cut never hides
 * a schedule silently.
 *
 * Kept out of Pending deliberately: that section's badge is a count of
 * work waiting on this person, and a schedule that only runs on its own would
 * inflate it into a queue nobody can empty. The Workbench folds it (Plan 338
 * D3), so it reads the schedules only once the operator opens it. Outside a
 * fold it disappears when there is nothing to say.
 *
 * The trigger_armed notice still reaches the Action Center's notices lane. Here
 * it only tells this section to read the schedules again, because the notice
 * arrives live and the schedules read does not.
 */
/**
 * The folded Schedules header's signal that an agent set up a schedule. It
 * counts the trigger_armed notices in the Action Center the board already
 * holds, because the schedules read waits for the operator to expand the
 * section. A notice can outlive its schedule, so this says what an agent did
 * and leaves what still runs to the expanded list. That list holds
 * operator-created schedules too, so its length and this count differ.
 */
export function FoldedSchedulesNotice({ state }: { state: UseActionCenterResult }) {
  const count = state.lanes.notices.filter((item) => item.kind === 'trigger_armed').length;
  if (count === 0) return null;
  return (
    <Text size="xs" variant="muted">
      {count} set up by an agent lately
    </Text>
  );
}

export function WorkbenchSchedules({
  state,
  spaceId,
  spaceSlug,
  currentSessionId,
}: {
  state: UseActionCenterResult;
  spaceId: string;
  spaceSlug: string;
  /** The conversation beside the Workbench, which a run link never opens. */
  currentSessionId?: string | null | undefined;
}) {
  const { data, isLoading } = useUpcomingSchedules(spaceId);
  const fold = useWorkbenchSectionFold();
  const schedules = data?.schedules ?? [];
  const unlisted = Math.max(0, (data?.total ?? schedules.length) - schedules.length);

  const queryClient = useQueryClient();
  const noticeIds = state.lanes.notices.map((item) => item.id).join(',');
  const seenNoticeIds = useRef(noticeIds);
  useEffect(() => {
    if (seenNoticeIds.current === noticeIds) return;
    seenNoticeIds.current = noticeIds;
    void queryClient.invalidateQueries({ queryKey: upcomingSchedulesKey(spaceId) });
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
      link={{ href: `/s/${spaceSlug}/triggers`, label: 'Triggers' }}
    >
      {schedules.length === 0 ? (
        <WorkbenchEmptyRow label="No upcoming schedules" />
      ) : (
        <Column gap="xs">
          {schedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              variant="compact"
              spaceSlug={spaceSlug}
              currentSessionId={currentSessionId}
            />
          ))}
          {unlisted > 0 ? (
            <Text size="sm" variant="muted">
              {`${String(unlisted)} more upcoming on Triggers`}
            </Text>
          ) : null}
        </Column>
      )}
    </WorkbenchSection>
  );
}
