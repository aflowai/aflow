import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { createMcpElicitationReconciler } from '../mcpElicitationReconciler.js';
import {
  acquireMcpElicitationLease,
  setMcpElicitationRequest,
  registerExecutorHeartbeat,
  readMcpElicitationLease,
  getMcpElicitationRequest,
  mcpElicitationCandidateMember,
  MCP_ELICITATION_RECHECK_MS,
} from '@aflow/redis';
import { StreamKeys } from '@aflow/schemas';

function mockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

const TENANT = '00000000-0000-0000-0000-000000000001';

async function seedLease(
  redis: RedisType,
  args: {
    elicitationId: string;
    executorInstanceId: string;
    sessionId?: string;
    keepHeartbeat?: boolean;
  },
): Promise<void> {
  await acquireMcpElicitationLease(
    redis,
    {
      elicitationId: args.elicitationId,
      executorInstanceId: args.executorInstanceId,
      stepExecutionId: `step-${args.elicitationId}`,
      tenantId: TENANT,
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    },
    { ttlMs: 900_000 },
  );
  await setMcpElicitationRequest(
    redis,
    {
      mode: 'form',
      elicitationId: args.elicitationId,
      message: 'pick',
      requestedSchema: { type: 'object', properties: {} },
    },
    {
      tenantId: TENANT,
      stepExecutionId: `step-${args.elicitationId}`,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    },
    900_000,
  );
  if (args.keepHeartbeat) {
    await registerExecutorHeartbeat(redis, 'mcp', args.executorInstanceId);
  }
}

/** Move past the re-check interval so armed candidates come due. */
function advanceToRecheck(): void {
  vi.setSystemTime(Date.now() + MCP_ELICITATION_RECHECK_MS + 1000);
}

async function indexedMembers(redis: RedisType): Promise<string[]> {
  return redis.zrange(StreamKeys.mcpElicitationLeaseCandidatesKey, 0, -1);
}

describe('createMcpElicitationReconciler', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = mockRedis();
    await redis.flushall();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finds nothing while every lease is inside its re-check interval', async () => {
    await seedLease(redis, {
      elicitationId: 'elic-fresh',
      executorInstanceId: 'exec-DEAD',
      sessionId: 'session-1',
    });

    const reconciler = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    const result = await reconciler.sweepOnce();
    expect(result.candidates).toBe(0);
    expect(await readMcpElicitationLease(redis, 'elic-fresh')).not.toBeNull();
  });

  it('skips leases whose holder is still heartbeating and pushes them forward', async () => {
    await seedLease(redis, {
      elicitationId: 'elic-alive',
      executorInstanceId: 'exec-A',
      sessionId: 'session-1',
      keepHeartbeat: true,
    });
    advanceToRecheck();

    const reconciler = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    const result = await reconciler.sweepOnce();
    expect(result.candidates).toBe(1);
    expect(result.processed).toBe(0);

    expect(await readMcpElicitationLease(redis, 'elic-alive')).not.toBeNull();
    expect(await getMcpElicitationRequest(redis, TENANT, 'elic-alive')).not.toBeNull();

    // Pushed forward rather than consumed: the next cycle must not re-read it.
    const second = await reconciler.sweepOnce();
    expect(second.candidates).toBe(0);
  });

  it('reaps a lease whose holder heartbeat is missing and emits ExecutorLost on the session stream', async () => {
    await seedLease(redis, {
      elicitationId: 'elic-dead',
      executorInstanceId: 'exec-DEAD',
      sessionId: 'session-1',
    });
    advanceToRecheck();

    const reconciler = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    const result = await reconciler.sweepOnce();
    expect(result.processed).toBe(1);

    expect(await readMcpElicitationLease(redis, 'elic-dead')).toBeNull();
    expect(await getMcpElicitationRequest(redis, TENANT, 'elic-dead')).toBeNull();
    expect(await indexedMembers(redis)).toEqual([]);

    const events = await redis.xrange(
      StreamKeys.sessionEventsStream(TENANT, 'session-1'),
      '-',
      '+',
    );
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1]![1] as string[];
    const obj: Record<string, string> = {};
    for (let i = 0; i < last.length; i += 2) obj[last[i]!] = last[i + 1]!;
    expect(obj['eventType']).toBe('McpElicitationExecutorLost');
  });

  it('reaps a sessionless lease but does not emit a session event (no UI surface)', async () => {
    await seedLease(redis, {
      elicitationId: 'elic-workflow',
      executorInstanceId: 'exec-DEAD',
    });
    advanceToRecheck();

    const reconciler = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    const result = await reconciler.sweepOnce();
    expect(result.processed).toBe(1);
    expect(await readMcpElicitationLease(redis, 'elic-workflow')).toBeNull();
    const events = await redis.xrange(StreamKeys.sessionEventsStream(TENANT, ''), '-', '+');
    expect(events.length).toBe(0);
  });

  it('handles a mix of alive + dead leases in one cycle', async () => {
    await seedLease(redis, {
      elicitationId: 'elic-alive',
      executorInstanceId: 'exec-A',
      sessionId: 'session-1',
      keepHeartbeat: true,
    });
    await seedLease(redis, {
      elicitationId: 'elic-dead-1',
      executorInstanceId: 'exec-DEAD-1',
      sessionId: 'session-1',
    });
    await seedLease(redis, {
      elicitationId: 'elic-dead-2',
      executorInstanceId: 'exec-DEAD-2',
      sessionId: 'session-2',
    });
    advanceToRecheck();

    const reconciler = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    const result = await reconciler.sweepOnce();
    expect(result.candidates).toBe(3);
    expect(result.processed).toBe(2);
    expect(await readMcpElicitationLease(redis, 'elic-alive')).not.toBeNull();
    expect(await readMcpElicitationLease(redis, 'elic-dead-1')).toBeNull();
    expect(await readMcpElicitationLease(redis, 'elic-dead-2')).toBeNull();
  });

  it('drops a candidate whose lease is gone rather than re-reading it forever', async () => {
    await seedLease(redis, {
      elicitationId: 'elic-vanished',
      executorInstanceId: 'exec-DEAD',
      sessionId: 'session-1',
    });
    await redis.del(StreamKeys.mcpElicitationLeaseKey('elic-vanished'));
    advanceToRecheck();

    const reconciler = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    const result = await reconciler.sweepOnce();
    expect(result.processed).toBe(0);
    expect(await indexedMembers(redis)).toEqual([]);
  });

  it('leaves the lease alone when a peer re-acquired it under its own member', async () => {
    // The stale member names a holder that is gone; the live lease belongs to
    // someone else. Reaping on the stale member's authority would delete a
    // lease whose holder is alive and answering.
    await seedLease(redis, {
      elicitationId: 'elic-rebound',
      executorInstanceId: 'exec-NEW',
      sessionId: 'session-1',
      keepHeartbeat: true,
    });
    await redis.zadd(
      StreamKeys.mcpElicitationLeaseCandidatesKey,
      '0',
      mcpElicitationCandidateMember('exec-OLD', 'elic-rebound'),
    );
    advanceToRecheck();

    const reconciler = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    await reconciler.sweepOnce();
    expect(await readMcpElicitationLease(redis, 'elic-rebound')).not.toBeNull();
    expect(await indexedMembers(redis)).toEqual([
      mcpElicitationCandidateMember('exec-NEW', 'elic-rebound'),
    ]);
  });

  it('does not run a second time on a candidate another instance already claimed', async () => {
    await seedLease(redis, {
      elicitationId: 'elic-contended',
      executorInstanceId: 'exec-DEAD',
      sessionId: 'session-1',
    });
    advanceToRecheck();

    const first = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    const second = createMcpElicitationReconciler({ redis, intervalMs: 999_999 });
    const [a, b] = await Promise.all([first.sweepOnce(), second.sweepOnce()]);
    expect((a.processed ?? 0) + (b.processed ?? 0)).toBe(1);
  });
});
