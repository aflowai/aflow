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

function executorBackgroundServices(stepType: string): BackgroundTaskService[] {
  const own = BackgroundTaskServiceSchema.safeParse(`executor-${stepType}`);
  return own.success ? ['shared-runtime', own.data] : ['shared-runtime'];
}

export class ExecutorRuntime implements JobLoopHost {
  readonly config: ExecutorConfig;
  readonly deps: ExecutorDependencies;
  readonly handlers = new Map<string, StepHandler>();
  readonly limiter: ConcurrencyLimiter;
  readonly log;

  readonly inFlightMessageIds = new Set<string>();
  readonly abortControllers = new Map<string, AbortController>();

  stopRequested = false;
  private running = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

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

  getHandler(stepType: string): StepHandler | undefined {
    return this.handlers.get(stepType);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

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
    this.stopRequested = false;

    void consumeLoop(this);
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.log.info('Stopping executor runtime...');
    this.stopRequested = true;

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
