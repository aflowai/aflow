import type { EntityEventEnvelope } from '@aflow/schemas';

/** A Coach review the page has seen start and has not seen end. */
export interface CoachReviewInProgress {
  coachSessionId: string | null;
}

/**
 * The newest Coach review in progress by the entity events the page holds
 * (Plan 338 D3). `entity.coach.activated` starts a review, and
 * `entity.coach.completed` from the same Coach session ends it. A review that
 * started before the page subscribed is not in these events, so it reads as
 * none. A stall is time-derived, so no event says it.
 */
export function coachReviewFromEntityEvents(
  events: readonly EntityEventEnvelope[],
): CoachReviewInProgress | null {
  const ended = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    const sessionId = event.causedBySessionId ?? null;
    if (event.eventType === 'entity.coach.completed') {
      if (sessionId) ended.add(sessionId);
      continue;
    }
    if (event.eventType !== 'entity.coach.activated') continue;
    if (sessionId && ended.has(sessionId)) continue;
    return { coachSessionId: sessionId };
  }
  return null;
}
