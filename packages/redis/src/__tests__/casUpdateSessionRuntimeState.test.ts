/**
 * Regression test for the atomic version-CAS primitive that backs the Plan 230
 * barrier-sweep clobber fix: `casUpdateSessionRuntimeState` must replace the
 * serialized `runtimeState` hash field ONLY when its current `version` still
 * equals the expected version, so a synthetic recovery can never overwrite a
 * concurrent legitimate decrement.
 *
 * The primitive's correctness lives in a Lua `cjson` compare-and-set, which
 * ioredis-mock cannot run (its Lua VM has no `cjson`), so this exercises the
 * real script against a live Redis when one is reachable and skips otherwise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../../../../scripts/stackRedis.mjs';

/**
 * Its own database. Writing session state on db 0 puts entries into the shared
 * candidate indexes a live dev orchestrator is draining, and it then retries a
 * synthetic tenant forever.
 */
const TEST_DB = 12;
import { StreamKeys, type SystemRole } from '@aflow/schemas';
import {
  setSessionState,
  getSessionState,
  casUpdateSessionRuntimeState,
  type SessionHotState,
} from '../index.js';

const TENANT = 'tenant-cas-test';
const RUN = '00000000-0000-0000-0000-0000000000c5';

const STACK_REDIS = await stackRedis(TEST_DB);

function makeState(version: number): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'helmsman' as SystemRole },
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    runtimeState: { schemaVersion: 1, variables: { x: 1 }, version, updatedAtMs: 1000 },
  };
}

function runtime(version: number, x: number): SessionHotState['runtimeState'] {
  return { schemaVersion: 1, variables: { x }, version, updatedAtMs: 2000 };
}

describe.skipIf(!STACK_REDIS.available)('casUpdateSessionRuntimeState (real-redis Lua)', () => {
  let redis: RedisType;
  const key = StreamKeys.sessionStateKey(TENANT, RUN);
  beforeEach(async () => {
    redis = new Redis(STACK_REDIS.url);
    await redis.del(key);
  });
  afterEach(async () => {
    await redis.del(key);
    await redis.quit();
  });

  it('writes and returns true when the expected version matches', async () => {
    await setSessionState(redis, makeState(5));
    const ok = await casUpdateSessionRuntimeState(redis, TENANT, RUN, 5, runtime(6, 2));
    expect(ok).toBe(true);
    const after = await getSessionState(redis, TENANT, RUN);
    expect(after?.runtimeState?.version).toBe(6);
    expect((after?.runtimeState?.variables as Record<string, unknown>)['x']).toBe(2);
  });

  it('no-ops and returns false when the expected version is stale (clobber rejected)', async () => {
    await setSessionState(redis, makeState(6)); // a concurrent writer already advanced to 6
    const ok = await casUpdateSessionRuntimeState(redis, TENANT, RUN, 5, runtime(7, 9));
    expect(ok).toBe(false);
    const after = await getSessionState(redis, TENANT, RUN);
    expect(after?.runtimeState?.version).toBe(6); // untouched
    expect((after?.runtimeState?.variables as Record<string, unknown>)['x']).toBe(1); // untouched
  });

  it('returns false when the session has no runtimeState field', async () => {
    const ok = await casUpdateSessionRuntimeState(redis, TENANT, RUN, 5, runtime(6, 2));
    expect(ok).toBe(false);
  });
});
