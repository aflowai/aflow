import type { Redis } from 'ioredis';
import type { SessionHotState, StepHotState, StaleBarrier } from '@aflow/redis';
import {
  peekStaleBarriers,
  claimBarrier,
  refreshBarrier,
  dropBarrier,
  registerBarrierWatchdog,
} from '@aflow/redis';
import type { StepType } from '@aflow/schemas';
import type { ShardManager } from '../../ShardManager.js';
import { isRescuableOrphan } from './rescuableOrphan.js';
import type { StepInFlightStatus } from './stepCompletionPath.js';

/**
 * Bounded grace for a CANCELLING session before its barrier is dropped, measured
 * as score-age beyond `maxAgeMs` (the sweep does NOT bump a CANCELLING entry's
 * score, so its age keeps advancing and it is re-examined every tick). At the
 * 30s sweep cadence this is ~3 ticks — enough for the cancel path to clear the
 * barrier naturally, without refreshing it forever.
 */
const CANCELLING_GRACE_MS = 90_000;

export interface BarrierSweepLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface SweepStaleBarriersDeps {
  redis: Redis;
  getSessionState: (
    redis: Redis,
    tenantId: string,
    runId: string,
  ) => Promise<SessionHotState | null>;
  getStepState: (
    redis: Redis,
    tenantId: string,
    stepExecutionId: string,
  ) => Promise<StepHotState | null>;
  getStepInFlight: (redis: Redis, stepExecutionId: string) => Promise<StepInFlightStatus>;
  hasAvailableExecutor: (redis: Redis, stepType: StepType) => Promise<boolean>;
  /** Ceiling on candidates examined per cycle. */
  maxBatch?: number;
  /** Aborted when the cycle runs past its budget; checked between candidates. */
  signal?: AbortSignal;
  /**
   * Atomic version-conditional write of `runtimeState` — returns false when a
   * concurrent legitimate mutation already advanced the version (so a synthetic
   * recovery can never clobber a real tool-result decrement).
   */
  casUpdateSessionRuntimeState: (
    redis: Redis,
    tenantId: string,
    runId: string,
    expectedVersion: number,
    newRuntimeState: SessionHotState['runtimeState'],
  ) => Promise<boolean>;
  shardManager: ShardManager | undefined;
  logger: BarrierSweepLogger;
  maxAgeMs: number;
}

type StatusClass = 'terminal' | 'resting' | 'cancelling' | 'anomalous' | 'running';

/** Single uppercase status classifier — no scattered string literals downstream. */
function classifyStatus(status: SessionHotState['status']): StatusClass {
  switch (status) {
    case 'SUCCEEDED':
    case 'FAILED':
    case 'CANCELLED':
      return 'terminal';
    case 'PAUSED':
    case 'WAITING_ON_CHILD':
      return 'resting';
    case 'CANCELLING':
      return 'cancelling';
    case 'QUEUED':
    case 'STALLED':
      return 'anomalous';
    case 'RUNNING':
      return 'running';
    default:
      // Any unrecognized/future status is treated as anomalous (→ logged + the
      // barrier dropped) rather than ever being force-recovered.
      return 'anomalous';
  }
}

interface InlineRefVar {
  ref?: { kind: string; value?: unknown };
}

function readPendingCount(state: SessionHotState, agentStepId: string): number {
  const rt = state.runtimeState;
  if (!rt) return 0;
  const entry = rt.variables[`ai.agent.pendingToolCallCount.${agentStepId}`] as
    InlineRefVar | undefined;
  if (entry?.ref?.kind === 'inline' && typeof entry.ref.value === 'number') {
    return entry.ref.value;
  }
  return 0;
}

/**
 * Periodic, completion-path-aware sweep of stale parallel barriers (Plan 230 §0).
 * For each stale candidate it reads the authoritative session state and only
 * synthesizes a failure when NO completion path exists — healthy resting waits
 * and live executor/timer calls are refreshed, never recovered. The mutating
 * recovery is an atomic version-CAS so it cannot clobber a concurrent decrement,
 * and only the shard that owns the run acts.
 */
export interface BarrierSweepResult {
  candidates: number;
  processed: number;
}

export async function sweepStaleBarriers(
  deps: SweepStaleBarriersDeps,
): Promise<BarrierSweepResult> {
  const { redis, logger, maxAgeMs } = deps;
  let candidates: StaleBarrier[];
  try {
    candidates = await peekStaleBarriers(redis, maxAgeMs, deps.maxBatch);
  } catch (err) {
    logger.warn('Barrier sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { candidates: 0, processed: 0 };
  }

  const now = Date.now();
  let processed = 0;
  for (const candidate of candidates) {
    if (deps.signal?.aborted) break;
    try {
      await processStaleBarrier(deps, candidate, now);
      processed++;
    } catch (err) {
      logger.warn('Failed to process stale barrier', {
        barrier: candidate.entry,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { candidates: candidates.length, processed };
}

async function processStaleBarrier(
  deps: SweepStaleBarriersDeps,
  candidate: StaleBarrier,
  now: number,
): Promise<void> {
  const { redis } = deps;
  const { entry, member, score } = candidate;

  // Sweeping is shared infra: only the owning shard acts, so a non-owner can't
  // refresh a barrier it doesn't own and reset the owner's staleness clock.
  if (deps.shardManager && !deps.shardManager.ownsRun(entry.runId)) return;

  const state = await deps.getSessionState(redis, entry.tenantId, entry.runId);

  // Missing session → drop.
  if (!state?.runtimeState) {
    await dropBarrier(redis, member);
    return;
  }

  const count = readPendingCount(state, entry.agentStepId);
  // Resolved (or never tracked) → drop.
  if (count <= 0) {
    await dropBarrier(redis, member);
    return;
  }

  switch (classifyStatus(state.status)) {
    case 'terminal':
      await dropBarrier(redis, member);
      return;
    case 'resting':
      // Legitimate resting wait (PAUSED / WAITING_ON_CHILD) → never recover;
      // push the re-examination out by another maxAgeMs.
      await refreshBarrier(redis, member, now);
      return;
    case 'cancelling':
      if (now - score >= deps.maxAgeMs + CANCELLING_GRACE_MS) {
        await dropBarrier(redis, member);
      }
      // else: leave untouched so the score-age grace clock keeps advancing.
      return;
    case 'anomalous':
      deps.logger.warn('Barrier sweep: live barrier on anomalous session status', {
        tenantId: entry.tenantId,
        runId: entry.runId,
        agentStepId: entry.agentStepId,
        status: state.status,
        pendingCount: count,
      });
      await dropBarrier(redis, member);
      return;
    case 'running':
      await processRunningBarrier(deps, candidate, state, now);
      return;
  }
}

async function processRunningBarrier(
  deps: SweepStaleBarriersDeps,
  candidate: StaleBarrier,
  state: SessionHotState,
  now: number,
): Promise<void> {
  const { redis } = deps;
  const { entry, member } = candidate;

  if (!(await rescuable(deps, state, now))) {
    // A live executor call or scheduled timer still has a completion path.
    await refreshBarrier(redis, member, now);
    return;
  }

  // Ownership-aware atomic claim: exactly one orchestrator wins the ZREM.
  const claimed = await claimBarrier(redis, member);
  if (!claimed) return;

  // Re-read after the claim and re-classify against the latest state.
  const fresh = await deps.getSessionState(redis, entry.tenantId, entry.runId);
  if (!fresh?.runtimeState) return; // gone → already effectively dropped.
  const freshCount = readPendingCount(fresh, entry.agentStepId);
  if (freshCount <= 0) return; // resolved between peek and claim → dropped.

  if (classifyStatus(fresh.status) !== 'running' || !(await rescuable(deps, fresh, now))) {
    // No longer an orphan → re-register so a future sweep re-evaluates rather
    // than silently losing the watchdog after the claim removed it.
    await registerBarrierWatchdog(redis, entry.tenantId, entry.runId, entry.agentStepId, now);
    return;
  }

  // Atomic version-CAS write keyed on `fresh`. If a concurrent legitimate
  // decrement lands in the re-read→write window it advances the version and the
  // CAS no-ops — the real result is authoritative; re-register for re-evaluation.
  const written = await applyBarrierRecovery(deps, entry, fresh, freshCount, now);
  if (!written) {
    await registerBarrierWatchdog(redis, entry.tenantId, entry.runId, entry.agentStepId, now);
  }
}

async function rescuable(
  deps: SweepStaleBarriersDeps,
  state: SessionHotState,
  now: number,
): Promise<boolean> {
  return isRescuableOrphan(
    {
      redis: deps.redis,
      getStepState: deps.getStepState,
      getStepInFlight: deps.getStepInFlight,
      hasAvailableExecutor: deps.hasAvailableExecutor,
      shardManager: deps.shardManager,
    },
    state,
    { now },
  );
}

/** Returns true if the recovery was written, false if the version-CAS lost to a concurrent write. */
async function applyBarrierRecovery(
  deps: SweepStaleBarriersDeps,
  entry: StaleBarrier['entry'],
  state: SessionHotState,
  count: number,
  now: number,
): Promise<boolean> {
  const rt = state.runtimeState;
  if (!rt) return false;

  const pendingKey = `ai.agent.pendingToolCallCount.${entry.agentStepId}`;
  const pendingResultsKey = `ai.agent.pendingToolResults.${entry.agentStepId}`;

  // A count > 1 recovery force-released a *parallel* barrier: session-level state
  // can only prove the current call is orphaned, so a still-live sibling call may
  // have been force-failed. Surface that case under a distinct, alertable message.
  deps.logger.warn(
    count > 1
      ? 'Recovered a multi-call parallel barrier — a still-live sibling tool call may have been force-failed'
      : 'Releasing orphaned parallel barrier',
    {
      tenantId: entry.tenantId,
      runId: entry.runId,
      agentStepId: entry.agentStepId,
      pendingCount: count,
    },
  );

  const newVars = { ...rt.variables };
  newVars[pendingKey] = {
    ref: { kind: 'inline', value: 0 },
    updatedAtMs: now,
    updatedBy: { actor: 'orchestrator', stepId: entry.agentStepId },
  };

  const resultsEntry = newVars[pendingResultsKey] as InlineRefVar | undefined;
  const accumulated = Array.isArray(resultsEntry?.ref?.value)
    ? [...(resultsEntry.ref.value as unknown[])]
    : [];
  accumulated.push({
    stepId: '_barrier_recovery',
    name: '_barrier_recovery',
    status: 'FAILED',
    summary: `Barrier recovered: ${String(count)} tool call(s) did not complete after ${String(
      Math.round(deps.maxAgeMs / 1000),
    )}s`,
  });
  newVars[pendingResultsKey] = {
    ref: { kind: 'inline', value: accumulated },
    updatedAtMs: now,
    updatedBy: { actor: 'orchestrator', stepId: entry.agentStepId },
  };

  return deps.casUpdateSessionRuntimeState(deps.redis, entry.tenantId, entry.runId, rt.version, {
    ...rt,
    variables: newVars,
    version: rt.version + 1,
    updatedAtMs: now,
  });
}
