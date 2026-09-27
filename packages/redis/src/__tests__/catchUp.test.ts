/**
 * Arriving late is the normal way to join long-running work, so the answer to
 * "what did I miss" has to be cheap and true.
 *
 * Unseen is unseen. A room a member has never opened counts in full — the
 * space is what they belong to, and a thread they have not visited is the
 * clearest case of something they have not seen.
 *
 * Messages are counted by position rather than by walking the event log. The
 * log is shared with streaming deltas, so a walk reports nothing in exactly
 * the busy rooms this exists for — the case pinned below.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { StreamKeys } from '@aflow/schemas';
import type { Redis as RedisType } from 'ioredis';
import {
  appendSessionEvent,
  buildCatchUpDelta,
  markSeen,
  readLastSeen,
  takeRoomMessagePosition,
} from '../index.js';
import { setSessionState } from '../hotState/session.js';
import type { SessionHotState } from '../hotState/schemas.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const SARA = '00000000-0000-4000-8000-00000000e5a1';
const KARIM = '00000000-0000-4000-8000-00000000c0a2';

let SESSION = '';

function hotState(over: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: SESSION,
    tenantId: TENANT,
    status: 'RUNNING',
    createdAt: 0,
    ...over,
  } as SessionHotState;
}

/** Read the room the way a caller does: from its current state. */
async function delta(redis: RedisType, userId: string, over: Partial<SessionHotState> = {}) {
  const state = hotState(over);
  await setSessionState(redis, state);
  return buildCatchUpDelta(redis, TENANT, SESSION, userId, state, { scanActivity: true });
}

/** Someone says something in the room, taking the next position in it. */
async function say(redis: RedisType, actorUserId: string, body: string) {
  const messageSeq = await takeRoomMessagePosition(redis, TENANT, SESSION, actorUserId);
  await appendSessionEvent(redis, TENANT, SESSION, {
    eventId: crypto.randomUUID(),
    eventType: 'RoomMessage',
    timestamp: Date.now(),
    sessionId: SESSION,
    metadata: { actorUserId, body, wakeHelmsman: false, messageSeq },
  });
  return messageSeq;
}

async function stepDone(redis: RedisType, ok = true) {
  await appendSessionEvent(redis, TENANT, SESSION, {
    eventId: crypto.randomUUID(),
    eventType: ok ? 'StepSucceeded' : 'StepFailed',
    timestamp: Date.now(),
    sessionId: SESSION,
  });
}

async function agentTurnNoise(redis: RedisType, entries: number) {
  for (let i = 0; i < entries; i++) {
    await appendSessionEvent(redis, TENANT, SESSION, {
      eventId: crypto.randomUUID(),
      eventType: 'StepStarted',
      timestamp: Date.now(),
      sessionId: SESSION,
    });
  }
}

/** What the room's counter stands at — the state a caller would pass in. */
async function seqNow(redis: RedisType): Promise<number> {
  const raw = await redis.hget(StreamKeys.sessionStateKey(TENANT, SESSION), 'lastMessageSeq');
  return raw ? Number.parseInt(raw, 10) : 0;
}

describe('catch-up delta', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = new Redis() as unknown as RedisType;
    SESSION = crypto.randomUUID();
    await setSessionState(redis, hotState());
  });

  it('counts a room you have never opened, in full', async () => {
    await say(redis, SARA, 'started looking into this');
    await say(redis, SARA, 'and here is what I found');

    const { delta: d } = await delta(redis, KARIM, { lastMessageSeq: await seqNow(redis) });

    expect(d.hasNews).toBe(true);
    expect(d.messagesFromOthers).toBe(2);
  });

  it('survives an agent turn burying the messages', async () => {
    // One turn emits hundreds of step log entries. A count that walked the log
    // would drown the two real messages in step noise — which is silence in the
    // one room where someone is actually waiting to be told.
    await say(redis, SARA, 'the error rate is climbing');
    await agentTurnNoise(redis, 300);
    await say(redis, SARA, 'rolling back');

    const { delta: d } = await delta(redis, KARIM, { lastMessageSeq: await seqNow(redis) });

    expect(d.messagesFromOthers).toBe(2);
  });

  it('stays quiet for a room where only you have spoken', async () => {
    await say(redis, KARIM, 'thinking out loud');

    const { delta: d } = await delta(redis, KARIM, { lastMessageSeq: await seqNow(redis) });

    expect(d.hasNews).toBe(false);
    expect(d.messagesFromOthers).toBe(0);
  });

  it('says where you stopped, so the room can draw the line', async () => {
    await say(redis, SARA, 'first');
    const stopped = await seqNow(redis);
    await markSeen(redis, TENANT, SESSION, KARIM, { streamId: '0', messageSeq: stopped });
    await say(redis, SARA, 'second');

    const { delta: d } = await delta(redis, KARIM, { lastMessageSeq: await seqNow(redis) });

    expect(d.seenMessageSeq).toBe(stopped);
    expect(d.messagesFromOthers).toBe(1);
  });

  it('does not consume the news by asking for it', async () => {
    // What makes it safe to show these counts on every index at once: a list
    // view asks the same question the room does, and only the room answers by
    // moving the marker.
    await say(redis, SARA, 'deploy is out');
    await say(redis, SARA, 'watching the graphs');

    const first = await delta(redis, KARIM, { lastMessageSeq: await seqNow(redis) });
    const second = await delta(redis, KARIM, { lastMessageSeq: await seqNow(redis) });

    expect(first.delta.messagesFromOthers).toBe(2);
    expect(second.delta.messagesFromOthers).toBe(2);
    expect(await readLastSeen(redis, TENANT, SESSION, KARIM)).toBeNull();
  });

  it('counts work the agent finished, and what failed', async () => {
    await stepDone(redis);
    await stepDone(redis);
    await stepDone(redis, false);

    const { delta: d } = await delta(redis, KARIM);
    expect(d.stepsCompleted).toBe(2);
    expect(d.stepsFailed).toBe(1);
    expect(d.hasNews).toBe(true);
  });

  it('leaves the run alone when only the count was asked for', async () => {
    // The indexes ask about many rooms at once, so they must not pay for a
    // walk each — the run's own activity is a room-entry question.
    await stepDone(redis);
    const state = hotState();
    await setSessionState(redis, state);

    const { delta: d } = await buildCatchUpDelta(redis, TENANT, SESSION, KARIM, state);

    expect(d.stepsCompleted).toBe(0);
  });

  it('reports that the room is waiting on a person', async () => {
    const { delta: d } = await delta(redis, KARIM, { status: 'PAUSED' });
    expect(d.awaitingInput).toBe(true);
  });

  it('goes quiet again once you have seen it', async () => {
    await say(redis, SARA, 'something happened');
    const seq = await seqNow(redis);

    const second = await delta(redis, KARIM, { lastMessageSeq: seq });
    expect(second.delta.hasNews).toBe(true);
    await markSeen(redis, TENANT, SESSION, KARIM, second.cursor);

    const third = await delta(redis, KARIM, { lastMessageSeq: seq });
    expect(third.delta.messagesFromOthers).toBe(0);
  });

  it('keeps each person’s marker separate', async () => {
    await say(redis, KARIM, 'a note only Karim wrote');
    const seq = await seqNow(redis);

    // Karim wrote it, so he has read it. Sara has never looked and it is news.
    expect((await delta(redis, KARIM, { lastMessageSeq: seq })).delta.hasNews).toBe(false);
    expect((await delta(redis, SARA, { lastMessageSeq: seq })).delta.messagesFromOthers).toBe(1);
    expect(await readLastSeen(redis, TENANT, SESSION, SARA)).toBeNull();
  });

  it('recovers when the room’s counter has been reset under a marker', async () => {
    // A hot session that ages out takes its counter with it. A marker left
    // above the restarted counter must not swallow the next real message.
    await markSeen(redis, TENANT, SESSION, KARIM, { streamId: '0', messageSeq: 40 });

    expect((await delta(redis, KARIM, { lastMessageSeq: 0 })).delta.messagesFromOthers).toBe(0);
    expect((await delta(redis, KARIM, { lastMessageSeq: 1 })).delta.messagesFromOthers).toBe(1);
  });
});
