/**
 * Single-job processing — handler dispatch, timeout, result emission.
 */
import {
  codeLaneBreakerRefusal,
  type SimulatedFulfillmentReport,
  type StepJobMessage,
} from '@aflow/schemas';
import {
  getStepState,
  updateStepState,
  appendSessionEvent,
  registerStepInFlight,
  clearStepInFlight,
  releaseStepJob,
  StepJobNotPendingError,
  wasStepCancelled,
} from '@aflow/redis';
import type {
  ExecutorConfig,
  ExecutorContext,
  ExecutorDependencies,
  ExecutorLogger,
  SlotController,
  StepHandler,
  StepResult,
} from '../types.js';
import type { ConcurrencyLimiter } from '../concurrency.js';
import { withTimeout } from '../timeout.js';
import { admitOperation } from './operationAdmission.js';
import { createAflowError, toAflowError } from './errors.js';
import { createJobLogger } from './logger.js';
import { STEP_HEARTBEAT_INTERVAL_MS } from './constants.js';
import { buildExecutionContext } from './buildContext.js';
import { acknowledgeJob, emitFailure, emitResult, emitSuccess } from './resultReporting.js';

/**
 * A step job is superseded — and must NOT run — when the durable step state has
 * moved past this job's attempt: either a newer attempt was scheduled (the stall
 * watchdog failed attempt N and retry enqueued N+1 while this attempt-N job was
 * still pending in the stream), or the step is already terminally FAILED at this
 * attempt. Running it would re-execute the step against a slot that no longer
 * owns it. A missing/unreadable state is NOT superseded (fail open).
 */
export function isSupersededStepJob(
  stepState: { attempt: number; status: string } | null | undefined,
  jobAttempt: number,
): boolean {
  if (!stepState) return false;
  return (
    stepState.attempt > jobAttempt ||
    (stepState.status === 'FAILED' && stepState.attempt === jobAttempt)
  );
}

/** A claimed job, from its claim to its end. */
export interface InFlightStep {
  stepExecutionId: string;
  operationId: string;
  /**
   * Set once the step starts, past any wait for a slot: the default timeout
   * until its own is known, which a progress-aware timeout then keeps current.
   */
  deadlineRef?: { current: number };
}

export interface ProcessJobHost {
  config: ExecutorConfig;
  deps: ExecutorDependencies;
  handlers: Map<string, StepHandler>;
  log: ExecutorLogger;
  abortControllers: Map<string, AbortController>;
  /** Operations admitted through a limit of their own, by operation id. */
  operationLimiters: ReadonlyMap<string, ConcurrencyLimiter>;
  /** Aborts once claiming stops; a step not yet admitted to its slot is then given back. */
  readonly claimingStopped: AbortSignal;
  /** Aborts once the runtime stops, ending what this process still vouches for. */
  readonly stopped: AbortSignal;
  /** A claimed step has started: it is past any wait for a slot and will run. */
  stepStarted(): void;
}

/** How a step under an operation limit leaves its wait for a slot. */
type Admission = 'admitted' | 'cancelled' | 'released' | 'superseded';

/**
 * Stale-attempt fence: if a newer attempt of this step has already been
 * scheduled (the stall watchdog failed attempt N and retry enqueued N+1 while
 * this attempt-N job was still pending in the stream), or the step is already
 * terminally FAILED at this attempt, running the job would re-execute the step
 * against a slot that no longer owns it — the current attempt owns the step.
 * Fail open: a read error proceeds.
 */
async function isSuperseded(
  host: ProcessJobHost,
  job: StepJobMessage,
  jobLog: ExecutorLogger,
): Promise<boolean> {
  try {
    const fenceState = await getStepState(host.deps.redis, job.tenantId, job.stepExecutionId);
    if (fenceState && isSupersededStepJob(fenceState, job.attempt)) {
      jobLog.info('Dropping superseded step job', {
        jobAttempt: job.attempt,
        currentAttempt: fenceState.attempt,
        currentStatus: fenceState.status,
      });
      return true;
    }
  } catch (err) {
    jobLog.warn('Stale-attempt fence check failed; proceeding', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return false;
}

/**
 * Waits for the step's operation slot. A cancel or a stop to claiming ends the
 * wait, and a step that did wait is checked again once admitted, because
 * minutes may have passed: the run may have been cancelled, failed or retried
 * meanwhile. Anything but `admitted` holds no operation slot on return.
 */
async function admitLimitedStep(admission: {
  host: ProcessJobHost;
  job: StepJobMessage;
  jobLog: ExecutorLogger;
  limiter: ConcurrencyLimiter;
  slotController: SlotController;
  externalAbort: AbortSignal;
}): Promise<Admission> {
  const { host, job, jobLog, limiter, slotController, externalAbort } = admission;
  const refusal = (): Admission | undefined => {
    if (externalAbort.aborted) return 'cancelled';
    if (host.claimingStopped.aborted) return 'released';
    return undefined;
  };

  const before = refusal();
  if (before !== undefined) return before;

  let waited: boolean;
  try {
    waited = await admitOperation({
      limiter,
      slotController,
      signal: AbortSignal.any([externalAbort, host.claimingStopped]),
      refreshInFlight: () => {
        void refreshInFlight(host, job, jobLog);
      },
      waiting: () => {
        jobLog.info('Waiting for a slot', {
          operationId: job.operationId,
          limit: limiter.limit,
        });
      },
    });
  } catch (error) {
    const ended = refusal();
    if (ended !== undefined) return ended;
    throw error;
  }

  let after = refusal();
  if (after === undefined && waited) {
    if (await isSuperseded(host, job, jobLog)) after = 'superseded';
    else if (await wasStepCancelled(host.deps.redis, job.stepExecutionId, job.attempt)) {
      after = 'cancelled';
    }
  }
  if (after === undefined) return 'admitted';
  limiter.release();
  return after;
}

/** Ends a claimed step that never started, without emitting a result for it. */
async function setAsideUnstarted(
  host: ProcessJobHost,
  job: StepJobMessage,
  messageId: string,
  jobLog: ExecutorLogger,
  admission: Exclude<Admission, 'admitted'>,
): Promise<void> {
  if (admission === 'released') {
    // A step given back is already STARTED, and the stall watchdog fails a
    // STARTED step whose in-flight record lapses: renewed before the hand-back
    // and never after, it spans the record's whole lifetime for the next
    // executor without overwriting the record that executor writes.
    await refreshInFlight(host, job, jobLog);
    await releaseStepJob(host.deps.redis, job, messageId).then(
      () => {
        jobLog.info('Gave back a step still waiting for a slot: claiming has stopped', {
          operationId: job.operationId,
        });
      },
      (err: unknown) => {
        if (err instanceof StepJobNotPendingError) {
          jobLog.info('Gave back nothing: the step was no longer this executor’s', {
            operationId: job.operationId,
          });
          return;
        }
        // Left pending, so still this process's: once its heartbeat lapses the
        // reclaim hands it to another, which is slower but loses nothing.
        vouchUntilStopped(host, job, jobLog);
        jobLog.warn('Could not give back a step still waiting for a slot', {
          operationId: job.operationId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return;
  }
  await clearStepInFlight(host.deps.redis, job.stepExecutionId).catch(() => {});
  if (admission === 'cancelled') {
    jobLog.info('Dropping cancelled step job', { attempt: job.attempt });
  }
  await acknowledgeJob(host.deps, job.stepType, messageId);
}

async function refreshInFlight(
  host: ProcessJobHost,
  job: StepJobMessage,
  jobLog: ExecutorLogger,
): Promise<void> {
  await registerStepInFlight(host.deps.redis, job.stepExecutionId, null).catch((err: unknown) => {
    jobLog.warn('Failed to refresh the in-flight heartbeat of a step not yet started', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Keeps the in-flight record of a step this process still holds alive until it stops. */
function vouchUntilStopped(
  host: ProcessJobHost,
  job: StepJobMessage,
  jobLog: ExecutorLogger,
): void {
  if (host.stopped.aborted) return;
  const refresh = setInterval(() => {
    void refreshInFlight(host, job, jobLog);
  }, STEP_HEARTBEAT_INTERVAL_MS);
  host.stopped.addEventListener(
    'abort',
    () => {
      clearInterval(refresh);
    },
    { once: true },
  );
}

export async function processJob(
  host: ProcessJobHost,
  messageId: string,
  job: StepJobMessage,
  slotController: SlotController,
  inFlight?: InFlightStep,
): Promise<void> {
  const startTime = Date.now();

  const jobLog = createJobLogger(`Executor:${host.config.consumerName}`, {
    stepExecutionId: job.stepExecutionId,
    attempt: job.attempt,
  });

  // Held outside the handler so a fulfillment the handler already resolved
  // still rides the result when the attempt ends by throwing or timing out.
  let simulatedFulfillment: SimulatedFulfillmentReport | undefined;
  const reportSimulatedFulfillment = (report: SimulatedFulfillmentReport): void => {
    simulatedFulfillment = report;
  };
  let admittedBy: ConcurrencyLimiter | undefined;
  const externalAbort = new AbortController();

  try {
    // Breaker check per claimed job, not only at startup. Startup keeps a
    // disabled host from consuming at all; this is what a host that got past
    // that — a differently-configured runtime pointed at the same stream, a
    // regressed startup guard — hits before anything else touches the job. The
    // refusal is terminal and says why, so the step does not sit SCHEDULED
    // waiting for a lane that will not run it.
    const laneRefusal = codeLaneBreakerRefusal(job.stepType, `operation ${job.operationId}`);
    if (laneRefusal) {
      jobLog.warn('Refusing claimed job: lane breaker is open', {
        stepType: job.stepType,
        operationId: job.operationId,
      });
      await emitFailure(host.deps, job, laneRefusal.toAflowError(), Date.now() - startTime);
      await acknowledgeJob(host.deps, job.stepType, messageId);
      return;
    }

    // Registered before anything can wait, so a cancel published while the step
    // is queued for a slot ends the wait instead of reaching it once admitted.
    host.abortControllers.set(job.stepExecutionId, externalAbort);

    if (await isSuperseded(host, job, jobLog)) {
      await acknowledgeJob(host.deps, job.stepType, messageId);
      return;
    }

    if (job.sessionId) {
      try {
        const now = Date.now();
        const stepState = await getStepState(host.deps.redis, job.tenantId, job.stepExecutionId);
        const shouldMarkStarted = stepState?.status === 'SCHEDULED' || !stepState;

        if (shouldMarkStarted) {
          await updateStepState(host.deps.redis, job.tenantId, job.stepExecutionId, {
            sessionId: job.sessionId,
            status: 'STARTED',
            startedAt: now,
          });

          const queueWaitMs =
            stepState?.scheduledAt !== undefined ? Math.max(0, now - stepState.scheduledAt) : null;

          await appendSessionEvent(host.deps.redis, job.tenantId, job.sessionId, {
            eventId: crypto.randomUUID(),
            eventType: 'StepStarted',
            timestamp: now,
            sessionId: job.sessionId,
            stepId: job.stepId,
            stepExecutionId: job.stepExecutionId,
            stepType: job.stepType,
            attempt: job.attempt,
            metadata: {
              operationId: job.operationId,
              executorConsumer: host.config.consumerName,
              ...(queueWaitMs !== null ? { queueWaitMs } : {}),
            },
          });
        }
      } catch (err) {
        jobLog.warn('Failed to record StepStarted', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Claim per-step in-flight liveness before any wait or slow setup (slot
    // admission / validate / context build / output probe), so the stall
    // watchdog never mistakes a freshly-claimed step for a disappeared
    // executor. The real deadline is filled in once the effective timeout is
    // known (below).
    await registerStepInFlight(host.deps.redis, job.stepExecutionId, null).catch((err: unknown) => {
      jobLog.warn('Failed to register step in-flight heartbeat', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const operationLimiter = host.operationLimiters.get(job.operationId);
    if (operationLimiter !== undefined) {
      const admission = await admitLimitedStep({
        host,
        job,
        jobLog,
        limiter: operationLimiter,
        slotController,
        externalAbort: externalAbort.signal,
      });
      if (admission !== 'admitted') {
        await setAsideUnstarted(host, job, messageId, jobLog, admission);
        return;
      }
      admittedBy = operationLimiter;
    }

    // Started from here on: a drain counts this step and waits for it.
    if (inFlight !== undefined) {
      inFlight.deadlineRef = { current: Date.now() + host.config.defaultTimeoutMs };
    }
    host.stepStarted();

    const handler = host.handlers.get(job.stepType);
    if (!handler) {
      jobLog.error(`No handler for step type: ${job.stepType}`);
      await emitFailure(
        host.deps,
        job,
        createAflowError(
          'UNKNOWN_STEP_TYPE',
          `No handler registered for step type: ${job.stepType}`,
          'internal',
          false,
        ),
        Date.now() - startTime,
      );
      await acknowledgeJob(host.deps, job.stepType, messageId);
      return;
    }

    const ctx = await buildExecutionContext(host.deps, job, jobLog, slotController);

    if (handler.validate) {
      const validationError = await handler.validate(ctx);
      if (validationError) {
        jobLog.warn('Job validation failed', { error: validationError });
        await emitFailure(host.deps, job, validationError, Date.now() - startTime);
        await acknowledgeJob(host.deps, job.stepType, messageId);
        return;
      }
    }

    const existingOutput = await ctx.outputExists();
    if (existingOutput) {
      jobLog.debug('Output already exists, short-circuiting');
      await emitSuccess(host.deps, job, existingOutput, Date.now() - startTime);
      await acknowledgeJob(host.deps, job.stepType, messageId);
      return;
    }

    const handlerTimeout = handler.resolveTimeoutMs
      ? await handler.resolveTimeoutMs(ctx).catch((err: unknown) => {
          jobLog.warn('resolveTimeoutMs failed; falling back to step/default timeout', {
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        })
      : undefined;
    const timeoutSpec =
      handlerTimeout ??
      ctx.stepDefinition?.timeout?.executionTimeoutMs ??
      host.config.defaultTimeoutMs;
    // Log/telemetry label and the heartbeat's initial deadline both use the
    // ceiling; a progress-aware spec slides the live deadline via deadlineRef.
    const timeoutMs = typeof timeoutSpec === 'number' ? timeoutSpec : timeoutSpec.maxMs;

    // Cancellation check, deliberately AFTER the controller is registered: from
    // then on the abort Pub/Sub can reach this job, so anything published earlier
    // is what the durable record has to catch. The two together leave no gap —
    // reading before registering would leave exactly that window open. An abort
    // that already landed during setup is caught here too, since `withTimeout`
    // would start the handler regardless.
    //
    // A workflow OPERATION task depends on this entirely: it has no session, so
    // the stale-attempt fence above reads no state and cannot tell that its run
    // was cancelled. Without this, a cancelled ledger row is still followed by a
    // container start — a coding job outliving a dev-stack restart is this.
    if (
      externalAbort.signal.aborted ||
      (await wasStepCancelled(host.deps.redis, job.stepExecutionId, job.attempt))
    ) {
      jobLog.info('Dropping cancelled step job', { attempt: job.attempt });
      await clearStepInFlight(host.deps.redis, job.stepExecutionId).catch(() => {});
      await acknowledgeJob(host.deps, job.stepType, messageId);
      return;
    }

    jobLog.debug('Step attempt started', {
      operationId: job.operationId,
      stepType: job.stepType,
      stepId: job.stepId,
      attempt: job.attempt,
      timeoutMs,
    });

    const heartbeatStart = Date.now();
    // The executor self-enforces the timeout via withTimeout, so this is the
    // point past which a live executor must have emitted a result. The watchdog
    // reads it from the in-flight key to size its zombie-reap backstop off the
    // step's real operation cap rather than a flat clock. Under a
    // progress-aware timeout withTimeout keeps this ref current, so an
    // idle-extended stream carries its extended deadline to the watchdog.
    const deadlineRef = { current: heartbeatStart + timeoutMs };
    if (inFlight !== undefined) inFlight.deadlineRef = deadlineRef;
    const refreshStepInFlight = () => {
      void registerStepInFlight(host.deps.redis, job.stepExecutionId, deadlineRef.current).catch(
        (err: unknown) => {
          jobLog.warn('Failed to refresh step in-flight heartbeat', {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    };
    refreshStepInFlight();
    const heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - heartbeatStart;
      jobLog.debug('Step attempt in flight', {
        operationId: job.operationId,
        stepId: job.stepId,
        attempt: job.attempt,
        elapsedMs,
        timeoutMs,
        remainingMs: Math.max(0, timeoutMs - elapsedMs),
      });
      refreshStepInFlight();
    }, STEP_HEARTBEAT_INTERVAL_MS);

    try {
      const timedResult = await withTimeout<StepResult>(
        async (signal, reportProgress) => {
          const timedCtx: ExecutorContext = {
            ...ctx,
            signal,
            reportProgress,
            reportSimulatedFulfillment,
          };
          return handler.execute(timedCtx);
        },
        timeoutSpec,
        { externalSignal: externalAbort.signal, deadlineRef },
      );

      if (timedResult.success) {
        const stepResult = timedResult.value;
        await emitResult(host.deps, job, stepResult, timedResult.durationMs, simulatedFulfillment);
        await acknowledgeJob(host.deps, job.stepType, messageId);

        jobLog.debug('Job completed', {
          operationId: job.operationId,
          status: stepResult.status,
          durationMs: timedResult.durationMs,
        });
      } else if (timedResult.reason === 'interrupted') {
        jobLog.info('Step externally interrupted — skipping result emission', {
          durationMs: timedResult.durationMs,
        });
        await acknowledgeJob(host.deps, job.stepType, messageId);
      } else {
        const timeoutError = timedResult.error;
        jobLog.warn('Step attempt timed out', {
          operationId: job.operationId,
          stepType: job.stepType,
          stepId: job.stepId,
          attempt: job.attempt,
          timeoutMs,
          durationMs: timedResult.durationMs,
        });
        await emitFailure(
          host.deps,
          job,
          timeoutError.toAflowError(),
          timedResult.durationMs,
          simulatedFulfillment,
        );
        await acknowledgeJob(host.deps, job.stepType, messageId);
      }
    } finally {
      clearInterval(heartbeat);
      await clearStepInFlight(host.deps.redis, job.stepExecutionId).catch(() => {});
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const aflowError = toAflowError(error);
    const logMethod =
      aflowError.classification === 'internal' || aflowError.classification === 'transient'
        ? jobLog.error.bind(jobLog)
        : jobLog.warn.bind(jobLog);
    logMethod('Unhandled job execution error', {
      error: error instanceof Error ? error.message : String(error),
      errorCode: aflowError.code,
      errorClassification: aflowError.classification,
      errorRetryable: aflowError.retryable,
      durationMs,
    });

    await emitFailure(host.deps, job, aflowError, durationMs, simulatedFulfillment);
    await acknowledgeJob(host.deps, job.stepType, messageId);
  } finally {
    admittedBy?.release();
    if (host.abortControllers.get(job.stepExecutionId) === externalAbort) {
      host.abortControllers.delete(job.stepExecutionId);
    }
  }
}
