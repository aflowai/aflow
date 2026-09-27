import { z } from 'zod';

// ============================================================================
// Snapshot Schema
// ============================================================================

/**
 * A point-in-time snapshot of a run's hot state.
 *
 * Contains everything needed to resume orchestration:
 * - Full SessionHotState
 * - All active StepHotState entries (not completed/failed steps)
 * - The recovery event seq at snapshot time (replay starts after this)
 * - A SHA-256 checksum for integrity verification
 */
export const RunSnapshotSchema = z.object({
  /** Schema version for upcasting */
  version: z.literal(1),

  /** Tenant context */
  tenantId: z.string(),

  /** Session this snapshot belongs to */
  sessionId: z.string().uuid(),

  /** Recovery event seq at snapshot time. Replay starts from seq + 1. */
  seq: z.number().int().nonnegative(),

  /** When this snapshot was taken (epoch ms) */
  timestamp: z.number(),

  /** Full serialized SessionHotState (JSON) */
  sessionHotState: z.record(z.unknown()),

  /** Active StepHotState entries keyed by stepExecutionId (JSON) */
  stepHotStates: z.record(z.string(), z.record(z.unknown())),

  /** SHA-256 of the canonical JSON serialization (integrity check) */
  checksum: z.string(),
});

export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

// ============================================================================
// Snapshot Trigger Configuration
// ============================================================================

export const SnapshotTriggerConfigSchema = z.object({
  /** Take a snapshot every N recovery events (default: 50) */
  everyNEvents: z.number().int().min(1).default(50),

  /** Max snapshot size in bytes before offloading to PayloadStore (default: 1MB) */
  maxInlineBytes: z.number().int().min(0).default(1_048_576),
});

export type SnapshotTriggerConfig = z.infer<typeof SnapshotTriggerConfigSchema>;
