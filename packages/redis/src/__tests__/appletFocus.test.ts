/**
 * The focus slot is one-per-session on purpose: a turn has exactly one
 * current instance, so setting focus overwrites rather than accumulates,
 * and a corrupt or expired slot degrades to "no focus" — never an error —
 * because the sole-active fallback recovers the common case.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { StreamKeys, type AppletFocus } from '@aflow/schemas';
import { setAppletFocus, getAppletFocus, clearAppletFocus } from '../appletFocus.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

let SESSION = '';

function focus(overrides: Partial<AppletFocus> = {}): AppletFocus {
  return {
    sessionId: SESSION,
    instanceId: INSTANCE_A,
    source: 'explicit_agent_focus',
    version: 4,
    ...overrides,
  };
}

describe('applet focus store', () => {
  let redis: RedisType;

  beforeEach(() => {
    redis = new Redis() as unknown as RedisType;
    SESSION = crypto.randomUUID();
  });

  it('round-trips a focus', async () => {
    await setAppletFocus(redis, TENANT, focus());
    expect(await getAppletFocus(redis, TENANT, SESSION)).toEqual(focus());
  });

  it('is empty until someone points at something', async () => {
    expect(await getAppletFocus(redis, TENANT, SESSION)).toBeNull();
  });

  it('overwrites — one current instance per session', async () => {
    await setAppletFocus(redis, TENANT, focus());
    await setAppletFocus(redis, TENANT, focus({ instanceId: INSTANCE_B, version: 9 }));
    const current = await getAppletFocus(redis, TENANT, SESSION);
    expect(current?.instanceId).toBe(INSTANCE_B);
    expect(current?.version).toBe(9);
  });

  it('clears', async () => {
    await setAppletFocus(redis, TENANT, focus());
    await clearAppletFocus(redis, TENANT, SESSION);
    expect(await getAppletFocus(redis, TENANT, SESSION)).toBeNull();
  });

  it('treats an explicitly expired focus as unset', async () => {
    await setAppletFocus(
      redis,
      TENANT,
      focus({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(await getAppletFocus(redis, TENANT, SESSION)).toBeNull();
  });

  it('treats an unreadable slot as unset instead of failing the turn', async () => {
    await redis.set(StreamKeys.sessionAppletFocusKey(TENANT, SESSION), 'not-json');
    expect(await getAppletFocus(redis, TENANT, SESSION)).toBeNull();

    await redis.set(
      StreamKeys.sessionAppletFocusKey(TENANT, SESSION),
      JSON.stringify({ sessionId: SESSION }),
    );
    expect(await getAppletFocus(redis, TENANT, SESSION)).toBeNull();
  });

  it('carries a TTL so a dead session ages out', async () => {
    await setAppletFocus(redis, TENANT, focus());
    const ttl = await redis.ttl(StreamKeys.sessionAppletFocusKey(TENANT, SESSION));
    expect(ttl).toBeGreaterThan(0);
  });
});
