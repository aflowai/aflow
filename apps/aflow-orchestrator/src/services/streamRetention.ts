/**
 * Drains the retention candidate set and trims each claimed stream to the point
 * every consumer group has finished with.
 *
 * Hosted here rather than in the executors because the orchestrator is always
 * running and already owns transport hygiene; producers and executors arm
 * candidates and this drains all of them. SPOP is atomic, so several
 * orchestrator instances share the set without coordinating.
 */
import type { Redis } from 'ioredis';
import {
  claimRetentionCandidates,
  peekRetentionCandidates,
  rearmRetentionCandidates,
  trimToAckedFrontier,
} from '@aflow/redis';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskLogger,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane } from '@aflow/schemas';
import { recordStreamRetention } from '@aflow/observability';

export const STREAM_RETENTION_TASK_ID = 'orchestrator.stream_retention';

export interface StreamRetentionDeps {
  redis: Redis;
  logger: BackgroundTaskLogger;
}

export function createStreamRetentionTask(deps: StreamRetentionDeps): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(STREAM_RETENTION_TASK_ID);
  return createBackgroundTaskRunner(
    {
      taskId: STREAM_RETENTION_TASK_ID,
      scope: runtime.scope,
      intervalMs: runtime.intervalMs ?? 60_000,
      maxBatch: runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
      // Without this the runner's own failures — a rejected SPOP, an exceeded
      // cycle budget — are swallowed before they reach any log.
      logger: deps.logger,
    },
    async (ctx): Promise<BackgroundTaskCycleResult> => {
      const dryRun = ctx.mode === 'observe';

      // Observe must not mutate the set it is observing, so it reads without
      // consuming. The enabled path pops, which is what keeps concurrent
      // orchestrators off the same stream.
      const candidates = dryRun
        ? await peekRetentionCandidates(deps.redis, ctx.maxBatch)
        : await claimRetentionCandidates(deps.redis, ctx.maxBatch);
      if (candidates.length === 0) return { candidates: 0 };

      let processed = 0;
      let failed = 0;
      let trimmed = 0;
      // The metric is aggregated by stream family to keep 128 shards each of
      // results and control out of the label set, so the specific stream that is
      // not draining is named here instead. Logs carry that cardinality happily.
      let oldestHeld: { streamKey: string; ageMs: number } | null = null;
      // A popped candidate is off the set. Anything not carried through to a
      // completed trim has to go back: the arm that produced it may have been
      // the stream's last transport event, in which case nothing would restore
      // it and its entries would sit there unreclaimed indefinitely.
      const unfinished: string[] = [];

      for (const [index, streamKey] of candidates.entries()) {
        if (ctx.budgetExhausted() || ctx.signal.aborted) {
          unfinished.push(...candidates.slice(index));
          break;
        }
        try {
          const result = await trimToAckedFrontier(deps.redis, streamKey, { dryRun });
          recordStreamRetention(result);
          trimmed += result.trimmed;
          processed++;
          if (
            result.oldestRetainedAgeMs !== null &&
            (oldestHeld === null || result.oldestRetainedAgeMs > oldestHeld.ageMs)
          ) {
            oldestHeld = { streamKey, ageMs: result.oldestRetainedAgeMs };
          }
        } catch (err) {
          failed++;
          unfinished.push(streamKey);
          deps.logger.warn('[stream-retention] trim failed', {
            streamKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Observe never popped, so there is nothing to give back.
      if (!dryRun && unfinished.length > 0) {
        try {
          await rearmRetentionCandidates(deps.redis, unfinished);
        } catch (err) {
          deps.logger.error(
            '[stream-retention] could not re-arm candidates',
            err instanceof Error ? err : new Error(String(err)),
            { count: unfinished.length },
          );
        }
      }

      if (trimmed > 0 || backgroundWorkVerboseLogsEnabled()) {
        deps.logger.info('[stream-retention] reclaimed acked entries', {
          streams: processed,
          trimmed,
          dryRun,
          ...(oldestHeld === null
            ? {}
            : {
                oldestHeldStream: oldestHeld.streamKey,
                oldestHeldAgeMs: oldestHeld.ageMs,
              }),
        });
      }

      return {
        candidates: candidates.length,
        processed,
        failed,
        // Never in observe mode: peeking does not drain, so a full batch is the
        // steady state and re-arming immediately would spin. And not while
        // candidates were handed back, or a failing stream would be retried in a
        // tight loop instead of on the next cadence.
        hasMore: !dryRun && candidates.length === ctx.maxBatch && unfinished.length === 0,
      };
    },
  );
}
