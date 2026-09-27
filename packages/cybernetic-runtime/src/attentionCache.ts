import type { Redis } from 'ioredis';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Constants
// ============================================================================

/** Absolute TTL for cached attention values (safety net). */
const ATTENTION_CACHE_TTL_SECONDS = 60;

// ============================================================================
// Key builders
// ============================================================================

function generationKey(tenantId: string, spaceId: string): string {
  return `entity:attention:gen:${tenantId}:${spaceId}`;
}

function valueKey(tenantId: string, spaceId: string, generation: string): string {
  return `entity:attention:${tenantId}:${spaceId}:${generation}`;
}

// ============================================================================
// Telemetry counters
// ============================================================================

let hitsTotal = 0;
let missesTotal = 0;
let invalidationsTotal = 0;

export function getAttentionCacheCounters(): {
  hits: number;
  misses: number;
  invalidations: number;
} {
  return { hits: hitsTotal, misses: missesTotal, invalidations: invalidationsTotal };
}

export function resetAttentionCacheCounters(): void {
  hitsTotal = 0;
  missesTotal = 0;
  invalidationsTotal = 0;
}

// ============================================================================
// Public API
// ============================================================================

/** Result of a cache get — includes generation for safe write-back. */
export interface AttentionCacheGetResult {
  value: string | null;
  /** Generation at read time. Pass to setAttentionCache for safe write-back. */
  generation: string | null;
}

/**
 * Get the cached attention value for a space.
 * Returns the value (or null on miss) plus the current generation for
 * generation-safe write-back via `setAttentionCache`.
 */
export async function getAttentionCache(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<AttentionCacheGetResult> {
  try {
    const genKey = generationKey(tenantId, spaceId);
    const gen = await redis.get(genKey);
    if (!gen) {
      missesTotal++;
      return { value: null, generation: null };
    }

    const valKey = valueKey(tenantId, spaceId, gen);
    const value = await redis.get(valKey);
    if (!value) {
      missesTotal++;
      return { value: null, generation: gen };
    }

    hitsTotal++;
    return { value, generation: gen };
  } catch (err) {
    getCyberneticLogger().warn(
      `attentionCache.get failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    missesTotal++;
    return { value: null, generation: null };
  }
}

/**
 * Set the cached attention value for a space, but only if the generation
 * has not advanced since the caller's read. This prevents stale values
 * from being cached under a newer generation after an invalidation
 * occurred during compute.
 *
 * @param readGeneration - The generation returned by getAttentionCache at read time.
 */
export async function setAttentionCache(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  value: string,
  readGeneration: string | null,
): Promise<void> {
  try {
    const genKey = generationKey(tenantId, spaceId);

    // Ensure a generation key exists — initialize to "1" if absent
    await redis.setnx(genKey, '1');
    const currentGen = await redis.get(genKey);
    if (!currentGen) return;

    // Only write if generation has not advanced since read
    if (readGeneration !== null && currentGen !== readGeneration) return;

    const valKey = valueKey(tenantId, spaceId, currentGen);

    // Write value with 60s TTL
    await redis.set(valKey, value, 'EX', ATTENTION_CACHE_TTL_SECONDS);
  } catch (err) {
    getCyberneticLogger().warn(
      `attentionCache.set failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Bump the generation for a space, invalidating the current cached value.
 */
export async function bumpAttentionGeneration(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<void> {
  try {
    const genKey = generationKey(tenantId, spaceId);
    await redis.incr(genKey);
    invalidationsTotal++;
  } catch (err) {
    getCyberneticLogger().warn(
      `attentionCache.bumpGeneration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
