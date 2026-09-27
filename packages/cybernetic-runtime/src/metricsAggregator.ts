import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  EntityMetricsBucket,
  EntityMetricsBucketDuration,
  EntityEventEnvelope,
  EntityOperatingMode,
} from '@aflow/schemas';
import { EntityEventEnvelopeSchema } from '@aflow/schemas';
import { ENTITY_EVENTS_STREAM_KEY } from '@aflow/redis';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface AggregationParams {
  tenantId: string;
  spaceId: string;
  bucketStart: Date;
  bucketDuration: EntityMetricsBucketDuration;
  /** PostgresJsDatabase — used for future Postgres persistence. */
  db: PostgresJsDatabase;
  redis: Redis;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a Date to a Redis stream ID prefix (millisecond timestamp).
 * Stream IDs are `<ms>-<seq>`, so using `<ms>` as a range bound captures
 * all entries at or after that millisecond.
 */
function dateToStreamId(d: Date): string {
  return `${d.getTime()}-0`;
}

/** Compute the end of a bucket given its start and duration. */
function bucketEnd(start: Date, duration: EntityMetricsBucketDuration): Date {
  const ms = start.getTime();
  switch (duration) {
    case '1h':
      return new Date(ms + 60 * 60 * 1_000);
    case '1d':
      return new Date(ms + 24 * 60 * 60 * 1_000);
    case '7d':
      return new Date(ms + 7 * 24 * 60 * 60 * 1_000);
  }
}

/**
 * Deserialize raw Redis XRANGE results into EntityEventEnvelope[].
 *
 * Each XRANGE entry is `[id, [field, value, field, value, ...]]`.
 */
function parseStreamEntries(entries: Array<[string, string[]]>): EntityEventEnvelope[] {
  const events: EntityEventEnvelope[] = [];

  for (const [, fields] of entries) {
    try {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (key !== undefined && value !== undefined) {
          obj[key] = value;
        }
      }

      // Re-use the same deserialization approach as entityEvents.ts
      const parsed = deserializeFields(obj);
      events.push(EntityEventEnvelopeSchema.parse(parsed));
    } catch (err) {
      getCyberneticLogger().warn('metricsAggregator: skipping unparseable entity event', {
        error: String(err),
      });
    }
  }

  return events;
}

/** String fields that must NOT be coerced to numbers during deserialization. */
const STRING_FIELDS = new Set([
  'eventId',
  'eventType',
  'spaceId',
  'tenantId',
  'causedBySessionId',
  'causedByStepExecutionId',
  'causedByEntityEventId',
  'workflowSlug',
  'workflowRunId',
  'operatingMode',
  'summary',
]);

function deserializeFields(fields: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === 'null') {
      result[key] = null;
    } else if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (STRING_FIELDS.has(key)) {
      result[key] = value;
    } else if (/^-?\d+$/.test(value)) {
      result[key] = parseInt(value, 10);
    } else if (/^-?\d*\.\d+$/.test(value)) {
      result[key] = parseFloat(value);
    } else if (value.startsWith('{') || value.startsWith('[')) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ============================================================================
// Read events for a time window
// ============================================================================

/**
 * Read all entity events from the Redis stream within [bucketStart, bucketEnd).
 *
 * Uses XRANGE with millisecond-precision IDs. Paginates in batches of 500
 * to avoid loading an unbounded number of entries at once.
 */
async function readEventsForWindow(
  redis: Redis,
  streamKey: string,
  start: Date,
  end: Date,
): Promise<EntityEventEnvelope[]> {
  const BATCH_SIZE = 500;
  const startId = dateToStreamId(start);
  // End is exclusive — use (endMs - 1) so we don't include events at exactly endMs
  const endId = `${end.getTime() - 1}-18446744073709551615`;

  const allEvents: EntityEventEnvelope[] = [];
  let cursor = startId;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const batch = (await redis.xrange(streamKey, cursor, endId, 'COUNT', BATCH_SIZE)) as Array<
      [string, string[]]
    >;

    if (batch.length === 0) break;

    const parsed = parseStreamEntries(batch);
    allEvents.push(...parsed);

    if (batch.length < BATCH_SIZE) break;

    // Advance cursor past the last returned ID
    const lastEntry = batch[batch.length - 1];
    if (!lastEntry) break;
    // Increment sequence to make cursor exclusive
    const [ms, seq] = lastEntry[0].split('-');
    cursor = `${ms}-${Number(seq) + 1}`;
  }

  return allEvents;
}

// ============================================================================
// Core aggregation
// ============================================================================

/**
 * Aggregate entity events into a single metrics bucket.
 *
 * Reads events from the Redis stream for the specified time window,
 * counts them by type, and computes derived rates. Returns a fully
 * populated `EntityMetricsBucket`.
 */
export async function aggregateMetricsBucket(
  params: AggregationParams,
): Promise<EntityMetricsBucket> {
  const { tenantId, spaceId, bucketStart, bucketDuration, redis } = params;
  const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);
  const end = bucketEnd(bucketStart, bucketDuration);

  getCyberneticLogger().debug(
    `metricsAggregator: aggregating bucket tenantId=${tenantId} spaceId=${spaceId} start=${bucketStart.toISOString()} duration=${bucketDuration}`,
  );

  const events = await readEventsForWindow(redis, streamKey, bucketStart, end);

  // ── Counters ─────────────────────────────────────────────────────────────

  let triggerCount = 0;
  let interactionCount = 0;
  let procedureActivationCount = 0;
  let runnerSessionCount = 0;
  let backgroundRunCount = 0;

  const modeDistribution: Record<EntityOperatingMode, number> = {
    conversational: 0,
    exploratory: 0,
    procedural: 0,
    supervisory: 0,
  };

  let coachProposalCount = 0;
  let coachRatifiedCount = 0;
  let coachRejectedCount = 0;
  let anomalyCount = 0;

  let evalPassCount = 0;
  let evalFailCount = 0;
  let evalRegressionCount = 0;
  let evalScoreSum = 0;
  let evalScoreCount = 0;

  let procedureCompletedCount = 0;
  let procedurePassedCount = 0;

  let totalCostUsd = 0;
  let totalTokens = 0;

  let prunedLearningCount = 0;

  // ── Walk events ──────────────────────────────────────────────────────────

  for (const event of events) {
    switch (event.eventType) {
      case 'entity.trigger.received': {
        triggerCount++;
        // Background run = trigger with lane === 'internal' in payload
        const payload = event.payload;
        if (payload['lane'] === 'internal') {
          backgroundRunCount++;
        }
        break;
      }

      case 'entity.interaction.started':
        interactionCount++;
        break;

      case 'entity.procedure.activated':
        procedureActivationCount++;
        break;

      case 'entity.runner.dispatched':
        runnerSessionCount++;
        break;

      // `entity.session.described` is a description OF activity, not activity:
      // counting it would make a space look busier the more the Clerk ran.
      case 'entity.task.dispatched':
      case 'entity.task.completed':
      case 'entity.run.updated':
      case 'entity.session.described':
        break;

      case 'entity.mode.transition': {
        const mode = event.operatingMode;
        if (mode && mode in modeDistribution) {
          modeDistribution[mode]++;
        }
        break;
      }

      case 'entity.procedure.completed': {
        procedureCompletedCount++;
        const p = event.payload;
        if (p['passed'] === true) {
          procedurePassedCount++;
        }
        // Sum cost/tokens if present (future payloads may carry these)
        if (typeof p['costUsd'] === 'number') {
          totalCostUsd += p['costUsd'];
        }
        if (typeof p['tokens'] === 'number') {
          totalTokens += p['tokens'];
        }
        break;
      }

      case 'entity.coach.proposal':
        coachProposalCount++;
        break;

      case 'entity.coach.ratified':
        coachRatifiedCount++;
        break;

      case 'entity.coach.rejected':
        coachRejectedCount++;
        break;

      case 'entity.coach.anomaly':
        anomalyCount++;
        break;

      case 'entity.coach.context_pressure':
        break;

      case 'entity.coach.consolidation':
        // Counted toward prunedLearningCount if payload indicates pruning
        {
          const c = event.payload;
          if (typeof c['prunedCount'] === 'number') {
            prunedLearningCount += c['prunedCount'];
          }
        }
        break;

      case 'entity.eval.completed': {
        // Payload shape from evalRunner.ts emitEvalCompleted: { verdict, scores, faultLayer }
        const e = event.payload;
        const verdict = e['verdict'] as string | undefined;
        if (verdict === 'pass') {
          evalPassCount++;
        } else if (verdict === 'fail' || verdict === 'partial') {
          evalFailCount++;
        }
        // scores.overall is the composite score
        const scores = e['scores'] as Record<string, unknown> | undefined;
        if (scores && typeof scores['overall'] === 'number') {
          evalScoreSum += scores['overall'];
          evalScoreCount++;
        }
        break;
      }

      case 'entity.eval.regression':
        evalRegressionCount++;
        break;

      // Events that don't contribute to metrics directly
      case 'entity.trigger.routed':
      case 'entity.interaction.ended':
      case 'entity.runner.completed':
      case 'entity.runner.reflection':
      case 'entity.context.assembled':
      case 'entity.coach.activated':
      case 'entity.coach.completed':
      case 'entity.coach.promotion':
      case 'entity.coach.suppressed':
      case 'entity.coach.platform_issue_acknowledged':
      case 'entity.coach.anomaly_acknowledged':
      case 'entity.coach.withdrawn':
      case 'entity.coach.ratification_failed':
      case 'entity.coach.preview_failed':
      case 'entity.coach.apply_failed':
      case 'entity.coach.enrichment_suppressed':
      case 'entity.coach.sampling_adjusted':
      case 'entity.skill.authored':
      case 'entity.skill.maturity_transition':
      case 'entity.memory.mutation':
      case 'entity.identity.updated':
      case 'entity.binding.ratified':
      case 'entity.binding.removed':
        break;

      // 102h entity lifecycle events — counted but not aggregated into specific metrics
      case 'entity.space.bootstrapped':
      case 'entity.directives.updated':
        break;

      // Arming a schedule is configuration, not a run. The firing it leads to
      // announces itself as `entity.trigger.received` and is counted there, so
      // counting this too would report work that has not happened yet.
      case 'entity.schedule.armed':
        break;

      // 104b interaction phase — observability, not aggregated into metrics
      case 'entity.interaction.phase':
        break;

      // 104c hot-path hardening events — observability, not aggregated into metrics
      case 'entity.hook.failed':
      case 'entity.budget.exceeded':
      case 'entity.scarcity.dormant':
        break;

      // 104e user feedback & causal measurement — observability, not bucket metrics
      case 'entity.user.feedback':
      case 'entity.causal.measured':
        break;
    }
  }

  // ── Derived rates ────────────────────────────────────────────────────────

  const totalEvals = evalPassCount + evalFailCount;

  const bucket: EntityMetricsBucket = {
    spaceId,
    tenantId,
    bucketStart: bucketStart.toISOString(),
    bucketDuration,

    // Activity
    triggerCount,
    interactionCount,
    procedureActivationCount,
    runnerSessionCount,
    backgroundRunCount,

    // Mode distribution — normalize raw counts to fractions (0.0-1.0)
    modeDistribution: (() => {
      const total =
        modeDistribution.conversational +
        modeDistribution.exploratory +
        modeDistribution.procedural +
        modeDistribution.supervisory;
      if (total === 0) return modeDistribution; // all zeros is fine
      return {
        conversational: modeDistribution.conversational / total,
        exploratory: modeDistribution.exploratory / total,
        procedural: modeDistribution.procedural / total,
        supervisory: modeDistribution.supervisory / total,
      };
    })(),

    // Cost (summed from procedure.completed payloads, or 0 as placeholder)
    totalCostUsd,
    totalTokens,

    // Competence
    procedureSuccessRate:
      procedureCompletedCount > 0 ? procedurePassedCount / procedureCompletedCount : undefined,
    coachProposalCount,
    coachRatifiedCount,
    coachRejectedCount,
    anomalyCount,

    // Evaluation signals
    evalPassRate: totalEvals > 0 ? evalPassCount / totalEvals : undefined,
    evalRegressionCount,
    averageEvalScore: evalScoreCount > 0 ? evalScoreSum / evalScoreCount : undefined,

    prunedLearningCount,
  };

  getCyberneticLogger().debug(
    `metricsAggregator: bucket aggregated tenantId=${tenantId} spaceId=${spaceId} start=${bucketStart.toISOString()} duration=${bucketDuration} events=${String(events.length)} triggers=${String(triggerCount)} interactions=${String(interactionCount)}`,
  );

  return bucket;
}
