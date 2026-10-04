import type { Redis } from 'ioredis';
import type { SessionHotState, StepHotState } from '@aflow/redis';
import type { StepType } from '@aflow/schemas';
import type { ShardManager } from '../../ShardManager.js';
import {
  classifyStepCompletionPath,
  type StepCompletionPathDeps,
  type StepInFlightStatus,
} from './stepCompletionPath.js';

export interface RescuableOrphanDeps {
  redis: Redis;
  getStepState: (
    redis: Redis,
    tenantId: string,
    stepExecutionId: string,
  ) => Promise<StepHotState | null>;
  getStepInFlight: (redis: Redis, stepExecutionId: string) => Promise<StepInFlightStatus>;
  hasAvailableExecutor: (redis: Redis, stepType: StepType) => Promise<boolean>;
  getShardTimer: StepCompletionPathDeps['getShardTimer'];
  /** When present, the session must be owned by this shard to be rescuable. */
  shardManager: ShardManager | undefined;
}

export interface IsRescuableOrphanOpts {
  /** Pre-fetched current step state — supply to avoid a redundant getStepState read. */
  stepState?: StepHotState | null;
  /** Wall clock for the completion-path graces; defaults to Date.now(). */
  now?: number;
}

/**
 * §0 rescuable-orphan predicate for the parallel-barrier sweep, over the same
 * `classifyStepCompletionPath` that orphan recovery and the stall watchdog
 * read, so the three cannot drift. A session is a rescuable
 * orphan ONLY when **no authoritative completion path exists** for its current
 * step: it is RUNNING, the current step is still STARTED/SCHEDULED, and
 * `classifyStepCompletionPath` finds no live executor in-flight, no scheduled
 * pickup grace, no snooze window and no executor wait. Elapsed wall-clock age is never, by
 * itself, evidence of failure — a long `snooze` or a live in-flight executor
 * call is healthy and must not be recovered.
 */
export async function isRescuableOrphan(
  deps: RescuableOrphanDeps,
  state: SessionHotState,
  opts?: IsRescuableOrphanOpts,
): Promise<boolean> {
  if (state.status !== 'RUNNING') return false;
  if (!state.currentStepExecutionId) return false;
  if (deps.shardManager && !deps.shardManager.ownsRun(state.sessionId)) return false;

  const stepState =
    opts && 'stepState' in opts
      ? opts.stepState
      : await deps.getStepState(deps.redis, state.tenantId, state.currentStepExecutionId);
  if (!stepState) return false;
  if (stepState.status !== 'STARTED' && stepState.status !== 'SCHEDULED') return false;

  const { hasCompletionPath } = await classifyStepCompletionPath(
    {
      redis: deps.redis,
      getStepInFlight: deps.getStepInFlight,
      hasAvailableExecutor: deps.hasAvailableExecutor,
      getShardTimer: deps.getShardTimer,
    },
    stepState,
    opts?.now ?? Date.now(),
  );
  return !hasCompletionPath;
}
