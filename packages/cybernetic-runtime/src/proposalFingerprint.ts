import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { StagedChangeOp } from '@aflow/schemas';

// ---------------------------------------------------------------------------
// Fingerprint computation
// ---------------------------------------------------------------------------

/**
 * Compute a stable fingerprint for a set of proposal ops.
 *
 * The fingerprint is a SHA-256 hash of the canonical representation:
 * sorted keys of each op + optional target slug. This ensures that
 * permuted payload keys produce identical fingerprints.
 */
export function computeProposalFingerprint(ops: StagedChangeOp[], targetSlug?: string): string {
  const canonical = ops.map((op) => stableStringify(op)).join('|');
  const input = targetSlug ? `${targetSlug}:${canonical}` : canonical;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic JSON stringification with sorted keys.
 * Handles nested objects recursively.
 */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map((v) => stableStringify(v)).join(',') + ']';
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = sorted.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`,
  );
  return '{' + pairs.join(',') + '}';
}

// ---------------------------------------------------------------------------
// Redis ZSET operations
// ---------------------------------------------------------------------------

function rejectedFingerprintsKey(spaceId: string): string {
  return `cybernetic:rejected-fingerprints:${spaceId}`;
}

/**
 * Check whether a proposal fingerprint matches a recently rejected proposal.
 *
 * @returns `{ duplicate: true, originalRejectionId }` if a match is found
 *          within the retention window, `{ duplicate: false }` otherwise.
 */
export async function checkDuplicateFingerprint(
  redis: Redis,
  spaceId: string,
  fingerprint: string,
  windowMs: number,
): Promise<{ duplicate: boolean; originalRejectionId?: string }> {
  const key = rejectedFingerprintsKey(spaceId);

  // Trim expired entries first
  const cutoff = Date.now() - windowMs;
  await redis.zremrangebyscore(key, '-inf', cutoff);

  // Scan for any member starting with this fingerprint
  // Members are stored as `{fingerprint}:{rejectionId}`
  const members = await redis.zrangebyscore(key, cutoff, '+inf');
  const prefix = `${fingerprint}:`;
  for (const member of members) {
    if (member.startsWith(prefix)) {
      const rejectionId = member.slice(prefix.length);
      return { duplicate: true, originalRejectionId: rejectionId };
    }
  }

  return { duplicate: false };
}

/**
 * Record a rejected proposal's fingerprint in the ZSET.
 * Automatically trims entries older than `windowMs`.
 */
export async function recordRejectedFingerprint(
  redis: Redis,
  spaceId: string,
  fingerprint: string,
  rejectedAt: number,
  rejectionId: string,
  windowMs: number,
): Promise<void> {
  const key = rejectedFingerprintsKey(spaceId);
  const member = `${fingerprint}:${rejectionId}`;

  // ZADD + trim in pipeline
  const pipeline = redis.pipeline();
  pipeline.zadd(key, rejectedAt, member);
  pipeline.zremrangebyscore(key, '-inf', Date.now() - windowMs);
  await pipeline.exec();
}
