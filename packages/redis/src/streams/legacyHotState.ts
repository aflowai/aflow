import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

// ============================================================================
// Hot State Operations
// ============================================================================

/**
 * Default TTL for hot state (24 hours).
 */
const HOT_STATE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Set run hot state with TTL.
 */
export async function setSessionHotState(
  redis: Redis,
  tenantId: string,
  runId: string,
  state: Record<string, unknown>,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<void> {
  const key = StreamKeys.sessionStateKey(tenantId, runId);
  await redis.setex(key, ttlSeconds, JSON.stringify(state));
}

/**
 * Get run hot state.
 */
export async function getSessionHotState(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const key = StreamKeys.sessionStateKey(tenantId, runId);
  const value = await redis.get(key);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Set run metadata with TTL.
 */
export async function setRunMeta(
  redis: Redis,
  tenantId: string,
  runId: string,
  meta: {
    status: string;
    currentStepExecutionId?: string;
    lastEventId?: string;
  },
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<void> {
  const key = StreamKeys.sessionMetaKey(tenantId, runId);
  await redis.setex(key, ttlSeconds, JSON.stringify(meta));
}

/**
 * Get run metadata.
 */
export async function getRunMeta(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<{
  status: string;
  currentStepExecutionId?: string;
  lastEventId?: string;
} | null> {
  const key = StreamKeys.sessionMetaKey(tenantId, runId);
  const value = await redis.get(key);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as {
      status: string;
      currentStepExecutionId?: string;
      lastEventId?: string;
    };
  } catch {
    return null;
  }
}

/**
 * Delete run hot state and metadata.
 */
export async function deleteSessionHotState(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  await redis.del(
    StreamKeys.sessionStateKey(tenantId, runId),
    StreamKeys.sessionMetaKey(tenantId, runId),
  );
}

/**
 * Refresh TTL on run hot state.
 */
export async function refreshSessionHotStateTtl(
  redis: Redis,
  tenantId: string,
  runId: string,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<void> {
  await redis.expire(StreamKeys.sessionStateKey(tenantId, runId), ttlSeconds);
  await redis.expire(StreamKeys.sessionMetaKey(tenantId, runId), ttlSeconds);
}
