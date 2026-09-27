import { describe, it, expect } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { seedMcpElicitationLeaseCandidatesOnce } from '../mcpElicitationLeaseRollout.js';
import { mcpElicitationCandidateMember } from '../mcpElicitationLeaseCandidates.js';

describe('seeding the elicitation lease candidate index', () => {
  it('arms every lease and passes over the keys the index keeps under the same prefix', async () => {
    const redis = new Redis({ port: 6391 }) as unknown as RedisType;
    const index = StreamKeys.mcpElicitationLeaseCandidatesKey;
    await redis.hset(StreamKeys.mcpElicitationLeaseKey('elic-1'), {
      executorInstanceId: 'exec-a',
    });
    await redis.zadd(index, '1', mcpElicitationCandidateMember('exec-b', 'elic-2'));

    const result = await seedMcpElicitationLeaseCandidatesOnce(redis);

    expect(result).toEqual({ ran: true, scanned: 1, armed: 1 });
    expect(await redis.zrange(index, 0, -1)).toContain(
      mcpElicitationCandidateMember('exec-a', 'elic-1'),
    );
  });
});
