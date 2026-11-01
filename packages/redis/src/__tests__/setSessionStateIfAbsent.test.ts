/**
 * Restoring a resting session from its snapshot must not overwrite a hash a
 * writer put back first: that hash is newer, and its message position above
 * all must not roll back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { SystemRole } from '@aflow/schemas';
import { getSessionState, setSessionStateIfAbsent, type SessionHotState } from '../index.js';
import { allocateMessageSeq } from '../hotState/roomMessages.js';

const TENANT = 'tenant-if-absent';
const SESSION = '00000000-0000-0000-0000-0000000000d7';

function resting(): SessionHotState {
  return {
    sessionId: SESSION,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'helmsman' as SystemRole },
    agentVersion: '1',
    status: 'PAUSED',
    createdAt: 1000,
    lastUpdatedAt: 1000,
  };
}

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

describe('setSessionStateIfAbsent', () => {
  it('writes the state where no hash holds it', async () => {
    expect(await setSessionStateIfAbsent(redis, resting())).toBe(true);

    expect(await getSessionState(redis, TENANT, SESSION)).toMatchObject({ status: 'PAUSED' });
  });

  it('leaves a hash a writer put back first, with its message position', async () => {
    expect(await setSessionStateIfAbsent(redis, resting())).toBe(true);
    await allocateMessageSeq(redis, TENANT, SESSION);
    await allocateMessageSeq(redis, TENANT, SESSION);

    expect(await setSessionStateIfAbsent(redis, { ...resting(), status: 'COMPLETED' })).toBe(false);

    const after = await getSessionState(redis, TENANT, SESSION);
    expect(after).toMatchObject({ status: 'PAUSED', lastMessageSeq: 2 });
  });
});
