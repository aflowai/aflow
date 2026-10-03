/**
 * Executor runtime — manages the lifecycle of job processing.
 */
import {
  StreamKeys,
  BackgroundTaskServiceSchema,
  installBackgroundTaskControlPlane,
  type BackgroundTaskControlPlane,
  type BackgroundTaskService,
} from '@aflow/schemas';
import { recordBackgroundTaskDisabled } from '@aflow/observability';
import {
  ensureConsumerGroup,
  registerExecutorHeartbeat,
  unregisterExecutorHeartbeat,
} from '@aflow/redis';
import type { StepHandler, ExecutorConfig, ExecutorDependencies } from '../types.js';
import { ConcurrencyLimiter } from '../concurrency.js';
import { externalAbortReason } from '../timeout.js';
import { createJobLogger } from './logger.js';
import { HEARTBEAT_INTERVAL_MS } from './constants.js';
import { claimPendingMessages, consumeLoop, type JobLoopHost } from './jobLoop.js';
import type { InFlightStep } from './processJob.js';

function executorBackgroundServices(stepType: string): BackgroundTaskService[] {
  const own = BackgroundTaskServiceSchema.safeParse(`executor-${stepType}`);
  return own.success ? ['shared-runtime', own.data] : ['shared-runtime'];
}

export class ExecutorRuntime implements JobLoopHost {
  readonly config: ExecutorConfig;
  readonly deps: ExecutorDependencies;
  readonly handlers = new Map<string, StepHandler>();
  readonly limiter: ConcurrencyLimiter;
  readonly operationLimiters = new Map<string, ConcurrencyLimiter>();
  readonly log;

  readonly inFlightSteps = new Map<string, InFlightStep>();
  readonly abortControllers = new Map<string, AbortController>();

  stopRequested = false;
  private claiming = new AbortController();
  private lifetime = new AbortController();
  private running = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private idleWaiters: Array<() => void> = [];
  private inFlightWaiters: Array<() => void> = [];
  private starting: Promise<void> | null = null;
  private consuming: Promise<void> = Promise.resolve();

  private readonly controlPlane: BackgroundTaskControlPlane;

  constructor(config: ExecutorConfig, deps: ExecutorDependencies) {
    this.config = config;
    this.deps = deps;
    this.limiter = new ConcurrencyLimiter(config.concurrency);
    this.log = createJobLogger(`Executor:${config.consumerName}`);
    // Installed here rather than in each executor app so every executor process
    // gets exactly one control plane, before any handler wires its own tasks.
    this.controlPlane = installBackgroundTaskControlPlane({
      services: executorBackgroundServices(config.stepType),
      hooks: {
        logError: (message, data) => {
          this.log.error(message, data);
        },
        logWarn: (message, data) => {
          this.log.warn(message, data);
        },
        onDisabled: recordBackgroundTaskDisabled,
      },
    });
  }

  registerHandler(handler: StepHandler): void {
    if (this.handlers.has(handler.stepType)) {
      throw new Error(`Handler already registered for step type: ${handler.stepType}`);
    }
    this.handlers.set(handler.stepType, handler);
    this.log.debug(`Registered handler for step type: ${handler.stepType}`);
  }

  /**
   * Run at most `maxConcurrent` steps of one operation at once, within the
   * executor's own limit. A step past it waits, claimed, for one to end; a
   * later call changes the number without ending anything already running.
   */
  limitOperation(operationId: string, maxConcurrent: number): void {
    const existing = this.operationLimiters.get(operationId);
    if (existing === undefined) {
      this.operationLimiters.set(operationId, new ConcurrencyLimiter(maxConcurrent));
    } else {
      existing.setLimit(maxConcurrent);
    }
  }

  getHandler(stepType: string): StepHandler | undefined {
    return this.handlers.get(stepType);
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.starting ??= this.begin().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  get claimingStopped(): AbortSignal {
    return this.claiming.signal;
  }

  get stopped(): AbortSignal {
    return this.lifetime.signal;
  }

  private async begin(): Promise<void> {
    this.stopRequested = false;
    if (this.claiming.signal.aborted) this.claiming = new AbortController();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    this.log.debug('Starting executor runtime', {
      streamKey: this.config.streamKey,
      consumerGroup: this.config.consumerGroup,
      concurrency: this.config.concurrency,
    });

    for (const handler of Array.from(this.handlers.values())) {
      if (handler.initialize) {
        await handler.initialize();
      }
    }

    await ensureConsumerGroup(this.deps.redis, this.config.streamKey, this.config.consumerGroup);

    await registerExecutorHeartbeat(
      this.deps.redis,
      this.config.stepType,
      this.config.consumerName,
    );
    this.log.debug(`Registered heartbeat for step type: ${this.config.stepType}`);

    const heartbeatRuntime = this.controlPlane.resolve('executor.heartbeat');
    if (heartbeatRuntime.mode === 'enabled') {
      this.heartbeatInterval = setInterval(() => {
        registerExecutorHeartbeat(
          this.deps.redis,
          this.config.stepType,
          this.config.consumerName,
        ).catch((err: unknown) => {
          this.log.warn('Failed to refresh heartbeat', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, heartbeatRuntime.intervalMs ?? HEARTBEAT_INTERVAL_MS);
    }

    if (this.config.claimPendingOnStart) {
      await claimPendingMessages(this);
    }

    if (this.deps.redisSubscriber) {
      try {
        await this.deps.redisSubscriber.psubscribe(StreamKeys.stepAbortPattern);
        this.deps.redisSubscriber.on('pmessage', (_pattern, channel, message) => {
          const stepExecId = channel.slice('aflow:abort:'.length);
          const controller = this.abortControllers.get(stepExecId);
          if (controller) {
            this.log.info('Aborting step via pub/sub', {
              stepExecutionId: stepExecId,
              cause: message,
            });
            // The publisher's reason rides along so a handler can tell an operator
            // stop from a deadline; without it every abort looks like a timeout.
            controller.abort(externalAbortReason(message));
          }
        });
        this.log.debug('Subscribed to step abort signals');
      } catch (err) {
        this.log.warn('Failed to subscribe to step abort signals — external abort disabled', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.running = true;
    // A stop asked for while starting stands: a signal can land during any of
    // the awaits above, and a drain that has begun claims nothing more.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopRequested can change during the awaits above
    if (!this.stopRequested) this.consuming = consumeLoop(this);
  }

  /**
   * Stops reading the stream. Steps already started keep running, with their
   * heartbeats and this executor's, until they end or `stop` is called; a step
   * still waiting for its operation's slot is given back to the stream for the
   * next executor, unworked.
   */
  stopClaiming(): void {
    this.stopRequested = true;
    this.claiming.abort();
  }

  /**
   * The started steps, each named, with the instant its own timeout ends it. A
   * claimed step still waiting for a slot is not among them: it holds nothing
   * a drain should wait for.
   */
  inFlight(): Array<{ name: string; deadlineAt: number }> {
    return [...this.inFlightSteps.values()].flatMap((step) =>
      step.deadlineRef === undefined
        ? []
        : [
            {
              name: `${step.operationId} ${step.stepExecutionId}`,
              deadlineAt: step.deadlineRef.current,
            },
          ],
    );
  }

  /** Resolves once claiming has stopped and no claimed step is in flight. */
  async idle(): Promise<void> {
    // The read under way when claiming stopped can still hand this consumer jobs.
    await this.consuming;
    if (this.inFlightSteps.size === 0) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** Resolves once a claimed step has started, at once if one already has. */
  whenInFlight(): Promise<void> {
    if (this.inFlight().length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.inFlightWaiters.push(resolve);
    });
  }

  stepStarted(): void {
    const waiters = this.inFlightWaiters;
    this.inFlightWaiters = [];
    for (const resolve of waiters) resolve();
  }

  stepSettled(messageId: string): void {
    this.inFlightSteps.delete(messageId);
    if (this.inFlightSteps.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.claiming.abort();
    this.lifetime.abort();
    await this.starting?.catch(() => undefined);
    if (!this.running) {
      return;
    }

    this.log.info('Stopping executor runtime...');

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.deps.redisSubscriber) {
      await this.deps.redisSubscriber.punsubscribe(StreamKeys.stepAbortPattern).catch(() => {});
    }

    await unregisterExecutorHeartbeat(
      this.deps.redis,
      this.config.stepType,
      this.config.consumerName,
    ).catch((err: unknown) => {
      this.log.warn('Failed to unregister heartbeat', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.log.info(`Unregistered heartbeat for step type: ${this.config.stepType}`);

    const maxWaitMs = 30_000;
    const startTime = Date.now();

    while (this.limiter.active > 0 && Date.now() - startTime < maxWaitMs) {
      this.log.info(`Waiting for ${String(this.limiter.active)} in-flight jobs...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    for (const handler of Array.from(this.handlers.values())) {
      if (handler.shutdown) {
        await handler.shutdown();
      }
    }

    this.running = false;
    this.log.info('Executor runtime stopped');
  }
}
