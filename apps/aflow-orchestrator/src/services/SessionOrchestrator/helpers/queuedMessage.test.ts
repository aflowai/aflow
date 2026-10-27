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
/** How many of the next durable writes the database refuses. */
let refusedWrites = 0;

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
              if (refusedWrites > 0) {
                refusedWrites -= 1;
                return Promise.reject(new Error('connection terminated unexpectedly'));
              }
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
vi.mock('@aflow/redis', async (importOriginal) => ({
  HOT_STATE_TTL_SECONDS: (await importOriginal<typeof import('@aflow/redis')>())
    .HOT_STATE_TTL_SECONDS,
  appendRoomMessage: (...args: unknown[]) => appendRoomMessage(...args),
  markSeenThroughMessage: (...args: unknown[]) => markSeenThroughMessage(...args),
}));

import {
  messageOfResumeInput,
  queueMessageForNextTurn,
  settleOwedRoomMessages,
} from './queuedMessage.js';
import { readRoomExchange } from './roomExchange.js';

const PERSON = '0f0e0d0c-1111-4222-8333-444455556666';
const EVENT_ID = '7a7b7c7d-1111-4222-8333-444455556666';

beforeEach(() => {
  log.length = 0;
  refusedWrites = 0;
  vi.clearAllMocks();
});

/** A hot session on a fresh Redis, posted into through the real stream append. */
async function hotRoom(): Promise<Redis> {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  appendRoomMessage.mockImplementation(actual.appendRoomMessage);
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  await redis.hset(StreamKeys.sessionStateKey('tenant-1', 'session-1'), 'status', 'PAUSED');
  return redis;
}

async function streamLength(redis: Redis): Promise<number> {
  const stream = await redis.xrange(
    StreamKeys.sessionEventsStream('tenant-1', 'session-1'),
    '-',
    '+',
  );
  return stream.length;
}

async function roomBodies(): Promise<string[]> {
  const room = await readRoomExchange({} as never, 'tenant-1' as never, 'session-1');
  return room.entries.map((entry) => entry.body);
}

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

  describe('when the stream append succeeds and the durable write does not', () => {
    const deliver = (redis: Redis) =>
      queueMessageForNextTurn({} as never, redis, {
        tenantId: 'tenant-1' as never,
        sessionId: 'session-1',
        deliveryKey: 'idem-1',
        actorUserId: PERSON,
        body: 'Also bump the version.',
      });

    it('does not throw — the waiting conversation is not failed — and owes the row', async () => {
      const redis = await hotRoom();
      refusedWrites = 1;

      const first = await deliver(redis);

      expect(first).toEqual({ eventId: expect.any(String), durableOwed: true });
      expect(await streamLength(redis)).toBe(1);
      expect(log).toEqual([]);
    });

    it('a redelivery writes the owed row before it reports a duplicate, and the turn reads it once', async () => {
      const redis = await hotRoom();
      refusedWrites = 1;
      const first = await deliver(redis);

      const second = await deliver(redis);

      expect(second).toEqual({ eventId: first!.eventId, duplicate: true });
      expect(await streamLength(redis)).toBe(1);
      expect(await roomBodies()).toEqual(['Also bump the version.']);
      // Settled: a third delivery and the next turn's settlement write nothing more.
      await deliver(redis);
      await settleOwedRoomMessages({} as never, redis, 'tenant-1' as never, 'session-1');
      expect(await roomBodies()).toEqual(['Also bump the version.']);
    });

    it('a redelivery whose write fails again still owes the row — never a duplicate', async () => {
      const redis = await hotRoom();
      refusedWrites = 2;
      await deliver(redis);

      await expect(deliver(redis)).resolves.toEqual({
        eventId: expect.any(String),
        durableOwed: true,
      });
      expect(log).toEqual([]);
      await expect(deliver(redis)).resolves.toMatchObject({ duplicate: true });
      expect(await roomBodies()).toEqual(['Also bump the version.']);
    });

    it('with no redelivery, the turn the run wakes settles the row before it reads the room', async () => {
      const redis = await hotRoom();
      refusedWrites = 1;
      await deliver(redis);

      // What agentTurn does before readRoomExchange.
      await expect(
        settleOwedRoomMessages({} as never, redis, 'tenant-1' as never, 'session-1'),
      ).resolves.toEqual([]);

      expect(await roomBodies()).toEqual(['Also bump the version.']);
    });
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
