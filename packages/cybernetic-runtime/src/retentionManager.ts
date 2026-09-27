import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ENTITY_EVENTS_STREAM_KEY } from '@aflow/redis';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Configuration
// ============================================================================

export interface RetentionConfig {
  /** Days to keep raw entity events in the Redis stream. Default 30. */
  rawEventRetentionDays: number;
  /** Days to keep hourly metric buckets in Postgres. Default 90. */
  hourlyMetricsRetentionDays: number;
  /** Days to keep daily metric buckets in Postgres. Default 365. */
  dailyMetricsRetentionDays: number;
  /** Days to keep context assembly snapshots. Default 14. */
  contextSnapshotRetentionDays: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  rawEventRetentionDays: 30,
  hourlyMetricsRetentionDays: 90,
  dailyMetricsRetentionDays: 365,
  contextSnapshotRetentionDays: 14,
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a retention window (days) into a Redis stream MINID
 * (millisecond timestamp). Events older than this will be trimmed.
 */
function retentionMinId(retentionDays: number, now: Date): string {
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1_000;
  return `${cutoffMs}-0`;
}

// ============================================================================
// Retention enforcement
// ============================================================================

export interface EnforceRetentionParams {
  tenantId: string;
  spaceId: string;
  config: RetentionConfig;
  /** PostgresJsDatabase — used for future Postgres cleanup. */
  db: PostgresJsDatabase;
  redis: Redis;
  /** Override "now" for testing. Defaults to current time. */
  now?: Date;
}

export interface RetentionResult {
  /** Number of raw entity events trimmed from the Redis stream. */
  eventsDeleted: number;
  /** Number of metric bucket rows deleted from Postgres (0 until migration). */
  metricsDeleted: number;
  /** Number of context snapshot docs deleted (0 until implemented). */
  snapshotsDeleted: number;
}

/**
 * Enforce retention policy for a single space.
 *
 * 1. Trim the Redis entity events stream using XTRIM MINID.
 * 2. (Future) Delete old metric buckets from Postgres entity_metrics table.
 * 3. (Future) Delete old context assembly snapshots from memoryDocs.
 */
export async function enforceRetention(params: EnforceRetentionParams): Promise<RetentionResult> {
  const { tenantId, spaceId, config, redis, now = new Date() } = params;
  const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);

  getCyberneticLogger().debug(
    `retentionManager: enforcing retention tenantId=${tenantId} spaceId=${spaceId} rawDays=${String(config.rawEventRetentionDays)}`,
  );

  // ── 1. Trim Redis stream ───────────────────────────────────────────────

  // Get stream length before trim for reporting
  const lengthBefore = await redis.xlen(streamKey);

  const minId = retentionMinId(config.rawEventRetentionDays, now);
  await redis.xtrim(streamKey, 'MINID', '~', minId);

  const lengthAfter = await redis.xlen(streamKey);
  const eventsDeleted = Math.max(0, lengthBefore - lengthAfter);

  // ── 2. Delete old Postgres metric buckets ──────────────────────────────

  // TODO: Implement once entity_metrics Postgres table is created.
  // Will use `DELETE FROM entity_metrics WHERE bucket_duration = '1h'
  //   AND bucket_start < now - hourlyMetricsRetentionDays` etc.
  const metricsDeleted = 0;

  // ── 3. Delete old context snapshots ────────────────────────────────────

  // TODO: Implement once context snapshot storage pattern is finalized.
  // Will delete memoryDocs with path prefix `/evals/*/results/` older
  // than contextSnapshotRetentionDays.
  const snapshotsDeleted = 0;

  getCyberneticLogger().info(
    `retentionManager: retention enforced tenantId=${tenantId} spaceId=${spaceId} eventsDeleted=${String(eventsDeleted)} metricsDeleted=${String(metricsDeleted)} snapshotsDeleted=${String(snapshotsDeleted)} streamBefore=${String(lengthBefore)} streamAfter=${String(lengthAfter)}`,
  );

  return { eventsDeleted, metricsDeleted, snapshotsDeleted };
}
