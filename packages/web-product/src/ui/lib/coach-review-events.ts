import { SessionStatusSchema, type EntityEventEnvelope, type SessionStatus } from '@aflow/schemas';

/** A Coach review the page has seen start and has not seen end. */
export interface CoachReviewInProgress {
  coachSessionId: string | null;
}

/**
 * Whether a Coach session in each status is still reviewing. The record is
 * keyed by the enum, so a status added there fails to compile until it is
 * placed. A paused Coach is one the active surface calls stalled.
 */
const REVIEWING_BY_STATUS: Record<SessionStatus, boolean> = {
  QUEUED: true,
  RUNNING: true,
  WAITING_ON_CHILD: true,
  PAUSED: false,
  SUCCEEDED: false,
  FAILED: false,
  CANCELLED: false,
  CANCELLING: false,
  STALLED: false,
};

/** The session and status an `entity.session.status` event carries, or null. */
function sessionStatusOf(
  event: EntityEventEnvelope,
): { sessionId: string; status: SessionStatus } | null {
  const sessionId = event.payload['sessionId'] ?? event.causedBySessionId;
  const status = SessionStatusSchema.safeParse(event.payload['status']);
  if (typeof sessionId !== 'string' || !status.success) return null;
  return { sessionId, status: status.data };
}

/**
 * The newest Coach review in progress by the entity events the page holds
 * (Plan 338 D3). `entity.coach.activated` starts a review. Two events end it.
 * One is `entity.coach.completed` from the same Coach session. The other is
 * that session's newest `entity.session.status` naming a status that is not
 * reviewing, because a failed, cancelled, stalled or paused session never
 * sends the completion. A review that started before the page subscribed is
 * not in these events, so it reads as none.
 */
export function coachReviewFromEntityEvents(
  events: readonly EntityEventEnvelope[],
): CoachReviewInProgress | null {
  // A session's status can land before its activation, because the
  // projection and the Coach trigger write the stream apart. So the ends are
  // gathered over every event before any start is read.
  const completed = new Set<string>();
  const newestStatus = new Map<string, SessionStatus>();
  for (const event of events) {
    if (event.eventType === 'entity.session.status') {
      const moved = sessionStatusOf(event);
      if (moved) newestStatus.set(moved.sessionId, moved.status);
    } else if (event.eventType === 'entity.coach.completed' && event.causedBySessionId) {
      completed.add(event.causedBySessionId);
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.eventType !== 'entity.coach.activated') continue;
    const sessionId = event.causedBySessionId ?? null;
    if (sessionId && completed.has(sessionId)) continue;
    const status = sessionId ? newestStatus.get(sessionId) : undefined;
    if (status && !REVIEWING_BY_STATUS[status]) continue;
    return { coachSessionId: sessionId };
  }
  return null;
}
