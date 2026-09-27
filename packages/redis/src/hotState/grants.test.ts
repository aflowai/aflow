import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { RunAccessGrant } from '@aflow/schemas';
import { getRunAccessGrant, setRunAccessGrant, serializeRunAccessGrant } from './grants.js';
import { atomicCreateSession } from './atomic.js';
import { setSessionState } from './session.js';
import type { SessionHotState, StepHotState, SessionEvent } from './schemas.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = '265a4135-2103-48f2-92ae-344c77c2c006';
const SPACE = '9e842431-cb9a-477d-b090-e33e601a4c83';
const USER = '1eab6e64-861a-4b99-b396-74f35b111dbb';

function makeGrant(): RunAccessGrant {
  return {
    spaceId: SPACE,
    accessLevel: 'write',
    grantedToUserId: USER,
    tenantRole: 'admin',
    spaceRole: 'admin',
    grantedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    capabilities: {
      allowedCapabilities: [{ capabilityGroupId: 'ai.text', accessMode: 'write' }],
      deniedCapabilities: [],
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
  };
}

function makeRunState(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'cybernetic-runner' },
    agentVersion: 1,
    status: 'RUNNING',
    currentStepId: 'execute',
    createdAt: Date.now(),
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
    spaceId: SPACE,
    ...overrides,
  } as SessionHotState;
}

describe('run access grant storage', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
  });

  it('round-trips a grant written onto an existing session hash', async () => {
    await setSessionState(redis, makeRunState());
    const grant = makeGrant();
    await setRunAccessGrant(redis, TENANT, RUN, grant);

    expect(await getRunAccessGrant(redis, TENANT, RUN)).toEqual(grant);
  });

  it('returns null when no grant was ever stored', async () => {
    await setSessionState(redis, makeRunState());
    expect(await getRunAccessGrant(redis, TENANT, RUN)).toBeNull();
  });

  // The regression: `atomicCreateSession` DELs the hash before writing it, so a
  // grant stored ahead of session creation is silently discarded. That left the
  // grant readable only until its (then separate) key aged out, and every run
  // whose gated work outlived that window paused unrecoverably.
  it('survives session creation when carried on the run state literal', async () => {
    const grant = makeGrant();
    const runState = makeRunState({ grantJson: serializeRunAccessGrant(grant) });

    const step: StepHotState = {
      stepExecutionId: '92e4a368-d58d-4713-a12f-303fef860712',
      tenantId: TENANT,
      sessionId: RUN,
      stepId: 'execute',
      stepType: 'ai',
      operationId: 'ai.agent.turn',
      attempt: 1,
      status: 'SCHEDULED',
      scheduledAt: Date.now(),
    } as StepHotState;
    const event: SessionEvent = {
      eventId: 'e1',
      eventType: 'SessionStarted',
      timestamp: Date.now(),
      sessionId: RUN,
    } as SessionEvent;

    await atomicCreateSession(redis, runState, step, event, { ...event, eventId: 'e2' });

    expect(await getRunAccessGrant(redis, TENANT, RUN)).toEqual(grant);
  });

  it('is discarded when stored before session creation instead of carried in it', async () => {
    await setRunAccessGrant(redis, TENANT, RUN, makeGrant());

    const step: StepHotState = {
      stepExecutionId: '92e4a368-d58d-4713-a12f-303fef860712',
      tenantId: TENANT,
      sessionId: RUN,
      stepId: 'execute',
      stepType: 'ai',
      operationId: 'ai.agent.turn',
      attempt: 1,
      status: 'SCHEDULED',
      scheduledAt: Date.now(),
    } as StepHotState;
    const event: SessionEvent = {
      eventId: 'e1',
      eventType: 'SessionStarted',
      timestamp: Date.now(),
      sessionId: RUN,
    } as SessionEvent;

    await atomicCreateSession(redis, makeRunState(), step, event, { ...event, eventId: 'e2' });

    expect(await getRunAccessGrant(redis, TENANT, RUN)).toBeNull();
  });

  it('outlives the grant expiry window, so an aged-out grant stays renewable', async () => {
    const expired = { ...makeGrant(), expiresAt: new Date(Date.now() - 1000).toISOString() };
    await setSessionState(redis, makeRunState({ grantJson: serializeRunAccessGrant(expired) }));

    // Readable-but-expired is the renewable state; absent is the fatal one.
    const read = await getRunAccessGrant(redis, TENANT, RUN);
    expect(read).not.toBeNull();
    expect(new Date(read!.expiresAt).getTime()).toBeLessThan(Date.now());
  });
});
