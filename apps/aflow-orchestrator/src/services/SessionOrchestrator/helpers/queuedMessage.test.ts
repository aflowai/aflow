/**
 * Contract: a message sent to a conversation parked on a workflow run lands in
 * its room, where the turn the run's ending wakes reads it — the durable log
 * the turn builder reads, not only the live stream.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The event log, as rows the turn builder's query returns newest first. */
const log: Array<{ eventId: string; eventType: string; envelope: unknown }> = [];

vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(() => ({})),
  eventLog: { eventId: 'e', eventType: 't', sessionId: 's', timestamp: 'ts', envelope: 'env' },
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
}));

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
        actorUserId: PERSON,
        body: 'Hello?',
      }),
    ).resolves.toBeUndefined();
    expect(log).toEqual([]);
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
