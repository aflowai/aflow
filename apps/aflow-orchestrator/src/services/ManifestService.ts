import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createRecoverableRunsRepository, type RecoverableRunsRepository } from '@aflow/database';
import { shardFor } from '@aflow/redis';
import { logOrchestratorError } from '../lib/orchestratorLogger.js';

// ============================================================================
// Types
// ============================================================================

export interface ManifestService {
  /**
   * Track a new run in the manifest.
   * Called when a run is created (start_run).
   */
  trackRun(params: { runId: string; tenantId: string; status: string }): void;

  /**
   * Update a run's status in the manifest.
   * Called on status transitions (RUNNING → PAUSED, etc.)
   * Terminal statuses (SUCCEEDED/FAILED/CANCELLED) remove the run.
   */
  updateStatus(runId: string, tenantId: string, status: string): void;

  /**
   * Remove a terminal run from the manifest.
   * Called by the projection worker after flushing to Postgres.
   */
  removeTerminal(runId: string): void;

  /**
   * Remove multiple terminal runs from the manifest.
   */
  removeTerminalBatch(runIds: string[]): void;

  /**
   * Get the underlying repository (for RecoveryService queries).
   */
  getRepository(): RecoverableRunsRepository;
}

// Statuses that are removed from the recovery manifest.
// PAUSED/WAITING_ON_CHILD are included because resting runs are rehydrated
// on-demand from Postgres (hot_state_snapshot) rather than eagerly recovered on startup.
const TERMINAL_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'PAUSED',
  'WAITING_ON_CHILD',
]);

// ============================================================================
// Factory
// ============================================================================

export function createManifestService(db: PostgresJsDatabase): ManifestService {
  const repo = createRecoverableRunsRepository(db);

  // ── Per-run promise chains ──────────────────────────────────────────────
  //
  // Each runId maps to the tail of its serialised promise chain. New work
  // for the same run is appended to the chain so it waits for the previous
  // write to finish. This prevents ordering races like:
  //   trackRun(RUNNING) → updateStatus(FAILED→remove)
  // where the remove might complete before the upsert, resurrecting the run.
  //
  // Chains for different runs execute concurrently.
  // Auto-cleanup: when a chain settles and no newer work was appended,
  // the entry is removed to prevent unbounded growth.

  const runChains = new Map<string, Promise<void>>();

  function enqueueForRun(
    runId: string,
    label: string,
    fn: () => Promise<void>,
    logContext: Record<string, unknown> = {},
  ): void {
    const prev = runChains.get(runId) ?? Promise.resolve();

    const next = prev
      .catch(() => {
        /* ensure previous rejection does not block the chain */
      })
      .then(fn)
      .catch((err: unknown) => {
        logOrchestratorError(`[ManifestService] ${label} failed:`, err, { runId, ...logContext });
      })
      .finally(() => {
        // Auto-cleanup: remove entry only if no newer work was appended
        if (runChains.get(runId) === next) {
          runChains.delete(runId);
        }
      });

    runChains.set(runId, next);
  }

  return {
    trackRun({ runId, tenantId, status }) {
      const shardId = shardFor(runId);
      enqueueForRun(
        runId,
        `trackRun(${runId})`,
        () => repo.upsert({ runId, tenantId, shardId, status }),
        { tenantId },
      );
    },

    updateStatus(runId, tenantId, status) {
      if (TERMINAL_STATUSES.has(status)) {
        // Terminal runs are removed, not updated
        enqueueForRun(runId, `removeTerminal(${runId})`, () => repo.remove(runId));
      } else {
        const shardId = shardFor(runId);
        enqueueForRun(
          runId,
          `updateStatus(${runId}, ${status})`,
          () => repo.upsert({ runId, tenantId, shardId, status }),
          { tenantId },
        );
      }
    },

    removeTerminal(runId) {
      enqueueForRun(runId, `removeTerminal(${runId})`, () => repo.remove(runId));
    },

    removeTerminalBatch(runIds) {
      if (runIds.length === 0) return;
      // Batch removal doesn't need per-run ordering — it's only called
      // by the projection worker as a final cleanup, after individual
      // removeTerminal calls have already been enqueued.
      repo.removeBatch(runIds).catch((err: unknown) => {
        logOrchestratorError(
          `[ManifestService] removeTerminalBatch(${String(runIds.length)} runs) failed:`,
          err,
          { runCount: runIds.length },
        );
      });
    },

    getRepository() {
      return repo;
    },
  };
}
