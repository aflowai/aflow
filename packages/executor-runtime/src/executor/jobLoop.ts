/**
 * Job consume loop — stream read, pending reclaim, scheduling.
 */
import type { StepJobMessage } from '@aflow/schemas';
import {
  readStepJobs,
  listPendingStepJobs,
  claimPendingStepJobsByIds,
  isExecutorConsumerAlive,
} from '@aflow/redis';
import type { ConcurrencyLimiter } from '../concurrency.js';
import type { ExecutorLogger, SlotController } from '../types.js';
import { CLAIM_INTERVAL_MS } from './constants.js';
import { processJob, type ProcessJobHost } from './processJob.js';

export interface JobLoopHost extends ProcessJobHost {
  limiter: ConcurrencyLimiter;
  inFlightMessageIds: Set<string>;
  stopRequested: boolean;
}

export async function claimPendingMessages(host: JobLoopHost): Promise<void> {
  const redis = host.deps.redisBlocking ?? host.deps.redis;

  try {
    const pending = await listPendingStepJobs(redis, host.config.stepType, {
      minIdleMs: host.config.pendingTimeoutMs,
      count: host.config.batchSize * 2,
      streamKey: host.config.streamKey,
      consumerGroup: host.config.consumerGroup,
    });

    let skippedSelf = 0;
    let skippedAlive = 0;
    const idsToClaim: string[] = [];

    for (const entry of pending) {
      if (entry.consumer === host.config.consumerName) {
        skippedSelf++;
        continue;
      }
      const alive = await isExecutorConsumerAlive(
        host.deps.redis,
        host.config.stepType,
        entry.consumer,
      );
      if (alive) {
        skippedAlive++;
        continue;
      }
      idsToClaim.push(entry.id);
    }

    if (idsToClaim.length > 0) {
      const claimed = await claimPendingStepJobsByIds(
        redis,
        host.config.stepType,
        host.config.consumerName,
        idsToClaim,
        { streamKey: host.config.streamKey, consumerGroup: host.config.consumerGroup },
      );

      host.log.info('Reclaim: dead-consumer-aware claim', {
        pendingScanned: pending.length,
        skippedSelf,
        skippedAlive,
        claimed: claimed.length,
      });

      for (const { id: messageId, job } of claimed) {
        scheduleJob(host, messageId, job);
      }
    } else if (pending.length > 0 || skippedSelf > 0 || skippedAlive > 0) {
      host.log.debug('Reclaim: no dead-owned pending to claim', {
        pendingScanned: pending.length,
        skippedSelf,
        skippedAlive,
      });
    }
  } catch (error) {
    host.log.warn('Failed to claim pending messages', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function scheduleJob(host: JobLoopHost, messageId: string, job: StepJobMessage): void {
  if (host.inFlightMessageIds.has(messageId)) {
    host.log.debug('Skipping duplicate schedule', { messageId });
    return;
  }
  host.inFlightMessageIds.add(messageId);
  void (async (): Promise<void> => {
    await host.limiter.acquire();
    let held = true;
    let parentEnded = false;
    const slotController: SlotController = {
      get held(): boolean {
        return held;
      },
      release: (): void => {
        if (held) {
          host.limiter.release();
          held = false;
        }
      },
      acquire: async (): Promise<void> => {
        if (parentEnded || held) return;
        await host.limiter.acquire();
        held = true;
      },
    };
    try {
      await processJob(host, messageId, job, slotController);
    } catch (err) {
      host.log.error('Unhandled error in processJob', {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      parentEnded = true;
      host.limiter.release();
      host.inFlightMessageIds.delete(messageId);
    }
  })();
}

export async function consumeLoop(host: JobLoopHost): Promise<void> {
  let lastClaimTime = Date.now();

  while (!host.stopRequested) {
    try {
      const now = Date.now();
      if (now - lastClaimTime >= CLAIM_INTERVAL_MS) {
        await claimPendingMessages(host);
        lastClaimTime = now;
      }

      if (!host.limiter.hasCapacity) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const jobs = await readStepJobs(
        host.deps.redisBlocking,
        host.config.stepType,
        host.config.consumerName,
        {
          count: host.config.batchSize,
          blockMs: host.config.blockMs,
          streamKey: host.config.streamKey,
          consumerGroup: host.config.consumerGroup,
        },
      );

      for (const { id: messageId, job } of jobs) {
        scheduleJob(host, messageId, job);
      }
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopRequested can change
      if (!host.stopRequested) {
        host.log.error('Error in consume loop', {
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

export type { ExecutorLogger };
