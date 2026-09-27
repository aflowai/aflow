import { z } from 'zod';
import { StepUsageBreakdownSchema, RunUsageSummarySchema } from './events.js';
import {
  PauseContractSchema,
  WorkflowRunUpdatePayloadSchema,
  WorkflowTaskActivityPayloadSchema,
  WorkflowTaskSurfaceUpdatePayloadSchema,
  WorkflowTaskUpdatePayloadSchema,
} from './eventEnvelope.js';
import { StepOutputPresentationSchema } from './stepPresentation.js';
import { SessionIdSchema } from './ids.js';

// ============================================================================

/**
 * Compile-time projection spec: every key of Source must be explicitly
 * mapped or dropped. Adding a field to Source without updating the spec
 * is a compile error.
 *
 * This type is used purely for compile-time assertions — the spec objects
 * are never read at runtime. The actual mapper function is written alongside
 * the spec and must handle every 'map' field.
 */
export type ProjectionSpec<Source> = Record<keyof Source, 'map' | 'rename' | 'drop'>;

// ============================================================================
// API Run Event Schema
// ============================================================================

/**
 * The `data` sub-object carried on every API event.
 * Contains step-context and payload references.
 */
export const ApiSessionEventDataSchema = z.object({
  stepId: z.string().optional(),
  stepType: z.string().optional(),
  attempt: z.number().int().optional(),
  payloadRef: z.string().optional(),
  errorRef: z.string().optional(),
  requestedInputRef: z.string().optional(),
  runtimeStatePatch: z
    .object({
      version: z.number().int().nonnegative(),
      changed: z.array(
        z.object({
          key: z.string(),
          value: z.unknown(),
        }),
      ),
    })
    .optional(),
  outputVariables: z
    .array(
      z.object({
        key: z.string(),
        name: z.string().optional(),
        value: z.unknown(),
        semanticType: z.string().optional(),
      }),
    )
    .optional(),

  pauseContract: PauseContractSchema.optional(),
  workflowRunUpdate: WorkflowRunUpdatePayloadSchema.optional(),
  workflowTaskUpdate: WorkflowTaskUpdatePayloadSchema.optional(),
  workflowTaskActivity: WorkflowTaskActivityPayloadSchema.optional(),
  workflowTaskSurfaceUpdate: WorkflowTaskSurfaceUpdatePayloadSchema.optional(),
  presentation: StepOutputPresentationSchema.optional(),
});

export type ApiSessionEventData = z.infer<typeof ApiSessionEventDataSchema>;

export const ApiSessionEventSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  sessionId: SessionIdSchema,
  stepExecutionId: z.string().uuid().optional(),
  timestamp: z.string().datetime(),
  sequenceNumber: z.number().int().nonnegative(),
  eventVersion: z.number().int().positive(),
  data: ApiSessionEventDataSchema,
  metadata: z.record(z.unknown()).optional(),

  usage: StepUsageBreakdownSchema.optional(),
  usageSummary: RunUsageSummarySchema.optional(),

  surfaceMutations: z.array(z.record(z.unknown())).optional(),
  surfaceId: z.string().optional(),
});

export type ApiSessionEvent = z.infer<typeof ApiSessionEventSchema>;
