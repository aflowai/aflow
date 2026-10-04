/**
 * The poisoned-timer disposition driven end to end: the real claim Lua takes
 * the timer past its redelivery budget, the real `disposePoisonedTimer` builds
 * the synthetic failure, and the real `applyResult` decides what that failure
 * means. The seam under test is the retry math — the disposition consumes the
 * timer's attempt exactly as the dispatch it replaces would have, so the next
 * retry advances instead of re-arming the same attempt under the same timer id
 * forever — and the attempt-aware currency guard that discards a redelivery
 * whose step has already moved on.
 *
 * Real Redis on its own database: the claim and ack are Lua, and the guard's
 * subject is the actual step hash the reset pipeline wrote.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { AgentDefinitionSchema, StreamKeys, type TenantId, type TimerItem } from '@aflow/schemas';
import { createDatabase } from '@aflow/database';
import {
  scheduleShardTimer,
  timerId,
  shardFor,
  setSessionState,
  updateStepState,
  getStepState,
  getSessionState,
  TIMER_MAX_CLAIMS,
  type SessionHotState,
} from '@aflow/redis';
import { stackRedis } from '@aflow/redis/testing';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { createSessionOrchestrator } from '../../index.js';
import type { ShardManager } from '../../../ShardManager.js';

const DATABASE_URL = process.env['DATABASE_URL'];
/** Its own database: a claim takes everything due, including a dev orchestrator's. */
const REDIS_DB = 12;

const TENANT = 'd1d10000-0000-4000-8000-000000000922' as TenantId;

let handle: { sql: postgres.Sql; close: () => Promise<void> } | undefined;
let redis: RedisType;

const STACK_REDIS = await stackRedis(REDIS_DB);
const READY = Boolean(DATABASE_URL) && STACK_REDIS.available;

describe.skipIf(!READY)('poisoned-timer disposition through applyResult', () => {
  const payloadStore = createMemoryPayloadStore();

  const agentDef = AgentDefinitionSchema.parse({
    flowId: 'poison-harness-agent',
    version: '1.0.0',
    metadata: { name: 'Poison Harness' },
    stateVariables: [],
    steps: [{ stepId: 'work', stepType: 'api', operation: 'api.http.call' }],
    startStepId: 'work',
  });

  beforeAll(async () => {
    handle = createDatabase(DATABASE_URL!);
    redis = new Redis(STACK_REDIS.url);
  });

  afterAll(async () => {
    // Left clean: setSessionState arms projection candidates as a side effect,
    // and debris in a shared test database is claimed by whichever suite's
    // worker looks next.
    await redis.flushdb();
    redis.disconnect();
    await handle?.close();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  function orchestrator(sessionId: string) {
    const shardId = shardFor(sessionId);
    const shardManager = {
      ownedShards: () => [shardId],
      ownsShard: (id: number) => id === shardId,
      ownsRun: () => true,
      fencingToken: () => 1,
    } as unknown as ShardManager;
    return createSessionOrchestrator({
      db: drizzle(handle!.sql),
      sqlClient: handle!.sql,
      redis,
      payloadStore,
      consumerName: 'poison-harness',
      shardManager,
    });
  }

  const definitionRef = `inline:${Buffer.from(JSON.stringify(agentDef)).toString('base64')}`;

  async function seedSession(sessionId: string): Promise<void> {
    const state = {
      tenantId: TENANT,
      sessionId,
      target: { kind: 'inline-agent', definitionRef },
      agentVersion: '1.0.0',
      status: 'RUNNING',
      createdBy: 'poison-harness',
      traceId: randomUUID().replaceAll('-', ''),
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    } as unknown as SessionHotState;
    await setSessionState(redis, state);
  }

  interface SeedStepArgs {
    sessionId: string;
    stepExecutionId: string;
    status: 'FAILED' | 'STARTED';
    attempt: number;
  }

  async function seedStep({ sessionId, stepExecutionId, status, attempt }: SeedStepArgs) {
    await updateStepState(redis, TENANT, stepExecutionId, {
      sessionId,
      stepExecutionId,
      tenantId: TENANT,
      stepId: 'work',
      stepType: 'api',
      operationId: 'api.http.call',
      attempt,
      status,
      scheduledAt: Date.now(),
      inputRef: 'inline:e30=',
      idempotencyKey: `${sessionId}:${stepExecutionId}:${String(attempt)}`,
      traceId: randomUUID().replaceAll('-', ''),
    });
  }

  function timer(args: {
    sessionId: string;
    stepExecutionId: string;
    reason: 'retry' | 'timeout';
    attempt: number;
  }): TimerItem {
    return {
      tenantId: TENANT,
      sessionId: args.sessionId,
      stepExecutionId: args.stepExecutionId,
      stepId: 'work',
      operationId: 'api.http.call',
      stepType: 'api',
      reason: args.reason,
      attempt: args.attempt,
      inputRef: 'inline:e30=',
      traceId: randomUUID().replaceAll('-', ''),
      dueAtMs: Date.now() - 5_000,
    } as TimerItem;
  }

  /** Arm the timer already past its redelivery budget: the next claim poisons it. */
  async function armPoisoned(item: TimerItem): Promise<void> {
    await scheduleShardTimer(redis, item);
    const shardId = shardFor(item.sessionId!);
    await redis.hset(
      StreamKeys.shardTimerDataKey(shardId),
      `c:${timerId(item)}`,
      String(TIMER_MAX_CLAIMS),
    );
  }

  async function shardTimerIds(sessionId: string): Promise<string[]> {
    return redis.zrange(StreamKeys.shardTimersKey(shardFor(sessionId)), 0, -1);
  }

  it('a poisoned retry wake consumes the timer attempt and the next retry advances', async () => {
    const sessionId = randomUUID();
    const stepExecutionId = randomUUID();
    await seedSession(sessionId);
    await seedStep({ sessionId, stepExecutionId, status: 'FAILED', attempt: 1 });
    const poisoned = timer({ sessionId, stepExecutionId, reason: 'retry', attempt: 2 });
    await armPoisoned(poisoned);

    await orchestrator(sessionId).processDueTimers();

    const step = await getStepState(redis, TENANT, stepExecutionId);
    expect(step?.status).toBe('FAILED');
    // The disposition consumed attempt 2 — the one the lost wake never
    // dispatched — so the freshly armed retry carries attempt 3.
    expect(step?.attempt).toBe(2);
    const ids = await shardTimerIds(sessionId);
    expect(ids).toContain(`${stepExecutionId}|retry|3|`);
    expect(ids).not.toContain(timerId(poisoned));
  });

  it('a poisoned timeout wake fails the step without a retry', async () => {
    const sessionId = randomUUID();
    const stepExecutionId = randomUUID();
    await seedSession(sessionId);
    await seedStep({ sessionId, stepExecutionId, status: 'STARTED', attempt: 1 });
    const poisoned = timer({ sessionId, stepExecutionId, reason: 'timeout', attempt: 1 });
    await armPoisoned(poisoned);

    await orchestrator(sessionId).processDueTimers();

    const step = await getStepState(redis, TENANT, stepExecutionId);
    expect(step?.status).toBe('FAILED');
    const run = await getSessionState(redis, TENANT, sessionId);
    expect(run?.status).toBe('FAILED');
    const ids = await shardTimerIds(sessionId);
    expect(ids.filter((id) => id.includes('|retry|'))).toHaveLength(0);
    expect(ids).not.toContain(timerId(poisoned));
  });

  it('a redelivery whose step has moved on is acknowledged without touching the step', async () => {
    const sessionId = randomUUID();
    const stepExecutionId = randomUUID();
    await seedSession(sessionId);
    // The step already holds the attempt the timer carries: the disposition
    // for this wake landed once before and its ack was lost.
    await seedStep({ sessionId, stepExecutionId, status: 'FAILED', attempt: 2 });
    const poisoned = timer({ sessionId, stepExecutionId, reason: 'retry', attempt: 2 });
    await armPoisoned(poisoned);

    await orchestrator(sessionId).processDueTimers();

    const step = await getStepState(redis, TENANT, stepExecutionId);
    expect(step?.status).toBe('FAILED');
    expect(step?.attempt).toBe(2);
    const run = await getSessionState(redis, TENANT, sessionId);
    expect(run?.status).toBe('RUNNING');
    expect(await shardTimerIds(sessionId)).not.toContain(timerId(poisoned));
  });
});
