import { z } from 'zod';

/**
 * Operator-initiated run cancellation from the run-surface UI. Unlike the
 * agent inline `workflow.run.cancel` op (which runs the cascade inline on the
 * orchestrator and returns the completed terminal shape), the operator route
 * lives on the API tier — which cannot import the harness `cancelRun` cascade
 * (`cancel_run` fan-out + terminal `completeRun` waiter-wake). So the route
 * validates the run, enqueues the cascade onto the worker harness-advance
 * stream, and returns an **accepted** acknowledgement. The terminal
 * `WorkflowRunUpdate(cancelled)` arrives over SSE once the worker finishes the
 * cascade, flipping the surface card without a refetch.
 */
export const WorkflowRunCancelOperatorInputSchema = z.object({
  runId: z.string().uuid(),
  /** Optional human-readable cancellation reason; recorded in attention payload. */
  reason: z.string().max(500).optional(),
});
export type WorkflowRunCancelOperatorInput = z.infer<typeof WorkflowRunCancelOperatorInputSchema>;

export const WorkflowRunCancelOperatorOutputSchema = z.object({
  runId: z.string().uuid(),
  /**
   * `cancelling` — the cascade has been enqueued on the worker; the run is not
   * yet terminal. The surface flips to `cancelled` when the worker's terminal
   * `WorkflowRunUpdate` lands over SSE.
   */
  status: z.literal('cancelling'),
});
export type WorkflowRunCancelOperatorOutput = z.infer<typeof WorkflowRunCancelOperatorOutputSchema>;
