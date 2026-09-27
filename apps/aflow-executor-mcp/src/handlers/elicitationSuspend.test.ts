import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  suspendForElicitation,
  outcomeToElicitResult,
  type TimerSeam,
} from './elicitationSuspend.js';
import {
  publishMcpElicitationResponse,
  readMcpElicitationLease,
  acquireMcpElicitationLease,
} from '@aflow/redis';
import type { McpElicitationRequest } from '@aflow/schemas';

function createMockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

function makeRequest(overrides: Partial<McpElicitationRequest> = {}): McpElicitationRequest {
  return {
    mode: 'form',
    elicitationId: 'elic-1',
    message: 'Please confirm',
    requestedSchema: { type: 'object', properties: {} },
    ...overrides,
  } as McpElicitationRequest;
}

class FakeSlot {
  held = true;
  releaseCount = 0;
  acquireCount = 0;
  release(): void {
    if (this.held) {
      this.releaseCount++;
      this.held = false;
    }
  }
  async acquire(): Promise<void> {
    if (!this.held) {
      this.acquireCount++;
      this.held = true;
    }
  }
}

/**
 * Manual timer seam — every test drives time deterministically via
 * `fireTimeout` / `fireInterval`. Keeps the suspend race testable without
 * `vi.useFakeTimers()`, which is fiddly to combine with real ioredis-mock
 * event loops.
 */
function makeManualTimer(): {
  timer: TimerSeam;
  fireTimeouts: () => void;
  fireIntervals: () => Promise<void>;
} {
  const timeouts: Array<{ id: number; fn: () => void; cleared: boolean }> = [];
  const intervals: Array<{ id: number; fn: () => void; cleared: boolean }> = [];
  let nextId = 1;
  const timer: TimerSeam = {
    setTimeout: (fn) => {
      const id = nextId++;
      timeouts.push({ id, fn, cleared: false });
      return id;
    },
    clearTimeout: (handle) => {
      const entry = timeouts.find((t) => t.id === handle);
      if (entry) entry.cleared = true;
    },
    setInterval: (fn) => {
      const id = nextId++;
      intervals.push({ id, fn, cleared: false });
      return id;
    },
    clearInterval: (handle) => {
      const entry = intervals.find((i) => i.id === handle);
      if (entry) entry.cleared = true;
    },
  };
  return {
    timer,
    fireTimeouts: () => {
      for (const t of timeouts) if (!t.cleared) t.fn();
    },
    fireIntervals: async () => {
      for (const i of intervals) if (!i.cleared) i.fn();
      // Heartbeat interval body is async (refresh CAS) — yield so its
      // awaits drain before the test inspects state.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('suspendForElicitation — happy path', () => {
  let redis: RedisType;
  let subscriber: RedisType;

  beforeEach(async () => {
    redis = createMockRedis();
    subscriber = createMockRedis();
    await redis.flushall();
  });

  it('resolves when an accept response arrives on the channel', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();

    const suspendPromise = suspendForElicitation({
      request: makeRequest(),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });

    // Yield once so the suspend handler's setup (lease + publish + subscribe)
    // runs before we publish a response.
    await new Promise((r) => setTimeout(r, 10));

    // While suspended: slot is released, lease is held.
    expect(slot.held).toBe(false);
    expect(slot.releaseCount).toBe(1);
    const leaseDuring = await readMcpElicitationLease(redis, 'elic-1');
    expect(leaseDuring).not.toBeNull();
    expect(leaseDuring!.executorInstanceId).toBe('exec-A');

    publishMcpElicitationResponse(redis, {
      elicitationId: 'elic-1',
      action: 'accept',
      content: { answer: 'yes' },
    });

    const outcome = await suspendPromise;
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.response.action).toBe('accept');
      expect(outcome.response.content).toEqual({ answer: 'yes' });
    }

    // After resume: slot was re-acquired, lease was released.
    expect(slot.held).toBe(true);
    expect(slot.acquireCount).toBe(1);
    expect(await readMcpElicitationLease(redis, 'elic-1')).toBeNull();
  });

  it('outcomeToElicitResult maps an accept outcome with content', () => {
    const result = outcomeToElicitResult({
      kind: 'resolved',
      response: { elicitationId: 'x', action: 'accept', content: { foo: 'bar' } },
    });
    expect(result).toEqual({ action: 'accept', content: { foo: 'bar' } });
  });

  it('outcomeToElicitResult omits content for decline/cancel', () => {
    expect(
      outcomeToElicitResult({
        kind: 'resolved',
        response: { elicitationId: 'x', action: 'decline' },
      }),
    ).toEqual({ action: 'decline' });
  });
});

describe('suspendForElicitation — timeout path', () => {
  let redis: RedisType;
  let subscriber: RedisType;

  beforeEach(async () => {
    redis = createMockRedis();
    subscriber = createMockRedis();
    await redis.flushall();
  });

  it('resolves with `timeout` when the lease TTL fires before a response', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();

    const suspendPromise = suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-timeout' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });

    await new Promise((r) => setTimeout(r, 10));
    // Fire the timeout. Don't fire the heartbeat — that races and would
    // resolve as a successful refresh.
    manual.fireTimeouts();

    const outcome = await suspendPromise;
    expect(outcome.kind).toBe('timeout');
    expect(outcomeToElicitResult(outcome)).toEqual({ action: 'cancel' });

    // Slot back, lease released.
    expect(slot.held).toBe(true);
    expect(await readMcpElicitationLease(redis, 'elic-timeout')).toBeNull();
  });
});

describe('suspendForElicitation — lease conflict', () => {
  let redis: RedisType;
  let subscriber: RedisType;

  beforeEach(async () => {
    redis = createMockRedis();
    subscriber = createMockRedis();
    await redis.flushall();
  });

  it('returns `lease_conflict` without yielding the slot', async () => {
    // Seed a lease held by a different executor.
    await acquireMcpElicitationLease(
      redis,
      {
        elicitationId: 'elic-conflict',
        executorInstanceId: 'exec-OTHER',
        stepExecutionId: 'step-X',
        tenantId: 'tenant-1',
        bindingId: 'kaggle-default',
        serverId: 'kaggle',
      },
      { ttlMs: 60_000 },
    );

    const slot = new FakeSlot();
    const manual = makeManualTimer();

    const outcome = await suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-conflict' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });

    expect(outcome.kind).toBe('lease_conflict');
    expect(outcomeToElicitResult(outcome)).toEqual({ action: 'decline' });
    // Critical: we never released the slot — fast-decline path doesn't
    // touch concurrency budget.
    expect(slot.held).toBe(true);
    expect(slot.releaseCount).toBe(0);
    expect(slot.acquireCount).toBe(0);
  });
});

describe('suspendForElicitation — lease lost during wait', () => {
  let redis: RedisType;
  let subscriber: RedisType;

  beforeEach(async () => {
    redis = createMockRedis();
    subscriber = createMockRedis();
    await redis.flushall();
  });

  it('resolves with `lease_lost` when heartbeat CAS fails', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();

    const suspendPromise = suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-lost' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Simulate lease loss: delete the key behind our back.
    await redis.del('aflow:mcp:elicitation:lease:elic-lost');

    // Fire the heartbeat — CAS will return 0, suspend resolves as lost.
    await manual.fireIntervals();

    const outcome = await suspendPromise;
    expect(outcome.kind).toBe('lease_lost');
    expect(outcomeToElicitResult(outcome)).toEqual({ action: 'cancel' });
  });
});

describe('suspendForElicitation — subscribe-before-publish ordering', () => {
  let redis: RedisType;
  let subscriber: RedisType;

  beforeEach(async () => {
    redis = createMockRedis();
    subscriber = createMockRedis();
    await redis.flushall();
  });

  it('catches a response that arrives during the subscribe-then-publish window', async () => {
    // Simulate a fast-path orchestrator: publish the response *immediately*
    // when the request envelope hits the wire. Before the fix this raced
    // the SUBSCRIBE round-trip and produced a 15-minute hang.
    const slot = new FakeSlot();
    const manual = makeManualTimer();

    // Hook the publisher: as soon as the request envelope is published,
    // turn around and publish the response on the same Redis instance.
    // (subscriber is a peer mock instance sharing the EventEmitter bus.)
    const originalPublish = redis.publish.bind(redis);
    redis.publish = ((channel: string, message: string) => {
      const result = originalPublish(channel, message);
      if (channel.startsWith('aflow:pubsub:mcp-elicitation-request:')) {
        // Fire the response back synchronously (microtask). This is the
        // tightest possible race with subscribe(elicitationId).
        queueMicrotask(() => {
          publishMcpElicitationResponse(redis, {
            elicitationId: 'elic-fast',
            action: 'accept',
            content: { quick: 'yes' },
          });
        });
      }
      return result;
    }) as typeof redis.publish;

    const outcome = await suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-fast' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.response.action).toBe('accept');
      expect(outcome.response.content).toEqual({ quick: 'yes' });
    }
  });

  it('returns lease_lost when subscribe setup throws', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();

    // Force subscribe() to throw on the dedicated subscriber.
    (subscriber as { subscribe: (...args: unknown[]) => Promise<unknown> }).subscribe = () =>
      Promise.reject(new Error('redis subscriber down'));

    const outcome = await suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-subfail' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });
    expect(outcome.kind).toBe('lease_lost');
    // Slot must still be returned + lease released even on early-bail path.
    expect(slot.held).toBe(true);
    expect(await readMcpElicitationLease(redis, 'elic-subfail')).toBeNull();
  });
});

describe('suspendForElicitation — tenant scoping', () => {
  let redis: RedisType;
  let subscriber: RedisType;

  beforeEach(async () => {
    redis = createMockRedis();
    subscriber = createMockRedis();
    await redis.flushall();
  });

  it('ignores responses with a mismatched tenantId and waits for the right one', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();

    const suspendPromise = suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-tenant' }),
      tenantId: 'tenant-EXPECTED',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });

    await new Promise((r) => setTimeout(r, 10));
    // Wrong tenant — must be ignored.
    publishMcpElicitationResponse(redis, {
      elicitationId: 'elic-tenant',
      action: 'accept',
      content: { stolen: 'yes' },
      tenantId: 'tenant-OTHER',
    });
    // Correct tenant.
    await new Promise((r) => setTimeout(r, 10));
    publishMcpElicitationResponse(redis, {
      elicitationId: 'elic-tenant',
      action: 'accept',
      content: { rightful: 'yes' },
      tenantId: 'tenant-EXPECTED',
    });

    const outcome = await suspendPromise;
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind === 'resolved') {
      expect(outcome.response.content).toEqual({ rightful: 'yes' });
    }
  });

  it('accepts responses without tenantId (legacy publishers)', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();

    const suspendPromise = suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-legacy' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });
    await new Promise((r) => setTimeout(r, 10));
    // Legacy publisher omits tenantId.
    publishMcpElicitationResponse(redis, {
      elicitationId: 'elic-legacy',
      action: 'accept',
    });
    const outcome = await suspendPromise;
    expect(outcome.kind).toBe('resolved');
  });
});

describe('suspendForElicitation — pool abort registry', () => {
  let redis: RedisType;
  let subscriber: RedisType;

  beforeEach(async () => {
    redis = createMockRedis();
    subscriber = createMockRedis();
    await redis.flushall();
  });

  it('settles with lease_lost when the pool fires the registered aborter', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();
    const aborters = new Set<() => void>();

    const suspendPromise = suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-pool-abort' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
      abortRegistry: aborters,
    });

    // Let the suspend complete its setup so an aborter is registered.
    await new Promise((r) => setTimeout(r, 10));
    expect(aborters.size).toBe(1);

    // Simulate pool eviction firing all aborters.
    for (const fn of aborters) fn();

    const outcome = await suspendPromise;
    expect(outcome.kind).toBe('lease_lost');
    // Aborter was removed in the suspend's finally.
    expect(aborters.size).toBe(0);
    // Slot back, lease released.
    expect(slot.held).toBe(true);
    expect(await readMcpElicitationLease(redis, 'elic-pool-abort')).toBeNull();
  });

  it('removes aborter on normal resolve (no leak)', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();
    const aborters = new Set<() => void>();

    const suspendPromise = suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-clean' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
      abortRegistry: aborters,
    });
    await new Promise((r) => setTimeout(r, 10));
    publishMcpElicitationResponse(redis, {
      elicitationId: 'elic-clean',
      action: 'accept',
    });
    await suspendPromise;
    expect(aborters.size).toBe(0);
  });
});

describe('suspendForElicitation — slot management', () => {
  let redis: RedisType;
  let subscriber: RedisType;

  beforeEach(async () => {
    redis = createMockRedis();
    subscriber = createMockRedis();
    await redis.flushall();
  });

  it('works without a slot controller (caller has none)', async () => {
    const manual = makeManualTimer();
    const suspendPromise = suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-noslot' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      // No slotController.
      timer: manual.timer,
    });
    await new Promise((r) => setTimeout(r, 10));
    publishMcpElicitationResponse(redis, {
      elicitationId: 'elic-noslot',
      action: 'decline',
    });
    const outcome = await suspendPromise;
    expect(outcome.kind).toBe('resolved');
  });

  it('releases + re-acquires the slot exactly once even on timeout', async () => {
    const slot = new FakeSlot();
    const manual = makeManualTimer();

    const suspendPromise = suspendForElicitation({
      request: makeRequest({ elicitationId: 'elic-once' }),
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      stepExecutionId: 'step-1',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      executorInstanceId: 'exec-A',
      leaseTtlMs: 60_000,
      redis,
      redisSubscriber: subscriber,
      slotController: slot,
      timer: manual.timer,
    });
    await new Promise((r) => setTimeout(r, 10));
    manual.fireTimeouts();
    await suspendPromise;
    expect(slot.releaseCount).toBe(1);
    expect(slot.acquireCount).toBe(1);
  });
});
