import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

/**
 * Which orchestrator processes are alive, as one bounded sorted set: member is
 * the instance id, score is when its lease expires.
 *
 * This is deliberately separate from the shard registry, which answers a
 * different question. The registry says *who owns each shard*; this says *which
 * processes are alive*. Conflating them — a per-shard key that any holder could
 * refresh — let an instance keep a shard's liveness marker warm after it had
 * lost that shard, so acquisition saw "someone is alive here" and refused to
 * hand the shard to anyone, indefinitely, while the registered owner was dead.
 * Acquisition now looks up the *registered owner's* liveness, so a stale
 * renewer can only keep itself alive, never someone else's claim.
 *
 * One write per live process per interval, so the cost is O(live instances) and
 * independent of how many shards each holds.
 */

/** Lease window. A process that misses this many ms of heartbeats is treated as gone. */
export const INSTANCE_LEASE_TTL_MS = 30_000;

/**
 * Expiry is computed from Redis' clock, not the caller's.
 *
 * Instances compare their own lease against another instance's, and a few
 * seconds of clock skew between two machines is enough to declare a healthy
 * owner dead or a dead one alive. One clock removes the question.
 */
const NOW_MS_LUA = `
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

const HEARTBEAT_LUA = `
${NOW_MS_LUA}
redis.call('ZADD', KEYS[1], nowMs + tonumber(ARGV[2]), ARGV[1])
-- Opportunistic: keeps the set bounded by live processes rather than by every
-- instance id the deployment has ever used.
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', nowMs)
return 1
`;

/** Renew this process's liveness. Call every ~10s; the lease is 30s. */
export async function registerOrchestratorHeartbeat(
  redis: Redis,
  instanceId: string,
): Promise<void> {
  await redis.eval(
    HEARTBEAT_LUA,
    1,
    StreamKeys.orchestratorLivenessKey,
    instanceId,
    String(INSTANCE_LEASE_TTL_MS),
  );
}

/**
 * Drop this process's liveness on shutdown.
 *
 * Only its own member: the previous single shared key meant one instance
 * stopping deleted the fleet's liveness, and the server watchdog then reported
 * every orchestrator offline while the rest were healthy.
 */
export async function unregisterOrchestratorHeartbeat(
  redis: Redis,
  instanceId: string,
): Promise<void> {
  await redis.zrem(StreamKeys.orchestratorLivenessKey, instanceId);
}

const ANY_ALIVE_LUA = `
${NOW_MS_LUA}
return redis.call('ZCOUNT', KEYS[1], nowMs, '+inf')
`;

/** Is any orchestrator alive? Used by the server's queued-run watchdog. */
export async function isOrchestratorAlive(redis: Redis): Promise<boolean> {
  const alive = await redis.eval(ANY_ALIVE_LUA, 1, StreamKeys.orchestratorLivenessKey);
  return Number(alive) > 0;
}

const INSTANCE_ALIVE_LUA = `
${NOW_MS_LUA}
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then return 0 end
if tonumber(score) <= nowMs then return 0 end
return 1
`;

/** Is one named instance alive? The question shard acquisition actually asks. */
export async function isInstanceAlive(redis: Redis, instanceId: string): Promise<boolean> {
  const alive = await redis.eval(
    INSTANCE_ALIVE_LUA,
    1,
    StreamKeys.orchestratorLivenessKey,
    instanceId,
  );
  return Number(alive) === 1;
}

const LIVE_INSTANCES_LUA = `
${NOW_MS_LUA}
return redis.call('ZRANGEBYSCORE', KEYS[1], nowMs, '+inf')
`;

/**
 * Live instance ids, freshest lease last. Uses Redis' clock like every other
 * read here — comparing server-stamped scores against the caller's clock is the
 * skew this file exists to avoid.
 */
export async function listLiveOrchestrators(redis: Redis): Promise<string[]> {
  const members = await redis.eval(LIVE_INSTANCES_LUA, 1, StreamKeys.orchestratorLivenessKey);
  return Array.isArray(members) ? (members as string[]) : [];
}
