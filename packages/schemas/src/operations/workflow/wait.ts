import { z } from 'zod';
import {
  WAIT_WINDOW_MAX_SECONDS,
  WAIT_WINDOW_MIN_SECONDS,
  WaitEventKindSchema,
  WaitOutcomeSchema,
  WaitSubjectSchema,
} from '../../runtime/waits.js';

// --- workflow.wait (Plan 339 D1) ---

export const WorkflowWaitInputSchema = z.object({
  kind: WaitEventKindSchema,
  subject: WaitSubjectSchema.describe(
    'The run id, plan node id, owner/repo#number or pull request link, Action Center item id, or folder binding id.',
  ),
  windowSeconds: z
    .number()
    .int()
    .min(WAIT_WINDOW_MIN_SECONDS)
    .max(WAIT_WINDOW_MAX_SECONDS)
    .describe('The longest wait. When it closes with no event, you are woken and told so.'),
  since: z
    .string()
    .datetime()
    .optional()
    .describe(
      'Catch up from this time: an event already recorded since then ends the wait at once. Without it, only a later event does.',
    ),
});
export type WorkflowWaitInput = z.infer<typeof WorkflowWaitInputSchema>;

export const WorkflowWaitOutputSchema = z.object({
  waitId: z.string().uuid(),
  kind: WaitEventKindSchema,
  subject: WaitSubjectSchema,
  /**
   * `waiting`: end the turn, and this conversation is woken when the event
   * arrives or the window closes. `ended`: the event had fired already, and
   * `outcome` carries it.
   */
  state: z.enum(['waiting', 'ended']),
  closesAt: z.string().datetime(),
  outcome: WaitOutcomeSchema.optional(),
});
export type WorkflowWaitOutput = z.infer<typeof WorkflowWaitOutputSchema>;
