/**
 * Whether sandboxed code can run here.
 *
 * The claim is settled at boot and is the only half a policy refusal may rest
 * on: an executor that has not registered its first heartbeat, or one stopped
 * for an afternoon, must not turn a stored decision into a refusal.
 */
import type { Redis } from 'ioredis';
import { hasAvailableExecutor } from '@aflow/redis';
import type { ComputeAvailability, EditionDescriptor } from '@aflow/schemas';

/**
 * How long one reading stands for.
 *
 * `hasAvailableExecutor` scans the keyspace, which is O(keys) however narrow the
 * prefix, so it must not run once per request. Heartbeats refresh on a 10s tick
 * under a 60s expiry, so a reading held for a fraction of that is within the
 * resolution the signal has anyway.
 */
const READING_HOLDS_MS = 5_000;

/** Per connection, so a process holds one reading and a test holds none. */
const readings = new WeakMap<Redis, { takenAt: number; alive: boolean }>();

async function executorIsAnswering(redis: Redis): Promise<boolean> {
  const now = Date.now();
  const held = readings.get(redis);
  if (held !== undefined && now - held.takenAt < READING_HOLDS_MS) return held.alive;

  const alive = await hasAvailableExecutor(redis, 'compute');
  readings.set(redis, { takenAt: now, alive });
  return alive;
}

export async function readComputeAvailability(
  redis: Redis | null | undefined,
  edition: EditionDescriptor,
): Promise<ComputeAvailability> {
  const composed = edition.computeRuntime;
  if (redis === null || redis === undefined) return { composed, executor: 'unknown' };
  try {
    return { composed, executor: (await executorIsAnswering(redis)) ? 'up' : 'down' };
  } catch {
    // A Redis that cannot be reached is not a stopped executor.
    return { composed, executor: 'unknown' };
  }
}
