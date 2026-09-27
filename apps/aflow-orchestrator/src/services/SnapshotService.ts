import { createHash } from 'node:crypto';
import { logOrchestratorError } from '../lib/orchestratorLogger.js';
import type { Redis } from 'ioredis';
import {
  type RunSnapshot,
  RunSnapshotSchema,
  type SnapshotTriggerConfig,
  RecoveryStreamKeys,
} from '@aflow/schemas';
import {
  getSessionStateSafe,
  getStepState,
  HOT_STATE_TTL_SECONDS,
  getRecoveryEventCount,
  resetRecoveryEventCount,
  readRecoveryEvents,
} from '@aflow/redis';
import type { ManifestService } from './ManifestService.js';

// ============================================================================
// Types
// ============================================================================

export interface SnapshotService {
  /**
   * Check event count and take a snapshot if threshold is reached.
   * Fire-and-forget — errors are logged, never thrown.
   */
  maybeSnapshot(tenantId: string, runId: string): void;

  /**
   * Force a snapshot regardless of event count.
   * Called at major transition boundaries (pause, completion, shard handoff).
   * Fire-and-forget — errors are logged, never thrown.
   */
  forceSnapshot(tenantId: string, runId: string): void;

  /**
   * Load the latest snapshot for a run from Redis.
   * Returns null if no snapshot exists or if the snapshot is corrupt.
   *
   * NOTE: Snapshots are Redis-local. After total Redis loss, this returns null.
   * Full recovery after Redis loss requires durable externalization (Package 3).
   */
  loadSnapshot(tenantId: string, runId: string): Promise<RunSnapshot | null>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TRIGGER_CONFIG: SnapshotTriggerConfig = {
  everyNEvents: 50,
  maxInlineBytes: 1_048_576, // 1MB
};

/** Step event types that indicate a step is no longer active */
const TERMINAL_STEP_EVENTS = new Set(['step.succeeded', 'step.failed', 'step.cancelled']);

// ============================================================================
// Canonical JSON helpers
// ============================================================================

/**
 * Canonical JSON: sort object keys recursively for deterministic serialisation.
 * Arrays preserve order. Primitives pass through unchanged.
 */
function canonicalStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

/**
 * Compute SHA-256 checksum over the state portion of a snapshot.
 * Excludes metadata (version, seq, timestamp) — only covers the actual state.
 */
function computeChecksum(
  runHotState: Record<string, unknown>,
  stepHotStates: Record<string, Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(canonicalStringify({ runHotState, stepHotStates }))
    .digest('hex');
}

// ============================================================================
// Redis Key
// ============================================================================

/**
 * Redis key for storing the latest snapshot data.
 * Separate from `snapshotRefKey` which stores external PayloadRef.
 */
function snapshotDataKey(tenantId: string, runId: string): string {
  return `aflow:snapshot:${tenantId}:${runId}:latest`;
}

// ============================================================================
// Factory
// ============================================================================

export interface SnapshotServiceDeps {
  redis: Redis;
  manifestService?: ManifestService;
  triggerConfig?: Partial<SnapshotTriggerConfig>;
}

export function createSnapshotService(deps: SnapshotServiceDeps): SnapshotService {
  const { redis, manifestService } = deps;
  const config: SnapshotTriggerConfig = {
    ...DEFAULT_TRIGGER_CONFIG,
    ...deps.triggerConfig,
  };

  // ── Per-run promise chains ──────────────────────────────────────────────
  //
  // Same pattern as ManifestService: serialised per-run, concurrent across runs.
  // Prevents interleaved snapshot reads/writes for the same run.

  const runChains = new Map<string, Promise<void>>();

  function enqueueForRun(tenantId: string, runId: string, fn: () => Promise<void>): void {
    const prev = runChains.get(runId) ?? Promise.resolve();

    const next = prev
      .catch(() => {
        /* ensure previous rejection does not block the chain */
      })
      .then(fn)
      .catch((err: unknown) => {
        logOrchestratorError(`[SnapshotService] snapshot failed for ${runId}:`, err, {
          tenantId,
          runId,
        });
      })
      .finally(() => {
        if (runChains.get(runId) === next) {
          runChains.delete(runId);
        }
      });

    runChains.set(runId, next);
  }

  // ── Active step discovery ───────────────────────────────────────────────
  //
  // Replays recovery events to find ALL currently active steps, not just
  // currentStepExecutionId. This correctly handles parallel tool calls
  // where multiple steps are in-flight simultaneously.
  //
  // Active = scheduled but not yet succeeded/failed/cancelled.
  // The recovery event stream is bounded (trimmed after each snapshot)
  // so this is always cheap — at most ~N events where N = everyNEvents.

  async function discoverActiveStepIds(tenantId: string, runId: string): Promise<Set<string>> {
    const events = await readRecoveryEvents(redis, tenantId, runId);
    const active = new Set<string>();

    for (const event of events) {
      const stepId = event.stepExecutionId;
      if (!stepId) continue;

      if (event.type === 'step.scheduled') {
        active.add(stepId);
      } else if (TERMINAL_STEP_EVENTS.has(event.type)) {
        active.delete(stepId);
      }
    }

    return active;
  }

  // ── Core snapshot logic ─────────────────────────────────────────────────

  async function takeSnapshot(tenantId: string, runId: string): Promise<void> {
    // 1. Read current recovery seq
    const seqKey = RecoveryStreamKeys.recoverySeqKey(tenantId, runId);
    const seqStr = await redis.get(seqKey);
    const seq = seqStr ? parseInt(seqStr, 10) : 0;

    if (seq === 0) {
      // No recovery events have been emitted — nothing to snapshot
      return;
    }

    // 2. Read SessionHotState
    const runResult = await getSessionStateSafe(redis, tenantId, runId);
    if (!runResult.ok) {
      console.warn(`[SnapshotService] Cannot snapshot run ${runId}: hot state ${runResult.kind}`);
      return;
    }

    // 3. Discover ALL active step execution IDs from recovery events
    const activeStepIds = await discoverActiveStepIds(tenantId, runId);

    // Also include currentStepExecutionId as a safety net — even if it wasn't
    // in a step.scheduled event (e.g., paused step referenced by run state)
    const currentStepExecId = runResult.state.currentStepExecutionId;
    if (currentStepExecId) {
      activeStepIds.add(currentStepExecId);
    }

    // 4. Read active StepHotStates from Redis
    const stepHotStates: Record<string, Record<string, unknown>> = {};

    for (const stepExecId of activeStepIds) {
      const stepState = await getStepState(redis, tenantId, stepExecId);
      if (stepState) {
        stepHotStates[stepExecId] = stepState as unknown as Record<string, unknown>;
      }
    }

    // 5. Build and checksum
    const runHotState = runResult.state as unknown as Record<string, unknown>;
    const checksum = computeChecksum(runHotState, stepHotStates);

    const snapshot: RunSnapshot = {
      version: 1,
      tenantId,
      sessionId: runId,
      seq,
      timestamp: Date.now(),
      sessionHotState: runHotState,
      stepHotStates,
      checksum,
    };

    // 6. Store in Redis
    const snapshotJson = JSON.stringify(snapshot);
    const snapshotBytes = Buffer.byteLength(snapshotJson, 'utf-8');

    if (snapshotBytes > config.maxInlineBytes) {
      console.warn(
        `[SnapshotService] Snapshot for run ${runId} is ${String(snapshotBytes)} bytes ` +
          `(exceeds ${String(config.maxInlineBytes)} limit). PayloadStore externalization pending.`,
      );
    }

    const key = snapshotDataKey(tenantId, runId);
    await redis.set(key, snapshotJson, 'EX', HOT_STATE_TTL_SECONDS);

    // 7. Reset event count (next snapshot triggers after another N events)
    await resetRecoveryEventCount(redis, tenantId, runId);

    // 8. Update manifest with snapshot seq (best-effort)
    // NOTE: snapshotRef is Redis-local — NOT durable after total Redis loss.
    // The seq is still useful for determining replay bounds during recovery.
    // Durable externalization (PayloadStore/GCS) is deferred to Package 3.
    if (manifestService) {
      const repo = manifestService.getRepository();
      const snapshotRef = `redis:${snapshotDataKey(tenantId, runId)}`;
      repo.updateSnapshot(runId, snapshotRef, seq).catch((err: unknown) => {
        logOrchestratorError(
          `[SnapshotService] Failed to update manifest snapshot for ${runId}:`,
          err,
          {
            tenantId,
            runId,
          },
        );
      });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  return {
    maybeSnapshot(tenantId, runId) {
      enqueueForRun(tenantId, runId, async () => {
        const count = await getRecoveryEventCount(redis, tenantId, runId);
        if (count < config.everyNEvents) return;
        await takeSnapshot(tenantId, runId);
      });
    },

    forceSnapshot(tenantId, runId) {
      enqueueForRun(tenantId, runId, () => takeSnapshot(tenantId, runId));
    },

    async loadSnapshot(tenantId, runId) {
      const key = snapshotDataKey(tenantId, runId);
      const data = await redis.get(key);
      if (!data) return null;

      try {
        const parsed: unknown = JSON.parse(data);
        const result = RunSnapshotSchema.safeParse(parsed);
        if (!result.success) {
          console.warn(
            `[SnapshotService] Invalid snapshot for run ${runId}: ${result.error.message}`,
          );
          return null;
        }

        // Verify checksum
        const expected = computeChecksum(result.data.sessionHotState, result.data.stepHotStates);
        if (expected !== result.data.checksum) {
          console.warn(`[SnapshotService] Checksum mismatch for snapshot of run ${runId}`);
          return null;
        }

        return result.data;
      } catch (err) {
        console.warn(
          `[SnapshotService] Failed to parse snapshot for run ${runId}:`,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    },
  };
}
