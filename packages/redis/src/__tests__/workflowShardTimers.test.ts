/**
 * Workflow-correlated timers keep their envelope through the claim path.
 *
 * Uses a real Redis: claiming is a Lua script, and ioredis-mock's Lua VM does
 * not reproduce it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../../../../scripts/stackRedis.mjs';
import { StreamKeys, TimerItemSchema, type TimerItem } from '@aflow/schemas';
import {
  ackShardTimer,
  claimDueShardTimers,
  scheduleShardTimer,
  timerShardKey,
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

const TENANT = '11111111-1111-4111-9111-111111111111';
const RUN_ID = '22222222-2222-4222-9222-222222222222';
const SESSION_ID = '33333333-3333-4333-9333-333333333333';
const STEP_EXEC_ID = '44444444-4444-4444-9444-444444444444';
const SPACE_ID = '55555555-5555-4555-9555-555555555555';

function workflowTimer(overrides: Record<string, unknown> = {}): TimerItem {
  return TimerItemSchema.parse({
    tenantId: TENANT,
    workflowExecution: {
      runId: RUN_ID,
      taskId: 'snooze-task',
      attempt: 1,
      dispatchAttemptToken: `dispatch:${RUN_ID}:snooze-task:1`,
    },
    stepExecutionId: STEP_EXEC_ID,
    stepId: 'snooze-task',
    operationId: 'agent.schedule.snooze',
    stepType: 'agent',
    reason: 'delayed_start',
    attempt: 1,
    inputRef: `inline:${Buffer.from(JSON.stringify({ durationMs: 60000 })).toString('base64')}`,
    traceId: 'trace-wf',
    dueAtMs: Date.now() - 1, // already due
    spaceId: SPACE_ID,
    credentialOwnerId: 'user-1',
    ...overrides,
  });
}

function sessionTimer(): TimerItem {
  return TimerItemSchema.parse({
    tenantId: TENANT,
    sessionId: SESSION_ID,
    stepExecutionId: STEP_EXEC_ID,
    stepId: 'delayed-step',
    operationId: 'ai.text.generate',
    stepType: 'ai',
    reason: 'delayed_start',
    attempt: 1,
    inputRef: `inline:${Buffer.from('{}').toString('base64')}`,
    traceId: 'trace-session',
    dueAtMs: Date.now() - 1,
  });
}

describe.skipIf(!STACK_REDIS.available)('workflow-correlated shard timers', () => {
  let redis: RedisType;

  beforeEach(() => {
    redis = new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    for (const shardId of [shardFor(RUN_ID), shardFor(SESSION_ID)]) {
      await redis.del(StreamKeys.shardTimersKey(shardId), StreamKeys.shardTimerDataKey(shardId));
      await redis.zrem(StreamKeys.dueShardsKey, String(shardId));
    }
    redis.disconnect();
  });

  it('shards workflow timers by runId and session timers by sessionId', () => {
    expect(timerShardKey(workflowTimer())).toBe(RUN_ID);
    expect(timerShardKey(sessionTimer())).toBe(SESSION_ID);
  });

  it('claims a due workflow timer with the envelope intact', async () => {
    const timer = workflowTimer();
    await scheduleShardTimer(redis, timer);

    const shardId = shardFor(RUN_ID);
    const claim = await claimDueShardTimers(redis, [shardId]);

    expect(claim.timers).toHaveLength(1);
    const item = claim.timers[0]!;
    expect(item.sessionId).toBeUndefined();
    expect(item.workflowExecution).toEqual(timer.workflowExecution);
    expect(item.operationId).toBe('agent.schedule.snooze');
    expect(item.spaceId).toBe(SPACE_ID);
    expect(item.credentialOwnerId).toBe('user-1');

    // Leased, not popped: a second drain within the lease sees nothing, and the
    // timer only disappears once it is acknowledged.
    expect((await claimDueShardTimers(redis, [shardId])).timers).toHaveLength(0);
    await ackShardTimer(redis, item, claim.leaseUntilMs);
    expect(await redis.zcard(StreamKeys.shardTimersKey(shardId))).toBe(0);
  });

  it('leaves not-yet-due workflow timers alone', async () => {
    await scheduleShardTimer(redis, workflowTimer({ dueAtMs: Date.now() + 60_000 }));
    const claim = await claimDueShardTimers(redis, [shardFor(RUN_ID)]);
    expect(claim.timers).toHaveLength(0);
  });

  it('does not return workflow timers to an instance owning other shards', async () => {
    await scheduleShardTimer(redis, workflowTimer());
    const owned = shardFor(RUN_ID);
    const otherShards = Array.from({ length: SHARD_COUNT }, (_, i) => i).filter((i) => i !== owned);
    const claim = await claimDueShardTimers(redis, otherShards);
    // Scoped to this run: the suite shares a Redis with other test files, so a
    // global emptiness assertion would be checking their state, not ours.
    expect(claim.timers.filter((t) => t.workflowExecution?.runId === RUN_ID)).toHaveLength(0);
  });

  it('claims session timers on the session shard', async () => {
    const timer = sessionTimer();
    await scheduleShardTimer(redis, timer);
    const claim = await claimDueShardTimers(redis, [shardFor(SESSION_ID)]);
    expect(claim.timers).toHaveLength(1);
    expect(claim.timers[0]!.sessionId).toBe(SESSION_ID);
    expect(claim.timers[0]!.workflowExecution).toBeUndefined();
  });
});
