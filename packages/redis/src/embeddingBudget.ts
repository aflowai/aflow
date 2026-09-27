/**
 * Daily embedding token budgets — platform-funded embeddings are bounded per
 * space (one abuser cannot exhaust a shared pool) with a tenant-level
 * aggregate backstop. Exhaustion is a graceful degrade signal (defer the
 * embed, fall back to FTS), never an error.
 */
import type { Redis } from 'ioredis';

const KEY_PREFIX = 'aflow:embed-budget';
/** Counters live past their day so a late reader can inspect; 2 days. */
const COUNTER_TTL_SECONDS = 172_800;

export interface EmbeddingBudgetLimits {
  /** Daily token budget per space; undefined = unlimited. */
  perSpaceTokens?: number;
  /** Daily token budget for the whole tenant; undefined = unlimited. */
  tenantTokens?: number;
}

export interface EmbeddingBudgetResult {
  allowed: boolean;
  /** Which bound rejected the spend (null when allowed). */
  exceededScope: 'space' | 'tenant' | null;
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

/** ~4 chars per token — the budget is a spend bound, not an exact meter. */
export function estimateEmbeddingTokens(texts: readonly string[]): number {
  let chars = 0;
  for (const t of texts) chars += t.length;
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Record `tokens` against the day's counters and report whether the spend is
 * within budget. Counters increment before the check (slight overshoot on the
 * boundary is accepted); with no limits configured Redis is not touched.
 */
export async function consumeEmbeddingBudget(
  redis: Redis,
  args: {
    tenantId: string;
    /** Null for docs outside any space — only the tenant bound applies. */
    spaceId: string | null;
    tokens: number;
    limits: EmbeddingBudgetLimits;
  },
): Promise<EmbeddingBudgetResult> {
  const { tenantId, spaceId, tokens, limits } = args;
  const checkSpace = limits.perSpaceTokens !== undefined && spaceId !== null;
  const checkTenant = limits.tenantTokens !== undefined;
  if (!checkSpace && !checkTenant) return { allowed: true, exceededScope: null };

  const day = dayBucket(new Date());
  const pipeline = redis.pipeline();
  if (checkSpace) {
    const key = spaceKey(tenantId, spaceId, day);
    pipeline.incrby(key, tokens);
    pipeline.expire(key, COUNTER_TTL_SECONDS);
  }
  if (checkTenant) {
    const key = tenantKey(tenantId, day);
    pipeline.incrby(key, tokens);
    pipeline.expire(key, COUNTER_TTL_SECONDS);
  }
  const results = (await pipeline.exec()) ?? [];

  let idx = 0;
  if (checkSpace) {
    const total = Number(results[idx]?.[1] ?? 0);
    idx += 2;
    if (total > (limits.perSpaceTokens ?? Infinity)) {
      return { allowed: false, exceededScope: 'space' };
    }
  }
  if (checkTenant) {
    const total = Number(results[idx]?.[1] ?? 0);
    if (total > (limits.tenantTokens ?? Infinity)) {
      return { allowed: false, exceededScope: 'tenant' };
    }
  }
  return { allowed: true, exceededScope: null };
}
