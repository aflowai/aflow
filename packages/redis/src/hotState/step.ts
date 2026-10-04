import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import type { StepHotState } from './schemas.js';
import { HOT_STATE_TTL_SECONDS, StepHotStateSchema } from './schemas.js';
import {
  serializeForHash,
  serializeForHashWithDeletes,
  deserializeFromHash,
} from './serialization.js';
import {
  stepStallCandidateForScript,
  syncStepStallCandidateForStep,
} from './stepStallCandidates.js';
// ============================================================================
// Step State Operations
// ============================================================================

/**
 * Set step hot state in Redis hash.
 */
export async function setStepState(
  redis: Redis,
  state: StepHotState,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<void> {
  const key = StreamKeys.stepStateKey(state.tenantId, state.stepExecutionId);
  const serialized = serializeForHash(state);

  const pipeline = redis.pipeline();
  pipeline.del(key);
  pipeline.hset(key, serialized);
  pipeline.expire(key, ttlSeconds);
  syncStepStallCandidateForStep(pipeline, state.tenantId, state.sessionId, state, Date.now());
  await pipeline.exec();
}

/**
 * Create a step's hot state only if the key is absent, atomically.
 *
 * `setStepState` is DEL-then-HSET, which is right for a writer that owns the
 * step and wrong for one filling a gap: between reading "absent" and writing,
 * a concurrent wake can recreate the step and complete it, and the write would
 * roll it back to the older snapshot it came from. Restoring a cold step is
 * exactly that second case, so the emptiness check and the write have to be
 * one operation.
 *
 * No stall candidate is armed: the arm is a no-op for the resting statuses a
 * restore writes (`stepStallEarliestReapAtMs` returns null for them), and a
 * step that is live enough to stall was not restored by this call.
 *
 * @returns true if this call created the hash, false if one already existed.
 */
export async function setStepStateIfAbsent(
  redis: Redis,
  state: StepHotState,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<boolean> {
  const key = StreamKeys.stepStateKey(state.tenantId, state.stepExecutionId);
  const serialized = serializeForHash(state);
  const fields = Object.entries(serialized).flat();

  const created = await redis.eval(
    `
    if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
    redis.call('HSET', KEYS[1], unpack(ARGV, 2))
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
    return 1
  `,
    1,
    key,
    String(ttlSeconds),
    ...fields,
  );
  return created === 1;
}

/**
 * Get step hot state from Redis.
 */
export async function getStepState(
  redis: Redis,
  tenantId: string,
  stepExecutionId: string,
): Promise<StepHotState | null> {
  const key = StreamKeys.stepStateKey(tenantId, stepExecutionId);
  const data = await redis.hgetall(key);

  if (Object.keys(data).length === 0) {
    return null;
  }

  try {
    const parsed = deserializeFromHash(data);
    return StepHotStateSchema.parse(parsed);
  } catch (error) {
    console.error('Failed to parse step state:', error);
    return null;
  }
}

/**
 * Update specific fields in step state.
 *
 * `sessionId` is required rather than optional because the stall index is keyed
 * by session: a patch that flips a step back into flight — a retry, a parked
 * step woken to accept a synthetic result — has to re-arm the session it
 * belongs to, and the step execution id alone cannot name it. It is a
 * `StepHotState` field, so passing it also rewrites the value already there.
 */
export async function updateStepState(
  redis: Redis,
  tenantId: string,
  stepExecutionId: string,
  updates: Partial<StepHotState> & { sessionId: string },
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<void> {
  const key = StreamKeys.stepStateKey(tenantId, stepExecutionId);
  const { toSet, toDelete } = serializeForHashWithDeletes(updates);

  const pipeline = redis.pipeline();
  if (Object.keys(toSet).length > 0) {
    pipeline.hset(key, toSet);
  }
  if (toDelete.length > 0) {
    pipeline.hdel(key, ...toDelete);
  }
  pipeline.expire(key, ttlSeconds);
  syncStepStallCandidateForStep(pipeline, tenantId, updates.sessionId, updates, Date.now());
  await pipeline.exec();
}

const CAS_STEP_STATE_LUA = `
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'attempt') ~= ARGV[2] then return 0 end
local setArgCount = tonumber(ARGV[6])
if setArgCount > 0 then
  redis.call('HSET', KEYS[1], unpack(ARGV, 7, 6 + setArgCount))
end
if #ARGV > 6 + setArgCount then
  redis.call('HDEL', KEYS[1], unpack(ARGV, 7 + setArgCount))
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
if ARGV[4] ~= '' then
  redis.call('ZADD', KEYS[2], tonumber(ARGV[4]), ARGV[5])
end
return 1
`;

/**
 * `updateStepState`, applied only while the step still holds `expected`'s
 * status and attempt. Returns false, with nothing written, once it does not.
 *
 * For a writer that read the step and decided from what it read: a cancel,
 * retry or result landing between that read and this write is authoritative,
 * and a last-write-wins patch would put the step back to what it was. The
 * stall candidate is armed inside the same script, and only when the write
 * lands.
 */
export async function casUpdateStepState(
  redis: Redis,
  tenantId: string,
  stepExecutionId: string,
  expected: Pick<StepHotState, 'status' | 'attempt'>,
  updates: Partial<StepHotState> & { sessionId: string },
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<boolean> {
  const { toSet, toDelete } = serializeForHashWithDeletes(updates);
  const setArgs = Object.entries(toSet).flat();
  const stall = stepStallCandidateForScript(tenantId, updates.sessionId, updates, Date.now());
  const written = await redis.eval(
    CAS_STEP_STATE_LUA,
    2,
    StreamKeys.stepStateKey(tenantId, stepExecutionId),
    stall.key,
    expected.status,
    String(expected.attempt),
    String(ttlSeconds),
    stall.dueAtMs === null ? '' : String(stall.dueAtMs),
    stall.member,
    String(setArgs.length),
    ...setArgs,
    ...toDelete,
  );
  return written === 1;
}
