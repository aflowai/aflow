/**
 * The due-shard timer index, exercised against a real Redis.
 *
 * Every property here lives in a Lua script — atomic claim, lease advance,
 * minimum recomputation, redelivery counting — and ioredis-mock's Lua VM does
 * not reproduce them, so this skips rather than pretending when no Redis is
 * reachable. Keys are namespaced per run and cleaned up individually; the suite
 * never flushes a database it might be sharing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../../../../scripts/stackRedis.mjs';
import {
  StreamKeys,
  type OperationId,
  type PayloadRef,
  type SessionId,
  type StepExecutionId,
  type StepId,
  type TenantId,
  type TimerItem,
  type TraceId,
} from '@aflow/schemas';
import {
  ackShardTimer,
  ackShardTimerById,
  claimDueShardTimers,
  getShardTimer,
  migrateLegacyShardTimers,
  repairDueShardIndex,
  rescheduleClaimedTimer,
  scheduleShardTimer,
  timerId,
  timerShardKey,
  TIMER_MAX_CLAIMS,
} from '../streams/shardTimers.js';
import { shardFor, SHARD_COUNT } from '../shard.js';

/**
 * Isolated to a dedicated Redis database. These suites write shard-registry,
 * liveness and stream-group state under the same fixed key names production
 * uses, so on db 0 they would fight a dev orchestrator for ownership — and take
 * shards away from it mid-run.
 */
const TEST_DB = 15;

const STACK_REDIS = await stackRedis(TEST_DB);

const TENANT = 'a0000000-0000-0000-0000-0000000180ff' as TenantId;

/** Derives a distinct, schema-valid step id from a session id. */
function stepIdFor(sessionId: string): string {
  return `11111111-0000-0000-0000-${sessionId.slice(-12)}`;
}

function makeTimer(
  sessionId: string,
  dueAtMs: number,
  overrides: Partial<TimerItem> = {},
): TimerItem {
  return {
    tenantId: TENANT,
    sessionId: sessionId as SessionId,
    stepExecutionId: stepIdFor(sessionId) as StepExecutionId,
    stepId: 's1' as StepId,
    operationId: 'ai.generate.text' as OperationId,
    stepType: 'ai',
    reason: 'retry',
    attempt: 1,
    inputRef: 'inline:e30=' as PayloadRef,
    traceId: '00000000-0000-0000-0000-0000000000aa' as TraceId,
    dueAtMs,
    ...overrides,
  } as TimerItem;
}

/** Session ids that hash to distinct shards, so cross-shard behaviour is real. */
function sessionForDistinctShards(count: number): string[] {
  const found = new Map<number, string>();
  for (let i = 0; found.size < count && i < 10_000; i++) {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    const shard = shardFor(id);
    if (!found.has(shard)) found.set(shard, id);
  }
  return [...found.values()];
}

describe.skipIf(!STACK_REDIS.available)('shard timer index (real Redis)', () => {
  let redis: RedisType;
  let touchedShards: Set<number>;

  beforeEach(() => {
    redis = new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
    touchedShards = new Set();
  });

  afterEach(async () => {
    for (const shardId of touchedShards) {
      await redis.del(StreamKeys.shardTimersKey(shardId), StreamKeys.shardTimerDataKey(shardId));
      await redis.zrem(StreamKeys.dueShardsKey, String(shardId));
    }
    redis.disconnect();
  });

  const track = (timer: TimerItem): number => {
    const shardId = shardFor(timerShardKey(timer));
    touchedShards.add(shardId);
    return shardId;
  };

  it('claims a due timer and leaves an undue one alone', async () => {
    const [dueSession, futureSession] = sessionForDistinctShards(2) as [string, string];
    const due = makeTimer(dueSession, Date.now() - 1000);
    const future = makeTimer(futureSession, Date.now() + 600_000);
    const shards = [track(due), track(future)];

    await scheduleShardTimer(redis, due);
    await scheduleShardTimer(redis, future);

    const claim = await claimDueShardTimers(redis, shards);
    expect(claim.timers.map((t) => t.sessionId)).toEqual([dueSession]);
    expect(claim.oldestDueAgeMs).toBeGreaterThanOrEqual(1000);
  });

  it('never hands a timer to an instance that does not own its shard', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);

    const otherShards = Array.from({ length: SHARD_COUNT }, (_, i) => i).filter(
      (id) => id !== shardId,
    );
    const claim = await claimDueShardTimers(redis, otherShards);
    // Scoped to this run: the suite shares a Redis with other test files.
    expect(claim.timers.filter((t) => t.sessionId === session)).toEqual([]);

    // Still claimable by the real owner — the drain did not consume it.
    const owner = await claimDueShardTimers(redis, [shardId]);
    expect(owner.timers).toHaveLength(1);
  });

  it('leases a claimed timer instead of deleting it, so a crashed worker loses nothing', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);

    const first = await claimDueShardTimers(redis, [shardId], { leaseMs: 30_000 });
    expect(first.timers).toHaveLength(1);

    // The payload survives the claim; a second drain within the lease sees nothing.
    const withinLease = await claimDueShardTimers(redis, [shardId]);
    expect(withinLease.timers).toEqual([]);

    // Once the lease expires the timer is due again — this is the crash path.
    const afterLease = await claimDueShardTimers(redis, [shardId], {
      nowMs: Date.now() + 31_000,
    });
    expect(afterLease.timers).toHaveLength(1);
  });

  it('removes the timer and its shard entry on acknowledgement', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);
    const claimed = await claimDueShardTimers(redis, [shardId]);
    await ackShardTimer(redis, timer, claimed.leaseUntilMs);

    expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(0);
    expect(await redis.hlen(StreamKeys.shardTimerDataKey(shardId))).toBe(0);
    expect(await redis.zscore(StreamKeys.dueShardsKey, String(shardId))).toBeNull();
  });

  it('reads a timer by its identity while it is armed or leased, and none once acknowledged', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    const identity = {
      sessionId: timer.sessionId,
      stepExecutionId: timer.stepExecutionId,
      reason: timer.reason,
      attempt: timer.attempt,
    };

    expect(await getShardTimer(redis, identity)).toBeNull();
    await scheduleShardTimer(redis, timer);
    expect(await getShardTimer(redis, identity)).toEqual(timer);
    expect(await getShardTimer(redis, { ...identity, attempt: 2 })).toBeNull();

    const claimed = await claimDueShardTimers(redis, [shardId]);
    expect(await getShardTimer(redis, identity)).toEqual(timer);

    await ackShardTimer(redis, timer, claimed.leaseUntilMs);
    expect(await getShardTimer(redis, identity)).toBeNull();
  });

  it('upserts rather than duplicating when the same wake-up is rescheduled', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const shardId = track(makeTimer(session, 0));
    await scheduleShardTimer(redis, makeTimer(session, Date.now() + 60_000));
    await scheduleShardTimer(redis, makeTimer(session, Date.now() - 1000));

    expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(1);
    const claim = await claimDueShardTimers(redis, [shardId]);
    expect(claim.timers).toHaveLength(1);
  });

  it('keeps successive workflow poll cycles distinct', async () => {
    const runId = sessionForDistinctShards(1)[0]!;
    const shardId = shardFor(runId);
    touchedShards.add(shardId);
    const base = {
      tenantId: TENANT,
      stepExecutionId: '11111111-1111-0000-0000-000000000001' as StepExecutionId,
      stepId: 'task-1' as StepId,
      operationId: 'compute.sandbox.exec' as OperationId,
      stepType: 'compute' as const,
      reason: 'delayed_start' as const,
      attempt: 1,
      inputRef: 'inline:e30=' as PayloadRef,
      traceId: '00000000-0000-0000-0000-0000000000aa' as TraceId,
      dueAtMs: Date.now() - 1000,
    };
    for (const cycle of [1, 2]) {
      await scheduleShardTimer(redis, {
        ...base,
        workflowExecution: {
          runId,
          taskId: 'task-1',
          attempt: 1,
          dispatchAttemptToken: `dispatch:${runId}:task-1:1:poll:${String(cycle)}`,
        },
      } as TimerItem);
    }
    expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(2);
  });

  it('leases a poisoned timer for disposition rather than deleting it', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);

    // Exhaust the redelivery budget without ever acknowledging.
    let now = Date.now();
    for (let attempt = 0; attempt < TIMER_MAX_CLAIMS; attempt++) {
      const claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
      expect(claim.timers.map((t) => t.sessionId)).toEqual([session]);
      now += 2000;
    }

    // Every claim past the budget surfaces the timer as poison, with its claim
    // count, and keeps it stored — including past twice the budget, where the
    // count is what routes the caller from disposition to durable archive. The
    // claim never deletes a decodable payload: it is the only copy of the wake.
    for (let attempt = TIMER_MAX_CLAIMS + 1; attempt <= TIMER_MAX_CLAIMS * 2 + 2; attempt++) {
      const claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
      expect(claim.timers).toEqual([]);
      expect(claim.poisoned.map((p) => p.timer.sessionId)).toEqual([session]);
      expect(claim.poisoned[0]?.claims).toBe(attempt);
      expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(1);
      now += 2000;
    }
  });

  it('surfaces a schema-invalid payload as malformed poison, retirable by id', async () => {
    // Decodes as JSON but no longer matches the schema — the claim keeps it,
    // and it must come back with its storage identity or nothing could ever
    // archive or acknowledge it.
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);
    await redis.hset(
      StreamKeys.shardTimerDataKey(shardId),
      `d:${timerId(timer)}`,
      JSON.stringify({ tenantId: TENANT, futureShape: true }),
    );

    let now = Date.now();
    let claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
    for (let attempt = 1; attempt <= TIMER_MAX_CLAIMS; attempt++) {
      now += 2000;
      claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
    }

    expect(claim.timers).toEqual([]);
    expect(claim.poisoned).toEqual([]);
    expect(claim.malformedPoisoned).toHaveLength(1);
    const malformed = claim.malformedPoisoned[0]!;
    expect(malformed.timerId).toBe(timerId(timer));
    expect(malformed.shardId).toBe(shardId);
    expect(JSON.parse(malformed.raw)).toMatchObject({ futureShape: true });

    expect(
      await ackShardTimerById(redis, malformed.shardId, malformed.timerId, claim.leaseUntilMs),
    ).toBe(true);
    expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(0);
  });

  it('surfaces an undecodable payload as malformed poison rather than ever deleting it', async () => {
    // The archive stores even an unparseable payload as raw text, so the
    // claim has no case where deletion loses nothing — retirement is always
    // an acknowledged archive.
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);
    await redis.hset(
      StreamKeys.shardTimerDataKey(shardId),
      `d:${timerId(timer)}`,
      'not json at all',
    );

    let now = Date.now();
    let claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
    for (let attempt = 1; attempt <= TIMER_MAX_CLAIMS * 2 + 2; attempt++) {
      now += 2000;
      claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
      if (attempt > TIMER_MAX_CLAIMS) {
        expect(claim.malformedPoisoned.map((m) => m.raw)).toEqual(['not json at all']);
        expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(1);
      }
    }

    const malformed = claim.malformedPoisoned[0]!;
    expect(
      await ackShardTimerById(redis, malformed.shardId, malformed.timerId, claim.leaseUntilMs),
    ).toBe(true);
    expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(0);
  });

  it('a fresh arming resets the redelivery budget', async () => {
    // A retry's next attempt re-arms under the same timer id. A counter
    // inherited from a poisoned predecessor would poison the new wake on
    // arrival and dead-letter it undelivered — the step's only recovery.
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);

    let now = Date.now();
    let claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
    for (let attempt = 1; attempt <= TIMER_MAX_CLAIMS; attempt++) {
      now += 2000;
      claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
    }
    expect(claim.poisoned.map((p) => p.timer.sessionId)).toEqual([session]);

    await scheduleShardTimer(redis, { ...timer, dueAtMs: now - 1000 });
    claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });

    expect(claim.timers.map((t) => t.sessionId)).toEqual([session]);
    expect(claim.poisoned).toEqual([]);
  });

  it('acknowledges a poisoned timer once its disposition lands', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);

    let now = Date.now();
    let claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
    for (let attempt = 1; attempt <= TIMER_MAX_CLAIMS; attempt++) {
      now += 2000;
      claim = await claimDueShardTimers(redis, [shardId], { nowMs: now, leaseMs: 1000 });
    }
    expect(claim.poisoned.map((p) => p.timer.sessionId)).toEqual([session]);

    expect(await ackShardTimer(redis, timer, claim.leaseUntilMs)).toBe(true);
    expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(0);
  });

  it('re-arms without consuming a redelivery when the handler defers', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);

    // Far more deferrals than the poison bound; none of them may count.
    for (let i = 0; i < TIMER_MAX_CLAIMS * 3; i++) {
      const claim = await claimDueShardTimers(redis, [shardId]);
      expect(claim.timers).toHaveLength(1);
      expect(claim.poisoned).toEqual([]);
      await rescheduleClaimedTimer(redis, timer, timer.dueAtMs);
    }
  });

  it('bounds a claim by the overall cap', async () => {
    const sessions = sessionForDistinctShards(5);
    const shards = sessions.map((s) => track(makeTimer(s, 0)));
    for (const session of sessions) {
      await scheduleShardTimer(redis, makeTimer(session, Date.now() - 1000));
    }

    const claim = await claimDueShardTimers(redis, shards, { maxTotal: 2 });
    expect(claim.timers).toHaveLength(2);
    expect(await redis.zcard(StreamKeys.dueShardsKey)).toBeGreaterThanOrEqual(3);
  });

  it('rebuilds a due-shard entry that went missing', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);

    // Simulate the index entry being lost without the shard's own timers.
    await redis.zrem(StreamKeys.dueShardsKey, String(shardId));
    expect((await claimDueShardTimers(redis, [shardId])).timers).toEqual([]);

    await repairDueShardIndex(redis, [shardId]);
    expect((await claimDueShardTimers(redis, [shardId])).timers).toHaveLength(1);
  });

  it('budgets per shard so one backlog cannot starve the others', async () => {
    // A single shared budget let the shard with the oldest backlog take the
    // whole batch, and because due shards are visited earliest-first it kept
    // that position every tick — starving the retry timers that resume other
    // sessions indefinitely.
    const [busySession, quietSession] = sessionForDistinctShards(2) as [string, string];
    const busyShard = shardFor(busySession);
    const quietShard = shardFor(quietSession);
    touchedShards.add(busyShard);
    touchedShards.add(quietShard);

    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      await scheduleShardTimer(redis, {
        ...makeTimer(busySession, now - 10_000 + i),
        stepExecutionId:
          `22222222-0000-0000-0000-${String(i).padStart(12, '0')}` as StepExecutionId,
      });
    }
    await scheduleShardTimer(redis, makeTimer(quietSession, now - 1000));

    const claim = await claimDueShardTimers(redis, [busyShard, quietShard], {
      limitPerShard: 2,
      maxTotal: 100,
    });
    const sessions = claim.timers.map((t) => t.sessionId);
    expect(sessions.filter((id) => id === busySession)).toHaveLength(2);
    expect(sessions).toContain(quietSession);
  });

  it('leaves a timer stored in the pre-id format alone instead of deleting it', async () => {
    // The pre-id format used the serialized payload as the ZSET member. Treating
    // an unrecognised member as an orphan would silently destroy every timer
    // armed before the deploy.
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    const legacyMember = JSON.stringify(timer);

    await redis.zadd(StreamKeys.shardTimersKey(shardId), timer.dueAtMs, legacyMember);
    await redis.zadd(StreamKeys.dueShardsKey, timer.dueAtMs, String(shardId));

    const claim = await claimDueShardTimers(redis, [shardId]);
    expect(claim.legacyClaimed).toBe(1);
    expect(await redis.zscore(StreamKeys.shardTimersKey(shardId), legacyMember)).not.toBeNull();
  });

  it('converts pre-id timers so they become claimable', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);

    await redis.zadd(StreamKeys.shardTimersKey(shardId), timer.dueAtMs, JSON.stringify(timer));
    // The old scheduler never wrote the global index, so the shard is invisible.
    await redis.zrem(StreamKeys.dueShardsKey, String(shardId));

    const migration = await migrateLegacyShardTimers(redis, [shardId]);
    expect(migration.migrated).toBe(1);

    const claim = await claimDueShardTimers(redis, [shardId]);
    expect(claim.timers.map((t) => t.sessionId)).toContain(session);
    expect(claim.legacyClaimed).toBe(0);
  });

  it('does not acknowledge away a timer that was re-armed while it was handled', async () => {
    const [session] = sessionForDistinctShards(1) as [string];
    const timer = makeTimer(session, Date.now() - 1000);
    const shardId = track(timer);
    await scheduleShardTimer(redis, timer);

    const claim = await claimDueShardTimers(redis, [shardId]);
    expect(claim.timers).toHaveLength(1);

    // A producer re-arms the same wake-up while the handler is still running.
    const rearmed = { ...timer, dueAtMs: Date.now() + 30_000 };
    await scheduleShardTimer(redis, rearmed);

    const acked = await ackShardTimer(redis, timer, claim.leaseUntilMs);
    expect(acked).toBe(false);
    expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(1);
  });

  it('issues exactly one script call regardless of how many shards are owned', async () => {
    // Counted on the client rather than from INFO commandstats: this suite
    // shares a Redis with other test files, and a server-wide counter measures
    // their traffic too.
    const allShards = Array.from({ length: SHARD_COUNT }, (_, i) => i);
    const spy = vi.spyOn(redis, 'eval');
    try {
      await claimDueShardTimers(redis, allShards);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
