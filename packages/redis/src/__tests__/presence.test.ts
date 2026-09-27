/**
 * Presence is ephemeral on purpose.
 *
 * A roster that outlives the people in it is worse than no roster — "Sara is
 * here" is only useful if it is true right now. Entries carry their own
 * timestamp so a browser that closes without saying goodbye ages out, and
 * the roster is published rather than held in one server's memory, because
 * two people in a room are rarely on the same instance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { markPresent, markAway, readPresence } from '../presence.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const SARA = '00000000-0000-4000-8000-00000000e5a1';
const KARIM = '00000000-0000-4000-8000-00000000c0a2';

let SESSION = '';

describe('presence roster', () => {
  let redis: RedisType;

  beforeEach(() => {
    redis = new Redis() as unknown as RedisType;
    SESSION = crypto.randomUUID();
  });

  it('shows who is in the room', async () => {
    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't1', activity: 'viewing' });
    await markPresent(redis, TENANT, SESSION, { userId: KARIM, tabId: 't2', activity: 'viewing' });

    const roster = await readPresence(redis, TENANT, SESSION);
    expect(roster.map((p) => p.userId).sort()).toEqual([KARIM, SARA].sort());
  });

  it('counts a person once however many tabs they have open', async () => {
    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't1', activity: 'viewing' });
    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't2', activity: 'viewing' });

    expect(await readPresence(redis, TENANT, SESSION)).toHaveLength(1);
  });

  it('reports typing when any of a person’s tabs is typing', async () => {
    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't1', activity: 'viewing' });
    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't2', activity: 'typing' });

    const roster = await readPresence(redis, TENANT, SESSION);
    expect(roster[0]?.activity).toBe('typing');
  });

  it('drops someone who left', async () => {
    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't1', activity: 'viewing' });
    await markPresent(redis, TENANT, SESSION, { userId: KARIM, tabId: 't2', activity: 'viewing' });
    await markAway(redis, TENANT, SESSION, { userId: SARA, tabId: 't1' });

    const roster = await readPresence(redis, TENANT, SESSION);
    expect(roster.map((p) => p.userId)).toEqual([KARIM]);
  });

  it('keeps a person while one of their tabs is still open', async () => {
    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't1', activity: 'viewing' });
    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't2', activity: 'viewing' });
    await markAway(redis, TENANT, SESSION, { userId: SARA, tabId: 't1' });

    expect(await readPresence(redis, TENANT, SESSION)).toHaveLength(1);
  });

  it('ages out a tab that stopped heartbeating without leaving', async () => {
    const longAgo = Date.now() - 120_000;
    await markPresent(redis, TENANT, SESSION, {
      userId: SARA,
      tabId: 'crashed',
      activity: 'viewing',
      at: longAgo,
    });
    await markPresent(redis, TENANT, SESSION, { userId: KARIM, tabId: 't2', activity: 'viewing' });

    const roster = await readPresence(redis, TENANT, SESSION);
    expect(roster.map((p) => p.userId)).toEqual([KARIM]);
  });

  it('sweeps the aged-out entry rather than re-filtering it forever', async () => {
    await markPresent(redis, TENANT, SESSION, {
      userId: SARA,
      tabId: 'crashed',
      activity: 'viewing',
      at: Date.now() - 120_000,
    });

    await readPresence(redis, TENANT, SESSION);

    const remaining = await redis.hgetall(`aflow:presence:${TENANT}:${SESSION}`);
    expect(Object.keys(remaining)).toHaveLength(0);
  });

  it('survives an unreadable entry instead of failing the whole roster', async () => {
    await markPresent(redis, TENANT, SESSION, { userId: KARIM, tabId: 't2', activity: 'viewing' });
    await redis.hset(`aflow:presence:${TENANT}:${SESSION}`, 'garbage:field', 'not json');

    const roster = await readPresence(redis, TENANT, SESSION);
    expect(roster.map((p) => p.userId)).toEqual([KARIM]);
  });

  it('tells other instances a roster changed, rather than keeping it in memory', async () => {
    const publish = vi.spyOn(redis, 'publish');

    await markPresent(redis, TENANT, SESSION, { userId: SARA, tabId: 't1', activity: 'viewing' });
    await markAway(redis, TENANT, SESSION, { userId: SARA, tabId: 't1' });

    const channels = publish.mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      `aflow:pubsub:presence:${TENANT}:${SESSION}`,
      `aflow:pubsub:presence:${TENANT}:${SESSION}`,
    ]);
  });

  it('is empty for a room nobody is in', async () => {
    expect(await readPresence(redis, TENANT, SESSION)).toEqual([]);
  });
});
