import type { Redis } from 'ioredis';

/**
 * Symmetric barrier-watchdog cleanup for the failure-side decrement: when a
 * barrier-tracked tool result drops the pending count to zero, the watchdog
 * entry must be removed directly (mirroring the success path) rather than left
 * for the periodic sweep to drop. Returns whether a removal was issued.
 */
export async function removeBarrierWatchdogOnClear(
  redis: Redis,
  remove: (redis: Redis, tenantId: string, runId: string, agentStepId: string) => Promise<void>,
  args: { tenantId: string; runId: string; agentStepId: string; newCount: number },
): Promise<boolean> {
  if (args.newCount !== 0) return false;
  await remove(redis, args.tenantId, args.runId, args.agentStepId).catch(() => {});
  return true;
}
