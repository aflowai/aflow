/**
 * Room-message positions must be unique and must not resurrect dead sessions.
 *
 * Two people posting at the same instant is the normal case in a shared room,
 * so positions come from an atomic increment rather than a read-then-write.
 * The counter lives on the session's own hash, which means an append to a
 * session that is not there would otherwise create one — a hash holding
 * nothing but a counter, which reads downstream as a live session.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  appendRoomMessage,
  setSessionState,
  getSessionState,
  type SessionHotState,
} from '../index.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const SARA = '00000000-0000-4000-8000-00000000e5a1';
const KARIM = '00000000-0000-4000-8000-00000000c0a2';

// ioredis-mock shares one store across instances, so each test gets its own
// session rather than a flush that would race sibling suites.
let SESSION = '';

function hotState(status: SessionHotState['status'] = 'RUNNING'): SessionHotState {
  return {
    sessionId: SESSION,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' },
    agentVersion: '1',
    status,
    createdAt: 1_700_000_000_000,
    lastUpdatedAt: 1_700_000_000_000,
  } as SessionHotState;
}

describe('appendRoomMessage', () => {
  let redis: RedisType;

  beforeEach(() => {
    redis = new Redis() as unknown as RedisType;
    SESSION = crypto.randomUUID();
  });

  it('hands out increasing positions from the first message', async () => {
    await setSessionState(redis, hotState());

    const first = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: SARA,
      body: 'the error rate is climbing',
    });
    const second = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: KARIM,
      body: 'looks like the deploy',
    });

    expect(first).toMatchObject({ ok: true, messageSeq: 1 });
    expect(second).toMatchObject({ ok: true, messageSeq: 2 });
  });

  it('a caller-supplied eventId posts once — the loser of a race gets duplicate_event', async () => {
    await setSessionState(redis, hotState());
    const eventId = crypto.randomUUID();

    const first = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: SARA,
      body: 'move_card — moved "Ship it" to Done',
      eventId,
    });
    const second = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: SARA,
      body: 'move_card — moved "Ship it" to Done',
      eventId,
    });

    expect(first).toMatchObject({ ok: true, messageSeq: 1, eventId });
    expect(second).toEqual({ ok: false, reason: 'duplicate_event' });
    // The counter must not have moved for the refused duplicate — a phantom
    // increment would show every other member unread mail nobody can read.
    const third = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: KARIM,
      body: 'nice',
    });
    expect(third).toMatchObject({ ok: true, messageSeq: 2 });
  });

  it('gives concurrent posters distinct positions', async () => {
    await setSessionState(redis, hotState());

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        appendRoomMessage(redis, TENANT, SESSION, {
          actorUserId: i % 2 === 0 ? SARA : KARIM,
          body: `message ${String(i)}`,
        }),
      ),
    );

    const positions = results.map((r) => (r.ok ? r.messageSeq : -1));
    expect(new Set(positions).size).toBe(25);
    expect([...positions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it('keeps the counter on the session so it survives a rehydrate', async () => {
    await setSessionState(redis, hotState());
    await appendRoomMessage(redis, TENANT, SESSION, { actorUserId: SARA, body: 'one' });
    await appendRoomMessage(redis, TENANT, SESSION, { actorUserId: SARA, body: 'two' });

    const state = await getSessionState(redis, TENANT, SESSION);
    expect(state?.lastMessageSeq).toBe(2);

    // A rehydrate writes the snapshot back; the next position continues from it.
    await setSessionState(redis, { ...hotState(), lastMessageSeq: 2 } as SessionHotState);
    const next = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: KARIM,
      body: 'three',
    });
    expect(next).toMatchObject({ ok: true, messageSeq: 3 });
  });

  it('posts while the agent is mid-turn without touching its status', async () => {
    await setSessionState(redis, hotState('RUNNING'));

    const result = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: SARA,
      body: 'while you are working — check the staging config too',
    });

    expect(result.ok).toBe(true);
    expect((await getSessionState(redis, TENANT, SESSION))?.status).toBe('RUNNING');
  });

  it('posts into a paused room', async () => {
    await setSessionState(redis, hotState('PAUSED'));

    const result = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: SARA,
      body: 'I will approve this after standup',
    });

    expect(result.ok).toBe(true);
    expect((await getSessionState(redis, TENANT, SESSION))?.status).toBe('PAUSED');
  });

  it('refuses a session that is not there instead of creating one', async () => {
    const result = await appendRoomMessage(redis, TENANT, SESSION, {
      actorUserId: SARA,
      body: 'anyone home?',
    });

    expect(result).toEqual({ ok: false, reason: 'session_not_hot' });
    expect(await getSessionState(redis, TENANT, SESSION)).toBeNull();
  });
});
