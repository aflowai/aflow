import { z } from 'zod';
import { WorkflowTaskInputBindingSchema } from './taskBindings.js';

export const WorkflowHumanActionPreviewSchema = z.object({
  op: z.string(),
  input: z.unknown().optional(),
  inputBindings: z.record(z.string().max(64), WorkflowTaskInputBindingSchema).optional(),
});
export type WorkflowHumanActionPreview = z.infer<typeof WorkflowHumanActionPreviewSchema>;

export const HumanApprovalCallSchema = WorkflowHumanActionPreviewSchema;
export type HumanApprovalCall = z.infer<typeof HumanApprovalCallSchema>;

export const HumanApprovalOutputSchema = z.object({
  decision: z.literal('approved'),
  comment: z.string().max(2000).optional(),
  decidedAt: z.string().datetime(),
  decidedBy: z.string(),
  approvedCall: HumanApprovalCallSchema.optional(),
});
export type HumanApprovalOutput = z.infer<typeof HumanApprovalOutputSchema>;

export const WorkflowHumanDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedAt: z.string().datetime().optional(),
  /**
   * Display label for the approver — the resolved `displayName ?? email ?? id`
   * (not the raw user id). Resolved on the read/emit path from the persisted
   * actor id; falls back to the raw id when the user can't be looked up. The
   * authoritative actor id lives in the audit trail, not this display field.
   */
  decidedBy: z.string().optional(),
  comment: z.string().max(2000).optional(),
});
export type WorkflowHumanDecision = z.infer<typeof WorkflowHumanDecisionSchema>;

export const HumanApprovalResolutionInputSchema = z.object({
  decision: z.literal('approved'),
  comment: z.string().max(2000).optional(),
  approvedCall: HumanApprovalCallSchema.optional(),
});
export type HumanApprovalResolutionInput = z.infer<typeof HumanApprovalResolutionInputSchema>;

export const WorkflowHumanFailureModeSchema = z.enum(['isolate', 'cancel_siblings']);
export type WorkflowHumanFailureMode = z.infer<typeof WorkflowHumanFailureModeSchema>;

export const WorkflowHumanTaskHydrationSchema = z.object({
  humanIntent: z.enum(['approve', 'collect']),
  resolutionSchema: z.record(z.unknown()).optional(),
  actionPreview: WorkflowHumanActionPreviewSchema.optional(),
  resumeContract: z.unknown().optional(),
  pauseVersion: z.number().int().nonnegative().optional(),
  failureMode: WorkflowHumanFailureModeSchema.optional(),
});
export type WorkflowHumanTaskHydration = z.infer<typeof WorkflowHumanTaskHydrationSchema>;
