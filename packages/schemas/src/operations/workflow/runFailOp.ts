import { z } from 'zod';

// --- workflow.run.fail ---

/**
 * The most a skill's stated reason carries: a check's summary with the end of
 * what it printed, which is what a failure is read for.
 */
export const WORKFLOW_RUN_FAIL_REASON_MAX_CHARS = 20_000;

export const WorkflowRunFailInputSchema = z.object({
  reason: z
    .string()
    .min(1)
    .max(WORKFLOW_RUN_FAIL_REASON_MAX_CHARS)
    .describe(
      'Why the run stops here, as whoever reads the failure needs it — usually bound from the output of the task whose result the skill decided to stop on.',
    ),
});
export type WorkflowRunFailInput = z.infer<typeof WorkflowRunFailInputSchema>;

/** Never produced: the step always fails, with `reason` as its message. */
export const WorkflowRunFailOutputSchema = z.object({}).strict();
export type WorkflowRunFailOutput = z.infer<typeof WorkflowRunFailOutputSchema>;
