/**
 * Contract: a message sent to a conversation parked on a workflow run lands in
 * its room, where the turn the run's ending wakes reads it — the durable log
 * the turn builder reads, not only the live stream.
 */
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamKeys } from '@aflow/schemas';

/** The event log, as rows the turn builder's query returns newest first. */
const log: Array<{ eventId: string; eventType: string; envelope: unknown }> = [];

vi.mock('@aflow/database', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aflow/database')>();
  return {
    // The real shared writer and id, run against the fake transaction below.
    persistRoomMessageEvent: real.persistRoomMessageEvent,
    deterministicRoomMessageEventId: real.deterministicRoomMessageEventId,
    createTenantContext: vi.fn(() => ({})),
    eventLog: real.eventLog,
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
      cb({
        insert: () => ({
          values: (row: { eventId: string; eventType: string; envelope: unknown }) => ({
            onConflictDoNothing: () => {
              if (!log.some((r) => r.eventId === row.eventId)) log.unshift(row);
              return Promise.resolve();
            },
          }),
        }),
        select: () => ({
          from: () => ({
            where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([...log]) }) }),
          }),
        }),
      }),
    ),
  };
});

const appendRoomMessage = vi.fn();
const markSeenThroughMessage = vi.fn();
vi.mock('@aflow/redis', () => ({
  appendRoomMessage: (...args: unknown[]) => appendRoomMessage(...args),
  markSeenThroughMessage: (...args: unknown[]) => markSeenThroughMessage(...args),
}));

import { messageOfResumeInput, queueMessageForNextTurn } from './queuedMessage.js';
import { readRoomExchange } from './roomExchange.js';

const PERSON = '0f0e0d0c-1111-4222-8333-444455556666';
const EVENT_ID = '7a7b7c7d-1111-4222-8333-444455556666';

beforeEach(() => {
  log.length = 0;
  vi.clearAllMocks();
});

describe('queueMessageForNextTurn', () => {
  it("is read by the parent's next turn once the run it waits on resolves", async () => {
    appendRoomMessage.mockResolvedValue({ ok: true, messageSeq: 5, eventId: EVENT_ID });

    const queued = await queueMessageForNextTurn({} as never, {} as never, {
      tenantId: 'tenant-1' as never,
      sessionId: 'session-1',
      deliveryKey: 'idem-1',
      actorUserId: PERSON,
      actorDisplayName: 'Ada',
      body: 'Also bump the version.',
    });
    expect(queued).toEqual({ eventId: EVENT_ID, messageSeq: 5 });
    // On the live stream for the people in the room, the sender's own message read.
    expect(appendRoomMessage).toHaveBeenCalledWith({}, 'tenant-1', 'session-1', {
      actorUserId: PERSON,
      actorDisplayName: 'Ada',
      body: 'Also bump the version.',
      wakeHelmsman: true,
      eventId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4/),
    });
    expect(markSeenThroughMessage).toHaveBeenCalledWith({}, 'tenant-1', 'session-1', PERSON, 5);

    // The run resolves and its waiter wakes the parked step; the turn that
    // follows builds from the room, and the message is there for it to act on.
    const room = await readRoomExchange({} as never, 'tenant-1' as never, 'session-1');
    expect(room.entries).toEqual([
      {
        messageSeq: 5,
        actorUserId: PERSON,
        actorDisplayName: 'Ada',
        body: 'Also bump the version.',
      },
    ]);
  });

  it('posts nothing where the session is gone from the hot store', async () => {
    appendRoomMessage.mockResolvedValue({ ok: false, reason: 'session_not_hot' });
    await expect(
      queueMessageForNextTurn({} as never, {} as never, {
        tenantId: 'tenant-1' as never,
        sessionId: 'session-1',
        deliveryKey: 'idem-1',
        actorUserId: PERSON,
        body: 'Hello?',
      }),
    ).resolves.toBeUndefined();
    expect(log).toEqual([]);
  });

  it('posts a redelivered resume once, and the next turn reads it once', async () => {
    const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
    appendRoomMessage.mockImplementation(actual.appendRoomMessage);
    const redis = new RedisMock() as unknown as Redis;
    await redis.hset(StreamKeys.sessionStateKey('tenant-1', 'session-1'), 'status', 'PAUSED');

    const deliver = () =>
      queueMessageForNextTurn({} as never, redis, {
        tenantId: 'tenant-1' as never,
        sessionId: 'session-1',
        deliveryKey: 'idem-1',
        actorUserId: PERSON,
        body: 'Also bump the version.',
        clientMessageId: 'client-1',
      });
    const first = await deliver();
    const second = await deliver();

    expect(first).toMatchObject({ messageSeq: 1 });
    expect(second).toEqual({ eventId: first!.eventId, duplicate: true });
    const stream = await redis.xrange(
      StreamKeys.sessionEventsStream('tenant-1', 'session-1'),
      '-',
      '+',
    );
    expect(stream).toHaveLength(1);
    expect(markSeenThroughMessage).toHaveBeenCalledOnce();
    const room = await readRoomExchange({} as never, 'tenant-1' as never, 'session-1');
    expect(room.entries.map((entry) => entry.body)).toEqual(['Also bump the version.']);

    // A different resume carrying the same words is a second message.
    await queueMessageForNextTurn({} as never, redis, {
      tenantId: 'tenant-1' as never,
      sessionId: 'session-1',
      deliveryKey: 'idem-2',
      actorUserId: PERSON,
      body: 'Also bump the version.',
    });
    expect(log).toHaveLength(2);
  });
});

describe('messageOfResumeInput', () => {
  it('reads text, `{ input: text }`, or text keyed by a chat input — and nothing else', () => {
    expect(messageOfResumeInput('Go.')).toBe('Go.');
    expect(messageOfResumeInput({ input: 'Go.' })).toBe('Go.');
    expect(messageOfResumeInput({ 'ai.agent.chatInput.ai-1': 'Go.' })).toBe('Go.');
    for (const input of [{}, '', '   ', { input: {} }, { message: 'Go.' }, ['Go.'], null, 3]) {
      expect(messageOfResumeInput(input), JSON.stringify(input)).toBeUndefined();
    }
  });
});
