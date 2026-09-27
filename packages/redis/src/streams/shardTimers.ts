import type { Redis } from 'ioredis';
import { TimerItemSchema, StreamKeys, type TimerItem } from '@aflow/schemas';
import { shardFor } from '../shard.js';

/**
 * Shard timers, indexed by a global due-shard ZSET and claimed under a lease.
 *
 * Two properties this layout exists for:
 *
 * 1. **Idle cost is one command, not one per shard.** `dueShardsKey` holds at
 *    most one member per logical shard, scored by that shard's earliest timer,
 *    so the drain asks "which shards have something due?" once per second
 *    instead of asking all 128 individually.
 * 2. **A claim is not a destructive pop.** Claiming advances the timer's score
 *    to a lease deadline and leaves the payload in place, so a worker that dies
 *    between popping and dispatching no longer silently loses the timer — it
 *    becomes due again when the lease expires.
 */

/** Default claim lease. A crashed claimant's timers become due again after this. */
export const TIMER_LEASE_MS = 60_000;

/**
 * A timer redelivered this many times without being acknowledged is poison —
 * something about it makes the handler die rather than fail. It stops being
 * handed to the handler and is instead surfaced for a terminal disposition,
 * staying leased until the caller acknowledges that the disposition landed.
 * Past twice this cap the disposition itself is what keeps failing, and the
 * caller archives the payload to the durable dead-letter table instead. The
 * claim never deletes: every payload is the only copy of its owed wake, an
 * unparseable one is archivable as raw text, and retirement is always an
 * acknowledged archive rather than a drop.
 */
export const TIMER_MAX_CLAIMS = 5;

/** Timers claimed from one shard per cycle. Per shard, so no shard can starve another. */
export const TIMER_CLAIM_PER_SHARD = 100;

/** Ceiling on one cycle's reply, so a fleet-wide backlog cannot produce an unbounded batch. */
export const TIMER_CLAIM_MAX_TOTAL = 1000;

export function timerShardKey(timer: TimerItem): string {
  // Schema invariant guarantees one of the two; the non-null assertion is safe.
  return timer.sessionId ?? timer.workflowExecution!.runId;
}

/**
 * Stable identity for a timer, so rescheduling the same wake-up upserts rather
 * than accumulating a second copy. `dispatchAttemptToken` is what keeps
 * successive workflow poll cycles distinct — they share a task and attempt but
 * never a token.
 */
export function timerId(timer: TimerItem): string {
  const token = timer.workflowExecution?.dispatchAttemptToken ?? '';
  return `${timer.stepExecutionId}|${timer.reason}|${String(timer.attempt)}|${token}`;
}

/**
 * Upsert the timer and refresh its shard's entry in the global due index.
 *
 * One EVAL replaces the single ZADD this used to be: the producer's round-trip
 * count is unchanged, which is the §2.3 budget every candidate index must meet.
 */
const SCHEDULE_TIMER_LUA = `
local timersKey = KEYS[1]
local dataKey = KEYS[2]
local dueShardsKey = KEYS[3]
local id = ARGV[1]
local dueAtMs = tonumber(ARGV[2])
local payload = ARGV[3]
local shardId = ARGV[4]

redis.call('ZADD', timersKey, dueAtMs, id)
redis.call('HSET', dataKey, 'd:' .. id, payload)
-- A fresh arming is a fresh redelivery budget. Retry timers re-arm under the
-- same id after each attempt; a counter inherited from a poisoned predecessor
-- would poison the new wake on arrival and dead-letter it undelivered.
redis.call('HDEL', dataKey, 'c:' .. id)

local earliest = redis.call('ZRANGE', timersKey, 0, 0, 'WITHSCORES')
if earliest[2] then
  redis.call('ZADD', dueShardsKey, earliest[2], shardId)
end
return 1
`;

export async function scheduleShardTimer(redis: Redis, timer: TimerItem): Promise<void> {
  const validatedTimer = TimerItemSchema.parse(timer);
  const shardId = shardFor(timerShardKey(validatedTimer));

  await redis.eval(
    SCHEDULE_TIMER_LUA,
    3,
    StreamKeys.shardTimersKey(shardId),
    StreamKeys.shardTimerDataKey(shardId),
    StreamKeys.dueShardsKey,
    timerId(validatedTimer),
    String(validatedTimer.dueAtMs),
    JSON.stringify(validatedTimer),
    String(shardId),
  );
}

/**
 * Claim due timers for the shards this instance owns.
 *
 * The whole drain is one Lua call. Shards the caller does not own keep their
 * due-index entry untouched so their real owner still sees them; the bounded
 * membership read is the only cost of skipping them.
 *
 * The budget is per shard, with a separate cap on the whole reply. A single
 * shared budget would let one shard's backlog consume the entire batch — and
 * because due shards are visited earliest-first, the same backlogged shard
 * would lead every tick and starve the rest indefinitely, holding up the retry
 * and delayed-start timers that resume live sessions.
 */
const CLAIM_TIMERS_LUA = `
local dueShardsKey = KEYS[1]
local nowMs = tonumber(ARGV[1])
local perShardLimit = tonumber(ARGV[2])
local leaseUntilMs = tonumber(ARGV[3])
local maxClaims = tonumber(ARGV[4])
local keyPrefix = ARGV[5]
local timersSuffix = ARGV[6]
local dataSuffix = ARGV[7]
local maxTotal = tonumber(ARGV[8])

local owned = {}
for i = 9, #ARGV do
  owned[ARGV[i]] = true
end

local dueShards = redis.call('ZRANGEBYSCORE', dueShardsKey, '-inf', nowMs)
local claimed = {}
local dropped = {}
local legacy = 0
local total = 0

for _, shardId in ipairs(dueShards) do
  if total >= maxTotal then break end
  if owned[shardId] then
    local timersKey = keyPrefix .. shardId .. timersSuffix
    local dataKey = keyPrefix .. shardId .. dataSuffix
    local budget = perShardLimit
    if maxTotal - total < budget then budget = maxTotal - total end
    local ids = redis.call('ZRANGEBYSCORE', timersKey, '-inf', nowMs, 'LIMIT', 0, budget)

    for _, id in ipairs(ids) do
      local payload = redis.call('HGET', dataKey, 'd:' .. id)
      if not payload and string.sub(id, 1, 1) == '{' then
        -- Written before timer ids existed, when the member WAS the payload.
        -- Left alone rather than dropped: migrateLegacyShardTimers converts it
        -- using the same id derivation the producers use, and deleting a live
        -- retry or delegation timeout here would be silent, unrecoverable loss.
        legacy = legacy + 1
      elseif not payload then
        -- No payload and not a legacy member: nothing to dispatch.
        redis.call('ZREM', timersKey, id)
        redis.call('HDEL', dataKey, 'c:' .. id)
      else
        local claims = redis.call('HINCRBY', dataKey, 'c:' .. id, 1)
        if claims > maxClaims then
          -- Poison keeps its lease, whatever the payload's shape: the caller
          -- owes it a terminal disposition — or a durable archive, which can
          -- store even an unparseable payload as raw text — and deleting here
          -- would destroy the only copy before either lands. The claim never
          -- deletes; retirement is always an acknowledged archive.
          redis.call('ZADD', timersKey, leaseUntilMs, id)
          dropped[#dropped + 1] = payload
          dropped[#dropped + 1] = claims
          dropped[#dropped + 1] = shardId
          dropped[#dropped + 1] = id
        else
          redis.call('ZADD', timersKey, leaseUntilMs, id)
          claimed[#claimed + 1] = payload
        end
      end
      total = total + 1
    end

    local earliest = redis.call('ZRANGE', timersKey, 0, 0, 'WITHSCORES')
    if earliest[2] then
      redis.call('ZADD', dueShardsKey, earliest[2], shardId)
    else
      redis.call('ZREM', dueShardsKey, shardId)
    end
  end
end

return { claimed, dropped, legacy }
`;

export interface ClaimedTimers {
  /** Timers leased to the caller. Each must be acknowledged or rescheduled. */
  timers: TimerItem[];
  /**
   * Timers past `TIMER_MAX_CLAIMS` redeliveries, each with its claim count.
   * Leased like a claim, never dropped: the caller establishes a terminal
   * disposition — or, past twice the cap, archives the payload durably — and
   * acknowledges. The claim count is what routes between the two.
   */
  poisoned: Array<{ timer: TimerItem; claims: number }>;
  /**
   * Poisoned payloads that decode as JSON but no longer match the schema —
   * vintage drift the claim cannot repair. Surfaced with the storage identity
   * so the caller can archive the raw payload and acknowledge by id; silently
   * omitting them left entries nothing could ever retire.
   */
  malformedPoisoned: Array<{ raw: string; claims: number; shardId: number; timerId: string }>;
  /** Deadline the claimed timers are leased until; pass it back when acknowledging. */
  leaseUntilMs: number;
  /** Claimed timers still stored in the pre-id format. Non-zero means a rollout is draining. */
  legacyClaimed: number;
  /**
   * Age in ms of the oldest timer claimed this cycle, or 0 when nothing was
   * due — the recovery-objective signal for this index.
   */
  oldestDueAgeMs: number;
}

function parseTimers(raw: unknown): TimerItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TimerItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    try {
      const parsed = TimerItemSchema.safeParse(JSON.parse(item));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A payload that no longer parses cannot be dispatched; the claim that
      // produced it already advanced past it.
    }
  }
  return out;
}

function parsePoisoned(raw: unknown): {
  poisoned: Array<{ timer: TimerItem; claims: number }>;
  malformedPoisoned: Array<{ raw: string; claims: number; shardId: number; timerId: string }>;
} {
  const poisoned: Array<{ timer: TimerItem; claims: number }> = [];
  const malformedPoisoned: Array<{
    raw: string;
    claims: number;
    shardId: number;
    timerId: string;
  }> = [];
  if (!Array.isArray(raw)) return { poisoned, malformedPoisoned };
  for (let i = 0; i + 3 < raw.length; i += 4) {
    const item: unknown = raw[i];
    if (typeof item !== 'string') continue;
    const claims = Number(raw[i + 1]);
    try {
      const parsed = TimerItemSchema.safeParse(JSON.parse(item));
      if (parsed.success) {
        poisoned.push({ timer: parsed.data, claims });
        continue;
      }
    } catch {
      // Decodable in Lua but not here would take a cjson/JSON divergence;
      // fall through to the malformed record either way.
    }
    malformedPoisoned.push({
      raw: item,
      claims,
      shardId: Number(raw[i + 2]),
      timerId: String(raw[i + 3]),
    });
  }
  return { poisoned, malformedPoisoned };
}

export async function claimDueShardTimers(
  redis: Redis,
  shardIds: readonly number[],
  options: { limitPerShard?: number; maxTotal?: number; leaseMs?: number; nowMs?: number } = {},
): Promise<ClaimedTimers> {
  const now = options.nowMs ?? Date.now();
  const leaseMs = options.leaseMs ?? TIMER_LEASE_MS;
  const leaseUntilMs = now + leaseMs;

  if (shardIds.length === 0) {
    return {
      timers: [],
      poisoned: [],
      malformedPoisoned: [],
      oldestDueAgeMs: 0,
      leaseUntilMs,
      legacyClaimed: 0,
    };
  }

  const result = (await redis.eval(
    CLAIM_TIMERS_LUA,
    1,
    StreamKeys.dueShardsKey,
    String(now),
    String(options.limitPerShard ?? TIMER_CLAIM_PER_SHARD),
    String(leaseUntilMs),
    String(TIMER_MAX_CLAIMS),
    StreamKeys.shardKeyParts.prefix,
    StreamKeys.shardKeyParts.timers,
    StreamKeys.shardKeyParts.timerData,
    String(options.maxTotal ?? TIMER_CLAIM_MAX_TOTAL),
    ...shardIds.map(String),
  )) as [unknown, unknown, unknown];

  const timers = parseTimers(result[0]);
  const { poisoned, malformedPoisoned } = parsePoisoned(result[1]);

  let oldestDueAgeMs = 0;
  for (const timer of [...timers, ...poisoned.map((p) => p.timer)]) {
    oldestDueAgeMs = Math.max(oldestDueAgeMs, now - timer.dueAtMs);
  }

  return {
    timers,
    poisoned,
    malformedPoisoned,
    oldestDueAgeMs,
    leaseUntilMs,
    legacyClaimed: Number(result[2] ?? 0),
  };
}

/**
 * Acknowledge a handled timer: remove it and refresh its shard's due entry.
 * Only the caller that claimed it should ack, but a duplicate ack is harmless.
 */
const ACK_TIMER_LUA = `
local timersKey = KEYS[1]
local dataKey = KEYS[2]
local dueShardsKey = KEYS[3]
local id = ARGV[1]
local shardId = ARGV[2]
local leaseUntilMs = ARGV[3]

-- Compare-and-ack. If the score is no longer the lease this caller was given,
-- a producer re-armed the same timer while it was being handled and the ack
-- would destroy the newer arming.
local score = redis.call('ZSCORE', timersKey, id)
if score ~= leaseUntilMs then
  return 0
end

redis.call('ZREM', timersKey, id)
redis.call('HDEL', dataKey, 'd:' .. id, 'c:' .. id)

local earliest = redis.call('ZRANGE', timersKey, 0, 0, 'WITHSCORES')
if earliest[2] then
  redis.call('ZADD', dueShardsKey, earliest[2], shardId)
else
  redis.call('ZREM', dueShardsKey, shardId)
end
return 1
`;

/**
 * Acknowledge a handled timer. `leaseUntilMs` is the deadline the claim
 * returned; the removal is skipped if the entry no longer carries it.
 */
export async function ackShardTimer(
  redis: Redis,
  timer: TimerItem,
  leaseUntilMs: number,
): Promise<boolean> {
  return ackShardTimerById(redis, shardFor(timerShardKey(timer)), timerId(timer), leaseUntilMs);
}

/**
 * Acknowledge by storage identity, for a payload the schema no longer parses —
 * the claim surfaces its shard and id precisely because no `TimerItem` can be
 * rebuilt to derive them from.
 */
export async function ackShardTimerById(
  redis: Redis,
  shardId: number,
  id: string,
  leaseUntilMs: number,
): Promise<boolean> {
  const removed = await redis.eval(
    ACK_TIMER_LUA,
    3,
    StreamKeys.shardTimersKey(shardId),
    StreamKeys.shardTimerDataKey(shardId),
    StreamKeys.dueShardsKey,
    id,
    String(shardId),
    String(leaseUntilMs),
  );
  return Number(removed) === 1;
}

/**
 * Convert timers armed before ids existed, when the ZSET member was the
 * serialized payload.
 *
 * Run at boot, before consumers start. Without it every timer in flight at
 * deploy time — retries, snoozes, delayed starts, delegation timeouts — sits in
 * its shard forever: the claim will not dispatch a member it cannot identify,
 * and the old scheduler never wrote the global due index at all, so those
 * shards are invisible to it.
 *
 * Bounded by what is actually there, and a no-op on a tree that has already
 * migrated. Delete once no deployment can still hold pre-id timers.
 */
export async function migrateLegacyShardTimers(
  redis: Redis,
  shardIds: readonly number[],
): Promise<{ migrated: number; unreadable: number }> {
  let migrated = 0;
  let unreadable = 0;

  for (const shardId of shardIds) {
    const key = StreamKeys.shardTimersKey(shardId);
    const members = await redis.zrange(key, 0, -1);
    for (const member of members) {
      if (!member.startsWith('{')) continue;
      const parsed = TimerItemSchema.safeParse(JSON.parse(member) as unknown);
      if (!parsed.success) {
        unreadable += 1;
        await redis.zrem(key, member);
        continue;
      }
      await scheduleShardTimer(redis, parsed.data);
      await redis.zrem(key, member);
      migrated += 1;
    }
  }

  return { migrated, unreadable };
}

/**
 * Re-arm a claimed timer at a new due time without consuming a redelivery.
 *
 * Used when the handler decides the timer is not actionable yet (an unowned
 * shard, a fencing rejection). It is deliberately not the failure path: a
 * handler that threw keeps its claim count so poison cannot loop forever.
 */
const RESCHEDULE_TIMER_LUA = `
local timersKey = KEYS[1]
local dataKey = KEYS[2]
local dueShardsKey = KEYS[3]
local id = ARGV[1]
local dueAtMs = tonumber(ARGV[2])
local shardId = ARGV[3]

redis.call('ZADD', timersKey, dueAtMs, id)
redis.call('HDEL', dataKey, 'c:' .. id)

local earliest = redis.call('ZRANGE', timersKey, 0, 0, 'WITHSCORES')
if earliest[2] then
  redis.call('ZADD', dueShardsKey, earliest[2], shardId)
end
return 1
`;

export async function rescheduleClaimedTimer(
  redis: Redis,
  timer: TimerItem,
  dueAtMs: number,
): Promise<void> {
  const shardId = shardFor(timerShardKey(timer));
  await redis.eval(
    RESCHEDULE_TIMER_LUA,
    3,
    StreamKeys.shardTimersKey(shardId),
    StreamKeys.shardTimerDataKey(shardId),
    StreamKeys.dueShardsKey,
    timerId(timer),
    String(dueAtMs),
    String(shardId),
  );
}

/**
 * Rebuild the global due entry for the given shards from their own timer sets.
 *
 * The due index is derived state; every writer above keeps it in step inside
 * the same Lua call. This exists for the one case that cannot: an index entry
 * lost to a Redis failure or an out-of-band deletion. Run it on shard
 * acquisition, where the cost is bounded by shards actually changing hands.
 */
const REPAIR_DUE_SHARDS_LUA = `
local dueShardsKey = KEYS[1]
local keyPrefix = ARGV[1]
local timersSuffix = ARGV[2]
for i = 3, #ARGV do
  local shardId = ARGV[i]
  local timersKey = keyPrefix .. shardId .. timersSuffix
  local earliest = redis.call('ZRANGE', timersKey, 0, 0, 'WITHSCORES')
  if earliest[2] then
    redis.call('ZADD', dueShardsKey, earliest[2], shardId)
  else
    redis.call('ZREM', dueShardsKey, shardId)
  end
end
return 1
`;

export async function repairDueShardIndex(
  redis: Redis,
  shardIds: readonly number[],
): Promise<void> {
  if (shardIds.length === 0) return;
  await redis.eval(
    REPAIR_DUE_SHARDS_LUA,
    1,
    StreamKeys.dueShardsKey,
    StreamKeys.shardKeyParts.prefix,
    StreamKeys.shardKeyParts.timers,
    ...shardIds.map(String),
  );
}
