/**
 * Room messages fold like any other session event, and authorship is whatever
 * the server stamped.
 *
 * Two people in one room means `role: 'user'` identifies nobody, so the
 * timeline has to carry who wrote each line. It comes from the event the
 * server wrote — never from what a turn happens to contain.
 */
import { describe, expect, it } from 'vitest';
import { applySseEvent } from '../applySseEvent.js';
import { INITIAL_STATE } from '../state.js';
import type { SessionEvent } from '../../types.js';

const SESSION = '00000000-0000-4000-8000-0000000000aa';
const SARA = '00000000-0000-4000-8000-00000000e5a1';
const KARIM = '00000000-0000-4000-8000-00000000c0a2';

function roomMessage(
  seq: number,
  actorUserId: string,
  body: string,
  extra: Record<string, unknown> = {},
): SessionEvent {
  return {
    eventId: `evt-${String(seq)}`,
    eventType: 'RoomMessage',
    sessionId: SESSION,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    sequenceNumber: seq,
    eventVersion: 1,
    data: {},
    metadata: { messageSeq: seq, actorUserId, body, wakeHelmsman: false, ...extra },
  } as unknown as SessionEvent;
}

function fold(events: SessionEvent[]) {
  return events.reduce((state, event) => applySseEvent(state, event), INITIAL_STATE);
}

describe('RoomMessage fold', () => {
  it('adds an attributed message to the timeline', () => {
    const state = fold([
      roomMessage(1, SARA, 'the error rate is climbing', {
        actorDisplayName: 'Sara',
      }),
    ]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: 'user',
      content: 'the error rate is climbing',
      authorUserId: SARA,
      authorDisplayName: 'Sara',
      messageSeq: 1,
    });
  });

  it('keeps two speakers distinct and ordered', () => {
    const state = fold([
      roomMessage(1, SARA, 'looks like yesterday’s deploy'),
      roomMessage(2, KARIM, 'agreed, rolling back'),
    ]);

    expect(state.messages.map((m) => m.authorUserId)).toEqual([SARA, KARIM]);
    expect(state.messages.map((m) => m.messageSeq)).toEqual([1, 2]);
  });

  it('never changes run status — posting does not advance the agent', () => {
    const before = INITIAL_STATE;
    const after = fold([roomMessage(1, SARA, 'just thinking out loud')]);

    expect(after.status).toBe(before.status);
    expect(after.requiredInput).toBe(before.requiredInput);
  });

  it('reconciles the sender’s optimistic copy instead of duplicating it', () => {
    const optimistic = {
      ...INITIAL_STATE,
      messages: [
        {
          id: 'client-abc',
          role: 'user' as const,
          content: 'ok, go',
          timestamp: new Date().toISOString(),
          deliveryState: 'queued' as const,
        },
      ],
    };

    const state = applySseEvent(
      optimistic,
      roomMessage(4, SARA, 'ok, go', { clientMessageId: 'client-abc' }),
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.deliveryState).toBeUndefined();
    expect(state.messages[0]?.authorUserId).toBe(SARA);
  });

  it('cannot restamp someone else’s settled message with a colliding id', () => {
    // The id comes from the client. Sara's message is already on the timeline
    // and delivered; Karim posts one claiming the same id.
    const settled = {
      ...INITIAL_STATE,
      messages: [
        {
          id: 'shared-id',
          role: 'user' as const,
          content: 'approve the rollback',
          timestamp: new Date().toISOString(),
          authorUserId: SARA,
        },
      ],
    };

    const state = applySseEvent(
      settled,
      roomMessage(9, KARIM, 'anything at all', { clientMessageId: 'shared-id' }),
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.authorUserId).toBe(SARA);
    expect(state.messages[0]?.content).toBe('approve the rollback');
  });

  it('leaves an unattributed settled message unattributed rather than adopting it', () => {
    const settled = {
      ...INITIAL_STATE,
      messages: [
        {
          id: 'orphan',
          role: 'user' as const,
          content: 'kicked off by a schedule',
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const state = applySseEvent(
      settled,
      roomMessage(3, KARIM, 'mine now', { clientMessageId: 'orphan' }),
    );

    expect(state.messages[0]?.authorUserId).toBeUndefined();
    expect(state.messages[0]?.content).toBe('kicked off by a schedule');
  });

  it('ignores an event with no body rather than adding an empty line', () => {
    const state = fold([
      {
        eventId: 'evt-empty',
        eventType: 'RoomMessage',
        sessionId: SESSION,
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
        eventVersion: 1,
        data: {},
        metadata: { messageSeq: 1, actorUserId: SARA, wakeHelmsman: false },
      } as unknown as SessionEvent,
    ]);

    expect(state.messages).toHaveLength(0);
  });
});

describe('authorship on agent-advancing messages', () => {
  it('attributes the message that started the session', () => {
    const state = fold([
      {
        eventId: 'evt-start',
        eventType: 'SessionStarted',
        sessionId: SESSION,
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
        eventVersion: 1,
        data: {},
        metadata: { userMessage: 'investigate the spike', actorUserId: KARIM },
      } as unknown as SessionEvent,
    ]);

    expect(state.messages[0]).toMatchObject({ content: 'investigate the spike' });
    expect(state.messages[0]?.authorUserId).toBe(KARIM);
  });

  it('leaves authorship absent when the server did not stamp one', () => {
    const state = fold([
      {
        eventId: 'evt-start',
        eventType: 'SessionStarted',
        sessionId: SESSION,
        timestamp: new Date().toISOString(),
        sequenceNumber: 1,
        eventVersion: 1,
        data: {},
        metadata: { userMessage: 'run it' },
      } as unknown as SessionEvent,
    ]);

    expect(state.messages[0]?.authorUserId).toBeUndefined();
  });
});
