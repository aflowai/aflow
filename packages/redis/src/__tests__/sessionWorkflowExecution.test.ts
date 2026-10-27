import { describe, it, expect } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { StreamKeys, type SessionId, type TenantId } from '@aflow/schemas';
import {
  getSessionWorkflowExecution,
  isSessionCorrupt,
  setSessionState,
  type SessionHotState,
} from '../hotState.js';

const TENANT = 'tenant-workflow-execution-test' as TenantId;

async function freshRedis(): Promise<RedisType> {
  const redis = new Redis() as unknown as RedisType;
  await redis.flushall();
  return redis;
}

function runState(sessionId: string, overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: sessionId as SessionId,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'test-role' },
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    ...overrides,
  };
}

describe('getSessionWorkflowExecution', () => {
  it('reads the workflow task a worker session serves, as its state recorded it', async () => {
    const redis = await freshRedis();
    const session = '00000000-0000-0000-0000-0000000000d1';
    const workflowExecution = { runId: 'wf-run-1', taskId: 'task-a', attempt: 2 };
    await setSessionState(redis, runState(session, { workflowExecution }));
    expect(await getSessionWorkflowExecution(redis, TENANT, session)).toEqual(workflowExecution);
  });

  it('is absent for a session that serves no workflow task, or has no state', async () => {
    const redis = await freshRedis();
    const session = '00000000-0000-0000-0000-0000000000d2';
    await setSessionState(redis, runState(session));
    expect(await getSessionWorkflowExecution(redis, TENANT, session)).toBeUndefined();
    expect(
      await getSessionWorkflowExecution(redis, TENANT, '00000000-0000-0000-0000-0000000000d3'),
    ).toBeUndefined();
  });

  it('judges nothing but the field: a hash that would not parse whole is not quarantined', async () => {
    const redis = await freshRedis();
    const session = '00000000-0000-0000-0000-0000000000d4';
    await redis.hset(StreamKeys.sessionStateKey(TENANT, session), 'grantJson', '{}');
    expect(await getSessionWorkflowExecution(redis, TENANT, session)).toBeUndefined();
    expect(await isSessionCorrupt(redis, TENANT, session)).toBe(false);
  });
});
