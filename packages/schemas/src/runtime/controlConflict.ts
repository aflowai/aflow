import { z } from 'zod';

/**
 * A control command lost a race or duplicated one that already applied.
 *
 * Distinct from a run failure: the run is healthy and the command simply no
 * longer applies. Conflicts must never transition the run to FAILED — two
 * humans acting on one execution is normal, not an error state.
 */
export const ControlConflictCodeSchema = z.enum([
  /** Resume arrived for a run that is no longer paused (someone else resumed it). */
  'run_not_paused',
  /** Resume targets a different pause point than the one the run is parked on. */
  'resume_step_mismatch',
  /** Interrupt/pause arrived for a run that is not in an interruptible state. */
  'run_not_interruptible',
  /** The run's state is gone (expired, cancelled, or never existed). */
  'run_not_found',
  /** Resume arrived for a session parked on a workflow run it started, not on a person. */
  'run_waiting_on_workflow_run',
]);
export type ControlConflictCode = z.infer<typeof ControlConflictCodeSchema>;

/**
 * `ControlRejected` session-event metadata — the typed conflict the losing
 * actor observes on the session stream.
 */
export const ControlRejectedMetadataSchema = z.object({
  conflictCode: ControlConflictCodeSchema,
  /** Control message type that was rejected (`resume_run`, `interrupt_run`, …). */
  controlMessageType: z.string(),
  /**
   * The command this is the outcome of. Control is asynchronous and a room
   * has several actors, so without it a client cannot tell whether a
   * rejection on the stream is its own or someone else's.
   */
  commandId: z.string().optional(),
  /** Human-readable explanation, safe to surface. */
  message: z.string(),
  /** Run status observed when the command was evaluated. */
  observedStatus: z.string().optional(),
  /** Pause point the run is actually parked on, when the command targeted another. */
  currentStepExecutionId: z.string().optional(),
  /** Pause point the rejected command targeted. */
  requestedStepExecutionId: z.string().optional(),
});
export type ControlRejectedMetadata = z.infer<typeof ControlRejectedMetadataSchema>;
