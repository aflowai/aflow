import type { EntityEventEnvelope } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';
import { coachReviewFromEntityEvents } from './coach-review-events.js';

let seq = 0;
function event(eventType: string, causedBySessionId?: string): EntityEventEnvelope {
  seq += 1;
  return {
    eventId: `e-${String(seq)}`,
    eventType,
    spaceId: 'space',
    tenantId: 'tenant',
    timestamp: seq,
    ...(causedBySessionId ? { causedBySessionId } : {}),
    payload: {},
    summary: eventType,
  } as EntityEventEnvelope;
}

/** A session status event as the projection sends it, for a top-level session. */
function sessionStatus(sessionId: string, status: string): EntityEventEnvelope {
  return { ...event('entity.session.status', sessionId), payload: { sessionId, status } };
}

describe('coachReviewFromEntityEvents', () => {
  it('reads no review from no Coach event', () => {
    expect(coachReviewFromEntityEvents([])).toBe(null);
    expect(coachReviewFromEntityEvents([event('entity.procedure.activated', 'run')])).toBe(null);
  });

  it('reads a review the stream has seen start, with its session', () => {
    expect(coachReviewFromEntityEvents([event('entity.coach.activated', 'c1')])).toEqual({
      coachSessionId: 'c1',
    });
  });

  it('drops a review once the same session completes', () => {
    expect(
      coachReviewFromEntityEvents([
        event('entity.coach.activated', 'c1'),
        event('entity.coach.completed', 'c1'),
      ]),
    ).toBe(null);
  });

  it('keeps another session’s review that has not ended, the newest first', () => {
    const events = [
      event('entity.coach.activated', 'c1'),
      event('entity.coach.activated', 'c2'),
      event('entity.coach.completed', 'c2'),
    ];
    expect(coachReviewFromEntityEvents(events)).toEqual({ coachSessionId: 'c1' });
    expect(coachReviewFromEntityEvents([...events, event('entity.coach.activated', 'c3')])).toEqual(
      { coachSessionId: 'c3' },
    );
  });

  it.each(['FAILED', 'CANCELLED', 'CANCELLING', 'STALLED', 'PAUSED', 'SUCCEEDED'])(
    'drops a review whose session moves to %s without a completion',
    (status) => {
      expect(
        coachReviewFromEntityEvents([
          event('entity.coach.activated', 'c1'),
          sessionStatus('c1', 'RUNNING'),
          sessionStatus('c1', status),
        ]),
      ).toBe(null);
    },
  );

  it('keeps a review whose session is running, or runs again after a pause', () => {
    expect(
      coachReviewFromEntityEvents([
        event('entity.coach.activated', 'c1'),
        sessionStatus('c1', 'RUNNING'),
      ]),
    ).toEqual({ coachSessionId: 'c1' });
    expect(
      coachReviewFromEntityEvents([
        event('entity.coach.activated', 'c1'),
        sessionStatus('c1', 'PAUSED'),
        sessionStatus('c1', 'RUNNING'),
      ]),
    ).toEqual({ coachSessionId: 'c1' });
  });

  it('drops a review whose session failed before the stream saw it start', () => {
    expect(
      coachReviewFromEntityEvents([
        sessionStatus('c1', 'FAILED'),
        event('entity.coach.activated', 'c1'),
      ]),
    ).toBe(null);
  });

  it('reads an older review once the newer one’s session fails', () => {
    expect(
      coachReviewFromEntityEvents([
        event('entity.coach.activated', 'c1'),
        event('entity.coach.activated', 'c2'),
        sessionStatus('c2', 'FAILED'),
      ]),
    ).toEqual({ coachSessionId: 'c1' });
  });

  it('ignores another session’s status and a status it does not know', () => {
    expect(
      coachReviewFromEntityEvents([
        event('entity.coach.activated', 'c1'),
        sessionStatus('other', 'FAILED'),
        sessionStatus('c1', 'EXPLODED'),
      ]),
    ).toEqual({ coachSessionId: 'c1' });
  });

  it('ignores a completion with no start in the stream', () => {
    expect(coachReviewFromEntityEvents([event('entity.coach.completed', 'c1')])).toBe(null);
  });
});
