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

  it('ignores a completion with no start in the stream', () => {
    expect(coachReviewFromEntityEvents([event('entity.coach.completed', 'c1')])).toBe(null);
  });
});
