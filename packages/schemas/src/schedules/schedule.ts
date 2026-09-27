import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

export const ScheduleKindSchema = z.enum([
  'cron', // Recurring on a cron expression
  'one_shot', // Fire once at a specific datetime
  'on_completion', // Fire when another flow's run reaches terminal state
]);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

export const ScheduleActionSchema = z.enum([
  'start_run', // Create a new flow run
  'resume_run', // Resume a paused run (self-snooze pattern)
]);
export type ScheduleAction = z.infer<typeof ScheduleActionSchema>;

export const ScheduleStatusSchema = z.enum([
  'active', // Will fire when conditions are met
  'paused', // Temporarily disabled (manual or programmatic)
  'expired', // One-shot that has fired, or past its expiresAt
  'deleted', // Soft-deleted
]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const OverlapPolicySchema = z.enum([
  'skip', // Skip firing if previous run is still active (default)
  'allow', // Allow parallel runs
  'cancel_previous', // Cancel previous run, start new one
]);
export type OverlapPolicy = z.infer<typeof OverlapPolicySchema>;

export const SourceStatusSchema = z.enum(['succeeded', 'failed', 'any_terminal']);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

// ============================================================================
// Input Template Reference Types
// ============================================================================

export const MemoryRefSchema = z.object({
  $memoryRef: z.string().min(1),
  view: z.enum(['content', 'metadata', 'summary']).default('content'),
});

export const SourceRefSchema = z.object({
  $sourceRef: z.enum(['runId', 'output', 'status', 'input']),
});

export const NowRefSchema = z.object({
  $now: z.enum(['iso', 'date', 'epoch']),
});

// ============================================================================
// FlowSchedule Record (API shape)
// ============================================================================

export const FlowScheduleSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),

  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),

  action: ScheduleActionSchema,
  flowId: z.string().nullish(),
  flowVersion: z.string().nullish(),
  targetRunId: z.string().uuid().nullish(),

  kind: ScheduleKindSchema,

  cronExpression: z.string().nullish(),
  timezone: z.string(),

  scheduledAt: z.string().datetime().nullish(),

  sourceFlowId: z.string().nullish(),
  sourceStatus: SourceStatusSchema.nullish(),

  inputTemplate: z.record(z.unknown()),

  status: ScheduleStatusSchema,
  overlapPolicy: OverlapPolicySchema,
  maxFirings: z.number().int().positive().nullish(),
  firingCount: z.number().int().nonnegative(),
  lastFiredAt: z.string().datetime().nullish(),
  lastRunId: z.string().uuid().nullish(),
  nextFireAt: z.string().datetime().nullish(),
  expiresAt: z.string().datetime().nullish(),
  lastError: z.string().nullish(),

  createdBy: z.string().nullish(),
  createdByRunId: z.string().uuid().nullish(),
  metadata: z.record(z.unknown()).nullish(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FlowSchedule = z.infer<typeof FlowScheduleSchema>;
