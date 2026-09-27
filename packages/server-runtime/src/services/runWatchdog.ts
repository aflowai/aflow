/**
 * Run Watchdog — makes an orphaned QUEUED run visibly STALLED.
 *
 * Candidates come from the queued-session index, scored by creation time, so
 * the read asks only for runs that have already outlived the grace period
 * instead of walking everything holding Redis state. The orchestrator heartbeat
 * is checked first and the index is not touched at all while one is alive:
 * a queued run behind a live orchestrator is not orphaned, it is waiting.
 *
 * Claiming leases the candidate, which is what makes the transition safe on a
 * fleet — the watchdog runs on every warm server instance, and without a single
 * winner each of them writes the same STALLED state and emits the same event.
 *
 * Writes Redis only; the projection worker carries the state to Postgres.
 * Never touches RUNNING runs — the orchestrator is their single writer.
 */
import type { Redis } from 'ioredis';
import { backgroundTaskControlPlane, type BackgroundTaskMode } from '@aflow/schemas';
import {
  isOrchestratorAlive,
  claimDueQueuedSessions,
  dropQueuedSessionCandidate,
  rearmQueuedSessionCandidate,
  getSessionState,
  updateSessionState,
  appendSessionEvent,
  markSessionDirty,
} from '@aflow/redis';
import {
  createBackgroundTaskRunner,
  type BackgroundTaskRunner,
  type BackgroundTaskCycleResult,
} from '@aflow/lib';

// ============================================================================
// Configuration
// ============================================================================

const TASK_ID = 'server.run_watchdog';

export interface RunWatchdogConfig {
  /** How often to scan for orphaned runs (ms). Default: 15_000 (15s). */
  intervalMs?: number;
  /**
   * How long a run can stay QUEUED before being considered orphaned (ms).
   * Default: 30_000 (30s). This should be longer than the orchestrator's
   * expected startup + first heartbeat window.
   */
  gracePeriodMs?: number;
  maxBatch?: number;
  maxCycleMs?: number;
  /** Override the registry's mode, for tests. Production resolves it. */
  mode?: BackgroundTaskMode;
}

export interface RunWatchdogDeps {
  redis: Redis;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
}

export type RunWatchdog = BackgroundTaskRunner;

// ============================================================================
// Implementation
// ============================================================================

export function createRunWatchdog(
  deps: RunWatchdogDeps,
  config: RunWatchdogConfig = {},
): RunWatchdog {
  const { redis, logger: logIn = console } = deps;
  const logger = {
    ...logIn,
    debug:
      logIn.debug ??
      ((...args: unknown[]) => {
        console.debug(...args);
      }),
  };
  // Budgets and mode come from the registry, so an operator raising a ceiling or
  // disabling the task there actually reaches the code that enforces it.
  const runtime = backgroundTaskControlPlane().resolve('server.run_watchdog');
  const {
    intervalMs = runtime.intervalMs ?? 15_000,
    gracePeriodMs = 30_000,
    maxBatch = runtime.maxBatch,
    maxCycleMs = runtime.maxCycleMs,
    mode = runtime.mode,
  } = config;

  async function stallQueuedRun(tenantId: string, runId: string): Promise<boolean> {
    const cutoffMs = Date.now() - gracePeriodMs;
    const state = await getSessionState(redis, tenantId, runId);
    if (state?.status !== 'QUEUED') {
      await dropQueuedSessionCandidate(redis, tenantId, runId);
      return false;
    }
    if (state.createdAt > cutoffMs) {
      // Only reachable from a claim whose holder died: the score is standing at
      // a lease deadline rather than the creation time it was armed with.
      await rearmQueuedSessionCandidate(redis, tenantId, runId, state.createdAt);
      return false;
    }

    const { agentTargetKey } = await import('@aflow/schemas');
    logger.warn(
      `[RunWatchdog] Marking run ${runId} (target: ${agentTargetKey(state.target)}) as STALLED (orchestrator offline)`,
    );

    const now = Date.now();

    await updateSessionState(redis, tenantId, runId, {
      status: 'STALLED',
      endedAt: now,
      pauseReason:
        'Flow engine (orchestrator) is not running. The run was queued but never started.',
    });

    await appendSessionEvent(redis, tenantId, runId, {
      eventId: crypto.randomUUID(),
      eventType: 'SessionStalled',
      timestamp: now,
      sessionId: runId,
      metadata: {
        reason: 'orchestrator_offline',
      },
    });

    // The STALLED write clears the queued candidate but does not arm the
    // projection one, and this transition has to reach Postgres.
    await markSessionDirty(redis, tenantId, runId);
    return true;
  }

  return createBackgroundTaskRunner(
    {
      taskId: TASK_ID,
      scope: 'per_instance',
      intervalMs,
      maxBatch,
      maxCycleMs,
      mode,
      runImmediately: true,
      logger: {
        debug: (message, data) => {
          logger.debug(message, data);
        },
        info: (message, data) => {
          logger.info(message, data);
        },
        warn: (message, data) => {
          logger.warn(message, data);
        },
        error: (message, error, data) => {
          logger.error(message, error, data);
        },
      },
    },
    async (ctx): Promise<BackgroundTaskCycleResult> => {
      // A liveness probe that throws reads as "alive": stalling runs because a
      // health check failed is strictly worse than leaving them queued.
      const orchestratorAlive = await isOrchestratorAlive(redis).catch(() => true);
      if (orchestratorAlive) return {};

      const claimed = await claimDueQueuedSessions(redis, Date.now() - gracePeriodMs, ctx.maxBatch);
      if (claimed.length === 0) return { candidates: 0 };
      if (ctx.mode === 'observe') return { candidates: claimed.length };

      let processed = 0;
      for (const { tenantId, sessionId } of claimed) {
        if (ctx.budgetExhausted()) break;
        if (await stallQueuedRun(tenantId, sessionId)) processed++;
      }
      return { candidates: claimed.length, processed, hasMore: claimed.length === ctx.maxBatch };
    },
  );
}
