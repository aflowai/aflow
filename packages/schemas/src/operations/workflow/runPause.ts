import { z } from 'zod';
import { WorkflowRunPauseReasonSchema } from '../../runtime/workflowResume.js';

/**
 * Operator-initiated, run-level **soft quiesce**. Commits a run-level
 * `manual`-cause pause (no task row touched, unlike `pauseRunForTask`),
 * keeps any parked Helmsman waiter asleep (`notifyWaiters:false`), and
 * emits a live `WorkflowRunUpdate(paused)`. New tasks stop dispatching;
 * in-flight tasks finish at their next boundary (the `dispatchNextOrTerminate`
 * paused-guard holds the run). Resumed via `workflow.run.resume` mode
 * `acknowledge`. Primary caller is the operator run-surface UI over the
 * `POST /spaces/:spaceId/workflow-runs/:runId/pause` route; the schema is
 * also the shape an agent-callable op would take (registered in Phase 1).
 */
export const WorkflowRunPauseInputSchema = z.object({
  runId: z.string().uuid(),
  /** Optional human-readable pause note; recorded in attention + contract prompt. */
  reason: z.string().max(500).optional(),
});
export type WorkflowRunPauseInput = z.infer<typeof WorkflowRunPauseInputSchema>;

export const WorkflowRunPauseOutputSchema = z.object({
  runId: z.string().uuid(),
  status: z.literal('paused'),
  /** Live pause_version after the commit (or the existing one if already paused). */
  pauseVersion: z.number().int().nonnegative(),
  /**
   * Current pause cause — `manual` when this call paused the run; the
   * pre-existing cause if the run was already paused (see `alreadyPaused`).
   */
  pauseCause: WorkflowRunPauseReasonSchema,
  /**
   * True when the run was ALREADY paused (any cause) and this call did NOT
   * re-stamp it — the CAS is `WHERE status='running'`, so an existing
   * HITL/credentials/etc. pause is never clobbered. The operator UI shows
   * Resume either way.
   */
  alreadyPaused: z.boolean(),
});
export type WorkflowRunPauseOutput = z.infer<typeof WorkflowRunPauseOutputSchema>;
