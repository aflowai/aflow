import type { Redis } from 'ioredis';
import { ENTITY_EVENTS_STREAM_KEY, ENTITY_EVENTS_TTL_SECONDS } from './entityEvents.js';

function legacyEventTypeMap(): Record<string, string> {
  return {
    'entity.bootstrapped': 'entity.space.bootstrapped',
    'entity.directives_updated': 'entity.directives.updated',
    'entity.worker.dispatched': 'entity.runner.dispatched',
    'entity.worker.completed': 'entity.runner.completed',
    'entity.learner.duplicateSuppressed': 'entity.coach.suppressed',
    'entity.skill.create.attempt': 'entity.skill.authored',
  };
}

function fieldsToRecord(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (k !== undefined && v !== undefined) obj[k] = v;
  }
  return obj;
}

function recordToFields(obj: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    out.push(k, v);
  }
  return out;
}

function mapEventType(eventType: string, _payloadRaw: string | undefined): string {
  const direct = legacyEventTypeMap()[eventType];
  if (direct) return direct;
  const learnerPrefix = 'entity.learner.';
  if (eventType.startsWith(learnerPrefix)) {
    return 'entity.coach.' + eventType.slice(learnerPrefix.length);
  }
  return eventType;
}

function migratePayloadJson(payloadRaw: string | undefined): string | undefined {
  if (payloadRaw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(payloadRaw);
    const migrated = migratePayloadValue(parsed);
    return JSON.stringify(migrated);
  } catch {
    return payloadRaw
      .replaceAll('cybernetic-executive', 'cybernetic-helmsman')
      .replaceAll('cybernetic-worker', 'cybernetic-runner')
      .replaceAll('cybernetic-learner', 'cybernetic-coach')
      .replaceAll('worker_model', 'runner_model')
      .replaceAll('worker_system_prompt', 'runner_system_prompt')
      .replaceAll('worker_tools', 'runner_tools')
      .replaceAll('cybernetic_worker_id', 'cybernetic_runner_id')
      .replaceAll('cybernetic_learner_id', 'cybernetic_coach_id');
  }
}

function migratePayloadValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replaceAll('cybernetic-executive', 'cybernetic-helmsman')
      .replaceAll('cybernetic-worker', 'cybernetic-runner')
      .replaceAll('cybernetic-learner', 'cybernetic-coach')
      .replaceAll('worker_model', 'runner_model')
      .replaceAll('worker_system_prompt', 'runner_system_prompt')
      .replaceAll('worker_tools', 'runner_tools')
      .replaceAll('cybernetic_worker_id', 'cybernetic_runner_id')
      .replaceAll('cybernetic_learner_id', 'cybernetic_coach_id');
  }
  if (Array.isArray(value)) {
    return value.map((x) => migratePayloadValue(x));
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      let nk = k;
      if (k === 'executive') nk = 'helmsman';
      else if (k === 'worker') nk = 'runner';
      else if (k === 'learner') nk = 'coach';
      next[nk] = migratePayloadValue(v);
    }
    return next;
  }
  return value;
}

function entryNeedsRewrite(before: Record<string, string>, after: Record<string, string>): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

async function rewriteEntityEventStreamKey(
  redis: Redis,
  key: string,
): Promise<{ rewritten: boolean; entries: number }> {
  const entries = await redis.xrange(key, '-', '+');
  if (entries.length === 0) return { rewritten: false, entries: 0 };

  const rebuilt: string[][] = [];
  let needs = false;

  for (const [, fields] of entries) {
    const rec = fieldsToRecord(fields);
    const next = { ...rec };
    if (next['eventType']) {
      const prevType = next['eventType'];
      next['eventType'] = mapEventType(prevType, next['payload']);
    }
    if (next['payload'] !== undefined) {
      next['payload'] = migratePayloadJson(next['payload']) ?? next['payload'];
    }
    if (entryNeedsRewrite(rec, next)) {
      needs = true;
    }
    rebuilt.push(recordToFields(next));
  }

  if (!needs) return { rewritten: false, entries: entries.length };

  const tempKey = `${key}:104a-replay`;
  await redis.del(tempKey);
  for (const pair of rebuilt) {
    await redis.xadd(tempKey, '*', ...pair);
  }
  const backupKey = `${key}:104a-bak`;
  await redis.del(backupKey);
  await redis.rename(key, backupKey);
  await redis.rename(tempKey, key);
  await redis.del(backupKey);
  await redis.expire(key, ENTITY_EVENTS_TTL_SECONDS);

  return { rewritten: true, entries: entries.length };
}

/**
 * Scan Redis for `entity_events:*` keys and replay entries when event types or
 * payloads still use pre-104a strings.
 */
export async function relabelEntityEventStreams104a(redis: Redis): Promise<{
  streamsRewritten: number;
  entriesReplayed: number;
}> {
  let streamsRewritten = 0;
  let entriesReplayed = 0;

  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'entity_events:*', 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  for (const key of keys) {
    const { rewritten, entries } = await rewriteEntityEventStreamKey(redis, key);
    if (rewritten) {
      streamsRewritten += 1;
      entriesReplayed += entries;
    }
  }

  return { streamsRewritten, entriesReplayed };
}

/**
 * Relabel the stream for one space (targeted helper).
 */
export async function relabelEntityEventStream104aForSpace(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<{ streamsRewritten: number; entriesReplayed: number }> {
  const key = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);
  const exists = await redis.exists(key);
  if (!exists) return { streamsRewritten: 0, entriesReplayed: 0 };
  const { rewritten, entries } = await rewriteEntityEventStreamKey(redis, key);
  return {
    streamsRewritten: rewritten ? 1 : 0,
    entriesReplayed: rewritten ? entries : 0,
  };
}
