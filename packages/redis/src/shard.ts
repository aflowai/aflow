import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

// ============================================================================
// Constants
// ============================================================================

/**
 * Fixed shard count. Must NEVER change after initial deployment.
 * 128 gives a good balance between granularity and overhead.
 * With 2-4 orchestrator instances, each owns 32-64 shards.
 */
export const SHARD_COUNT = 128;

/** Lease TTL in seconds (matches executor heartbeat pattern) */
export const SHARD_LEASE_TTL_SECONDS = 30;

// ============================================================================
// Hash Function
// ============================================================================

/**
 * Simple but effective string hash (FNV-1a variant).
 * Deterministic, fast, and produces good distribution.
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0; // FNV prime, keep as 32-bit int
  }
  return hash >>> 0; // unsigned
}

/**
 * Compute the shard ID for a given runId.
 * Deterministic: same runId always maps to same shard.
 */
export function shardFor(runId: string): number {
  return fnv1aHash(runId) % SHARD_COUNT;
}

// ============================================================================
// Shard Registry Types
// ============================================================================

export interface ShardLeaseEntry {
  owner: string; // orchestrator instance ID
  leaseVersion: number; // fencing token (incremented on each acquisition)
  leasedAt: number; // epoch ms
  /** Set when the owner released it; the entry stays so a handoff is visible. */
  released?: boolean;
}

// ============================================================================
// Shard Acquisition & Release
// ============================================================================

/**
 * Acquire a shard.
 *
 * The refusal test is "is the *registered owner* alive", not "does some
 * liveness marker exist". Those differ: an instance that lost a shard used to
 * keep refreshing that shard's marker, which made the shard look busy to
 * everyone while its registered owner was dead, and no one could take it.
 * Looking the owner up in the liveness index means a stale renewer can only
 * keep itself alive.
 */
const ACQUIRE_SHARD_LUA = `
local registryKey = KEYS[1]
local fenceKey = KEYS[2]
local livenessKey = KEYS[3]
local legacyHeartbeatKey = KEYS[4]
local shardField = ARGV[1]
local instanceId = ARGV[2]

local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local raw = redis.call('HGET', registryKey, shardField)
if raw and raw ~= '' then
  local ok, entry = pcall(cjson.decode, raw)
  if not ok then
    -- Corrupt entry — treat as unowned, overwritten below.
    redis.call('HDEL', registryKey, shardField)
  elseif entry.owner == instanceId and not entry.released then
    -- Already ours. Returning the existing token keeps re-acquisition
    -- idempotent; incrementing here would invalidate the fencing token this
    -- process is actively writing under.
    return entry.leaseVersion
  elseif not entry.released then
    local score = redis.call('ZSCORE', livenessKey, entry.owner)
    if score and tonumber(score) > nowMs then
      return -1
    end
    -- The owner may be running the per-shard protocol and so be absent from the
    -- index while perfectly alive. Without this a rollout would treat the whole
    -- other fleet as dead and take every shard it holds.
    if redis.call('EXISTS', legacyHeartbeatKey) == 1 then
      return -1
    end
  end
end

local newFence = redis.call('INCR', fenceKey)
redis.call('HSET', registryKey, shardField, cjson.encode({
  owner = instanceId,
  leaseVersion = newFence,
  leasedAt = nowMs
}))
return newFence
`;

/**
 * Attempt to acquire a single shard.
 * Returns the fencing token on success, or -1 if the shard is actively owned.
 */
export async function acquireShard(
  redis: Redis,
  shardId: number,
  instanceId: string,
): Promise<number> {
  const result = await redis.eval(
    ACQUIRE_SHARD_LUA,
    4,
    StreamKeys.shardRegistryKey,
    StreamKeys.shardFenceKey(shardId),
    StreamKeys.orchestratorLivenessKey,
    StreamKeys.legacyShardHeartbeatKey(shardId),
    `shard:${shardId}`,
    instanceId,
  );
  return Number(result);
}

/**
 * Keep the pre-index per-shard markers warm for the shards this process owns.
 *
 * Only so a process still running the per-shard protocol can see that this one
 * is alive. One pipeline, so it costs a single round trip. Delete together with
 * `legacyShardHeartbeatKey` once no deployment can still be running it.
 */
export async function renewLegacyShardHeartbeats(
  redis: Redis,
  instanceId: string,
  shardIds: readonly number[],
): Promise<void> {
  if (shardIds.length === 0) return;
  const pipeline = redis.pipeline();
  const stamp = `${instanceId}:${String(Date.now())}`;
  for (const shardId of shardIds) {
    pipeline.setex(StreamKeys.legacyShardHeartbeatKey(shardId), 30, stamp);
  }
  await pipeline.exec();
}

/** Clear the compatibility markers for shards this process is releasing. */
export async function clearLegacyShardHeartbeats(
  redis: Redis,
  shardIds: readonly number[],
): Promise<void> {
  if (shardIds.length === 0) return;
  await redis.del(...shardIds.map((shardId) => StreamKeys.legacyShardHeartbeatKey(shardId)));
}

/**
 * Acquire as many unleased shards as possible for this instance.
 * Stops early once `maxShards` is reached to avoid acquiring shards
 * that won't be renewed or released by the caller.
 *
 * @param maxShards - Maximum shards to acquire (defaults to SHARD_COUNT).
 * @returns The list of acquired shard IDs with their fencing tokens.
 */
export async function acquireAvailableShards(
  redis: Redis,
  instanceId: string,
  maxShards: number = SHARD_COUNT,
  alreadyOwned: ReadonlySet<number> = new Set(),
): Promise<Array<{ shardId: number; fencingToken: number }>> {
  const acquired: Array<{ shardId: number; fencingToken: number }> = [];

  for (let shardId = 0; shardId < SHARD_COUNT; shardId++) {
    if (acquired.length >= maxShards) break;
    // Shards already held would otherwise consume the free slots, and the loop
    // starts at zero — so after a single revoke the instance would spend its one
    // slot re-acquiring shard 0 and never reach the shard it lost.
    if (alreadyOwned.has(shardId)) continue;
    const fencingToken = await acquireShard(redis, shardId, instanceId);
    if (fencingToken > 0) {
      acquired.push({ shardId, fencingToken });
    }
  }

  return acquired;
}

/**
 * Release one shard, as a fenced registry mutation.
 *
 * Marking the entry released rather than deleting it keeps the owner and
 * fencing token visible, so `validateShardOwnership` can tell "released" from
 * "missing" during the handoff window. Releasing one shard says nothing about
 * the instance's others, and nothing about whether the process is alive — that
 * is the liveness index's job.
 */
const CAS_RELEASE_SHARD_LUA = `
local registryKey = KEYS[1]
local shardField = ARGV[1]
local expectedOwner = ARGV[2]
local expectedFence = tonumber(ARGV[3])

local raw = redis.call('HGET', registryKey, shardField)
if not raw or raw == '' then
  return 1
end

local ok, entry = pcall(cjson.decode, raw)
if not ok then
  return 1
end

if entry.owner == expectedOwner and entry.leaseVersion == expectedFence then
  entry.released = true
  redis.call('HSET', registryKey, shardField, cjson.encode(entry))
  return 1
end

-- A successor already owns it; leaving their entry untouched is the point.
return 0
`;

/**
 * Release shards owned by this instance.
 *
 * CAS on (owner, fencing token) so a release racing a successor's acquisition
 * cannot revoke the successor.
 */
export async function releaseShards(
  redis: Redis,
  instanceId: string,
  shardIds: number[],
  fencingTokens?: Map<number, number>,
): Promise<void> {
  if (shardIds.length === 0) return;

  for (const shardId of shardIds) {
    const fence = fencingTokens?.get(shardId) ?? 0;
    if (fence <= 0) continue;
    await redis.eval(
      CAS_RELEASE_SHARD_LUA,
      1,
      StreamKeys.shardRegistryKey,
      `shard:${shardId}`,
      instanceId,
      String(fence),
    );
  }
}

/**
 * Get current shard ownership map.
 * Returns a Map of shardId → ShardLeaseEntry for all registered shards.
 */
export async function getShardOwnerMap(redis: Redis): Promise<Map<number, ShardLeaseEntry>> {
  const raw = await redis.hgetall(StreamKeys.shardRegistryKey);
  const map = new Map<number, ShardLeaseEntry>();

  for (const [field, value] of Object.entries(raw)) {
    const match = /^shard:(\d+)$/.exec(field);
    if (!match?.[1]) continue;
    const shardId = parseInt(match[1], 10);

    try {
      const entry = JSON.parse(value) as ShardLeaseEntry;
      map.set(shardId, entry);
    } catch {
      // Skip corrupt entries
    }
  }

  return map;
}

/**
 * Get the fencing token for a shard.
 * Used by writers to validate ownership before mutating run state.
 */
export async function getShardFencingToken(redis: Redis, shardId: number): Promise<number> {
  const key = StreamKeys.shardFenceKey(shardId);
  const val = await redis.get(key);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Owner of every registered shard, in one read.
 *
 * Reclaim asks the same question of many shards at once; one HGETALL of a
 * 128-field hash beats one HGET per shard.
 */
export async function getShardOwners(redis: Redis): Promise<Map<number, string>> {
  const owners = new Map<number, string>();
  for (const [shardId, entry] of await getShardOwnerMap(redis)) {
    owners.set(shardId, entry.owner);
  }
  return owners;
}

/**
 * Get the current registry entry for a single shard.
 * Returns undefined if no entry exists (shard is unowned).
 * Used by consumers during immediate handoff on fence rejection.
 */
export async function getShardRegistryEntry(
  redis: Redis,
  shardId: number,
): Promise<ShardLeaseEntry | undefined> {
  const raw = await redis.hget(StreamKeys.shardRegistryKey, `shard:${shardId}`);
  if (!raw) return undefined;

  try {
    return JSON.parse(raw) as ShardLeaseEntry;
  } catch {
    return undefined;
  }
}

/**
 * Validate that this instance still owns a shard (fencing token check).
 * Call before any mutating operation to prevent split-brain writes.
 *
 * Missing registry entry = NOT owned (conservative). The periodic
 * reacquisition cycle (30s) will re-register the shard if appropriate.
 */
export async function validateShardOwnership(
  redis: Redis,
  shardId: number,
  instanceId: string,
  expectedFencingToken: number,
): Promise<boolean> {
  const raw = await redis.hget(StreamKeys.shardRegistryKey, `shard:${shardId}`);
  if (!raw) {
    // No registry entry — treat as NOT owned. This is the conservative choice:
    // a blind HDEL during deploy overlap could have cleared it, or the entry expired.
    // The periodic reacquisition cycle will re-register if appropriate.
    console.warn(
      `[validateShardOwnership] shard ${shardId} REJECTED: registry entry missing ` +
        `(local owner=${instanceId} fence=${String(expectedFencingToken)})`,
    );
    return false;
  }

  try {
    const entry = JSON.parse(raw) as ShardLeaseEntry;
    const ownerMatch = entry.owner === instanceId && entry.released !== true;
    const fenceMatch = entry.leaseVersion === expectedFencingToken;
    if (!ownerMatch || !fenceMatch) {
      console.warn(
        `[validateShardOwnership] shard ${shardId} REJECTED: ` +
          `registry owner=${entry.owner} fence=${String(entry.leaseVersion)} | ` +
          `local owner=${instanceId} fence=${String(expectedFencingToken)}`,
      );
    }
    return ownerMatch && fenceMatch;
  } catch {
    return false;
  }
}

// ============================================================================
// Active-run membership
// ============================================================================

/**
 * Active runs are tracked as SET membership, not a counter.
 *
 * A counter has to be incremented exactly once and decremented exactly once, and
 * this system delivers terminal transitions from several places — applyResult,
 * cancelRun, forceCompleteInFlightStep, pause routing — any of which can run
 * twice after a redelivery. `SADD`/`SREM` of a stable run id are idempotent, so
 * a duplicate simply has no effect.
 *
 * Both sets are written in one Lua call, so a state transition still costs the
 * single round trip the counter did.
 */
/**
 * Members carry their tenant, matching the dirty-session set. Without it a
 * repair pass holding only a run id cannot address that run's session state.
 */
function activeRunMember(tenantId: string, runId: string): string {
  return `${tenantId}:${runId}`;
}

function parseActiveRunMember(member: string): { tenantId: string; runId: string } | null {
  const idx = member.indexOf(':');
  if (idx <= 0 || idx === member.length - 1) return null;
  return { tenantId: member.slice(0, idx), runId: member.slice(idx + 1) };
}

const SET_RUN_ACTIVE_LUA = `
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[2])
return redis.call('SCARD', KEYS[2])
`;

const CLEAR_RUN_ACTIVE_LUA = `
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('SCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[3], ARGV[2])
end
return redis.call('SCARD', KEYS[2])
`;

/**
 * Called when a run enters or re-enters an active state (start, retry).
 * Returns the fleet-wide active count.
 */
export async function markRunActive(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<number> {
  const shardId = shardFor(runId);
  const member = activeRunMember(tenantId, runId);
  const result = await redis.eval(
    SET_RUN_ACTIVE_LUA,
    3,
    StreamKeys.shardActiveRunsKey(shardId),
    StreamKeys.activeRunsKey,
    StreamKeys.activeShardsKey,
    member,
    String(shardId),
  );
  return Number(result);
}

/**
 * Called when a run reaches a terminal state — SUCCEEDED, FAILED, CANCELLED.
 *
 * Not called on pause: a paused run still holds its slot, and its shard stays
 * swept by the recovery pass that keys off this set, which is what lets a
 * resume land promptly.
 */
export async function markRunInactive(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<number> {
  const shardId = shardFor(runId);
  const member = activeRunMember(tenantId, runId);
  const result = await redis.eval(
    CLEAR_RUN_ACTIVE_LUA,
    3,
    StreamKeys.shardActiveRunsKey(shardId),
    StreamKeys.activeRunsKey,
    StreamKeys.activeShardsKey,
    member,
    String(shardId),
  );
  return Number(result);
}

/**
 * Drop active-run members whose session no longer exists in hot state.
 *
 * Membership is maintained by the transitions themselves, so this is drift
 * repair, not the normal path: a process killed between a terminal write and
 * its release leaves a member behind, and nothing else removes it. Bounded by
 * the size of the set and intended for boot and operator use, never a cadence.
 */
export async function reconcileActiveRuns(
  redis: Redis,
): Promise<{ checked: number; removed: number }> {
  const members = await redis.smembers(StreamKeys.activeRunsKey);
  if (members.length === 0) return { checked: 0, removed: 0 };

  const parsed = members.map((member) => ({ member, parts: parseActiveRunMember(member) }));
  const pipeline = redis.pipeline();
  for (const { parts } of parsed) {
    pipeline.exists(parts ? StreamKeys.sessionStateKey(parts.tenantId, parts.runId) : 'aflow:none');
  }
  const results = (await pipeline.exec()) ?? [];

  let removed = 0;
  for (const [i, entry] of parsed.entries()) {
    if (Number(results[i]?.[1] ?? 1) !== 0) continue;
    if (entry.parts) {
      await markRunInactive(redis, entry.parts.tenantId, entry.parts.runId);
    } else {
      await redis.srem(StreamKeys.activeRunsKey, entry.member);
    }
    removed += 1;
  }
  return { checked: members.length, removed };
}

/** Shards holding at least one active run. Empty at idle. */
export async function getActiveShardIds(redis: Redis): Promise<number[]> {
  const members = await redis.smembers(StreamKeys.activeShardsKey);
  return members.map(Number).filter((id) => Number.isInteger(id));
}

/** Active runs on one shard. Diagnostics only — never polled on a cadence. */
export async function getShardActiveRuns(redis: Redis, shardId: number): Promise<number> {
  return redis.scard(StreamKeys.shardActiveRunsKey(shardId));
}

export interface SystemLoad {
  totalActiveRuns: number;
}

/**
 * Fleet-wide active run count for admission control, in one command.
 *
 * Admission is load shedding, not billing, so a briefly conservative count is
 * fine. What is not fine is drift that only grows: a leaked member is never
 * removed by anything on the hot path, and an inflated count turns into a 429
 * against real traffic. `reconcileActiveRuns` is the repair.
 */
export async function getSystemLoad(redis: Redis): Promise<SystemLoad> {
  const totalActiveRuns = await redis.scard(StreamKeys.activeRunsKey);
  return { totalActiveRuns };
}
