import type { Redis } from 'ioredis';
import { StreamKeys, ConsumerGroups, EXECUTOR_JOB_STEP_TYPES } from '@aflow/schemas';
// ============================================================================
// Stream Hygiene (startup cleanup)
// ============================================================================

interface ConsumerInfo {
  name: string;
  pending: number;
  idle: number;
}

/**
 * Remove stale (dead) consumers from a single consumer group.
 * A consumer is considered stale if it has 0 pending messages and has been
 * idle for longer than `maxIdleMs`.
 *
 * Returns the number of consumers removed.
 */
async function cleanupGroupConsumers(
  redis: Redis,
  streamKey: string,
  groupName: string,
  maxIdleMs: number,
): Promise<number> {
  let consumers: ConsumerInfo[];
  try {
    const raw = (await redis.xinfo('CONSUMERS', streamKey, groupName)) as unknown[];
    consumers = parseConsumerInfoArray(raw);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const c of consumers) {
    if (c.pending === 0 && c.idle > maxIdleMs) {
      try {
        await redis.xgroup('DELCONSUMER', streamKey, groupName, c.name);
        removed++;
      } catch {
        // Consumer may have been removed concurrently
      }
    }
  }
  return removed;
}

function parseConsumerInfoArray(raw: unknown[]): ConsumerInfo[] {
  const result: ConsumerInfo[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    const map = flatPairsToRecord(entry as string[]);
    result.push({
      name: map['name'] ?? '',
      pending: parseInt(map['pending'] ?? '0', 10),
      idle: parseInt(map['idle'] ?? '0', 10),
    });
  }
  return result;
}

function flatPairsToRecord(pairs: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < pairs.length; i += 2) {
    const key = pairs[i];
    const val = pairs[i + 1];
    if (key !== undefined && val !== undefined) {
      record[key] = val;
    }
  }
  return record;
}

export interface StreamCleanupResult {
  consumersRemoved: number;
  streamsChecked: number;
}

/**
 * Remove stale consumers from all known consumer groups.
 * Call on orchestrator/executor startup to clean up consumers left behind by
 * processes that were killed without graceful shutdown.
 *
 * Only removes consumers with 0 pending entries that have been idle for over
 * `maxIdleMs` (default 60s), so active consumers are never touched.
 */
export async function cleanupStaleConsumers(
  redis: Redis,
  maxIdleMs = 60_000,
): Promise<StreamCleanupResult> {
  let consumersRemoved = 0;
  let streamsChecked = 0;

  // Job stream groups
  for (const stepType of EXECUTOR_JOB_STEP_TYPES) {
    const n = await cleanupGroupConsumers(
      redis,
      StreamKeys.jobStream(stepType),
      ConsumerGroups.executor(stepType),
      maxIdleMs,
    );
    consumersRemoved += n;
    streamsChecked++;
  }

  return { consumersRemoved, streamsChecked };
}
