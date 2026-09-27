import { z } from 'zod';

// --- workflow.run.cancel ---

export const WorkflowRunCancelInputSchema = z.object({
  runId: z.string().uuid(),
  /** Optional human-readable cancellation reason; recorded in attention payload. */
  reason: z.string().max(500).optional(),
});
export type WorkflowRunCancelInput = z.infer<typeof WorkflowRunCancelInputSchema>;

export const WorkflowRunCancelOutputSchema = z.object({
  runId: z.string().uuid(),
  status: z.literal('cancelled'),
  cancelledAt: z.string().datetime(),
  /** Task ids transitioned to 'cancelled' by this call. */
  cancelledTaskIds: z.array(z.string()),
  /** Runner session ids the cancel cascade was sent to. */
  interruptedSessions: z.array(z.string()),
});
export type WorkflowRunCancelOutput = z.infer<typeof WorkflowRunCancelOutputSchema>;
