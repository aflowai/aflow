/**
 * ResultConsumer - Consumes step results from Redis Streams.
 *
 * Uses keyed concurrency: results for DIFFERENT runs process in parallel,
 * but results for the SAME run are serialised to preserve ordering and
 * single-writer semantics on run hot state.
 */
import type { Redis } from 'ioredis';
import {
  readShardStepResults,
  readShardPendingStepResults,
  ackShardStepResult,
  shardFor,
  validateShardOwnership,
  getShardRegistryEntry,
  claimShardPendingMessages,
  streamIdToTimestampMs,
  type BlockingRedisConnection,
} from '@aflow/redis';
import type { SessionOrchestrator } from './SessionOrchestrator/index.js';
import type { ShardManager } from './ShardManager.js';
import type { WakeHold } from './wakeHold.js';
import { isSlowBlockingRead } from '@aflow/lib';
import { buildAflowContext } from '@aflow/observability';
import { errorContextFromUnknown, type StepResultMessage, type TenantId } from '@aflow/schemas';
import { getOrchestratorLogger } from '../lib/orchestratorLogger.js';
import { failRun } from './SessionOrchestrator/handlers/failRun.js';
import {
  onWorkflowTaskComplete,
  type HarnessDeps,
  type WorkflowTaskOutcome,
} from './cybernetic/WorkflowRunHarness.js';

export interface ResultConsumerConfig {
  /** Consumer name (unique per instance) */
  consumerName: string;
  /** Batch size for reading results */
  batchSize?: number;
  /** Block timeout in milliseconds */
  blockMs?: number;
  /**
   * Cadence of the timer-dispatch interval. The interval executes the
   * orchestrator.timer_dispatch task, so both fields come from that task's
   * resolved runtime config, not from this consumer's own entry.
   */
  timerIntervalMs?: number;
  timerDispatchEnabled?: boolean;
  /** Max results processing concurrently across all runs (backpressure) */
  maxConcurrent?: number;
}

export interface ResultConsumer {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export interface ResultConsumerDeps {
  blockingRedis: BlockingRedisConnection;
  /** Redis connection for writes and non-blocking operations (acks, etc.) */
  redis: Redis;
  executionService: SessionOrchestrator;
  /** Shard manager — reads from owned shard streams only */
  shardManager: ShardManager;
  harnessDeps: HarnessDeps;
  wakeHold: WakeHold;
}

/**
 * Create a result consumer with keyed concurrency.
 */
export function createResultConsumer(
  deps: ResultConsumerDeps,
  config: ResultConsumerConfig,
): ResultConsumer {
  const log = getOrchestratorLogger().child({ component: 'result-consumer' });
  const { blockingRedis, redis, executionService, shardManager, harnessDeps, wakeHold } = deps;
  const {
    consumerName,
    batchSize = 50,
    blockMs = 100,
    timerIntervalMs = 1000,
    timerDispatchEnabled = true,
    maxConcurrent = 20,
  } = config;

  let running = false;
  let stopRequested = false;
  let loopPromise: Promise<void> | null = null;
  let timerInterval: NodeJS.Timeout | null = null;
  let timerTick: Promise<void> | null = null;

  // ── Keyed concurrency: per-run promise chains ──────────────────────────
  //
  // Each runId maps to the tail of its serialised promise chain. New work
  // for the same run is appended to the chain so it waits for the previous
  // result to finish. Chains for different runs execute concurrently.
  //
  // Auto-cleanup: when a chain's tail settles and no newer work was
  // appended, the entry is removed to prevent unbounded growth.

  const runChains = new Map<string, Promise<void>>();
  let inFlight = 0;

  // Track message IDs currently being processed (enqueued but not yet acked/errored).
  // Phase 1 (pending drain via cursor '0') returns ALL pending entries for this consumer,
  // including ones we already enqueued but haven't acked yet. Without this guard, the
  // same message would be enqueued again on every loop iteration, duplicating applyResult.
  const inFlightIds = new Set<string>();

  const MAX_RESULT_RETRIES = 3;
  const messageRetries = new Map<string, number>();

  function enqueueForRun(runId: string, messageId: string, fn: () => Promise<void>): void {
    inFlight++;
    inFlightIds.add(messageId);
    const prev = runChains.get(runId) ?? Promise.resolve();

    const next = prev
      .catch(() => {
        /* ensure previous rejection does not block the chain */
      })
      .then(fn)
      .finally(() => {
        inFlight--;
        inFlightIds.delete(messageId);
        // Auto-cleanup: remove entry only if no newer work was appended
        if (runChains.get(runId) === next) {
          runChains.delete(runId);
        }
      });

    runChains.set(runId, next);
  }

  // ── Main read loop ─────────────────────────────────────────────────────

  async function processResults(): Promise<void> {
    while (!stopRequested) {
      try {
        const heldMs = wakeHold.remainingMs();
        if (heldMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(heldMs, 1000)));
          continue;
        }

        // Backpressure: if at capacity, wait briefly before reading more
        if (inFlight >= maxConcurrent) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }

        // Read from shard-scoped result streams for owned shards
        const ownedShards = shardManager.ownedShards();
        const resultStreams = shardManager.resultStreams();
        if (ownedShards.length === 0) {
          // No shards owned yet — wait for reacquisition instead of busy-looping
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        const availableSlots = Math.min(batchSize, maxConcurrent - inFlight);

        // Phase 1: Drain pending entries (XCLAIM'd or previously unacked).
        // Cap at half of available slots to always leave room for fresh messages.
        const pendingLimit = Math.max(1, Math.floor(availableSlots / 2));
        const allPending = await readShardPendingStepResults(redis, consumerName, resultStreams, {
          count: pendingLimit,
        });
        // Filter out IDs already in-flight to prevent duplicate applyResult calls —
        // cursor '0' returns ALL pending entries including ones we enqueued but haven't acked yet.
        const pending = allPending.filter((entry) => !inFlightIds.has(entry.id));
        if (pending.length > 0) {
          log.debug(
            `Draining ${String(pending.length)} pending result messages (${String(allPending.length - pending.length)} already in-flight)`,
          );
        }

        // Phase 2: Always read fresh messages too (prevents pending poison-pill starvation).
        const remainingSlots = availableSlots - pending.length;
        const effectiveBlockMs = pending.length > 0 ? 0 : blockMs;
        const readStart = Date.now();
        const fresh =
          remainingSlots > 0
            ? await readShardStepResults(blockingRedis, consumerName, resultStreams, {
                count: remainingSlots,
                blockMs: effectiveBlockMs, // non-blocking if we have pending work
              })
            : [];
        if (remainingSlots > 0) {
          const xreadElapsedMs = Date.now() - readStart;
          if (
            fresh.length === 0 &&
            effectiveBlockMs > 0 &&
            isSlowBlockingRead(xreadElapsedMs, effectiveBlockMs)
          ) {
            log.warn('[PERF] hot_path_consumer_slow_read', {
              component: 'result-consumer',
              xreadElapsedMs: String(xreadElapsedMs),
              blockMs: String(effectiveBlockMs),
              entriesRead: '0',
              ownedShardCount: String(ownedShards.length),
            });
          } else if (fresh.length > 0) {
            let maxAgeMs = 0;
            const now = Date.now();
            for (const { id } of fresh) {
              const ts = streamIdToTimestampMs(id);
              if (ts !== null) {
                const age = now - ts;
                if (age > maxAgeMs) maxAgeMs = age;
              }
            }
            if (maxAgeMs > 250) {
              log.warn('[PERF] hot_path_consumer_slow_read', {
                component: 'result-consumer',
                xreadElapsedMs: String(xreadElapsedMs),
                blockMs: String(effectiveBlockMs),
                entriesRead: String(fresh.length),
                messageAgeMsMax: String(maxAgeMs),
                ownedShardCount: String(ownedShards.length),
              });
            }
          }
        }

        const results = [...pending, ...fresh];

        for (const { id, shardId, result } of results) {
          if (result.workflowExecution !== undefined) {
            const harnessRunId = result.workflowExecution.runId;
            enqueueForRun(harnessRunId, id, async () => {
              const resultShardId = shardFor(harnessRunId);
              const expectedToken = shardManager.fencingToken(resultShardId);
              if (
                expectedToken === 0 ||
                !(await validateShardOwnership(redis, resultShardId, consumerName, expectedToken))
              ) {
                try {
                  const entry = await getShardRegistryEntry(redis, resultShardId);
                  if (entry && entry.owner !== consumerName) {
                    await claimShardPendingMessages(
                      redis,
                      resultShardId,
                      'results',
                      entry.owner,
                      [id],
                      { minIdleMs: 0 },
                    );
                  }
                } catch {
                  // Best-effort handoff — periodic reclaim is the fallback.
                }
                shardManager.revokeShard(resultShardId);
                return;
              }

              try {
                const applyStart = Date.now();
                await routeWorkflowTaskResultToHarness(harnessDeps, result);
                const applyMs = Date.now() - applyStart;
                if (applyMs > 500) {
                  log.debug(
                    `Slow onWorkflowTaskComplete ${String(applyMs)}ms`,
                    buildAflowContext({
                      runId: harnessRunId,
                      stepExecutionId: result.stepExecutionId,
                      operationId: result.operationId,
                    }),
                  );
                }
                await ackShardStepResult(redis, shardId, id);
              } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                const retryCount = (messageRetries.get(id) ?? 0) + 1;
                messageRetries.set(id, retryCount);
                if (retryCount >= MAX_RESULT_RETRIES) {
                  log.error(
                    `Quarantining workflow-task result ${id} after ${String(retryCount)} ` +
                      `failures: ${errMsg}`,
                    error instanceof Error ? error : undefined,
                    errorContextFromUnknown(error, {
                      tenantId: result.tenantId,
                      stepExecutionId: result.stepExecutionId,
                      operationId: result.operationId,
                      stepType: result.stepType,
                      stepId: result.stepId,
                      traceId: result.traceId,
                      workflowExecution: result.workflowExecution,
                      retriesExhausted: true,
                    }),
                  );
                  await ackShardStepResult(redis, shardId, id);
                  messageRetries.delete(id);
                } else {
                  log.error(
                    `Error processing workflow-task result ${id} ` +
                      `(attempt ${String(retryCount)}/${String(MAX_RESULT_RETRIES)}): ${errMsg}`,
                    error instanceof Error ? error : undefined,
                    errorContextFromUnknown(error, {
                      tenantId: result.tenantId,
                      stepExecutionId: result.stepExecutionId,
                      workflowExecution: result.workflowExecution,
                    }),
                  );
                  // Don't ACK — message redelivered via pending entries.
                }
              }
            });
            continue;
          }

          // Schema-invariant: if not workflowExecution then sessionId is set.
          if (!result.sessionId) {
            log.error(
              `[ResultConsumer] result has neither sessionId nor workflowExecution — ` +
                `schema invariant violated; ACK + drop.`,
              undefined,
              { shardId, stepExecutionId: result.stepExecutionId },
            );
            await ackShardStepResult(redis, shardId, id);
            continue;
          }
          const sessionIdForRouting = result.sessionId; // narrowed
          enqueueForRun(sessionIdForRouting, id, async () => {
            const resultShardId = shardFor(sessionIdForRouting);
            const expectedToken = shardManager.fencingToken(resultShardId);
            if (
              expectedToken === 0 ||
              !(await validateShardOwnership(redis, resultShardId, consumerName, expectedToken))
            ) {
              try {
                const entry = await getShardRegistryEntry(redis, resultShardId);
                if (entry && entry.owner !== consumerName) {
                  await claimShardPendingMessages(
                    redis,
                    resultShardId,
                    'results',
                    entry.owner,
                    [id],
                    { minIdleMs: 0 },
                  );
                }
              } catch {
                // Best-effort handoff — ShardManager periodic reclaim is the fallback
              }
              shardManager.revokeShard(resultShardId);
              return;
            }

            try {
              const applyStart = Date.now();
              await executionService.applyResult({
                result,
                messageId: id,
              });
              const applyMs = Date.now() - applyStart;
              if (applyMs > 500) {
                log.debug(
                  `Slow applyResult ${String(applyMs)}ms`,
                  buildAflowContext({
                    runId: sessionIdForRouting,
                    stepExecutionId: result.stepExecutionId,
                    operationId: result.operationId,
                  }),
                );
              }

              await ackShardStepResult(redis, shardId, id);
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              const retryCount = (messageRetries.get(id) ?? 0) + 1;
              messageRetries.set(id, retryCount);

              if (retryCount >= MAX_RESULT_RETRIES) {
                // Poison message quarantine: ACK and fail the run to stop infinite retries
                log.error(
                  `Quarantining result ${id} after ${String(retryCount)} failures: ${errMsg}`,
                  error instanceof Error ? error : undefined,
                  errorContextFromUnknown(error, {
                    tenantId: result.tenantId,
                    sessionId: result.sessionId,
                    stepExecutionId: result.stepExecutionId,
                    operationId: result.operationId,
                    stepType: result.stepType,
                    stepId: result.stepId,
                    traceId: result.traceId,
                    retriesExhausted: true,
                  }),
                );
                try {
                  await failRun(
                    redis,
                    result.tenantId,
                    sessionIdForRouting,
                    'RESULT_PROCESSING_FAILED',
                    `Result could not be processed after ${String(MAX_RESULT_RETRIES)} attempts: ${errMsg}`,
                    'internal',
                  );
                } catch {
                  // failRun may itself fail if the run is already terminal — that's fine
                }
                await ackShardStepResult(redis, shardId, id);
                messageRetries.delete(id);
              } else {
                log.error(
                  `Error processing result ${id} (attempt ${String(retryCount)}/${String(MAX_RESULT_RETRIES)}): ${errMsg}`,
                  error instanceof Error ? error : undefined,
                  errorContextFromUnknown(error, {
                    tenantId: result.tenantId,
                    sessionId: result.sessionId,
                    stepExecutionId: result.stepExecutionId,
                    operationId: result.operationId,
                    stepType: result.stepType,
                    stepId: result.stepId,
                    traceId: result.traceId,
                  }),
                );
                // Don't ack — message will be redelivered via pending entries.
                // If applyResult's safety catch already called failRun(), the retry
                // will hit the early-exit for terminal runs and be acked cleanly.
              }
            }
          });
        }
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopRequested can change during async operations
        if (!stopRequested) {
          log.error(
            'Error in main loop',
            error instanceof Error ? error : undefined,
            errorContextFromUnknown(error, { component: 'result-consumer' }),
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  // ── Timer processing ───────────────────────────────────────────────────

  async function processTimers(): Promise<void> {
    if (stopRequested || wakeHold.remainingMs() > 0) return;

    // Tracked so shutdown can wait for it. A tick abandoned mid-flight leaves
    // timers claimed but unacknowledged, and 60s later the lease expires and
    // the same step attempt is dispatched a second time.
    const tick = (async () => {
      try {
        const count = await executionService.processDueTimers();
        if (count > 0) {
          log.debug(`Processed ${String(count)} due timers`);
        }
      } catch (error) {
        log.error(
          'Error processing timers',
          error instanceof Error ? error : undefined,
          errorContextFromUnknown(error, { component: 'result-consumer', sub: 'timers' }),
        );
      }
    })();
    timerTick = tick;
    try {
      await tick;
    } finally {
      if (timerTick === tick) timerTick = null;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  return {
    start() {
      if (running) {
        throw new Error('Consumer is already running');
      }

      running = true;
      stopRequested = false;

      loopPromise = processResults();

      if (timerDispatchEnabled) {
        timerInterval = setInterval(() => {
          void processTimers();
        }, timerIntervalMs);
      }

      log.debug(`Result consumer ${consumerName} started (maxConcurrent=${String(maxConcurrent)})`);
    },

    async stop() {
      if (!running) {
        return;
      }

      log.debug(`Stopping result consumer ${consumerName}...`);
      stopRequested = true;

      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }

      if (timerTick) {
        try {
          await timerTick;
        } catch {
          // Shutdown never fails on a timer error; the tick logged it already.
        }
      }

      // Wait for the read loop to exit
      if (loopPromise) {
        await loopPromise;
        loopPromise = null;
      }

      // Drain all in-flight per-run chains
      if (runChains.size > 0) {
        log.debug(`Draining ${String(runChains.size)} in-flight run chains...`);
        await Promise.allSettled(runChains.values());
        runChains.clear();
      }

      running = false;
      log.debug(`Result consumer ${consumerName} stopped`);
    },

    isRunning() {
      return running;
    },
  };
}

async function routeWorkflowTaskResultToHarness(
  harnessDeps: HarnessDeps,
  result: StepResultMessage,
): Promise<void> {
  const ref = result.workflowExecution;
  if (ref === undefined) {
    throw new Error('routeWorkflowTaskResultToHarness called without workflowExecution');
  }

  let outcome: WorkflowTaskOutcome;
  if (result.status === 'SUCCEEDED') {
    if (result.outputRef === null || result.outputRef === undefined) {
      throw new Error(
        `[ResultConsumer→harness] SUCCEEDED workflow-task result missing outputRef ` +
          `(runId=${ref.runId} taskId=${ref.taskId})`,
      );
    }
    outcome = { kind: 'succeeded', outputRef: result.outputRef };
  } else if (result.status === 'FAILED') {
    outcome = {
      kind: 'failed',
      ...(result.errorRef ? { errorRef: result.errorRef } : {}),
      ...(result.error?.message ? { failureReason: result.error.message } : {}),
      ...(result.error?.code ? { errorCode: result.error.code } : {}),
      ...(result.error?.classification ? { errorClassification: result.error.classification } : {}),
      ...(result.error?.retryable !== undefined ? { errorRetryable: result.error.retryable } : {}),
    };
  } else {
    // PAUSED — operation tasks rarely pause, but executors can return it
    // (e.g., a long-running compute that signals_blocked for input).
    outcome = {
      kind: 'paused',
      ...(result.requestedInputRef ? { contractRef: result.requestedInputRef } : {}),
    };
  }

  await onWorkflowTaskComplete(harnessDeps, {
    tenantId: result.tenantId as TenantId,
    workflowExecution: {
      runId: ref.runId,
      taskId: ref.taskId,
      attempt: ref.attempt,
      dispatchAttemptToken: ref.dispatchAttemptToken,
    },
    outcome,
    ...(result.traceId ? { traceId: result.traceId } : {}),
  });
}
