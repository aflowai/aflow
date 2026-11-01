/**
 * A wait outcome posted while a turn was in flight is not in that turn's
 * input, and nothing else wakes the conversation for it once the turn rests
 * (Plan 339 D1). The settle reads it as unread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WAIT_OUTCOME_ACTOR_ID } from '@aflow/schemas';

const rows: Array<{ eventType: string; envelope: unknown }> = [];
vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(() => ({})),
  eventLog: { eventType: 't', envelope: 'e', sessionId: 's', timestamp: 'ts' },
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([...rows]) }) }),
        }),
      }),
    }),
  ),
}));

import { hasUnreadWaitOutcomes } from './roomExchange.js';

const TURN_INPUT = 'gs://bucket/turn-input';

function posted(messageSeq: number, actorUserId: string) {
  return {
    eventType: 'RoomMessage',
    envelope: { metadata: { messageSeq, actorUserId, body: 'b', wakeHelmsman: true } },
  };
}

function turnRead(...messageSeqs: number[]) {
  return {
    retrieve: vi.fn(async () => ({
      newRoomMessages: messageSeqs.map((messageSeq) => ({ messageSeq })),
    })),
  };
}

beforeEach(() => {
  rows.length = 0;
});

describe('hasUnreadWaitOutcomes', () => {
  it('reads an outcome the last turn was not handed as unread', async () => {
    rows.push(posted(2, WAIT_OUTCOME_ACTOR_ID), posted(1, 'person-1'));

    expect(
      await hasUnreadWaitOutcomes({} as never, turnRead(1), 'tenant-1' as never, 's', TURN_INPUT),
    ).toBe(true);
  });

  it('reads an outcome the last turn was handed as read', async () => {
    rows.push(posted(2, WAIT_OUTCOME_ACTOR_ID), posted(1, 'person-1'));

    expect(
      await hasUnreadWaitOutcomes(
        {} as never,
        turnRead(1, 2),
        'tenant-1' as never,
        's',
        TURN_INPUT,
      ),
    ).toBe(false);
  });

  it('wakes for no message a person posted', async () => {
    rows.push(posted(3, 'person-1'));

    expect(
      await hasUnreadWaitOutcomes({} as never, turnRead(), 'tenant-1' as never, 's', TURN_INPUT),
    ).toBe(false);
  });
});
