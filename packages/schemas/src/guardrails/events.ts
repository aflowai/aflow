/**
 * Guardrail event schemas — what goes into run_events vs guardrail_log.
 */
import { z } from 'zod';

export const GuardrailCheckResultSchema = z.enum(['pass', 'violation', 'error', 'timeout']);
export type GuardrailCheckResult = z.infer<typeof GuardrailCheckResultSchema>;

export const GuardrailActionTakenSchema = z.enum([
  'allowed',
  'blocked',
  'retried',
  'redacted',
  'warned',
  'escalated',
]);
export type GuardrailActionTaken = z.infer<typeof GuardrailActionTakenSchema>;

/**
 * Full check record — goes to aflow:guardrail_log stream (NOT run_events).
 */
export const GuardrailCheckRecordSchema = z.object({
  type: z.literal('GuardrailCheck'),
  timestamp: z.number(),
  railId: z.string(),
  policyId: z.string(),
  trigger: z.string(),
  stepExecutionId: z.string().optional(),
  layer: z.string(),
  mode: z.string(),
  result: GuardrailCheckResultSchema,
  action: GuardrailActionTakenSchema,
  violationType: z.string().optional(),
  violationMessage: z.string().optional(),
  violationDetail: z.unknown().optional(),
  durationMs: z.number(),
});
export type GuardrailCheckRecord = z.infer<typeof GuardrailCheckRecordSchema>;

/**
 * Violation event — goes to run_events (only on actual violations).
 */
export const GuardrailViolationEventSchema = z.object({
  railId: z.string(),
  policyId: z.string(),
  trigger: z.string(),
  action: z.enum(['blocked', 'retried', 'redacted', 'escalated']),
  violationMessage: z.string().optional(),
  durationMs: z.number(),
});
export type GuardrailViolationEvent = z.infer<typeof GuardrailViolationEventSchema>;

/**
 * Run summary — goes to run_events once at run completion.
 */
export const GuardrailRunSummaryEventSchema = z.object({
  checksTotal: z.number().int().nonnegative(),
  checksPassed: z.number().int().nonnegative(),
  checksViolated: z.number().int().nonnegative(),
  checksErrored: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  violations: z.array(
    z.object({
      railId: z.string(),
      trigger: z.string(),
      action: z.string(),
    }),
  ),
});
export type GuardrailRunSummaryEvent = z.infer<typeof GuardrailRunSummaryEventSchema>;
