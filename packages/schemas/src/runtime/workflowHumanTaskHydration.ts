import { z } from 'zod';
import {
  WorkflowHumanActionPreviewSchema,
  WorkflowHumanFailureModeSchema,
} from '../operations/workflow.js';
import { PayloadRefSchema } from './payloadRef.js';
import { WorkflowResumeContractSchema } from './workflowResume.js';

/**
 * The full durable payload, stored via PayloadStore and referenced by a
 * single `human_task_hydration_ref` column on the task row. Small
 * previews land `inline:<base64>` (PayloadStore inline policy); large
 * previews land in GCS — the resolver doesn't care which, it just
 * `payloadStore.retrieve()`s the ref.
 */
export const DurableWorkflowHumanTaskHydrationSchema = z.object({
  /** Hydration schema version — bump only on **incompatible** changes. */
  hydrationVersion: z.literal(1),

  // ── Identity / CAS guard ──
  runId: z.string().uuid(),
  taskId: z.string().min(1).max(64),
  attempt: z.number().int().positive(),
  pauseVersion: z.number().int().nonnegative(),

  // ── Hydration body ──
  humanIntent: z.enum(['collect', 'approve']),
  failureMode: WorkflowHumanFailureModeSchema.optional(),
  /** JSON Schema for the operator's response (`collect` intent). */
  resolutionSchema: z.record(z.unknown()).optional(),
  actionPreview: WorkflowHumanActionPreviewSchema.optional(),
  actionPreviewRef: PayloadRefSchema.optional(),
  resumeContract: WorkflowResumeContractSchema,

  createdAt: z.string().datetime(),
});
export type DurableWorkflowHumanTaskHydration = z.infer<
  typeof DurableWorkflowHumanTaskHydrationSchema
>;

export const WorkflowHumanTaskHydrationMissingErrorSchema = z.object({
  code: z.literal('WORKFLOW_HUMAN_TASK_HYDRATION_MISSING'),
  runId: z.string().uuid(),
  taskId: z.string(),
  attempt: z.number().int().positive(),
  pauseVersion: z.number().int().nonnegative(),
  message: z.string(),
});
export type WorkflowHumanTaskHydrationMissingError = z.infer<
  typeof WorkflowHumanTaskHydrationMissingErrorSchema
>;
