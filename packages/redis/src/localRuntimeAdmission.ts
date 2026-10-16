/**
 * Admission to a model runtime on the operator's machine (Plan 323 D7).
 *
 * The runtime serves `limit` requests at once whoever sends them: the AI
 * executor, the API server and the memory embedder each reach it, under
 * whichever credential named it. So the limit lives here, keyed by the
 * runtime rather than by a credential or a process, and every caller takes a
 * lease from it.
 *
 * A lease is a holder with an expiry its holder renews. A holder that dies
 * stops renewing and its lease lapses on the next attempt anyone makes — no
 * sweep. Waiters queue in arrival order and keep their place only while they
 * keep asking, so a waiter that died does not block the queue either.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const KEY_PREFIX = 'aflow:local-runtime';
/** Long enough that a renewal missed to a GC pause or a slow round trip does not drop a live holder. */
export const RUNTIME_LEASE_TTL_MS = 30_000;
/** A third of the lease, so two renewals can be lost before it lapses. */
export const RUNTIME_LEASE_RENEW_MS = 10_000;
/**
 * How often a waiter asks again. A local request runs for seconds to minutes,
 * so half a second of slack after a release is noise next to it.
 */
export const RUNTIME_LEASE_POLL_MS = 500;

function runtimeKeys(runtimeId: string): [string, string, string] {
  // One hash tag, so the three keys a script touches share a cluster slot.
  const base = `${KEY_PREFIX}:{${runtimeId}}`;
  return [`${base}:holders`, `${base}:queue`, `${base}:waiting`];
}

/**
 * KEYS: holders (zset id → expiry), queue (zset id → arrival), waiting (zset id → expiry)
 * ARGV: id, limit, now, ttl, arrival
 * Returns 1 when `id` holds a lease after the call, 0 when it waits.
 */
const ACQUIRE = `
local holders, queue, waiting = KEYS[1], KEYS[2], KEYS[3]
local id, limit, now, ttl, arrival = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', holders, '-inf', now)
local dead = redis.call('ZRANGEBYSCORE', waiting, '-inf', now)
for _, d in ipairs(dead) do
  redis.call('ZREM', queue, d)
  redis.call('ZREM', waiting, d)
end
local expiry = now + ttl
if redis.call('ZSCORE', holders, id) then
  redis.call('ZADD', holders, expiry, id)
  return 1
end
redis.call('ZADD', queue, 'NX', arrival, id)
redis.call('ZADD', waiting, expiry, id)
local free = limit - redis.call('ZCARD', holders)
local granted = 0
if free > 0 then
  local rank = redis.call('ZRANK', queue, id)
  if rank and rank < free then
    redis.call('ZREM', queue, id)
    redis.call('ZREM', waiting, id)
    redis.call('ZADD', holders, expiry, id)
    granted = 1
  end
end
for _, k in ipairs({holders, queue, waiting}) do
  redis.call('PEXPIRE', k, ttl * 2)
end
return granted
`;

const RENEW = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
  return 1
end
return 0
`;

const RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

export interface RuntimeLease {
  /** Give the lease back. Idempotent. */
  release(): Promise<void>;
}

export interface AcquireRuntimeLeaseInput {
  redis: Redis;
  runtimeId: string;
  limit: number;
  /** Unique per request, e.g. a step execution id with its attempt. */
  holderId: string;
  /** Wait for a lease; without it a busy runtime answers null at once. */
  wait: boolean;
  signal?: AbortSignal | undefined;
  /** Called once, when the request first has to wait. */
  onWaiting?: (() => void) | undefined;
  /** Called on every attempt while waiting, so the caller can show it is alive. */
  onStillWaiting?: (() => void) | undefined;
}

export class RuntimeLeaseAbortedError extends Error {
  constructor() {
    super('Waiting for the local model runtime was cancelled.');
    this.name = 'RuntimeLeaseAbortedError';
  }
}

async function attempt(input: AcquireRuntimeLeaseInput, arrival: number): Promise<boolean> {
  const granted = await input.redis.eval(
    ACQUIRE,
    3,
    ...runtimeKeys(input.runtimeId),
    input.holderId,
    String(input.limit),
    String(Date.now()),
    String(RUNTIME_LEASE_TTL_MS),
    String(arrival),
  );
  return granted === 1;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RuntimeLeaseAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RuntimeLeaseAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function release(redis: Redis, runtimeId: string, holderId: string): Promise<void> {
  await redis.eval(RELEASE, 3, ...runtimeKeys(runtimeId), holderId);
}

/**
 * Take a lease on a runtime, waiting in arrival order when it is busy and
 * `wait` is set. Returns null only when `wait` is false and the runtime is
 * busy. A cancelled wait leaves the queue and throws `RuntimeLeaseAbortedError`.
 */
export async function acquireRuntimeLease(
  input: AcquireRuntimeLeaseInput,
): Promise<RuntimeLease | null> {
  const arrival = Date.now();
  let granted = await attempt(input, arrival);
  if (!granted && !input.wait) {
    await release(input.redis, input.runtimeId, input.holderId);
    return null;
  }
  if (!granted) {
    input.onWaiting?.();
    try {
      while (!granted) {
        await sleep(RUNTIME_LEASE_POLL_MS, input.signal);
        input.onStillWaiting?.();
        granted = await attempt(input, arrival);
      }
    } catch (error) {
      await release(input.redis, input.runtimeId, input.holderId).catch(() => undefined);
      throw error;
    }
  }

  const renewal = setInterval(() => {
    void input.redis
      .eval(
        RENEW,
        1,
        runtimeKeys(input.runtimeId)[0],
        input.holderId,
        String(Date.now() + RUNTIME_LEASE_TTL_MS),
        String(RUNTIME_LEASE_TTL_MS),
      )
      .catch(() => undefined);
  }, RUNTIME_LEASE_RENEW_MS);
  renewal.unref();

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(renewal);
      await release(input.redis, input.runtimeId, input.holderId).catch(() => undefined);
    },
  };
}

/**
 * Admission for a caller outside a step — a title, a judge — as a function
 * of the runtime and its limit. `wait: false` is for work that would rather
 * be retried later than queue behind an agent turn for minutes.
 */
export function runtimeAdmission(
  redis: Redis,
  options: { wait: boolean },
): (runtimeId: string, limit: number) => Promise<RuntimeLease | null> {
  return (runtimeId, limit) =>
    acquireRuntimeLease({ redis, runtimeId, limit, holderId: randomUUID(), wait: options.wait });
}
