import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { readLatestSessionPosition } from '../hotState/events.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-0000-0000-0000000000aa';

function createMockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

describe('readLatestSessionPosition', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = createMockRedis();
    // ioredis-mock shares one in-memory keyspace across instances; flush so a
    // prior test's stream can't leak into the empty-stream assertions.
    await redis.flushall();
  });

  it('returns the eventId of the newest stream entry', async () => {
    const key = StreamKeys.sessionEventsStream(TENANT, SESSION);
    await redis.xadd(key, '*', 'eventId', 'evt-1', 'eventType', 'WorkflowRunUpdate');
    // Field order varies in serializeForStream output; put eventId last here.
    await redis.xadd(key, '*', 'eventType', 'WorkflowTaskUpdate', 'eventId', 'evt-2');

    const position = await readLatestSessionPosition(redis, TENANT, SESSION);
    expect(position?.eventId).toBe('evt-2');
    // The stream id is the half a cursor can actually seek to; returning only
    // the event id is what made the workflow-run surface mint a dead cursor.
    expect(position?.id).toMatch(/^\d+-\d+$/);
  });

  it('returns null for an empty / nonexistent stream', async () => {
    expect(await readLatestSessionPosition(redis, TENANT, SESSION)).toBeNull();
  });

  it('returns null when the newest entry has no eventId field', async () => {
    const key = StreamKeys.sessionEventsStream(TENANT, SESSION);
    await redis.xadd(key, '*', 'eventType', 'WorkflowRunUpdate');
    expect(await readLatestSessionPosition(redis, TENANT, SESSION)).toBeNull();
  });
});
