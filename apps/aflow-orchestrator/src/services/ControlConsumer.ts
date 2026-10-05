/**
 * ControlConsumer - Consumes control commands from Redis Streams.
 *
 * Control commands are emitted by the API/control plane and processed by the orchestrator.
 *
 * Commands:
 * - start_run
 * - resume_run
 * - cancel_run
 * - interrupt_run
 *
 * ARCHITECTURE: Redis-first for hot execution state.
 * Error states are written to Redis, then projected to Postgres.
 */
import type { Redis } from 'ioredis';
import {
  readShardControlMessages,
  readShardPendingControlMessages,
  ackShardControlMessage,
  setSessionState,
  getSessionStateSafe,
  appendSessionEvent,
  markSessionDirty,
  shardFor,
  validateShardOwnership,
  getShardRegistryEntry,
  claimShardPendingMessages,
  streamIdToTimestampMs,
  type BlockingRedisConnection,
  type SessionHotState,
  type SessionEvent,
} from '@aflow/redis';
import type {
  ControlMessage,
  ControlRejectedMetadata,
  SessionAgentTarget,
  SystemRole,
} from '@aflow/schemas';
import { isSlowBlockingRead } from '@aflow/lib';
import { toFailedRunDisplay, errorContext, errorContextFromUnknown } from '@aflow/schemas';
import {
  type AuthorityLostError,
  type ControlConflictError,
  isAuthorityLostError,
  isControlConflictError,
} from '../lib/controlConflict.js';
import { classifyOrchestratorError } from '../lib/errorClassifier.js';
import { getOrchestratorLogger } from '../lib/orchestratorLogger.js';
import { getClearedDelegationStatePatch } from './SessionOrchestrator/helpers/delegationState.js';
import {
  enqueuePendingAndReconcile,
  isDelegationUpsertFailure,
} from './SessionOrchestrator/handlers/enqueueDelegationCompletion.js';
import type { SessionOrchestrator } from './SessionOrchestrator/index.js';
import type { ShardManager } from './ShardManager.js';

export interface ControlConsumerConfig {
  consumerName: string;
  batchSize?: number;
  blockMs?: number;
}

export interface ControlConsumerDeps {
  blockingRedis: BlockingRedisConnection;
  /** Redis connection for writes and non-blocking operations */
  redis: Redis;
  executionService: SessionOrchestrator;
  /** Shard manager — reads from owned shard streams only */
  shardManager: ShardManager;
}

export interface ControlConsumer {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export function createControlConsumer(
  deps: ControlConsumerDeps,
  config: ControlConsumerConfig,
): ControlConsumer {
  const log = getOrchestratorLogger().child({ component: 'control-consumer' });
  const { blockingRedis, redis, executionService, shardManager } = deps;
  const { consumerName, batchSize = 10, blockMs = 100 } = config;

  let running = false;
  let stopRequested = false;
  let loopPromise: Promise<void> | null = null;

  async function handleMessage(message: ControlMessage): Promise<void> {
    log.debug(`Processing ${message.type} for run ${message.runId}`);

    switch (message.type) {
      case 'start_run': {
        const { agentTargetKey } = await import('@aflow/schemas');
        log.debug(
          `Starting run ${message.runId} for ${agentTargetKey(message.target)}@${message.agentVersion}`,
        );
        await executionService.startRun({
          tenantId: message.tenantId,
          runId: message.runId,
          target: message.target,
          agentVersion: message.agentVersion,
          inputRef: message.inputRef,
          traceId: message.traceId,
          ...(message.createdBy ? { createdBy: message.createdBy } : {}),
          ...(message.spaceId ? { spaceId: message.spaceId } : {}),
          ...(message.trigger ? { trigger: message.trigger } : {}),
          activatedByPerson: message.activatedByPerson,
          ...(message.voiceMode ? { voiceMode: true } : {}),
          ...(message.actorContext ? { actorContext: message.actorContext } : {}),
          ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
          ...(message.simulationRunInput ? { simulationRunInput: message.simulationRunInput } : {}),
          idempotencyKey: message.idempotencyKey,
        });
        log.debug(`Run ${message.runId} started successfully`);
        return;
      }

      case 'resume_run':
        log.debug(`Resuming run ${message.runId}`);
        await executionService.resumeRun({
          tenantId: message.tenantId,
          runId: message.runId,
          stepExecutionId: message.stepExecutionId,
          inputRef: message.inputRef,
          traceId: message.traceId,
          ...(message.actorContext ? { actorContext: message.actorContext } : {}),
          ...(message.voiceMode !== undefined ? { voiceMode: message.voiceMode } : {}),
          ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
          activatedByPerson: message.activatedByPerson,
          idempotencyKey: message.idempotencyKey,
        });
        return;

      case 'cancel_run':
        log.debug(`Cancelling run ${message.runId}`);
        await executionService.cancelRun({
          tenantId: message.tenantId,
          runId: message.runId,
        });
        return;

      case 'interrupt_run':
        log.debug(`Interrupting run ${message.runId}`);
        await executionService.interruptRun({
          tenantId: message.tenantId,
          runId: message.runId,
        });
        return;

      case 'retry_run':
        log.debug(`Retrying failed run ${message.runId}`);
        await executionService.retryRun({
          tenantId: message.tenantId,
          runId: message.runId,
          ...(message.stepExecutionId ? { stepExecutionId: message.stepExecutionId } : {}),
          ...(message.inputRef ? { inputRef: message.inputRef } : {}),
          traceId: message.traceId,
          ...(message.actorContext ? { actorContext: message.actorContext } : {}),
          activatedByPerson: message.activatedByPerson,
          idempotencyKey: message.idempotencyKey,
        });
        return;
    }
  }

  /**
   * Record a lost race or duplicate command without touching run state.
   *
   * Two people acting on one execution is normal teamwork, not a run failure:
   * the winner's transition stands and the loser gets a typed `ControlRejected`
   * event on the session stream. Routing these through `markRunFailed` used to
   * overwrite the winner's now-RUNNING state with FAILED, killing healthy work.
   *
   * Must never throw — it runs in the consumer's catch path.
   */
  async function recordControlConflict(
    message: ControlMessage,
    conflict: ControlConflictError,
  ): Promise<void> {
    const metadata: ControlRejectedMetadata = {
      conflictCode: conflict.conflictCode,
      controlMessageType: message.type,
      message: conflict.message,
      ...(message.idempotencyKey ? { commandId: message.idempotencyKey } : {}),
      ...(conflict.observedStatus ? { observedStatus: conflict.observedStatus } : {}),
      ...(conflict.currentStepExecutionId
        ? { currentStepExecutionId: conflict.currentStepExecutionId }
        : {}),
      ...(conflict.requestedStepExecutionId
        ? { requestedStepExecutionId: conflict.requestedStepExecutionId }
        : {}),
    };

    log.info(
      `Control ${message.type} for run ${message.runId} rejected [${conflict.conflictCode}] — run untouched`,
      { tenantId: message.tenantId, runId: message.runId, ...metadata },
    );

    try {
      await appendSessionEvent(redis, message.tenantId, message.runId, {
        eventId: crypto.randomUUID(),
        eventType: 'ControlRejected',
        timestamp: Date.now(),
        sessionId: message.runId,
        ...(message.type === 'resume_run' || message.type === 'retry_run'
          ? message.stepExecutionId
            ? { stepExecutionId: message.stepExecutionId }
            : {}
          : {}),
        metadata,
      });
    } catch (emitErr) {
      log.error(
        `Failed to emit ControlRejected for run ${message.runId}`,
        emitErr instanceof Error ? emitErr : undefined,
        errorContextFromUnknown(emitErr, { tenantId: message.tenantId, runId: message.runId }),
      );
    }
  }

  /**
   * Record that a run's established authority no longer holds.
   *
   * The run keeps its state — it is paused, and it stays paused. The work is
   * still valid and becomes resumable the moment someone restores the
   * principal's access, so this reports rather than discards.
   */
  async function recordAuthorityLost(
    message: ControlMessage,
    error: AuthorityLostError,
  ): Promise<void> {
    log.warn(
      `Control ${message.type} for run ${message.runId} refused [${error.reason}] — run left paused`,
      { tenantId: message.tenantId, runId: message.runId, reason: error.reason },
    );

    try {
      await appendSessionEvent(redis, message.tenantId, message.runId, {
        eventId: crypto.randomUUID(),
        eventType: 'AuthorityLost',
        timestamp: Date.now(),
        sessionId: message.runId,
        metadata: {
          reason: error.reason,
          detail: error.detail,
          controlMessageType: message.type,
        },
      });
    } catch (emitErr) {
      log.error(
        `Failed to emit AuthorityLost for run ${message.runId}`,
        emitErr instanceof Error ? emitErr : undefined,
        errorContextFromUnknown(emitErr, { tenantId: message.tenantId, runId: message.runId }),
      );
    }
  }

  /**
   * Mark a run as failed in Redis when control message processing fails.
   *
   * REDIS-FIRST: Error state is written to Redis, then projected to Postgres.
   *
   * BOMB-PROOF: This function must NEVER throw. If the full state write fails,
   * it falls back to a minimal status-only update. If that also fails, it logs
   * and returns — the run may stay QUEUED, but the error is at least recorded
   * in server logs. A silent swallow here is the last resort, not the norm.
   */
  async function markRunFailed(message: ControlMessage, error: unknown): Promise<void> {
    const { agentTargetKey } = await import('@aflow/schemas');
    const flowId = message.type === 'start_run' ? agentTargetKey(message.target) : undefined;
    const context: { runId: string; flowId?: string } = { runId: message.runId };
    if (flowId) context.flowId = flowId;
    const { classified, internalMessage } = classifyOrchestratorError(error, context);
    const display = toFailedRunDisplay(classified, {
      runId: message.runId,
      includeDebug: true,
    });

    const needsInvestigation =
      classified.classification === 'internal' ||
      classified.classification === 'transient' ||
      classified.classification === 'provider';
    const structured = {
      ...errorContext(classified, {
        tenantId: message.tenantId,
        runId: message.runId,
      }),
      internalMessage,
    };
    if (needsInvestigation) {
      log.error(`Run ${message.runId} failed [${classified.code}]`, undefined, structured);
    } else {
      log.info(`Run ${message.runId} failed [${classified.code}] (expected class)`, structured);
    }

    const now = Date.now();

    // ── Attempt 1: Full state write ────────────────────────────────────────
    try {
      const existingResult = await getSessionStateSafe(redis, message.tenantId, message.runId);
      const existingState = existingResult.ok ? existingResult.state : undefined;

      // A run that already reached a settled outcome keeps it. A late or
      // duplicate control command failing here must not rewrite history —
      // the error belongs to the command, not to the completed run.
      if (existingState?.status === 'SUCCEEDED' || existingState?.status === 'CANCELLED') {
        log.warn(
          `Control ${message.type} for run ${message.runId} failed after the run settled ` +
            `as ${existingState.status} — leaving the run untouched [${classified.code}]`,
          structured,
        );
        return;
      }

      // For non-start_run messages, preserve existing session identity fields.
      // Bug fix: the old code set agentVersion to 'unknown' for resume/retry/cancel,
      // permanently corrupting the session so fetchAgentDef can never find the definition.
      const fallbackTarget: SessionAgentTarget = {
        kind: 'platform-role',
        systemRole: 'unknown' as SystemRole,
      };
      const resolvedTarget: SessionAgentTarget =
        message.type === 'start_run' ? message.target : (existingState?.target ?? fallbackTarget);
      const resolvedAgentVersion =
        message.type === 'start_run'
          ? message.agentVersion
          : (existingState?.agentVersion ?? 'unknown');
      const spaceId =
        (message.type === 'start_run' ? message.spaceId : undefined) ?? existingState?.spaceId;
      const createdBy =
        (message.type === 'start_run' ? message.createdBy : undefined) ?? existingState?.createdBy;
      const trigger =
        (message.type === 'start_run' ? message.trigger : undefined) ?? existingState?.trigger;
      const activatedByPerson =
        message.type === 'start_run' ? message.activatedByPerson : existingState?.activatedByPerson;

      // Encode classified (safe) error message — not the raw internal one
      const safeErrorPayload = JSON.stringify({
        code: classified.code,
        message: classified.message,
        classification: classified.classification,
      });
      const errorRef = `inline:${Buffer.from(safeErrorPayload).toString('base64')}`;

      const runState: SessionHotState = {
        sessionId: message.runId,
        tenantId: message.tenantId,
        target: resolvedTarget,
        agentVersion: resolvedAgentVersion,
        status: 'FAILED',
        createdAt: existingState?.createdAt ?? now,
        startedAt: now,
        endedAt: now,
        lastUpdatedAt: now,
        errorRef,
        ...(spaceId ? { spaceId } : {}),
        ...(createdBy ? { createdBy } : {}),
        ...(trigger ? { trigger } : {}),
        ...(activatedByPerson !== undefined ? { activatedByPerson } : {}),
        // Preserve step tracking fields (critical for retryRun to know which step to retry)
        ...(existingState?.currentStepId ? { currentStepId: existingState.currentStepId } : {}),
        ...(existingState?.currentStepExecutionId
          ? { currentStepExecutionId: existingState.currentStepExecutionId }
          : {}),
        ...(existingState?.parentSessionId
          ? { parentSessionId: existingState.parentSessionId }
          : {}),
        ...(existingState?.parentStepExecutionId
          ? { parentStepExecutionId: existingState.parentStepExecutionId }
          : {}),
        ...getClearedDelegationStatePatch(),
      };

      const failEvent: SessionEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'SessionFailed',
        timestamp: now,
        sessionId: message.runId,
        metadata: {
          error: display.errorMessage,
          errorCode: classified.code,
          classification: classified.classification,
          controlMessageType: message.type,
          ...(display.userError ? { userError: display.userError } : {}),
        },
      };

      await setSessionState(redis, runState);
      await appendSessionEvent(redis, message.tenantId, message.runId, failEvent);
      await markSessionDirty(redis, message.tenantId, message.runId);

      log.info(`Marked run ${message.runId} as FAILED [${classified.code}]`);

      // If this is a subflow, resume the parent so it doesn't hang
      if (existingState?.parentSessionId) {
        try {
          await enqueuePendingAndReconcile({
            redis,
            tenantId: message.tenantId,
            childRunId: message.runId,
            reason: 'ControlConsumer:full_write_failure',
            ...(existingState.parentStepExecutionId
              ? {
                  parentRunId: existingState.parentSessionId,
                  parentStepExecutionId: existingState.parentStepExecutionId,
                }
              : {}),
            childError: {
              code: classified.code,
              message: classified.message,
              classification: classified.classification,
              retryable: classified.retryable,
            },
          });
        } catch (resumeErr) {
          if (isDelegationUpsertFailure(resumeErr)) throw resumeErr;
          log.error(
            `Failed to resume parent after child ${message.runId} failed`,
            resumeErr instanceof Error ? resumeErr : undefined,
            errorContextFromUnknown(resumeErr, {
              tenantId: message.tenantId,
              runId: message.runId,
            }),
          );
        }
      }

      return; // Success — full state written
    } catch (fullWriteErr) {
      log.error(
        `Full state write failed for run ${message.runId}, trying minimal fallback`,
        fullWriteErr instanceof Error ? fullWriteErr : undefined,
        errorContextFromUnknown(fullWriteErr, {
          tenantId: message.tenantId,
          runId: message.runId,
        }),
      );
    }

    // ── Attempt 2: Minimal fallback — just set status + error event ────────
    try {
      const { updateSessionState } = await import('@aflow/redis');
      await updateSessionState(redis, message.tenantId, message.runId, {
        status: 'FAILED',
        endedAt: now,
        lastUpdatedAt: now,
        ...getClearedDelegationStatePatch(),
      });
      await appendSessionEvent(redis, message.tenantId, message.runId, {
        eventId: crypto.randomUUID(),
        eventType: 'SessionFailed',
        timestamp: now,
        sessionId: message.runId,
        metadata: {
          error: display.errorMessage,
          errorCode: classified.code,
          classification: classified.classification,
          ...(display.userError ? { userError: display.userError } : {}),
          fallback: true,
        },
      });
      await markSessionDirty(redis, message.tenantId, message.runId);
      log.warn(`Marked run ${message.runId} as FAILED via minimal fallback`);

      const currentState = await getSessionStateSafe(redis, message.tenantId, message.runId);
      if (currentState.ok && currentState.state.parentSessionId) {
        try {
          await enqueuePendingAndReconcile({
            redis,
            tenantId: message.tenantId,
            childRunId: message.runId,
            reason: 'ControlConsumer:minimal_failure_fallback',
            ...(currentState.state.parentStepExecutionId
              ? {
                  parentRunId: currentState.state.parentSessionId,
                  parentStepExecutionId: currentState.state.parentStepExecutionId,
                }
              : {}),
            childError: {
              code: classified.code,
              message: classified.message,
              classification: classified.classification,
              retryable: classified.retryable,
            },
          });
        } catch (resumeErr) {
          if (isDelegationUpsertFailure(resumeErr)) throw resumeErr;
          log.error(
            `Failed to reconcile parent after minimal fallback for child ${message.runId}`,
            resumeErr instanceof Error ? resumeErr : undefined,
            errorContextFromUnknown(resumeErr, {
              tenantId: message.tenantId,
              runId: message.runId,
            }),
          );
        }
      }
    } catch (minimalErr) {
      // Last resort: nothing we can do except log. The run may stay QUEUED.
      log.error(
        `CRITICAL: Could not mark run ${message.runId} as FAILED even with minimal fallback`,
        minimalErr instanceof Error ? minimalErr : undefined,
        errorContextFromUnknown(minimalErr, {
          tenantId: message.tenantId,
          sessionId: message.runId,
        }),
      );
    }
  }

  async function processLoop(): Promise<void> {
    while (!stopRequested) {
      try {
        const ownedShards = shardManager.ownedShards();
        const controlStreams = shardManager.controlStreams();
        if (ownedShards.length === 0) {
          // No shards owned yet — wait for reacquisition instead of busy-looping
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        // Phase 1: Drain pending entries (XCLAIM'd or previously unacked).
        // Cap at half of batchSize to always leave room for fresh messages.
        const pendingLimit = Math.max(1, Math.floor(batchSize / 2));
        const pending = await readShardPendingControlMessages(redis, consumerName, controlStreams, {
          count: pendingLimit,
        });
        if (pending.length > 0) {
          log.debug(`Draining ${String(pending.length)} pending control messages`);
        }

        // Phase 2: Always read fresh messages too (prevents pending poison-pill starvation).
        const freshLimit = batchSize - pending.length;
        const effectiveBlockMs = pending.length > 0 ? 0 : blockMs;
        const readStart = Date.now();
        const fresh =
          freshLimit > 0
            ? await readShardControlMessages(blockingRedis, consumerName, controlStreams, {
                count: freshLimit,
                blockMs: effectiveBlockMs, // non-blocking if we have pending work
              })
            : [];
        const readMs = Date.now() - readStart;

        const batch = [...pending, ...fresh];

        if (batch.length > 0) {
          log.debug(`Received ${String(batch.length)} control messages after ${String(readMs)}ms`);
        }

        if (freshLimit > 0) {
          if (
            fresh.length === 0 &&
            effectiveBlockMs > 0 &&
            isSlowBlockingRead(readMs, effectiveBlockMs)
          ) {
            log.warn('[PERF] hot_path_consumer_slow_read', {
              component: 'control-consumer',
              xreadElapsedMs: String(readMs),
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
                component: 'control-consumer',
                xreadElapsedMs: String(readMs),
                blockMs: String(effectiveBlockMs),
                entriesRead: String(fresh.length),
                messageAgeMsMax: String(maxAgeMs),
                ownedShardCount: String(ownedShards.length),
              });
            }
          }
        }

        for (const { id, shardId, message } of batch) {
          const msgShardId = shardFor(message.runId);
          const expectedToken = shardManager.fencingToken(msgShardId);
          if (
            expectedToken === 0 ||
            !(await validateShardOwnership(redis, msgShardId, consumerName, expectedToken))
          ) {
            try {
              const entry = await getShardRegistryEntry(redis, msgShardId);
              if (entry && entry.owner !== consumerName) {
                await claimShardPendingMessages(redis, msgShardId, 'control', entry.owner, [id], {
                  minIdleMs: 0,
                });
              }
            } catch {
              // Best-effort handoff — ShardManager periodic reclaim is the fallback
            }
            shardManager.revokeShard(msgShardId);
            continue;
          }

          try {
            const handleStart = Date.now();
            await handleMessage(message);
            const handleMs = Date.now() - handleStart;
            log.debug(`Processed ${message.type} in ${String(handleMs)}ms`);
            await ackShardControlMessage(redis, shardId, id);
          } catch (err) {
            // A conflict means the run already moved on — the command is void,
            // the run is healthy. Only genuine failures reach markRunFailed,
            // which is bomb-proof: it classifies the error, writes a safe
            // user-facing message to Redis, and logs the internal one.
            if (isControlConflictError(err)) {
              await recordControlConflict(message, err);
            } else if (isAuthorityLostError(err)) {
              await recordAuthorityLost(message, err);
            } else {
              await markRunFailed(message, err);
            }

            // Ack the message to prevent infinite retries of bad messages
            await ackShardControlMessage(redis, shardId, id);
          }
        }
      } catch (err) {
        log.error(
          'Error in main loop',
          err instanceof Error ? err : undefined,
          errorContextFromUnknown(err, { component: 'control-consumer' }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  return {
    start() {
      if (running) throw new Error('Control consumer already running');
      running = true;
      stopRequested = false;
      loopPromise = processLoop();
    },
    async stop() {
      if (!running) return;
      stopRequested = true;
      if (loopPromise) {
        await loopPromise;
        loopPromise = null;
      }
      running = false;
    },
    isRunning() {
      return running;
    },
  };
}
