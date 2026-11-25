/**
 * A writer that replaces a session hash carries its dry-run fields from the
 * raw hash, which answers even when it no longer parses as SessionHotState.
 * Salvage of a quarantined copy reads the same fields.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { getSessionDryRunLink, salvageCorruptStateFields } from '../index.js';

const TENANT = 'tenant-dry-run-link';
const SESSION = '00000000-0000-0000-0000-0000000000e1';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

describe('getSessionDryRunLink', () => {
  it('reads the dry run and task from a hash that does not parse', async () => {
    await redis.hset(StreamKeys.sessionStateKey(TENANT, SESSION), {
      status: 'not-a-status',
      dryRunOf: 'dry-run-1',
      dryRunTaskId: 'place-orders',
    });
    expect(await getSessionDryRunLink(redis, TENANT, SESSION)).toEqual({
      dryRunOf: 'dry-run-1',
      dryRunTaskId: 'place-orders',
    });
  });

  it('answers the dry run alone when the session names no task', async () => {
    await redis.hset(StreamKeys.sessionStateKey(TENANT, SESSION), { dryRunOf: 'dry-run-1' });
    expect(await getSessionDryRunLink(redis, TENANT, SESSION)).toEqual({ dryRunOf: 'dry-run-1' });
  });

  it('answers null for a live session', async () => {
    await redis.hset(StreamKeys.sessionStateKey(TENANT, SESSION), { status: 'RUNNING' });
    expect(await getSessionDryRunLink(redis, TENANT, SESSION)).toBeNull();
  });
});

describe('salvageCorruptStateFields', () => {
  it('salvages the dry-run fields of a quarantined copy', async () => {
    await redis.hset(`aflow:session:${TENANT}:${SESSION}:state:corrupt:1000`, {
      agentVersion: '1',
      dryRunOf: 'dry-run-1',
      dryRunTaskId: 'place-orders',
    });
    expect(await salvageCorruptStateFields(redis, TENANT, SESSION)).toMatchObject({
      dryRunOf: 'dry-run-1',
      dryRunTaskId: 'place-orders',
    });
  });
});
