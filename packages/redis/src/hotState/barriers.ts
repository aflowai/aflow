import type { Redis } from 'ioredis';
// ============================================================================

const BARRIER_WATCHDOG_KEY = 'aflow:barrier_watchdogs';

/** Barrier watchdog entry stored in the ZSET. */
interface BarrierWatchdogEntry {
  tenantId: string;
  runId: string;
  agentStepId: string;
}

/** A stale barrier surfaced by `peekStaleBarriers` (member kept in the ZSET). */
export interface StaleBarrier {
  entry: BarrierWatchdogEntry;
  /** Raw JSON ZSET member — the handle for claim/refresh/drop. */
  member: string;
  /** Current ZSET score (epoch ms of registration or last refresh). */
  score: number;
}

/**
 * Register a barrier in the watchdog ZSET with the creation timestamp as score.
 * Called when a parallel barrier is created in applyAgentDecision.
 */
export async function registerBarrierWatchdog(
  redis: Redis,
  tenantId: string,
  runId: string,
  agentStepId: string,
  createdAtMs: number,
): Promise<void> {
  const entry: BarrierWatchdogEntry = { tenantId, runId, agentStepId };
  await redis.zadd(BARRIER_WATCHDOG_KEY, createdAtMs, JSON.stringify(entry));
}

/**
 * Remove a barrier from the watchdog ZSET.
 * Called when the barrier is released (all tool calls completed).
 */
export async function removeBarrierWatchdog(
  redis: Redis,
  tenantId: string,
  runId: string,
  agentStepId: string,
): Promise<void> {
  const entry: BarrierWatchdogEntry = { tenantId, runId, agentStepId };
  await redis.zrem(BARRIER_WATCHDOG_KEY, JSON.stringify(entry));
}

/**
 * Read stale barrier entries (score <= now - maxAgeMs) WITHOUT removing them.
 * The sweep decides per candidate and then claims/refreshes/drops explicitly,
 * so a healthy resting wait is never destructively popped by the read itself.
 */
export async function peekStaleBarriers(
  redis: Redis,
  maxAgeMs: number,
  limit = 50,
): Promise<StaleBarrier[]> {
  const cutoff = Date.now() - maxAgeMs;
  const raw = await redis.zrangebyscore(
    BARRIER_WATCHDOG_KEY,
    '-inf',
    cutoff,
    'WITHSCORES',
    'LIMIT',
    0,
    limit,
  );

  const results: StaleBarrier[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const member = raw[i];
    const scoreStr = raw[i + 1];
    if (member === undefined || scoreStr === undefined) continue;
    try {
      const entry = JSON.parse(member) as BarrierWatchdogEntry;
      results.push({ entry, member, score: Number(scoreStr) });
    } catch {
      // Skip malformed entries (and leave them in the ZSET for a human to notice).
    }
  }
  return results;
}

/**
 * Atomically claim a barrier for recovery. Returns true iff this caller removed
 * the member (exactly one of N concurrent orchestrators wins the ZREM), so only
 * the claimant proceeds to synthesize a failure.
 */
export async function claimBarrier(redis: Redis, member: string): Promise<boolean> {
  const removed = await redis.zrem(BARRIER_WATCHDOG_KEY, member);
  return removed === 1;
}

/**
 * Refresh a barrier's score IN PLACE (ZADD XX). `XX` updates only an existing
 * member: if a real completion path removed the barrier between peek and refresh,
 * this is a no-op rather than resurrecting a dead entry.
 */
export async function refreshBarrier(redis: Redis, member: string, score: number): Promise<void> {
  await redis.zadd(BARRIER_WATCHDOG_KEY, 'XX', score, member);
}

/** Drop a barrier from the watchdog ZSET (resolved / terminal / anomalous). */
export async function dropBarrier(redis: Redis, member: string): Promise<void> {
  await redis.zrem(BARRIER_WATCHDOG_KEY, member);
}
