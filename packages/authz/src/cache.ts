/**
 * Redis caching layer for authorization decisions.
 */
import type { Redis } from 'ioredis';
import type { SpaceAccessAttributes } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Redis key prefix for tenant role cache. */
export const RBAC_TENANT_CACHE_PREFIX = 'aflow:rbac:tenant';

/** Redis key prefix for space role cache. */
export const RBAC_SPACE_CACHE_PREFIX = 'aflow:rbac:space';

/** Redis key prefix for space attributes cache (ownerId + memberCount). */
export const RBAC_SPACE_ATTRS_CACHE_PREFIX = 'aflow:rbac:spaceattrs';

/** Pub/Sub channel for RBAC cache invalidation. */
export const RBAC_INVALIDATE_CHANNEL = 'aflow:pubsub:rbac-invalidate';

/** Default TTL for RBAC cache entries (seconds). */
export const RBAC_CACHE_TTL = 120;

// ============================================================================
// Invalidation message contract
// ============================================================================

/** Structured invalidation message published on the RBAC Pub/Sub channel. */
export interface RbacInvalidationMessage {
  userId: string;
  tenantId: string;
  /** When present, only the space-specific cache entry is evicted. */
  spaceId?: string;
}

/**
 * Parse a raw Pub/Sub message into an RbacInvalidationMessage.
 * Returns null if the message is malformed.
 */
export function parseRbacInvalidationMessage(raw: string): RbacInvalidationMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'userId' in parsed &&
      'tenantId' in parsed &&
      typeof (parsed as Record<string, unknown>)['userId'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['tenantId'] === 'string'
    ) {
      const msg = parsed as Record<string, unknown>;
      return {
        userId: msg['userId'] as string,
        tenantId: msg['tenantId'] as string,
        ...(typeof msg['spaceId'] === 'string' ? { spaceId: msg['spaceId'] } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Tenant role cache
// ============================================================================

/** RBAC tenant role cache */
export async function getCachedTenantRole(
  redis: Redis,
  userId: string,
  tenantId: string,
): Promise<string | null> {
  return redis.get(`${RBAC_TENANT_CACHE_PREFIX}:${userId}:${tenantId}`);
}

export async function setCachedTenantRole(
  redis: Redis,
  userId: string,
  tenantId: string,
  role: string,
  ttlSeconds = RBAC_CACHE_TTL,
): Promise<void> {
  await redis.set(`${RBAC_TENANT_CACHE_PREFIX}:${userId}:${tenantId}`, role, 'EX', ttlSeconds);
}

/** RBAC space role cache */
export async function getCachedSpaceRole(
  redis: Redis,
  userId: string,
  tenantId: string,
  spaceId: string,
): Promise<string | null> {
  return redis.get(`${RBAC_SPACE_CACHE_PREFIX}:${userId}:${tenantId}:${spaceId}`);
}

export async function setCachedSpaceRole(
  redis: Redis,
  userId: string,
  tenantId: string,
  spaceId: string,
  role: string,
  ttlSeconds = RBAC_CACHE_TTL,
): Promise<void> {
  await redis.set(
    `${RBAC_SPACE_CACHE_PREFIX}:${userId}:${tenantId}:${spaceId}`,
    role,
    'EX',
    ttlSeconds,
  );
}

/** Space attributes cache (tenant-scoped, user-independent) */
export async function getCachedSpaceAttributes(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<SpaceAccessAttributes | null> {
  const raw = await redis.get(`${RBAC_SPACE_ATTRS_CACHE_PREFIX}:${tenantId}:${spaceId}`);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['memberCount'] === 'number'
    ) {
      const record = parsed as Record<string, unknown>;
      return {
        ownerId: typeof record['ownerId'] === 'string' ? record['ownerId'] : null,
        memberCount: record['memberCount'] as number,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function setCachedSpaceAttributes(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  attrs: SpaceAccessAttributes,
  ttlSeconds = RBAC_CACHE_TTL,
): Promise<void> {
  await redis.set(
    `${RBAC_SPACE_ATTRS_CACHE_PREFIX}:${tenantId}:${spaceId}`,
    JSON.stringify(attrs),
    'EX',
    ttlSeconds,
  );
}

export async function invalidateSpaceAttributesCache(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<void> {
  await redis.del(`${RBAC_SPACE_ATTRS_CACHE_PREFIX}:${tenantId}:${spaceId}`);
}

// ============================================================================
// Invalidation
// ============================================================================

/**
 * Compute the Redis keys that should be deleted for a given invalidation message.
 *
 * When `spaceId` is present, only the specific space cache entry is returned.
 * Otherwise, both the tenant cache key and a glob pattern for all space entries
 * are returned (caller must SCAN/KEYS the pattern).
 */
export function rbacKeysForInvalidation(msg: RbacInvalidationMessage): {
  /** Exact keys that can be DEL'd directly. */
  exact: string[];
  /** Glob patterns that require KEYS/SCAN before DEL. */
  patterns: string[];
} {
  const tenantKey = `${RBAC_TENANT_CACHE_PREFIX}:${msg.userId}:${msg.tenantId}`;

  if (msg.spaceId) {
    // Targeted: evict only tenant + one space
    const spaceKey = `${RBAC_SPACE_CACHE_PREFIX}:${msg.userId}:${msg.tenantId}:${msg.spaceId}`;
    return { exact: [tenantKey, spaceKey], patterns: [] };
  }

  // Broad: evict tenant + all spaces for this user+tenant
  const spacePattern = `${RBAC_SPACE_CACHE_PREFIX}:${msg.userId}:${msg.tenantId}:*`;
  return { exact: [tenantKey], patterns: [spacePattern] };
}

/** Invalidate all RBAC cache for a user in a tenant (local Redis, no pub/sub). */
export async function invalidateRbacCache(
  redis: Redis,
  userId: string,
  tenantId: string,
  spaceId?: string,
): Promise<void> {
  const msg: RbacInvalidationMessage = { userId, tenantId, ...(spaceId ? { spaceId } : {}) };
  const { exact, patterns } = rbacKeysForInvalidation(msg);

  const keysToDelete = [...exact];

  for (const pattern of patterns) {
    const matched = await redis.keys(pattern);
    keysToDelete.push(...matched);
  }

  if (keysToDelete.length > 0) {
    await redis.del(...keysToDelete);
  }
}

/** Publish RBAC invalidation event (notifies all server instances via Pub/Sub). */
export async function publishRbacInvalidation(
  redis: Redis,
  userId: string,
  tenantId: string,
  spaceId?: string,
): Promise<void> {
  const msg: RbacInvalidationMessage = { userId, tenantId, ...(spaceId ? { spaceId } : {}) };
  await redis.publish(RBAC_INVALIDATE_CHANNEL, JSON.stringify(msg));
}
