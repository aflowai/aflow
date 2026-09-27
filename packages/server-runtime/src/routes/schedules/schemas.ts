import { z } from 'zod';
import { ScheduleKindSchema, ScheduleStatusSchema, ScheduleActionSchema } from '@aflow/schemas';

// ============================================================================
// Route Schemas
// ============================================================================

/**
 * An expiry already in the past describes a schedule that can never usefully
 * run. Accepted silently it produces the worst possible row: `active`, with a
 * next firing the page will happily show, and an end date behind it. An agent
 * asked for "about two days" and wrote a date six months gone; nothing objected,
 * and the operator was shown a schedule that looked armed.
 *
 * Refused with the reason, because the caller is usually a model that can
 * correct itself if told what was wrong with the value it sent.
 */
const futureInstant = (label: string) =>
  z
    .string()
    .datetime()
    .refine((value) => new Date(value).getTime() > Date.now(), {
      message: `${label} is already in the past. Give an instant later than now, or omit it for no expiry.`,
    });

export const CreateScheduleBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  action: ScheduleActionSchema.default('start_run'),
  flowId: z.string().optional(),
  flowVersion: z.string().optional(),
  targetRunId: z.string().uuid().optional(),
  kind: ScheduleKindSchema,
  cronExpression: z.string().max(100).optional(),
  timezone: z.string().default('UTC'),
  scheduledAt: z.string().datetime().optional(),
  sourceFlowId: z.string().optional(),
  sourceStatus: z.enum(['succeeded', 'failed', 'any_terminal']).optional(),
  inputTemplate: z.record(z.unknown()).default({}),
  maxFirings: z.number().int().positive().optional(),
  expiresAt: futureInstant('expiresAt').optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateScheduleBodySchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  name: z.string().max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  cronExpression: z.string().max(100).optional(),
  timezone: z.string().optional(),
  inputTemplate: z.record(z.unknown()).optional(),
  expiresAt: futureInstant('expiresAt').nullable().optional(),
});

export const ListSchedulesQuerySchema = z.object({
  status: ScheduleStatusSchema.optional(),
  flowId: z.string().optional(),
  kind: ScheduleKindSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().optional(),
});
