import type { Redis } from 'ioredis';
import { getStepState, type SessionHotState, type StepHotState } from '@aflow/redis';

export interface HotStateSnapshot {
  runHotState: SessionHotState;
  stepHotStates: Record<string, StepHotState>;
}

/**
 * The durable copy of a resting run, so it can come back after Redis forgets.
 *
 * Only resting states carry one. A run that is still executing will be written
 * again shortly, and a finished run has nothing left to resume — but a paused
 * run may sit for weeks, long past the hot state's TTL, and without this it
 * could never be resumed at all.
 *
 * Shared because two workers flush the same dirty set and either may get there
 * first. If only one of them wrote the snapshot, whether a run stayed
 * resumable would depend on which worker happened to win.
 */
export async function buildHotStateSnapshot(
  redis: Redis,
  tenantId: string,
  runState: SessionHotState,
): Promise<HotStateSnapshot | null> {
  if (runState.status !== 'PAUSED' && runState.status !== 'WAITING_ON_CHILD') return null;

  const snapshot: HotStateSnapshot = { runHotState: runState, stepHotStates: {} };

  // The step the run is parked on — resuming needs it.
  if (runState.currentStepExecutionId) {
    const stepState = await getStepState(redis, tenantId, runState.currentStepExecutionId);
    if (stepState) snapshot.stepHotStates[runState.currentStepExecutionId] = stepState;
  }

  return snapshot;
}
