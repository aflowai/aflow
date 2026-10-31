'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@aflow/design-system';
import { selectChatScheduleNews } from '@aflow/schemas';

import type { UseActionCenterResult } from '../../hooks/use-action-center.js';
import { spaceSchedulesKey, useSpaceSchedules } from '../../hooks/use-space-schedules.js';
import { ScheduleCard, type ScheduleRow } from '../schedule-card.js';
import { WorkbenchSection } from './WorkbenchSection.js';

/**
 * The schedule that now carries a trigger: the last renewal in its chain, or
 * the schedule itself where nothing has renewed it. A renewal expires its
 * predecessor, so showing the predecessor would read a firing trigger as
 * expired. The database keeps one successor per schedule.
 */
function currentRenewal(
  row: ScheduleRow,
  successorOf: ReadonlyMap<string, ScheduleRow>,
): ScheduleRow {
  const seen = new Set([row.id]);
  let current = row;
  for (;;) {
    const next = successorOf.get(current.id);
    if (next === undefined || seen.has(next.id)) return current;
    seen.add(next.id);
    current = next;
  }
}

/**
 * The schedules an agent set up in chat lately, each followed to the renewal
 * that now carries it. The arrivals are the ones the Action Center's
 * trigger_armed notices announce, picked by the same selectChatScheduleNews,
 * and they keep that order.
 */
export function chatSchedules(rows: readonly ScheduleRow[], now = Date.now()): ScheduleRow[] {
  const successorOf = new Map<string, ScheduleRow>();
  for (const row of rows) {
    if (row.renewsScheduleId !== null) successorOf.set(row.renewsScheduleId, row);
  }
  const arrivals = selectChatScheduleNews(
    rows,
    (row) => ({
      armedInChat: row.createdByRunId !== null,
      renewsScheduleId: row.renewsScheduleId,
      status: row.status,
      createdAt: row.createdAt,
    }),
    now,
  );
  return arrivals
    .map((row) => currentRenewal(row, successorOf))
    .filter((row) => row.status !== 'deleted');
}

/**
 * Schedules an agent set up in chat, each as the Triggers page shows it,
 * trimmed to this column's width.
 *
 * Kept out of Pending deliberately: that section's badge is a count of
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
