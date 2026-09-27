import { z } from 'zod';
import { WorkflowResumeResolutionSchema } from '../../runtime/workflowResume.js';
import { WorkflowRunStatusSchema } from './enums.js';
import { WorkflowTaskResultSchema } from './ledger.js';
import { coerceJsonObjectArg } from '../jsonObjectArg.js';

// --- workflow.run.resume ---

const workflowRunResumeFields = {
  runId: z.string().uuid(),
  pauseVersion: z.number().int().nonnegative().optional(),
  resolution: z.preprocess(coerceJsonObjectArg, WorkflowResumeResolutionSchema),
  takeOver: z
    .boolean()
    .default(false)
    .describe(
      'Take over driving a paused run you are resolving: sessions already waiting on it ' +
        'are released with a handoff notice and stop observing the run. When false ' +
        "(default), resolving a pause leaves the current driver's wait intact — it " +
        "receives the run's later pause/terminal notifications as normal. Has no effect " +
        'on retry_failed_task or stalled-run recovery.',
    ),
};

export const WorkflowRunResumeInputSchema = z
  .object(workflowRunResumeFields)
  .strict(`Allowed keys: ${Object.keys(workflowRunResumeFields).join(', ')}.`)
  .superRefine((input, ctx) => {
    if (input.resolution.mode === 'retry_failed_task') {
      if (input.pauseVersion !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pauseVersion'],
          message:
            'retry_failed_task targets a failed run and must NOT carry pauseVersion. ' +
            'CAS is (failedAt, attempt) on resolution itself.',
        });
      }
    } else {
      if (input.pauseVersion === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pauseVersion'],
          message: `pauseVersion is required for paused-run resume mode "${input.resolution.mode}".`,
        });
      }
    }
  });
export type WorkflowRunResumeInput = z.infer<typeof WorkflowRunResumeInputSchema>;

export const WorkflowRunResumeOutputSchema = z.object({
  runId: z.string().uuid(),
  slug: z.string(),
  status: WorkflowRunStatusSchema,
  pauseVersion: z.number().int().nonnegative(),
  resumeAttemptCount: z.number().int().nonnegative(),
  /** 104d Phase 0: liveness state of the run before resume was applied. */
  priorLiveness: z.enum(['executing', 'waiting_for_input', 'stalled', 'idle']).optional(),
  /** 104d Phase 0: human-readable explanation of the prior liveness state. */
  priorLivenessReason: z.string().optional(),
  completedTasks: z.array(z.string()),
  pendingTasks: z.array(z.string()),
  taskResults: z.array(WorkflowTaskResultSchema),
  taskTools: z.array(
    z.object({
      toolId: z.string(),
      taskId: z.string(),
      name: z.string(),
    }),
  ),
});
export type WorkflowRunResumeOutput = z.infer<typeof WorkflowRunResumeOutputSchema>;
