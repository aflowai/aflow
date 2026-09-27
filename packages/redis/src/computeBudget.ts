/**
 * Daily compute-sandbox second budgets — sandbox time runs on shared worker
 * hosts, so it is bounded per space (one runaway skill cannot exhaust the
 * pool) with a tenant-level aggregate backstop.
 *
 * Metered in seconds rather than calls because a call is 60s–1800s depending
 * on its runtime preset, so seconds track real occupancy and call count does
 * not.
 *
 * Spend is RESERVED at the effective timeout (the worst case a call can
 * consume) and settled back to the measured duration when it finishes.
 * Charging the actual duration afterwards instead would let an unbounded
 * number of calls start concurrently before any of them was counted.
 */
import type { Redis } from 'ioredis';

const KEY_PREFIX = 'aflow:compute-budget';
/** Counters live past their day so a late reader can inspect; 2 days. */
const COUNTER_TTL_SECONDS = 172_800;

export interface ComputeBudgetLimits {
  /** Daily sandbox seconds per space; undefined = unlimited. */
  perSpaceSeconds?: number;
  /** Daily sandbox seconds for the whole tenant; undefined = unlimited. */
  tenantSeconds?: number;
}

export interface ComputeBudgetResult {
  allowed: boolean;
  /** Which bound rejected the reservation (null when allowed). */
  exceededScope: 'space' | 'tenant' | null;
  /** The bound that rejected, for a message that can name it. */
  limitSeconds: number | null;
  /**
   * The day bucket this reservation charged. Settlement must refund the bucket
   * it charged, not the one current when the call finishes — a reservation
   * spanning UTC midnight would otherwise leave its own day over-charged and
   * drive the next day's counter negative.
   */
  day: string;
}

function dayBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function spaceKey(tenantId: string, spaceId: string, day: string): string {
  return `${KEY_PREFIX}:${tenantId}:space:${spaceId}:${day}`;
}

function tenantKey(tenantId: string, day: string): string {
  return `${KEY_PREFIX}:${tenantId}:tenant:${day}`;
}

interface BudgetScopes {
  checkSpace: boolean;
  checkTenant: boolean;
}

function resolveScopes(limits: ComputeBudgetLimits, spaceId: string | null): BudgetScopes {
  return {
    checkSpace: limits.perSpaceSeconds !== undefined && spaceId !== null,
    checkTenant: limits.tenantSeconds !== undefined,
  };
}

async function applyDelta(
  redis: Redis,
  args: {
    tenantId: string;
    spaceId: string | null;
    seconds: number;
    scopes: BudgetScopes;
    day: string;
  },
): Promise<{ spaceTotal: number | null; tenantTotal: number | null }> {
  const { tenantId, spaceId, seconds, scopes, day } = args;
  const pipeline = redis.pipeline();
  if (scopes.checkSpace && spaceId !== null) {
    const key = spaceKey(tenantId, spaceId, day);
    pipeline.incrby(key, seconds);
    pipeline.expire(key, COUNTER_TTL_SECONDS);
  }
  if (scopes.checkTenant) {
    const key = tenantKey(tenantId, day);
    pipeline.incrby(key, seconds);
    pipeline.expire(key, COUNTER_TTL_SECONDS);
  }
  const results = (await pipeline.exec()) ?? [];

  let idx = 0;
  let spaceTotal: number | null = null;
  let tenantTotal: number | null = null;
  if (scopes.checkSpace && spaceId !== null) {
    spaceTotal = Number(results[idx]?.[1] ?? 0);
    idx += 2;
  }
  if (scopes.checkTenant) {
    tenantTotal = Number(results[idx]?.[1] ?? 0);
  }
  return { spaceTotal, tenantTotal };
}

/**
 * Reserve `seconds` against the day's counters and report whether the run may
 * proceed. Counters increment before the check (slight overshoot on the
 * boundary is accepted); with no limits configured Redis is not touched.
 *
 * A refused reservation is released again — nothing ran, so leaving it charged
 * would let repeated refusals inflate the counter past the time actually spent.
 */
export async function reserveComputeSeconds(
  redis: Redis,
  args: {
    tenantId: string;
    /** Null when the call carries no space — only the tenant bound applies. */
    spaceId: string | null;
    seconds: number;
    limits: ComputeBudgetLimits;
  },
): Promise<ComputeBudgetResult> {
  const { tenantId, spaceId, seconds, limits } = args;
  const day = dayBucket(new Date());
  const scopes = resolveScopes(limits, spaceId);
  if (!scopes.checkSpace && !scopes.checkTenant) {
    return { allowed: true, exceededScope: null, limitSeconds: null, day };
  }

  const { spaceTotal, tenantTotal } = await applyDelta(redis, {
    tenantId,
    spaceId,
    seconds,
    scopes,
    day,
  });

  let exceededScope: 'space' | 'tenant' | null = null;
  let limitSeconds: number | null = null;
  if (spaceTotal !== null && spaceTotal > (limits.perSpaceSeconds ?? Infinity)) {
    exceededScope = 'space';
    limitSeconds = limits.perSpaceSeconds ?? null;
  } else if (tenantTotal !== null && tenantTotal > (limits.tenantSeconds ?? Infinity)) {
    exceededScope = 'tenant';
    limitSeconds = limits.tenantSeconds ?? null;
  }

  if (exceededScope !== null) {
    await applyDelta(redis, { tenantId, spaceId, seconds: -seconds, scopes, day });
    return { allowed: false, exceededScope, limitSeconds, day };
  }
  return { allowed: true, exceededScope: null, limitSeconds: null, day };
}

/**
 * Release the unused part of a reservation once the call has finished. A
 * five-second call must not hold its full timeout for the rest of the day.
 *
 * `day` is the bucket the reservation charged, carried back from
 * `reserveComputeSeconds` so a call spanning UTC midnight refunds the day it
 * took from rather than the day it happened to end in.
 */
export async function settleComputeSeconds(
  redis: Redis,
  args: {
    tenantId: string;
    spaceId: string | null;
    reservedSeconds: number;
    actualSeconds: number;
    limits: ComputeBudgetLimits;
    day: string;
  },
): Promise<void> {
  const { tenantId, spaceId, reservedSeconds, actualSeconds, limits, day } = args;
  const refund = Math.floor(reservedSeconds - Math.max(0, actualSeconds));
  if (refund <= 0) return;
  const scopes = resolveScopes(limits, spaceId);
  if (!scopes.checkSpace && !scopes.checkTenant) return;
  await applyDelta(redis, { tenantId, spaceId, seconds: -refund, scopes, day });
}
