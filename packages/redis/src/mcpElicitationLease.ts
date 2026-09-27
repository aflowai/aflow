import type { Redis } from 'ioredis';
import { StreamKeys, McpElicitationLeaseSchema, type McpElicitationLease } from '@aflow/schemas';
import {
  mcpElicitationCandidateMember,
  mcpElicitationNextCheckAtMs,
} from './mcpElicitationLeaseCandidates.js';

/**
 * Acquire a fresh lease. Atomically writes all fields + sets TTL, and
 * fails if the key already exists (a peer holds the lease).
 *
 * Returns the persisted lease record on success, `null` if another holder
 * has the lease (caller should treat as conflict — typically respond with
 * `decline` to the duplicate request and skip the suspend).
 */
export async function acquireMcpElicitationLease(
  redis: Redis,
  lease: Omit<McpElicitationLease, 'acquiredAt' | 'leaseExpiresAt'>,
  opts: { ttlMs: number },
): Promise<McpElicitationLease | null> {
  const now = Date.now();
  const record: McpElicitationLease = McpElicitationLeaseSchema.parse({
    ...lease,
    acquiredAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + opts.ttlMs).toISOString(),
  });
  const key = StreamKeys.mcpElicitationLeaseKey(record.elicitationId);
  const ttlSec = Math.max(1, Math.ceil(opts.ttlMs / 1000));

  // SETNX-for-hash via Lua: only write if the key doesn't exist. Single
  // round-trip, atomic with the TTL set so we never leave a hash without
  // an expiry — and with the candidate ZADD, so a lease cannot exist without
  // the index entry that is now the only way to find it.
  const script = `
    if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
    redis.call('HSET', KEYS[1],
      'elicitationId', ARGV[1],
      'executorInstanceId', ARGV[2],
      'stepExecutionId', ARGV[3],
      'tenantId', ARGV[4],
      'bindingId', ARGV[5],
      'serverId', ARGV[6],
      'sessionId', ARGV[7],
      'acquiredAt', ARGV[8],
      'leaseExpiresAt', ARGV[9])
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[10]))
    redis.call('ZADD', KEYS[2], tonumber(ARGV[11]), ARGV[12])
    return 1
  `;
  const result = (await redis.eval(
    script,
    2,
    key,
    StreamKeys.mcpElicitationLeaseCandidatesKey,
    record.elicitationId,
    record.executorInstanceId,
    record.stepExecutionId,
    record.tenantId,
    record.bindingId,
    record.serverId,
    record.sessionId ?? '',
    record.acquiredAt,
    record.leaseExpiresAt,
    String(ttlSec),
    String(mcpElicitationNextCheckAtMs(now, opts.ttlMs)),
    mcpElicitationCandidateMember(record.executorInstanceId, record.elicitationId),
  )) as number;
  if (result !== 1) return null;
  return record;
}

/**
 * Refresh the TTL on a lease — only if the caller still holds it. CAS via
 * HGET inside Lua so a concurrent expire + reacquire by another instance
 * can't accidentally inherit our extension.
 *
 * Returns `true` if refreshed, `false` if the lease no longer belongs to
 * `executorInstanceId` (the holder should stop refreshing and treat its
 * awaited response as `elicitation_executor_lost`).
 */
export async function refreshMcpElicitationLease(
  redis: Redis,
  elicitationId: string,
  executorInstanceId: string,
  ttlMs: number,
): Promise<boolean> {
  const key = StreamKeys.mcpElicitationLeaseKey(elicitationId);
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  const now = Date.now();
  const newExpiresAt = new Date(now + ttlMs).toISOString();
  // The candidate ZADD rides the heartbeat the holder already issues, so the
  // index costs the hot path nothing — and a lease whose index entry was lost
  // (an evicted key, a rollout that predates the index) re-arms itself within
  // one heartbeat rather than needing a sweep to find it.
  const script = `
    local owner = redis.call('HGET', KEYS[1], 'executorInstanceId')
    if not owner or owner ~= ARGV[1] then return 0 end
    redis.call('HSET', KEYS[1], 'leaseExpiresAt', ARGV[2])
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
    redis.call('ZADD', KEYS[2], tonumber(ARGV[4]), ARGV[5])
    return 1
  `;
  const result = (await redis.eval(
    script,
    2,
    key,
    StreamKeys.mcpElicitationLeaseCandidatesKey,
    executorInstanceId,
    newExpiresAt,
    String(ttlSec),
    String(mcpElicitationNextCheckAtMs(now, ttlMs)),
    mcpElicitationCandidateMember(executorInstanceId, elicitationId),
  )) as number;
  return result === 1;
}

/**
 * Read the current lease record, if any. Used by the orchestrator's
 * response router to find the publish target, and by the reconciler to
 * detect a dead holder.
 */
export async function readMcpElicitationLease(
  redis: Redis,
  elicitationId: string,
): Promise<McpElicitationLease | null> {
  const key = StreamKeys.mcpElicitationLeaseKey(elicitationId);
  const raw = await redis.hgetall(key);
  // `hgetall` returns `{}` for a missing key — distinguish from a real
  // (zero-field) hash by checking elicitationId presence.
  if (!raw?.['elicitationId']) return null;
  const parsed = McpElicitationLeaseSchema.safeParse({
    elicitationId: raw['elicitationId'],
    executorInstanceId: raw['executorInstanceId'],
    stepExecutionId: raw['stepExecutionId'],
    tenantId: raw['tenantId'],
    bindingId: raw['bindingId'],
    serverId: raw['serverId'],
    // We store empty string for missing sessionId — restore to undefined
    // so the optional schema field round-trips.
    ...(raw['sessionId'] ? { sessionId: raw['sessionId'] } : {}),
    acquiredAt: raw['acquiredAt'],
    leaseExpiresAt: raw['leaseExpiresAt'],
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Release a lease. Idempotent and CAS-guarded — only deletes the key if
 * the calling executor still owns it. Safe to call from the handler's
 * `finally`: a missing key (expired) or one held by someone else is
 * treated as success.
 */
export async function releaseMcpElicitationLease(
  redis: Redis,
  elicitationId: string,
  executorInstanceId: string,
): Promise<void> {
  const key = StreamKeys.mcpElicitationLeaseKey(elicitationId);
  // The ZREM is unconditional on this holder's own member: it names the
  // instance, so a peer that legitimately re-acquired after our expiry owns a
  // different member and cannot be un-indexed by our release.
  const script = `
    redis.call('ZREM', KEYS[2], ARGV[2])
    local owner = redis.call('HGET', KEYS[1], 'executorInstanceId')
    if not owner or owner ~= ARGV[1] then return 0 end
    redis.call('DEL', KEYS[1])
    return 1
  `;
  await redis.eval(
    script,
    2,
    key,
    StreamKeys.mcpElicitationLeaseCandidatesKey,
    executorInstanceId,
    mcpElicitationCandidateMember(executorInstanceId, elicitationId),
  );
}

/**
 * Force-delete a lease bypassing the holder CAS. Used by the orchestrator's
 * reconciler when it has independently verified that the holder executor
 * is dead (heartbeat expired). Idempotent — DEL on a missing key is a
 * no-op.
 *
 * Not exported for normal flow — the only legitimate caller is the
 * reconciler, which has done its own liveness check.
 */
export async function forceDeleteMcpElicitationLease(
  redis: Redis,
  executorInstanceId: string,
  elicitationId: string,
): Promise<void> {
  const key = StreamKeys.mcpElicitationLeaseKey(elicitationId);
  await redis
    .multi()
    .del(key)
    .zrem(
      StreamKeys.mcpElicitationLeaseCandidatesKey,
      mcpElicitationCandidateMember(executorInstanceId, elicitationId),
    )
    .exec();
}
