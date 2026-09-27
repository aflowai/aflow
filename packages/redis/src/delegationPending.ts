import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

/**
 * Per-entry data stored alongside the ZSET member. Parent ids are
 * redundant with the reverse index (`StreamKeys.delegationParentKey`) on
 * purpose: if the reverse index is wiped, the drain can still resolve
 * which parent step to advance, preventing the silent-wedge class from
 * re-emerging at the recovery layer.
 */
export interface DelegationPendingData {
  parentRunId: string;
  parentStepExecutionId: string;
  attempt: number;
  /**
   * Number of escalation attempts (synthetic-FAILED injections) so far.
   * Tracked separately from `attempt` because escalation is the post-
   * maxAttempts phase — its purpose is to detect "synthetic FAILED was
   * injected but never applied to the parent step" so we can either
   * re-inject (idempotent) or fall through to `failRun` after a cap.
   */
  escalations?: number;
  lastError?: string;
  claimedBy?: string;
  claimedAt?: number;
}

export interface ClaimedDelegation {
  tenantId: string;
  childRunId: string;
  data: DelegationPendingData;
}

function makeMember(tenantId: string, childRunId: string): string {
  return `${tenantId}:${childRunId}`;
}

function parseMember(member: string): { tenantId: string; childRunId: string } | null {
  const idx = member.indexOf(':');
  if (idx === -1) return null;
  return {
    tenantId: member.slice(0, idx),
    childRunId: member.slice(idx + 1),
  };
}

function parseDataHash(hash: Record<string, string>): DelegationPendingData | null {
  const parentRunId = hash['parentRunId'];
  const parentStepExecutionId = hash['parentStepExecutionId'];
  if (!parentRunId || !parentStepExecutionId) return null;
  const attemptRaw = hash['attempt'];
  const attempt = attemptRaw ? Number.parseInt(attemptRaw, 10) : 0;
  const result: DelegationPendingData = {
    parentRunId,
    parentStepExecutionId,
    attempt: Number.isFinite(attempt) ? attempt : 0,
  };
  if (hash['escalations']) {
    const n = Number.parseInt(hash['escalations'], 10);
    if (Number.isFinite(n)) result.escalations = n;
  }
  if (hash['lastError']) result.lastError = hash['lastError'];
  if (hash['claimedBy']) result.claimedBy = hash['claimedBy'];
  if (hash['claimedAt']) {
    const ts = Number.parseInt(hash['claimedAt'], 10);
    if (Number.isFinite(ts)) result.claimedAt = ts;
  }
  return result;
}

// ============================================================================
// Lua scripts
// ============================================================================

/**
 * Upsert a pending entry. ZADD NX preserves any scheduled retry already
 * in flight (so a duplicate child terminal doesn't reset the backoff).
 * Parent ids are always written — re-parenting on `agent.control.resume`
 * needs the latest values to align with the reverse index.
 *
 * KEYS[1] = pending ZSET
 * KEYS[2] = pending data hash
 * ARGV[1] = member ("tenantId:childRunId")
 * ARGV[2] = dueAtMs (string)
 * ARGV[3] = parentRunId
 * ARGV[4] = parentStepExecutionId
 *
 * Returns 1 if a new entry was created, 0 if it already existed.
 */
const UPSERT_PENDING_LUA = `
local zKey = KEYS[1]
local dataKey = KEYS[2]
local member = ARGV[1]
local dueAt = ARGV[2]
local parentRunId = ARGV[3]
local parentStepExecutionId = ARGV[4]
local added = redis.call('ZADD', zKey, 'NX', dueAt, member)
redis.call('HSET', dataKey, 'parentRunId', parentRunId, 'parentStepExecutionId', parentStepExecutionId)
if added == 1 then
  redis.call('HSETNX', dataKey, 'attempt', '0')
end
return added
`;

/**
 * Atomically claim due entries: bump score to now+leaseMs, stamp
 * claimedBy/claimedAt. Two workers can't both hold a fresh claim on the
 * same member.
 *
 * KEYS[1] = pending ZSET
 * KEYS[2..N] (unused — we compute data keys per member below since the
 *             member encodes tenantId)
 * ARGV[1] = nowMs
 * ARGV[2] = leaseMs
 * ARGV[3] = batch size
 * ARGV[4] = workerId
 * ARGV[5] = data key prefix ("aflow:delegation:pending:data:")
 *
 * Returns a flat array: [member1, parentRunId1, parentStepExecutionId1, attempt1, lastError1, member2, ...]
 * (lastError may be empty string when missing).
 */
/**
 * Per-entry claim Lua. Atomically check that the entry is still due,
 * bump its score by leaseMs, and stamp the claim. Returns 1 if the
 * claim succeeded, 0 if the entry was already claimed by someone else
 * (lease still valid) or removed. The data-hash fetch is done on the
 * JS side via HGETALL afterwards — keeping Lua scope minimal sidesteps
 * a fengari-interop edge case (in ioredis-mock) where Lua-table return
 * values arrive at JS as a proxy that mishandles missing fields.
 *
 * KEYS[1] = pending ZSET
 * KEYS[2] = pending data hash for this member
 * ARGV[1] = member
 * ARGV[2] = nowMs (string)
 * ARGV[3] = newScore (string, = now + leaseMs)
 * ARGV[4] = workerId
 */
const CLAIM_ONE_LUA = `
local zKey = KEYS[1]
local dataKey = KEYS[2]
local member = ARGV[1]
local nowStr = ARGV[2]
local newScore = ARGV[3]
local workerId = ARGV[4]
local current = redis.call('ZSCORE', zKey, member)
if not current then return 0 end
if tonumber(current) > tonumber(nowStr) then return 0 end
redis.call('ZADD', zKey, newScore, member)
redis.call('HSET', dataKey, 'claimedBy', workerId, 'claimedAt', nowStr)
return 1
`;

/**
 * Release a claim and reschedule the entry for retry. Bumps attempt,
 * sets next due, clears the claim stamps.
 *
 * KEYS[1] = pending ZSET
 * KEYS[2] = pending data hash
 * ARGV[1] = member
 * ARGV[2] = nextDueAtMs
 * ARGV[3] = attempt (string)
 * ARGV[4] = lastError ('' if none)
 *
 * Returns 1 if the member existed and was rescheduled, 0 if it had
 * already been removed (e.g. by a concurrent complete).
 */
const RELEASE_LUA = `
local zKey = KEYS[1]
local dataKey = KEYS[2]
local member = ARGV[1]
local nextDue = ARGV[2]
local attempt = ARGV[3]
local lastError = ARGV[4]
local existed = redis.call('ZSCORE', zKey, member)
if not existed then
  return 0
end
redis.call('ZADD', zKey, nextDue, member)
redis.call('HSET', dataKey, 'attempt', attempt)
if lastError ~= '' then
  redis.call('HSET', dataKey, 'lastError', lastError)
else
  redis.call('HDEL', dataKey, 'lastError')
end
redis.call('HDEL', dataKey, 'claimedBy', 'claimedAt')
return 1
`;

const RELEASE_AFTER_ESCALATION_LUA = `
local zKey = KEYS[1]
local dataKey = KEYS[2]
local member = ARGV[1]
local nextDue = ARGV[2]
local lastError = ARGV[3]
local existed = redis.call('ZSCORE', zKey, member)
if not existed then return 0 end
redis.call('ZADD', zKey, nextDue, member)
local newCount = redis.call('HINCRBY', dataKey, 'escalations', 1)
if lastError ~= '' then
  redis.call('HSET', dataKey, 'lastError', lastError)
end
redis.call('HDEL', dataKey, 'claimedBy', 'claimedAt')
return newCount
`;

/**
 * Tear down all lifecycle state for a child: ZREM pending, delete data,
 * delete reverse index. Used by both `completeDelegationLifecycle` and
 * `abortDelegationLifecycle` — they differ only in caller intent + log
 * line, not Redis ops.
 *
 * KEYS[1] = pending ZSET
 * KEYS[2] = pending data hash
 * KEYS[3] = reverse index hash
 * ARGV[1] = member
 *
 * Returns 1 if anything was removed, 0 if everything was already clean.
 */
const TEARDOWN_LUA = `
local zKey = KEYS[1]
local dataKey = KEYS[2]
local revKey = KEYS[3]
local member = ARGV[1]
local removed = redis.call('ZREM', zKey, member)
redis.call('DEL', dataKey)
redis.call('DEL', revKey)
return removed
`;

// ============================================================================
// Public API
// ============================================================================

/**
 * Insert a pending delegation completion. Idempotent: re-emits don't
 * disturb the scheduled retry of an existing entry. Parent ids are
 * always (re-)written so re-parenting on resume keeps pending data
 * aligned with the reverse index.
 *
 * MUST be called BEFORE the child's result-stream message is acked. If
 * the process crashes between writing child terminal state and this
 * upsert, message replay must be allowed to re-create the lifecycle
 * entry; that's the at-least-once invariant the entire layer rests on.
 *
 * @returns true if a new entry was created, false if it already existed.
 */
export async function upsertPendingDelegationCompletion(
  redis: Redis,
  tenantId: string,
  childRunId: string,
  parentRunId: string,
  parentStepExecutionId: string,
  dueAtMs?: number,
): Promise<boolean> {
  const member = makeMember(tenantId, childRunId);
  const result = await redis.eval(
    UPSERT_PENDING_LUA,
    2,
    StreamKeys.delegationPendingKey,
    StreamKeys.delegationPendingDataKey(tenantId, childRunId),
    member,
    String(dueAtMs ?? Date.now()),
    parentRunId,
    parentStepExecutionId,
  );
  return result === 1;
}

/**
 * Claim up to `batchSize` due entries (score <= now). Each entry is
 * claimed atomically (per-member Lua): score bumps to `now + leaseMs`
 * and the claim is stamped, all in one round trip per entry. Two
 * workers can't both hold a fresh claim on the same member.
 *
 * Note: this is also the reclaim path. If a worker crashed mid-process,
 * its claim's score eventually drops below `now` (after leaseMs) and the
 * next call here picks it up. No separate reclaim sweep needed.
 *
 * The candidate list is read with a non-atomic ZRANGEBYSCORE; another
 * worker may claim some of the candidates before we get to them. That's
 * fine — the per-entry Lua's score check rejects stale candidates and
 * we move on.
 */
export async function claimDuePendingDelegations(
  redis: Redis,
  workerId: string,
  leaseMs: number,
  batchSize: number,
  nowMs?: number,
): Promise<ClaimedDelegation[]> {
  const now = nowMs ?? Date.now();
  const newScore = now + leaseMs;
  const candidates = await redis.zrangebyscore(
    StreamKeys.delegationPendingKey,
    '-inf',
    String(now),
    'LIMIT',
    0,
    batchSize,
  );
  if (candidates.length === 0) return [];

  const claimed: ClaimedDelegation[] = [];
  for (const member of candidates) {
    const parsed = parseMember(member);
    if (!parsed) continue;
    const dataKey = StreamKeys.delegationPendingDataKey(parsed.tenantId, parsed.childRunId);
    const ok = (await redis.eval(
      CLAIM_ONE_LUA,
      2,
      StreamKeys.delegationPendingKey,
      dataKey,
      member,
      String(now),
      String(newScore),
      workerId,
    )) as number;
    if (ok !== 1) continue; // already claimed by another worker or removed

    const hash = await redis.hgetall(dataKey);
    const parentRunId = hash['parentRunId'] ?? '';
    const parentStepExecutionId = hash['parentStepExecutionId'] ?? '';
    const attemptStr = hash['attempt'] ?? '0';
    const escalationsStr = hash['escalations'];
    const lastError = hash['lastError'];
    const data: DelegationPendingData = {
      parentRunId,
      parentStepExecutionId,
      attempt: Number.parseInt(attemptStr, 10) || 0,
      claimedBy: workerId,
      claimedAt: now,
    };
    if (escalationsStr) {
      const n = Number.parseInt(escalationsStr, 10);
      if (Number.isFinite(n)) data.escalations = n;
    }
    if (lastError) data.lastError = lastError;
    claimed.push({
      tenantId: parsed.tenantId,
      childRunId: parsed.childRunId,
      data,
    });
  }
  return claimed;
}

/**
 * Reschedule a claimed entry for retry. Bumps attempt, sets next due,
 * clears the claim stamps. Used when the drain finishes processing an
 * entry without the parent step reaching terminal — the lease releases
 * but the entry remains pending.
 */
export async function releasePendingDelegation(
  redis: Redis,
  tenantId: string,
  childRunId: string,
  nextDueAtMs: number,
  attempt: number,
  lastError?: string,
): Promise<boolean> {
  const member = makeMember(tenantId, childRunId);
  const result = await redis.eval(
    RELEASE_LUA,
    2,
    StreamKeys.delegationPendingKey,
    StreamKeys.delegationPendingDataKey(tenantId, childRunId),
    member,
    String(nextDueAtMs),
    String(attempt),
    lastError ?? '',
  );
  return result === 1;
}

/**
 * Post-escalation release: bump `escalations`, reschedule with backoff,
 * release lease. The lifecycle stays pending; the drain re-checks on
 * the next tick whether the synthetic FAILED was actually applied to
 * the parent step. Returns the new escalation count (or 0 if the
 * entry was concurrently cleaned up).
 */
export async function releasePendingDelegationAfterEscalation(
  redis: Redis,
  tenantId: string,
  childRunId: string,
  nextDueAtMs: number,
  lastError?: string,
): Promise<number> {
  const member = makeMember(tenantId, childRunId);
  const result = await redis.eval(
    RELEASE_AFTER_ESCALATION_LUA,
    2,
    StreamKeys.delegationPendingKey,
    StreamKeys.delegationPendingDataKey(tenantId, childRunId),
    member,
    String(nextDueAtMs),
    lastError ?? '',
  );
  return Number(result) || 0;
}

/**
 * Tear down lifecycle state after the parent step is observed terminal.
 * Atomic: ZREM pending + DEL data + DEL reverse index.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export async function completeDelegationLifecycle(
  redis: Redis,
  tenantId: string,
  childRunId: string,
): Promise<boolean> {
  return tearDownLifecycle(redis, tenantId, childRunId);
}

/**
 * Tear down lifecycle state on explicit cancel/abort (parent failure,
 * run cancel). Same Redis ops as `completeDelegationLifecycle`; the
 * distinction is semantic — callers log the reason that fits.
 */
export async function abortDelegationLifecycle(
  redis: Redis,
  tenantId: string,
  childRunId: string,
): Promise<boolean> {
  return tearDownLifecycle(redis, tenantId, childRunId);
}

async function tearDownLifecycle(
  redis: Redis,
  tenantId: string,
  childRunId: string,
): Promise<boolean> {
  const member = makeMember(tenantId, childRunId);
  const result = await redis.eval(
    TEARDOWN_LUA,
    3,
    StreamKeys.delegationPendingKey,
    StreamKeys.delegationPendingDataKey(tenantId, childRunId),
    StreamKeys.delegationParentKey(tenantId, childRunId),
    member,
  );
  return result === 1;
}

/**
 * Read the full pending data hash for a child (parent ids + attempt +
 * claim metadata). Returns null if the entry doesn't exist or has no
 * parent ids.
 */
export async function getPendingDelegationData(
  redis: Redis,
  tenantId: string,
  childRunId: string,
): Promise<DelegationPendingData | null> {
  const dataKey = StreamKeys.delegationPendingDataKey(tenantId, childRunId);
  const hash = await redis.hgetall(dataKey);
  if (Object.keys(hash).length === 0) return null;
  return parseDataHash(hash);
}

/**
 * Read the reverse-index hash for a child. Returns null if missing.
 * Used by the drain as a fallback path when pending data is missing.
 */
export async function getDelegationParent(
  redis: Redis,
  tenantId: string,
  childRunId: string,
): Promise<{ parentRunId: string; parentStepExecutionId: string } | null> {
  const key = StreamKeys.delegationParentKey(tenantId, childRunId);
  const hash = await redis.hgetall(key);
  const parentRunId = hash['parentRunId'];
  const parentStepExecutionId = hash['parentStepExecutionId'];
  if (!parentRunId || !parentStepExecutionId) return null;
  return { parentRunId, parentStepExecutionId };
}

/**
 * Total count of pending entries across all tenants. Useful for
 * operational metrics ("how many cascades are unresolved right now?").
 */
export async function getPendingDelegationCount(redis: Redis): Promise<number> {
  return redis.zcard(StreamKeys.delegationPendingKey);
}
