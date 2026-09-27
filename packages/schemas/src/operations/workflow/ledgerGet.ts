import { z } from 'zod';
import { ActiveLearningSchema } from '../../cybernetic/activeLearning.js';
import { WorkflowLedgerEntrySchema, WorkflowTrajectoryRowSchema } from './ledger.js';

// --- workflow.ledger.get ---

export const WorkflowLedgerGetInputSchema = z.object({
  slug: z.string().min(1).max(64),
  maxEntries: z.number().int().min(0).max(50).default(10),
  campaignId: z.string().uuid().optional(),
  includeEntries: z.boolean().default(false),
  before: z.string().max(128).optional(),
});
export type WorkflowLedgerGetInput = z.infer<typeof WorkflowLedgerGetInputSchema>;

export const WorkflowLedgerGetOutputSchema = z.object({
  workflowId: z.string().uuid(),
  totalEntries: z.number().int(),
  trajectory: z.array(WorkflowTrajectoryRowSchema),
  entries: z.array(WorkflowLedgerEntrySchema),
  activeLearnings: z.array(ActiveLearningSchema),
  /** Entries dropped by `learningPolicy.activeSetBudget` — never silent. */
  omittedDueToBudget: z.number().int().nonnegative(),
  /** True when the durable tier alone exceeds the budget — consolidation is due. */
  consolidationDue: z.boolean(),
  nextCursor: z.string().max(128).optional(),
});
export type WorkflowLedgerGetOutput = z.infer<typeof WorkflowLedgerGetOutputSchema>;
