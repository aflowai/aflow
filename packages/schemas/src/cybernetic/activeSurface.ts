import { z } from 'zod';
import { EntityOperatingModeSchema } from '../runtime/entityEvents.js';

// ============================================================================
// Canonical lifecycle (102m §4)
// ============================================================================

/**
 * The single discriminator UI surfaces key off. Every observable backend
 * state maps to exactly one value. Derived at the aggregator from existing
 * inputs — never persisted.
 *
 * Adding a value is a build error at every `Record<ActiveSurfaceRunLifecycle, …>`
 * consumer (see 102m §6.1). Use `assertExhaustiveLifecycle` for switch cases.
 */
export const ActiveSurfaceRunLifecycleSchema = z.enum([
  // Live, making progress
  'executing',
  // Live, blocked on input
  'awaiting_user',
  'awaiting_child',
  'paused',
  // Live, possibly stuck
  'stalled',
  // Terminating or terminated
  'interrupting',
  'cancelled',
  'failed',
  'completed',
  // Defensive escape hatch — see 102m §6
  'unknown',
]);

export type ActiveSurfaceRunLifecycle = z.infer<typeof ActiveSurfaceRunLifecycleSchema>;

/**
 * Stable reason codes for analytics, dashboards, and tooltip translation.
 * UI maps codes → human-readable copy via a single table per surface.
 *
 * `'partial_signal_read'` is a secondary annotation: it can co-occur with
 * any non-`unknown` lifecycle when a per-run Redis HMGET failed and we
 * fell back to Postgres-only derivation.
 */
export const ActiveSurfaceLifecycleReasonCodeSchema = z.enum([
  'interrupt_requested',
  'awaiting_user_input',
  'awaiting_child_session',
  'paused',
  'scheduler_stale',
  'scheduled_task_not_dispatched',
  'partial_signal_read',
]);

export type ActiveSurfaceLifecycleReasonCode = z.infer<
  typeof ActiveSurfaceLifecycleReasonCodeSchema
>;

/**
 * Throws on any unhandled lifecycle value. Use as the `default` of a switch
 * to make the switch exhaustive at the type level.
 *
 * Most consumers should prefer `Record<ActiveSurfaceRunLifecycle, …>` tables
 * instead — TypeScript catches missing values without a runtime throw.
 */
export function assertExhaustiveLifecycle(value: never): never {
  throw new Error(`Unhandled ActiveSurfaceRunLifecycle: ${String(value)}`);
}

// ============================================================================
// Helmsman summary
// ============================================================================

export const ActiveSurfaceHelmsmanSchema = z.object({
  /** Most recent live `cybernetic-helmsman` session, if any. */
  sessionId: z.string().uuid().nullable(),
  /** Helmsman's current lifecycle — same enum as runs and sessions (102m §5.5). */
  lifecycle: ActiveSurfaceRunLifecycleSchema,
  /** Operating mode from the most recent `entity.mode.transition` event. */
  mode: EntityOperatingModeSchema.nullable(),
  /** Source of the most recent `entity.interaction.started` event. */
  triggerSource: z.enum(['user', 'schedule', 'webhook', 'internal']).nullable(),
  lastInteractionAt: z.string().datetime().nullable(),
});

export type ActiveSurfaceHelmsman = z.infer<typeof ActiveSurfaceHelmsmanSchema>;

// ============================================================================
// Active run + tasks
// ============================================================================

/**
 * Wire-level task status. Mirrors `workflow_run_tasks.status` plus the
 * intermediate scheduler states from 104d. The client adapter maps this
 * to a `TaskVisualState` UI vocabulary.
 *
 * `unknown` is a defensive escape hatch for DB statuses the runtime hasn't
 * been taught about yet — keeps the value visible in the UI rather than
 * silently coercing to `scheduled` and losing the operator's signal.
 */
export const ActiveSurfaceTaskStatusSchema = z.enum([
  'scheduled',
  'claimed',
  'in_flight',
  'running',
  'paused',
  'blocked',
  'failed',
  'succeeded',
  'skipped',
  'unknown',
]);

export type ActiveSurfaceTaskStatus = z.infer<typeof ActiveSurfaceTaskStatusSchema>;

export const ActiveSurfaceTaskSchema = z.object({
  taskId: z.string().min(1).max(64),
  status: ActiveSurfaceTaskStatusSchema,
  /** Recorded edges from the run ledger — always resolvable. */
  dependsOn: z.array(z.string().max(64)).default([]),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export type ActiveSurfaceTask = z.infer<typeof ActiveSurfaceTaskSchema>;

/**
 * Drift classification:
 * - `full`: current Workflow JSON's task ids ⊇ all recorded run task ids.
 *   Render the full DAG and light recorded tasks; future branches stay visible.
 * - `degraded`: current Workflow has lost a task id the run executed.
 *   Render only the recorded task set with edges where both endpoints resolve.
 */
export const ActiveSurfaceGraphFidelitySchema = z.enum(['full', 'degraded']);

export type ActiveSurfaceGraphFidelity = z.infer<typeof ActiveSurfaceGraphFidelitySchema>;

/** Display hints for forward-DAG nodes — mirrors `WorkflowRunDetailGraphTaskHintSchema`. */
export const ActiveSurfaceWorkflowGraphTaskHintSchema = z.object({
  taskId: z.string().max(64),
  label: z.string().max(120),
  taskType: z.enum(['agent', 'operation', 'human']).optional(),
  humanIntent: z.enum(['approve', 'collect']).optional(),
  operationId: z.string().optional(),
});

/**
 * Optional layout hint when `graphFidelity === 'full'`. Lets the client
 * render the forward DAG without a second fetch for the workflow JSON.
 */
export const ActiveSurfaceWorkflowGraphSchema = z.object({
  taskIds: z.array(z.string().max(64)).max(200),
  edges: z
    .array(
      z.object({
        from: z.string().max(64),
        to: z.string().max(64),
      }),
    )
    .max(500),
  taskHints: z.array(ActiveSurfaceWorkflowGraphTaskHintSchema).max(200).optional(),
});

export type ActiveSurfaceWorkflowGraph = z.infer<typeof ActiveSurfaceWorkflowGraphSchema>;

export const ActiveSurfaceRunSchema = z.object({
  runId: z.string().uuid(),
  /**
   * Owning session — the runner / driver session that executes this workflow
   * run. Surfaced so the inspector can highlight the "you are here" cluster
   * when the user opens the chat on a sub-agent.
   */
  sessionId: z.string().uuid().nullable(),
  /** Resolved via `SkillManifest.workflowSlug` join. */
  skillId: z.string().min(1).max(128).nullable(),
  skillName: z.string().max(200).nullable(),
  workflowSlug: z.string().min(1).max(128),
  /** Canonical UI-facing state — see 102m §5.1. */
  lifecycle: ActiveSurfaceRunLifecycleSchema,
  /** Stable reason code for analytics + tooltip translation. */
  lifecycleReasonCode: ActiveSurfaceLifecycleReasonCodeSchema.optional(),
  /** Free-text diagnostic detail. Populated only when lifecycle === 'unknown'. ≤120 chars; non-PII. */
  lifecycleReasonDetail: z.string().max(120).optional(),
  startedAt: z.string().datetime(),
  /** Set when lifecycle is terminal (cancelled / failed / completed). */
  endedAt: z.string().datetime().nullable(),
  graphFidelity: ActiveSurfaceGraphFidelitySchema,
  /** Present when `graphFidelity === 'full'`. */
  workflowGraph: ActiveSurfaceWorkflowGraphSchema.optional(),
  /** Recorded task rows — always the source of truth for executed state. */
  tasks: z.array(ActiveSurfaceTaskSchema).max(200),
});

export type ActiveSurfaceRun = z.infer<typeof ActiveSurfaceRunSchema>;

// ============================================================================

export const ActiveSurfaceCoachLifecycleSchema = z.enum(['idle', 'reviewing', 'stalled']);

export type ActiveSurfaceCoachLifecycle = z.infer<typeof ActiveSurfaceCoachLifecycleSchema>;

export const ActiveSurfaceCoachSchema = z.object({
  /** Tri-state lifecycle — see {@link ActiveSurfaceCoachLifecycleSchema}. */
  lifecycle: ActiveSurfaceCoachLifecycleSchema,

  coachSessionId: z.string().uuid().optional(),

  /**
   * Count of `/coach/staged/*` docs with `status='proposed'` and
   * `resolutionRoute='tenant_ratification'` — the actionable queue.
   */
  pendingProposals: z.number().int().min(0),

  pendingPlatformIssues: z.number().int().min(0),

  pendingAnomalies: z.number().int().min(0),
});

export type ActiveSurfaceCoach = z.infer<typeof ActiveSurfaceCoachSchema>;

// ============================================================================
// Recent transitions (breadcrumb)
// ============================================================================

export const ActiveSurfaceTransitionKindSchema = z.enum([
  'mode',
  'skill_activation',
  'skill_completion',
  'coach_review',
]);

export type ActiveSurfaceTransitionKind = z.infer<typeof ActiveSurfaceTransitionKindSchema>;

export const ActiveSurfaceTransitionSchema = z.object({
  at: z.string().datetime(),
  kind: ActiveSurfaceTransitionKindSchema,
  /** Human-readable label, e.g. "procedural · weekly-roundup". */
  label: z.string().max(200),
});

export type ActiveSurfaceTransition = z.infer<typeof ActiveSurfaceTransitionSchema>;

// ============================================================================
// Provenance / freshness
// ============================================================================

/**
 * Provenance of the snapshot.
 *
 * - `live`: built from a fresh attention cache + ledger reads.
 * - `stale-cache`: served from an attention cache entry whose generation
 *   tag is behind the latest known invalidation (best-effort surface — the
 *   snapshot is still consistent, just may be a few seconds old).
 * - `degraded`: at least one active run has `graphFidelity === 'degraded'`,
 *   or a per-run hot-state read failed (partial signal).
 * - `fallback-static`: aggregator failed; client should fall back to the
 *   process-map topology view and surface a stale indicator.
 */
export const ActiveSurfaceCapturedFromSchema = z.enum([
  'live',
  'stale-cache',
  'degraded',
  'fallback-static',
]);

export type ActiveSurfaceCapturedFrom = z.infer<typeof ActiveSurfaceCapturedFromSchema>;

// ============================================================================
// Snapshot
// ============================================================================

export const ActiveSurfaceSnapshotSchema = z.object({
  spaceId: z.string().uuid(),
  capturedAt: z.string().datetime(),

  /**
   * Stable hash over (run lifecycles, reason codes, endedAt, task statuses,
   * graph fidelity, coach state, mode, trigger source, helmsman lifecycle).
   * Client compares to its last-seen value and skips render on no-op refetches.
   */
  activeSurfaceVersion: z.string().min(1).max(128),

  capturedFrom: ActiveSurfaceCapturedFromSchema,

  /**
   * Optional debug string for tooltips and logs — never primary UI copy.
   * Examples: "attention cache hit", "sse silent for 42s, polled",
   * "session hot state partial read", "unknown lifecycle for runId=…".
   */
  freshnessReason: z.string().max(500).optional(),

  helmsman: ActiveSurfaceHelmsmanSchema,
  /**
   * Active runs + recently-terminal runs (≤120s old) merged into one
   * server-derived list. Replaces the previous client-side sticky cache.
   */
  surfacedRuns: z.array(ActiveSurfaceRunSchema).max(25),
  coach: ActiveSurfaceCoachSchema,
  recentTransitions: z.array(ActiveSurfaceTransitionSchema).max(20),

  /**
   * Earliest instant at which this snapshot goes stale with no further write —
   * the recently-terminal window closing, a scheduler cursor ageing past the
   * stall threshold, a paused Coach ageing out of `stalled`. Absent when
   * nothing in the snapshot is on a clock.
   *
   * Producers can emit a delta for a mutation but not for the passage of time,
   * so a live subscriber needs the deadline to know when to rebuild. Derived,
   * never stored: the thresholds live with the aggregator that applies them.
   */
  nextTimeDerivedChangeAt: z.string().datetime().optional(),
});

export type ActiveSurfaceSnapshot = z.infer<typeof ActiveSurfaceSnapshotSchema>;
