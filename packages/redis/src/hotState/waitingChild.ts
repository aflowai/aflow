import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
// ============================================================================

const ADD_WAITING_CHILD_LUA = `
local stateKey = KEYS[1]
local revKey = KEYS[2]
local childId = ARGV[1]
local parentRunId = ARGV[2]
local parentStepExecutionId = ARGV[3]
redis.call('HSET', revKey, 'parentRunId', parentRunId, 'parentStepExecutionId', parentStepExecutionId)
local raw = redis.call('HGET', stateKey, 'waitingForChildSessionIds')
local arr = {}
if raw and raw ~= '' then
  arr = cjson.decode(raw)
end
for _, id in ipairs(arr) do
  if id == childId then return #arr end
end
table.insert(arr, childId)
redis.call('HSET', stateKey, 'waitingForChildSessionIds', cjson.encode(arr))
return #arr
`;

/**
 * Lua script: atomically remove a childRunId from waitingForChildSessionIds.
 * Returns the remaining count (0 means all children completed).
 */
const REMOVE_WAITING_CHILD_LUA = `
local key = KEYS[1]
local childId = ARGV[1]
local raw = redis.call('HGET', key, 'waitingForChildSessionIds')
if not raw or raw == '' then return 0 end
local arr = cjson.decode(raw)
local newArr = {}
for _, id in ipairs(arr) do
  if id ~= childId then table.insert(newArr, id) end
end
if #newArr == 0 then
  redis.call('HDEL', key, 'waitingForChildSessionIds')
else
  redis.call('HSET', key, 'waitingForChildSessionIds', cjson.encode(newArr))
end
return #newArr
`;

export async function addWaitingChild(
  redis: Redis,
  tenantId: string,
  parentRunId: string,
  parentStepExecutionId: string,
  childRunId: string,
): Promise<number> {
  const stateKey = StreamKeys.sessionStateKey(tenantId, parentRunId);
  const revKey = StreamKeys.delegationParentKey(tenantId, childRunId);
  const result = await redis.eval(
    ADD_WAITING_CHILD_LUA,
    2,
    stateKey,
    revKey,
    childRunId,
    parentRunId,
    parentStepExecutionId,
  );
  return result as number;
}

/**
 * Atomically remove a child run ID from a parent's waitingForChildSessionIds.
 * @returns The remaining count (0 means all children completed).
 */
export async function removeWaitingChild(
  redis: Redis,
  tenantId: string,
  parentRunId: string,
  childRunId: string,
): Promise<number> {
  const key = StreamKeys.sessionStateKey(tenantId, parentRunId);
  const result = await redis.eval(REMOVE_WAITING_CHILD_LUA, 1, key, childRunId);
  return result as number;
}
