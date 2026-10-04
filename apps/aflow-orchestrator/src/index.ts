/**
 * Aflow Orchestrator - Main entry point.
 *
 * This service runs the orchestration loop:
 * - Consumes step results from Redis Streams
 * - Applies state transitions via SessionOrchestrator
 * - Schedules next steps
 * - Processes timers for retries/delays
 */
// Must precede all other imports so Sentry can patch redis/pg before they load.
import './instrument.js';
import { getDatabase, getConnection } from '@aflow/database';
import {
  getRedisConnection,
  createBlockingRedisConnection,
  closeRedisConnection,
  quitRedisWithTimeout,
  ensureJobStreamGroups,
  ensureShardStreamGroups,
  cleanupStaleConsumers,
  registerOrchestratorHeartbeat,
  unregisterOrchestratorHeartbeat,
  isInstanceAlive,
  getSessionState,
  getStepState,
  getStepInFlight,
  hasAvailableExecutor,
  getShardTimer,
  casUpdateSessionRuntimeState,
  migrateLegacyShardTimers,
  reconcileActiveRuns,
  repairDueShardIndex,
  carryOverLegacyDirtySessions,
  carryOverWaitingParents,
  SHARD_COUNT,
} from '@aflow/redis';
import { resolvePayloadStore } from '@aflow/payload-store';
import {
  initObservability,
  shutdownObservability,
  createLogger,
  createLoggerWithConfig,
  recordBackgroundTaskDisabled,
} from '@aflow/observability';
import { flushCrashReporting } from '@aflow/observability/crashReporting';
import { errorContextFromUnknown, processEditionDescriptor } from '@aflow/schemas';
import { createSessionOrchestrator } from './services/SessionOrchestrator/index.js';
import { createControlConsumer } from './services/ControlConsumer.js';
import { createResultConsumer } from './services/ResultConsumer.js';
import { createProjectionWorker } from './services/ProjectionWorker.js';
import { createManifestService } from './services/ManifestService.js';
import { createSnapshotService } from './services/SnapshotService.js';
import { randomUUID } from 'node:crypto';
import { createShardManager } from './services/ShardManager.js';
import { recoverShardRuns } from './services/RecoveryService.js';
import { ScheduleEvaluator } from './services/ScheduleEvaluator.js';
import { startDelegationDrainLoop } from './services/SessionOrchestrator/handlers/delegationPendingDrain.js';
import { sweepDelegationSupervision } from './services/SessionOrchestrator/handlers/delegationSupervisionSweep.js';
import { createStreamRetentionTask } from './services/streamRetention.js';
import { createSessionMetadataTask } from './services/sessionMetadataTask.js';
import { fetchAgentDef } from './services/SessionOrchestrator/helpers/fetchAgentDef.js';
import { createWorkflowRunSweeper } from './services/cybernetic/workflowRunSweeperLoop.js';
import { createEvalBatchWorker } from './services/cybernetic/evalBatch/evalBatchWorkerLoop.js';
import { startMcpElicitationRouter } from './services/mcpElicitationHandler.js';
import { createMcpElicitationReconciler } from './services/mcpElicitationReconciler.js';
import {
  startWorkflowTaskProgressConsumer,
  seedWorkflowTaskProgressIndex,
  pruneWorkflowTaskProgressIndex,
} from '@aflow/cybernetic-runtime';
import { startWorkflowHarnessAdvanceConsumer } from './services/cybernetic/workflowHarnessAdvanceConsumer.js';
import { createRedisConnection, getExecutorRedisConfig } from '@aflow/redis';
import { sweepStaleBarriers } from './services/SessionOrchestrator/scheduling/barrierSweep.js';
import { createBackgroundTaskRunner } from '@aflow/lib';
import { installBackgroundTaskControlPlane } from '@aflow/schemas';

// Identity for this process: its Redis consumer name, and now also its entry in
// the liveness index. Both require it to be unique per *process*, not per
// revision — a revision runs many pods, and two processes sharing a name share a
// consumer group PEL and a liveness record, which is exactly the ambiguity the
// per-instance liveness index exists to remove. K_REVISION is kept as a readable
// prefix; the suffix is what makes it unique.
const CONSUMER_NAME =
  process.env['ORCHESTRATOR_CONSUMER_NAME'] ??
  `orchestrator-${process.env['K_REVISION'] ?? String(process.pid)}-${randomUUID().slice(0, 8)}`;

async function main(): Promise<void> {
  // Initialize observability (tracing, metrics, logging)
  // HOT-PATH: NO - This is startup initialization
  // Always initialize at least basic logging/observability
  await initObservability({
    serviceName: 'aflow-orchestrator',
    serviceVersion: process.env['npm_package_version'] ?? '0.1.0',
    environment: process.env['NODE_ENV'] ?? 'development',
    otlpEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    enableConsoleTracing: process.env['ENABLE_CONSOLE_TRACING'] === 'true',
    logLevel: (process.env['LOG_LEVEL'] ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
    prettyLogs: process.env['NODE_ENV'] !== 'production',
  });

  const logger = createLogger({ service: 'aflow-orchestrator' });
  logger.info('Starting Aflow Orchestrator...', { consumerName: CONSUMER_NAME });

  // Resolved before anything consumes a stream, and left to throw: the turn
  // assembler and catalog discovery compose their surfaces from this, so an
  // environment the edition cannot serve must refuse the boot rather than fail
  // the first agent turn that asks.
  const edition = processEditionDescriptor();
  logger.info('Edition resolved', {
    edition: edition.edition,
    computeRuntime: edition.computeRuntime,
    codeLane: edition.codeLane,
    hostLane: edition.hostLane,
    browserLane: edition.browserLane,
  });

  const controlPlane = installBackgroundTaskControlPlane({
    services: ['orchestrator'],
    hooks: {
      logError: (message, data) => {
        logger.error(message, undefined, data);
      },
      logWarn: (message, data) => {
        logger.warn(message, data);
      },
      onDisabled: recordBackgroundTaskDisabled,
    },
  });

  // Initialize connections
  const db = getDatabase();
  const sqlClient = getConnection();
  const redis = getRedisConnection();
  const resultBlockingRedis = createBlockingRedisConnection(`${CONSUMER_NAME}-result-blocking`);
  const controlBlockingRedis = createBlockingRedisConnection(`${CONSUMER_NAME}-control-blocking`);
  const harnessAdvanceBlockingRedis = createBlockingRedisConnection(
    `${CONSUMER_NAME}-harness-advance-blocking`,
  );
  const workflowProgressBlockingRedis = createBlockingRedisConnection(
    `${CONSUMER_NAME}-workflow-progress-blocking`,
  );

  // The orchestrator exchanges refs with every executor and the API, so a
  // process-local store resolves nothing any of them wrote.
  const resolvedPayloadStore = resolvePayloadStore({ redis });
  if (!resolvedPayloadStore) {
    logger.error(
      'No payload store: set PHOENIX_PAYLOAD_DIR, configure GCS, or leave USE_REDIS_PAYLOAD_STORE unset so Redis can serve it.',
    );
    process.exit(1);
  }
  const payloadStore = resolvedPayloadStore.store;
  logger.debug(resolvedPayloadStore.reason);

  // Ensure consumer groups exist (legacy global + shard-scoped)
  logger.debug('Ensuring Redis consumer groups...');
  await ensureJobStreamGroups(redis);
  await ensureShardStreamGroups(redis);
  logger.info('Shard stream consumer groups initialized');

  // Remove stale consumers left by ungraceful shutdowns (idle > 60s, 0 pending)
  const cleanup = await cleanupStaleConsumers(redis);
  if (cleanup.consumersRemoved > 0) {
    logger.info('Cleaned up stale stream consumers', {
      consumersRemoved: String(cleanup.consumersRemoved),
      streamsChecked: String(cleanup.streamsChecked),
    });
  }

  const { createGuardrailGate } = await import('./services/GuardrailGate/index.js');
  const guardrailGate = createGuardrailGate({ redis, db });

  const manifestService = createManifestService(db);
  logger.info('Manifest service initialized');

  const snapshotService = createSnapshotService({ redis, manifestService });
  logger.info('Snapshot service initialized');

  const manifestRepo = manifestService.getRepository();
  const shardManager = createShardManager(redis, {
    instanceId: CONSUMER_NAME,
    onShardsAcquired: async (shardIds) => {
      const result = await recoverShardRuns({ redis, manifestRepo, snapshotService }, shardIds);
      if (result.recovered > 0 || result.quarantined > 0) {
        logger.info('Shard recovery complete', {
          recovered: String(result.recovered),
          quarantined: String(result.quarantined),
          elapsedMs: String(result.elapsedMs),
          shards: String(shardIds.length),
        });
      }
    },
  });
  // Published before any shard is acquired. Liveness is now the only thing that
  // defends ownership, so a process that is owner-of-record while absent from
  // the index reads as dead — and a peer takes every shard it just claimed.
  await registerOrchestratorHeartbeat(redis, CONSUMER_NAME);
  logger.debug('Orchestrator liveness registered', { instanceId: CONSUMER_NAME });

  await shardManager.start();
  logger.info('Shard manager started', {
    ownedShards: String(shardManager.ownedShards().length),
  });

  // Timers armed before ids existed stored the payload as the ZSET member, and
  // the old scheduler never wrote the global due index, so those shards are
  // invisible to the claim. Convert them and rebuild the index across every
  // shard — not just the ones just acquired, since an instance that already
  // holds them all acquires nothing and would otherwise never repair.
  const allShards = Array.from({ length: SHARD_COUNT }, (_, i) => i);
  const timerMigration = await migrateLegacyShardTimers(redis, allShards);
  if (timerMigration.migrated > 0 || timerMigration.unreadable > 0) {
    logger.info('Converted timers stored in the pre-id format', {
      migrated: String(timerMigration.migrated),
      unreadable: String(timerMigration.unreadable),
    });
  }
  await repairDueShardIndex(redis, allShards);

  // Sessions in flight when the candidate indexes did not yet exist are armed
  // in none of them, and most need no further write that would arm them: a run
  // that already failed is terminal, and a run mid-step lost its executor to the
  // same restart.
  const carried = await carryOverLegacyDirtySessions(redis);
  if (carried.projection > 0) {
    logger.info('Carried pre-index sessions into the candidate indexes', {
      projection: String(carried.projection),
      queued: String(carried.queued),
      stalled: String(carried.stalled),
      waiting: String(carried.waiting),
    });
  }

  // A parent in child-wait is the one state whose next write is the release the
  // supervision index exists to guarantee, so nothing would ever arm the ones
  // already waiting when it appeared.
  const waitingParents = await carryOverWaitingParents(redis);
  if (waitingParents > 0) {
    logger.info('Armed supervision for parents already waiting on a child', {
      parents: String(waitingParents),
    });
  }

  // Create services
  const executionService = createSessionOrchestrator({
    db,
    sqlClient,
    redis,
    payloadStore,
    consumerName: CONSUMER_NAME,
    guardrailGate,
    manifestService,
    snapshotService,
    shardManager,
  });

  // Use blockingRedis for consumers that do blocking XREADGROUP calls
  // This prevents blocking reads from delaying other Redis operations
  const harnessDeps = { db, redis, payloadStore };

  // The interval inside the result consumer executes orchestrator.timer_dispatch,
  // so that task's runtime config — not this one's — drives it.
  const timerDispatchRuntime = controlPlane.resolve('orchestrator.timer_dispatch');
  if (timerDispatchRuntime.mode !== 'enabled') {
    // The stall sweep rides the timer tick, so stopping the tick stops it too —
    // a separately registered correctness task the operator's override never
    // named. That has to be as loud as the disable itself.
    logger.error(
      'orchestrator.timer_dispatch is disabled; orchestrator.step_stall_watchdog rides its interval and stops with it',
    );
    recordBackgroundTaskDisabled('orchestrator.step_stall_watchdog', 'coupled_to_timer_dispatch');
  }

  const resultConsumer = createResultConsumer(
    {
      blockingRedis: resultBlockingRedis,
      redis,
      executionService,
      shardManager,
      harnessDeps,
    },
    {
      consumerName: CONSUMER_NAME,
      batchSize: 50,
      // A blocked XREADGROUP wakes the instant an entry arrives, so this bounds
      // only how often an *empty* read returns — it adds no delivery latency.
      // At 100ms each consumer rebuilt and serialized a 128-stream read ten
      // times a second forever; that was the largest single idle CPU cost.
      blockMs: 1000,
      timerIntervalMs: timerDispatchRuntime.intervalMs ?? 1000,
      timerDispatchEnabled: timerDispatchRuntime.mode === 'enabled',
      maxConcurrent: 50,
    },
  );

  const controlConsumer = createControlConsumer(
    {
      blockingRedis: controlBlockingRedis,
      redis,
      executionService,
      shardManager,
    },
    {
      consumerName: CONSUMER_NAME,
      batchSize: 50,
      blockMs: 1000,
    },
  );

  const scheduleEvaluator = new ScheduleEvaluator({
    redis,
    sqlClient,
    instanceId: CONSUMER_NAME,
  });

  const projectionRuntime = controlPlane.resolve('orchestrator.projection');
  if (projectionRuntime.mode !== 'enabled') {
    // on_completion occurrences are recorded inside the projection worker's
    // transaction, so an accepted projection disable also suspends every
    // on_completion schedule fleet-wide — and the schedules domain would
    // otherwise carry no trace of why nothing fires.
    logger.error(
      'orchestrator.projection is disabled; on_completion schedule recording rides its cycle and is suspended with it',
    );
  }
  const projectionWorker =
    projectionRuntime.mode === 'enabled'
      ? createProjectionWorker(
          {
            redis,
            db,
            sqlClient,
            manifestService,
            payloadStore,
            completionSchedules: scheduleEvaluator,
          },
          {
            intervalMs: projectionRuntime.intervalMs ?? 3000,
            batchSize: projectionRuntime.maxBatch,
          },
        )
      : null;

  // Declared before anything that can fire asynchronously reads it: the boot
  // liveness timer below can go off while main() is still awaiting later
  // startup steps, and a block-scoped read before the declaration evaluates
  // is a ReferenceError, not false.
  let shuttingDown = false;

  const heartbeatRuntime = controlPlane.resolve('orchestrator.instance_heartbeat');
  const orchestratorInstanceId = CONSUMER_NAME;

  const heartbeatInterval =
    heartbeatRuntime.mode === 'enabled'
      ? setInterval(() => {
          void registerOrchestratorHeartbeat(redis, orchestratorInstanceId).catch(
            (err: unknown) => {
              logger.warn(
                'Failed to write orchestrator heartbeat',
                err instanceof Error ? { error: err.message } : undefined,
              );
            },
          );
        }, heartbeatRuntime.intervalMs ?? 10_000)
      : null;

  // A process that boots without ever appearing in the liveness index is
  // running but invisible: it acquires nothing, peers cannot reason about it,
  // and a supervisor sees a healthy child. Better to die loudly and be
  // restarted than to exist in that state. Cleared on shutdown — a graceful
  // drain removes the liveness entry on its way out, and a slow drain must
  // not be reported as a crash by its own boot check.
  let bootLivenessTimer: NodeJS.Timeout | null = null;
  if (heartbeatRuntime.mode === 'enabled') {
    const BOOT_LIVENESS_DEADLINE_MS = 60_000;
    bootLivenessTimer = setTimeout(() => {
      if (shuttingDown) return;
      void isInstanceAlive(redis, orchestratorInstanceId)
        .then((alive) => {
          if (alive || shuttingDown) return;
          logger.error(
            `Instance ${orchestratorInstanceId} is absent from the liveness index ${String(
              BOOT_LIVENESS_DEADLINE_MS,
            )}ms after boot; exiting so the supervisor restarts a visible process`,
          );
          process.exit(1);
        })
        .catch((err: unknown) => {
          logger.warn(
            'Boot liveness check failed to read the index; not exiting on an unreadable signal',
            err instanceof Error ? { error: err.message } : undefined,
          );
        });
    }, BOOT_LIVENESS_DEADLINE_MS);
    bootLivenessTimer.unref();
  }

  // A barrier is stale only once its children have had longer than any of them
  // could legitimately take; the scheduling budgets around that come from the
  // registry so raising one there reaches the code that enforces it.
  const BARRIER_MAX_AGE_MS = 120_000;
  const barrierRuntime = controlPlane.resolve('orchestrator.barrier_watchdog');
  const barrierWatchdog = createBackgroundTaskRunner(
    {
      taskId: 'orchestrator.barrier_watchdog',
      scope: barrierRuntime.scope,
      intervalMs: barrierRuntime.intervalMs ?? 30_000,
      maxBatch: barrierRuntime.maxBatch,
      maxCycleMs: barrierRuntime.maxCycleMs,
      mode: barrierRuntime.mode,
      logger,
    },
    async (ctx) => {
      if (ctx.mode === 'observe') return {};
      const { candidates, processed } = await sweepStaleBarriers({
        redis,
        getSessionState,
        getStepState,
        getStepInFlight,
        hasAvailableExecutor,
        getShardTimer,
        casUpdateSessionRuntimeState,
        shardManager,
        logger,
        maxAgeMs: BARRIER_MAX_AGE_MS,
        maxBatch: ctx.maxBatch,
        signal: ctx.signal,
      });
      return { candidates, processed };
    },
  );
  barrierWatchdog.start();

  const delegationDrainLoop = startDelegationDrainLoop(
    {
      redis,
      payloadStore,
      agentDefLoader: (tenantId, target, agentVersion) =>
        fetchAgentDef(db, payloadStore, tenantId, target, agentVersion),
    },
    {
      // Defaults from delegationPendingDrain.ts (5s tick / 30s lease /
      // batch 50 / 5 attempts / 5s flat backoff).
    },
  );

  const supervisionRuntime = controlPlane.resolve('orchestrator.delegation_supervision');
  const delegationSupervision = createBackgroundTaskRunner(
    {
      taskId: 'orchestrator.delegation_supervision',
      scope: supervisionRuntime.scope,
      intervalMs: supervisionRuntime.intervalMs ?? 30_000,
      maxBatch: supervisionRuntime.maxBatch,
      maxCycleMs: supervisionRuntime.maxCycleMs,
      mode: supervisionRuntime.mode,
      logger,
    },
    async (ctx) => {
      if (ctx.mode === 'observe') return {};
      const { candidates, processed } = await sweepDelegationSupervision({
        redis,
        payloadStore,
        agentDefLoader: (tenantId, target, agentVersion) =>
          fetchAgentDef(db, payloadStore, tenantId, target, agentVersion),
        shardManager,
        maxBatch: ctx.maxBatch,
        signal: ctx.signal,
      });
      return { candidates, processed };
    },
  );
  delegationSupervision.start();

  const streamRetention = createStreamRetentionTask({ redis, logger });
  streamRetention.start();

  const sessionMetadata = createSessionMetadataTask({ redis, db, logger });
  sessionMetadata.start();

  const workflowRunSweeper = createWorkflowRunSweeper({ sqlClient, harnessDeps });
  workflowRunSweeper.start();

  const evalBatchWorker = createEvalBatchWorker(
    { sqlClient, harnessDeps },
    { instanceId: CONSUMER_NAME },
  );

  const mcpElicitationSubscriber = createRedisConnection({
    ...getExecutorRedisConfig(),
    connectionName: `${CONSUMER_NAME}-mcp-elicitation-sub`,
  });
  // Each pattern subscription registers a `pmessage` listener; one per
  // orchestrator instance, so the default cap of 10 is fine here — but
  // bump anyway in case future subscriptions get added.
  mcpElicitationSubscriber.setMaxListeners(0);
  const stopMcpElicitationRouter = await startMcpElicitationRouter({
    redis,
    subscriberRedis: mcpElicitationSubscriber,
  });

  const mcpElicitationReconciler = createMcpElicitationReconciler({ redis });
  mcpElicitationReconciler.start();

  const workflowTaskProgressConsumer = startWorkflowTaskProgressConsumer({
    db,
    redis,
    blockingRedis: workflowProgressBlockingRedis,
  });

  const workflowHarnessAdvanceConsumer = await startWorkflowHarnessAdvanceConsumer({
    redis,
    blockingRedis: harnessAdvanceBlockingRedis,
    harnessDeps,
  });

  // Handle graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      if (bootLivenessTimer) clearTimeout(bootLivenessTimer);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      await barrierWatchdog.stop();
      await stopMcpElicitationRouter();
      await mcpElicitationReconciler.stop();
      try {
        await mcpElicitationSubscriber.quit();
      } catch {
        /* best-effort */
      }
      await delegationDrainLoop.stop();
      await delegationSupervision.stop();
      await streamRetention.stop();
      await sessionMetadata.stop();
      await workflowRunSweeper.stop();
      await workflowTaskProgressConsumer.stop();
      await workflowHarnessAdvanceConsumer.stop();
      await scheduleEvaluator.stop();
      await evalBatchWorker.stop();
      if (projectionWorker) await projectionWorker.stop();
      await resultConsumer.stop();
      await controlConsumer.stop();
      await shardManager.stop();
      // Last, and only after every shard is released. Dropping it earlier marks
      // this process dead while it is still the registered owner and still
      // draining, so a peer steals its shards mid-drain and every in-flight
      // result fails its fencing check.
      await unregisterOrchestratorHeartbeat(redis, orchestratorInstanceId);
      await Promise.all([
        quitRedisWithTimeout(resultBlockingRedis),
        quitRedisWithTimeout(controlBlockingRedis),
        quitRedisWithTimeout(harnessAdvanceBlockingRedis),
        quitRedisWithTimeout(workflowProgressBlockingRedis),
      ]);
      await closeRedisConnection();
      await shutdownObservability();
      await flushCrashReporting(2000);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error(
        'Error during shutdown',
        error instanceof Error ? error : undefined,
        errorContextFromUnknown(error, { consumerName: CONSUMER_NAME, phase: 'shutdown' }),
      );
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Recover orphaned sessions before starting consumers.
  // This must run AFTER shard recovery (which restores Redis state from snapshots)
  // but BEFORE consumers start processing new messages. Orphaned sessions are those
  // left RUNNING with dead executors after a restart — their results are irrecoverably
  // lost (e.g., LLM API responded while we were down). Agent sessions get PAUSED
  // (resumable), non-agent steps get synthetic FAILED (retryable). A step
  // waiting on its executor is neither: its wait is left to its timer, and
  // armed again where the timer is gone.
  const orphanRecovery = await executionService.recoverOrphanedSessions();
  if (orphanRecovery.paused > 0 || orphanRecovery.failed > 0 || orphanRecovery.rearmed > 0) {
    logger.info('Orphan recovery complete', {
      paused: String(orphanRecovery.paused),
      failed: String(orphanRecovery.failed),
      rearmed: String(orphanRecovery.rearmed),
    });
  }

  // Start all workers
  controlConsumer.start();
  resultConsumer.start();

  // Deliberately after the result and control consumers are running, and not
  // awaited: seeding walks the keyspace, and blocking the step-result path on a
  // scan at every boot would reintroduce the cost this index removed. The
  // progress feed simply picks up pre-index streams a moment later.
  void (async () => {
    try {
      const seeded = await seedWorkflowTaskProgressIndex(redis);
      const pruned = await pruneWorkflowTaskProgressIndex(redis);
      if (seeded > 0 || pruned > 0) {
        logger.info('Workflow task progress index reconciled', {
          seeded: String(seeded),
          pruned: String(pruned),
        });
      }

      // A process killed between a run's terminal write and its release leaves
      // the run counted as active forever, and admission control turns that
      // into a 429 against real traffic.
      const activeRuns = await reconcileActiveRuns(redis);
      if (activeRuns.removed > 0) {
        logger.info('Released active-run members with no session state', {
          checked: String(activeRuns.checked),
          removed: String(activeRuns.removed),
        });
      }
    } catch (err) {
      logger.warn(
        'Workflow task progress index reconciliation failed',
        err instanceof Error ? { error: err.message } : undefined,
      );
    }
  })();
  if (projectionWorker) projectionWorker.start();
  scheduleEvaluator.start();
  evalBatchWorker.start();

  logger.info('Aflow Orchestrator is running (Redis-first architecture)', {
    consumerName: CONSUMER_NAME,
  });
}

main().catch((error: unknown) => {
  const log = createLoggerWithConfig(
    { service: 'aflow-orchestrator', level: 'error', prettyPrint: false },
    { component: 'bootstrap' },
  );
  log.error(
    'Fatal error during orchestrator startup',
    error instanceof Error ? error : undefined,
    errorContextFromUnknown(error, { consumerName: CONSUMER_NAME, phase: 'main' }),
  );
  process.exit(1);
});
