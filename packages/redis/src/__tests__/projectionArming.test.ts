/**
 * Every writer of projection-visible session state must arm the candidate index.
 *
 * The projection worker discovers work through that index and nowhere else, so a
 * writer that skips it makes its own transition invisible: the run finishes in
 * Redis, the durable row keeps whatever the last projected status was, and
 * nothing anywhere reports a problem. The `atomic*` writers batch a whole state
 * transition into one pipeline instead of calling `markSessionDirty`, and that
 * is precisely where the arming went missing — every ordinary run reached
 * SUCCEEDED without its terminal state ever reaching Postgres.
 *
 * These are real-Redis: the arming, the claim and the acknowledgement are Lua
 * over sorted sets, and ioredis-mock does not implement them faithfully enough
 * for a pass to mean anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { StreamKeys, type SessionId, type StepExecutionId, type TenantId } from '@aflow/schemas';
import {
  setSessionState,
  markSessionDirty,
  atomicCreateSession,
  atomicCompleteStep,
  atomicScheduleStep,
  appendSessionEvent,
  claimProjectionCandidates,
  ackProjection,
  type SessionHotState,
  type StepHotState,
  type SessionEvent,
} from '../hotState.js';

/**
 * Isolated to a dedicated Redis database: these write session hashes and the
 * candidate index under the same fixed key names production uses, so on db 0
 * they would take a dev orchestrator's sessions out from under it.
 *
 * Its own database, not shared with the sibling projection suite. Claiming is
 * "take everything due", so a parallel suite on the same database leases these
 * members before this one can — filtering the result client-side does not undo
 * the lease it just took. Member-scoping is enough for suites where every
 * operation names its member; it is not enough for a claim.
 */
const TEST_DB = 14;

async function redisReachable(): Promise<boolean> {
  const probe = new Redis({
    host: '127.0.0.1',
    port: 6379,
    db: TEST_DB,
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const AVAILABLE = await redisReachable();

const TENANT = 'tenant-projection-arming' as TenantId;
const RUN = '00000000-0000-0000-0000-0000000000a1' as SessionId;
const STEP = '00000000-0000-0000-0000-0000000000b1' as StepExecutionId;
const MEMBER = `${TENANT}:${RUN}`;

function makeRunState(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'test-role' },
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    ...overrides,
  };
}

function makeStepState(overrides: Partial<StepHotState> = {}): StepHotState {
  return {
    stepExecutionId: STEP,
    tenantId: TENANT,
    sessionId: RUN,
    stepId: 'step-1',
    stepType: 'agent',
    operationId: 'agent.control.delegate',
    attempt: 1,
    status: 'STARTED',
    scheduledAt: 1000,
    inputRef: 'inline:test',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

function makeEvent(eventType: SessionEvent['eventType'] = 'StepSucceeded'): SessionEvent {
  return { eventId: crypto.randomUUID(), eventType, timestamp: Date.now(), sessionId: RUN };
}

describe.skipIf(!AVAILABLE)('projection arming', () => {
  let redis: RedisType;

  async function reset(): Promise<void> {
    await redis.del(
      StreamKeys.projectionCandidatesKey,
      StreamKeys.projectionOrderKey,
      StreamKeys.projectionLeasesKey,
      StreamKeys.sessionStateKey(TENANT, RUN),
      StreamKeys.stepStateKey(TENANT, STEP),
      StreamKeys.sessionEventsStream(TENANT, RUN),
    );
  }

  beforeEach(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6379, db: TEST_DB, maxRetriesPerRequest: 1 });
    await reset();
  });

  afterEach(async () => {
    await reset();
    redis.disconnect();
  });

  /** Arming is monotonic, so a writer arms iff it raises the count. */
  async function armsBy(act: () => Promise<unknown>): Promise<number> {
    const before = (await version()) ?? 0;
    await act();
    return ((await version()) ?? 0) - before;
  }

  async function version(): Promise<number | null> {
    const score = await redis.zscore(StreamKeys.projectionCandidatesKey, MEMBER);
    return score === null ? null : Number(score);
  }

  it('arms the candidate on markSessionDirty', async () => {
    await setSessionState(redis, makeRunState());
    expect(await armsBy(() => markSessionDirty(redis, TENANT, RUN))).toBe(1);

    expect(await redis.zscore(StreamKeys.projectionOrderKey, MEMBER)).not.toBeNull();
    expect(await redis.zscore(StreamKeys.projectionLeasesKey, MEMBER)).toBeNull();
  });

  it('arms the candidate on atomicCreateSession', async () => {
    await atomicCreateSession(
      redis,
      makeRunState({ status: 'QUEUED' }),
      makeStepState(),
      makeEvent('SessionStarted'),
      makeEvent('StepScheduled'),
    );

    expect(await version()).toBe(1);
  });

  it('arms the candidate on atomicScheduleStep', async () => {
    await setSessionState(redis, makeRunState());

    const armed = await armsBy(() =>
      atomicScheduleStep(
        redis,
        TENANT,
        RUN,
        makeStepState({ status: 'SCHEDULED' }),
        { status: 'RUNNING', currentStepExecutionId: STEP },
        makeEvent('StepScheduled'),
      ),
    );
    expect(armed).toBe(1);
  });

  it('arms the candidate on atomicCompleteStep', async () => {
    await setSessionState(redis, makeRunState());

    const armed = await armsBy(() =>
      atomicCompleteStep(
        redis,
        TENANT,
        { stepExecutionId: STEP, status: 'SUCCEEDED', endedAt: Date.now() },
        { sessionId: RUN, status: 'RUNNING' },
        makeEvent('StepSucceeded'),
      ),
    );
    expect(armed).toBe(1);
  });

  it('arms the candidate on appendSessionEvent', async () => {
    // Event-only appenders — workflow fan-out to waiter sessions, forwarded
    // child events, executor surface emissions — mutate no session state. If
    // the append itself does not arm, their events wait for an unrelated
    // mutation, and a stream past its cap evicts them before anything flushes.
    await setSessionState(redis, makeRunState());
    const claimedBefore = await claimProjectionCandidates(redis, 50);
    for (const c of claimedBefore)
      await ackProjection(redis, c.tenantId, c.runId, c.version, c.leaseUntilMs);

    const messageId = await appendSessionEvent(redis, TENANT, RUN, makeEvent());

    expect(messageId).toMatch(/^\d+-\d+$/);
    expect(await version()).toBe(1);
    expect(await redis.zscore(StreamKeys.projectionOrderKey, MEMBER)).not.toBeNull();
  });

  it('re-arms a run that reaches its terminal state after an earlier projection', async () => {
    // The bug this file exists for, end to end. A run projected while RUNNING is
    // correctly acknowledged and leaves the index; if its terminal transition
    // does not put it back, SUCCEEDED never reaches Postgres and the run looks
    // permanently in-flight in every durable view.
    await setSessionState(redis, makeRunState({ status: 'QUEUED' }));
    await markSessionDirty(redis, TENANT, RUN);

    const [claimed] = await claimProjectionCandidates(redis, 50);
    expect(claimed).toBeDefined();
    expect(await ackProjection(redis, TENANT, RUN, claimed!.version, claimed!.leaseUntilMs)).toBe(
      true,
    );
    expect(await version()).toBeNull();

    await atomicCompleteStep(
      redis,
      TENANT,
      { stepExecutionId: STEP, status: 'SUCCEEDED', endedAt: Date.now() },
      { sessionId: RUN, status: 'SUCCEEDED', endedAt: Date.now() },
      makeEvent('SessionCompleted'),
    );

    expect((await claimProjectionCandidates(redis, 50)).map((c) => c.runId)).toEqual([RUN]);
  });

  it('keeps the version monotonic across a writer that deletes the session hash', async () => {
    // setSessionState and atomicCreateSession DEL the hash before rewriting it.
    // A version stored there would reset to zero and climb back through a value
    // an in-flight worker already read, so its acknowledgement would match a
    // version that was never projected and drop the candidate.
    await setSessionState(redis, makeRunState());
    await markSessionDirty(redis, TENANT, RUN);
    const [claimed] = await claimProjectionCandidates(redis, 50);

    await setSessionState(redis, makeRunState({ status: 'PAUSED' }));
    await markSessionDirty(redis, TENANT, RUN);

    expect(await version()).toBeGreaterThan(claimed!.version);
    expect(await ackProjection(redis, TENANT, RUN, claimed!.version, claimed!.leaseUntilMs)).toBe(
      false,
    );
    expect(await version()).not.toBeNull();
  });

  it('does not create an orphan session hash for a session that has aged out', async () => {
    await markSessionDirty(redis, TENANT, RUN);

    expect(await redis.exists(StreamKeys.sessionStateKey(TENANT, RUN))).toBe(0);
    expect(await version()).toBe(1);
  });
});

describe('projection index writers', () => {
  it('is armed from exactly one module', async () => {
    // Two ways to arm a projection is how the atomic writers and the worker
    // drifted apart: the SET was written directly, the candidate index was not,
    // and the drift was invisible until runs stopped reaching Postgres.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const srcRoot = new URL('../', import.meta.url).pathname;

    async function* walk(dir: string): AsyncGenerator<string> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.name.endsWith('.ts')) yield full;
      }
    }

    const offenders: string[] = [];
    for await (const file of walk(srcRoot)) {
      if (file.endsWith('hotState/projectionCandidates.ts')) continue;
      if (file.includes('__tests__')) continue;
      const src = await fs.readFile(file, 'utf8');
      if (/projectionCandidatesKey|projectionOrderKey|projectionLeasesKey/.test(src)) {
        offenders.push(path.relative(srcRoot, file));
      }
    }

    expect(
      offenders,
      'Arm projections through markProjectionCandidate() in hotState/projectionCandidates.ts rather than naming the index keys directly.',
    ).toEqual([]);
  });
});
