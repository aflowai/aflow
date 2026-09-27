import { describe, it, expect } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type { SessionId, TenantId } from '@aflow/schemas';
import { setSessionState, getSessionStateSafe, type SessionHotState } from '../hotState.js';

const TENANT = 'tenant-wait-mode-test' as TenantId;

function createMockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

function makeRunState(overrides: Partial<SessionHotState>): SessionHotState {
  return {
    sessionId: '00000000-0000-0000-0000-0000000000c1' as SessionId,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'test-role' },
    agentVersion: '1',
    status: 'WAITING_ON_CHILD',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    ...overrides,
  };
}

describe('deserializeFromHash — delegationWaitMode round-trip (Plan 120 robustness regression)', () => {
  it("preserves delegationWaitMode='true' as a string, NOT a boolean", async () => {
    const redis = createMockRedis();
    const sessionId = '00000000-0000-0000-0000-0000000000c1' as SessionId;
    await setSessionState(redis, makeRunState({ sessionId, delegationWaitMode: 'true' }));
    const result = await getSessionStateSafe(redis, TENANT, sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.delegationWaitMode).toBe('true');
    expect(typeof result.state.delegationWaitMode).toBe('string');
  });

  it("preserves delegationWaitMode='false' as a string, NOT a boolean", async () => {
    const redis = createMockRedis();
    const sessionId = '00000000-0000-0000-0000-0000000000c2' as SessionId;
    await setSessionState(redis, makeRunState({ sessionId, delegationWaitMode: 'false' }));
    const result = await getSessionStateSafe(redis, TENANT, sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.delegationWaitMode).toBe('false');
    expect(typeof result.state.delegationWaitMode).toBe('string');
  });

  it("preserves delegationWaitMode='until_pause'", async () => {
    const redis = createMockRedis();
    const sessionId = '00000000-0000-0000-0000-0000000000c3' as SessionId;
    await setSessionState(redis, makeRunState({ sessionId, delegationWaitMode: 'until_pause' }));
    const result = await getSessionStateSafe(redis, TENANT, sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.delegationWaitMode).toBe('until_pause');
  });

  it('does NOT mark the session corrupt when delegationWaitMode is a string-enum boolean-shaped value', async () => {
    // The pre-fix code path: hot state with delegationWaitMode='true' got
    // coerced to a real boolean on read, failed Zod parse, quarantined the
    // session as corrupt. Pin that this CAN'T happen anymore.
    const redis = createMockRedis();
    const sessionId = '00000000-0000-0000-0000-0000000000c4' as SessionId;
    await setSessionState(redis, makeRunState({ sessionId, delegationWaitMode: 'true' }));
    const result = await getSessionStateSafe(redis, TENANT, sessionId);
    expect(result.ok).toBe(true);
    // If the bug recurs, ok=false and kind='corrupt'.
  });

  it('still coerces real boolean fields (voiceMode, interruptRequested) correctly', async () => {
    // Belt-and-suspenders: the reorder must not break the boolean-coercion
    // path for fields that ARE typed as boolean in the schema.
    const redis = createMockRedis();
    const sessionId = '00000000-0000-0000-0000-0000000000c5' as SessionId;
    await setSessionState(
      redis,
      makeRunState({
        sessionId,
        voiceMode: true,
        interruptRequested: false,
      }),
    );
    const result = await getSessionStateSafe(redis, TENANT, sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.voiceMode).toBe(true);
    expect(typeof result.state.voiceMode).toBe('boolean');
    expect(result.state.interruptRequested).toBe(false);
    expect(typeof result.state.interruptRequested).toBe('boolean');
  });
});
