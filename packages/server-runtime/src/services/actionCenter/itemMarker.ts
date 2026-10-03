import type { ActionCenterItem } from '@aflow/schemas';

/**
 * What makes a live viewer's copy of an item out of date.
 *
 * The realtime topic diffs on this string, so anything a reader can see must
 * be part of it. Assignment counts: routing a request changes nothing about
 * the underlying pause — same origin, same status — so a marker built from
 * the origin alone is byte-identical afterwards and the person it was just
 * handed to is never told.
 *
 * The parameter is narrowed to the three fields this reads, and none of them
 * is reader-specific: one diff over the pooled items therefore serves every
 * subscriber in a space, and widening it back to a projected item would
 * silently make that false.
 */
export function actionCenterItemMarker(
  item: Pick<ActionCenterItem, 'origin' | 'status'> & { assignee?: string | undefined },
): string {
  const o = item.origin;
  let cas: string;
  if (o.type === 'step' || o.type === 'gate') {
    cas = `${o.stepExecutionId}:v${o.pauseVersion}`;
  } else if (o.type === 'proposal') {
    cas = `${o.proposalId}:r${o.proposalRevision}`;
  } else if (o.type === 'settings') {
    cas = `${o.recordId}:v${o.recordVersion}`;
  } else if (o.type === 'coach_activity') {
    cas = `${o.activityId}:${o.createdAt}`;
  } else if (o.type === 'trigger_armed') {
    cas = `${o.scheduleId}:${o.createdAt}`;
  } else if (o.type === 'session_invitation') {
    cas = `${o.sessionId}:${o.inviteeUserId}:g${o.generation}`;
  } else if (o.type === 'browser_handoff') {
    // The waiting runs count: one more joining changes what the item lists.
    const waiting = o.waiting.map((w) => w.stepExecutionId).join(',');
    cas = `${o.hostname}:${o.profileId}:${o.site}:${o.startedAt}:${waiting}`;
  } else {
    cas = `${o.runId}:${o.taskId}:v${o.pauseVersion}`;
  }
  return [o.type, cas, item.status, item.assignee ?? ''].join('|');
}
