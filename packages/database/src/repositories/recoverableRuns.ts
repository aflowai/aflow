import { eq, and, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { recoverableRuns, type RecoverableRunRow } from '../schema/public.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Statuses that indicate a run is recoverable (non-terminal and actively executing).
 * PAUSED is intentionally excluded — paused runs are a stable resting state, not an
 * interrupted execution. They are rehydrated on-demand from Postgres (hot_state_snapshot)
 * when a user resumes them, rather than eagerly restored on every orchestrator restart.
 */
const RECOVERABLE_STATUSES = ['RUNNING', 'STALLED', 'QUEUED'] as const;

/** Statuses that indicate a run should be removed from the recovery manifest. */
export type TerminalStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PAUSED';

export type RecoverableStatus = (typeof RECOVERABLE_STATUSES)[number];

// ============================================================================
// Repository Interface
// ============================================================================

export interface RecoverableRunsRepository {
  /**
   * Upsert a run into the recovery manifest.
   * Called on run creation and on every status change.
   */
  upsert(params: {
    runId: string;
    tenantId: string;
    shardId: number;
    status: string;
    lastRecoverySeq?: number;
    latestSnapshotRef?: string | null;
    latestSnapshotSeq?: number | null;
  }): Promise<void>;

  /**
   * Update the recovery seq for a run (called as recovery events are emitted).
   */
  updateSeq(runId: string, lastRecoverySeq: number): Promise<void>;

  /**
   * Update snapshot info for a run (called after a snapshot is taken).
   */
  updateSnapshot(runId: string, snapshotRef: string, snapshotSeq: number): Promise<void>;

  /**
   * Get all recoverable (non-terminal) runs for a set of shards.
   * Used on shard acquisition to discover runs needing recovery.
   */
  getByShards(shardIds: number[]): Promise<RecoverableRunRow[]>;

  /**
   * Remove a run from the manifest (called when run reaches terminal state).
   */
  remove(runId: string): Promise<void>;

  /**
   * Remove multiple runs from the manifest in a single query.
   */
  removeBatch(runIds: string[]): Promise<void>;

  /**
   * Get a single run's manifest entry (for debugging/testing).
   */
  getByRunId(runId: string): Promise<RecoverableRunRow | null>;
}

// ============================================================================
// Implementation
// ============================================================================

export function createRecoverableRunsRepository(db: PostgresJsDatabase): RecoverableRunsRepository {
  return {
    async upsert(params) {
      const now = new Date();
      await db
        .insert(recoverableRuns)
        .values({
          runId: params.runId,
          tenantId: params.tenantId,
          shardId: params.shardId,
          status: params.status,
          lastRecoverySeq: params.lastRecoverySeq ?? 0,
          ...(params.latestSnapshotRef !== undefined
            ? { latestSnapshotRef: params.latestSnapshotRef }
            : {}),
          ...(params.latestSnapshotSeq !== undefined
            ? { latestSnapshotSeq: params.latestSnapshotSeq }
            : {}),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: recoverableRuns.runId,
          set: {
            status: params.status,
            ...(params.lastRecoverySeq !== undefined
              ? { lastRecoverySeq: params.lastRecoverySeq }
              : {}),
            ...(params.latestSnapshotRef !== undefined
              ? { latestSnapshotRef: params.latestSnapshotRef }
              : {}),
            ...(params.latestSnapshotSeq !== undefined
              ? { latestSnapshotSeq: params.latestSnapshotSeq }
              : {}),
            updatedAt: now,
          },
        });
    },

    async updateSeq(runId, lastRecoverySeq) {
      await db
        .update(recoverableRuns)
        .set({ lastRecoverySeq, updatedAt: new Date() })
        .where(eq(recoverableRuns.runId, runId));
    },

    async updateSnapshot(runId, snapshotRef, snapshotSeq) {
      await db
        .update(recoverableRuns)
        .set({
          latestSnapshotRef: snapshotRef,
          latestSnapshotSeq: snapshotSeq,
          updatedAt: new Date(),
        })
        .where(eq(recoverableRuns.runId, runId));
    },

    async getByShards(shardIds) {
      if (shardIds.length === 0) return [];

      return db
        .select()
        .from(recoverableRuns)
        .where(
          and(
            inArray(recoverableRuns.shardId, shardIds),
            inArray(recoverableRuns.status, [...RECOVERABLE_STATUSES]),
          ),
        );
    },

    async remove(runId) {
      await db.delete(recoverableRuns).where(eq(recoverableRuns.runId, runId));
    },

    async removeBatch(runIds) {
      if (runIds.length === 0) return;
      await db.delete(recoverableRuns).where(inArray(recoverableRuns.runId, runIds));
    },

    async getByRunId(runId) {
      const rows = await db
        .select()
        .from(recoverableRuns)
        .where(eq(recoverableRuns.runId, runId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
