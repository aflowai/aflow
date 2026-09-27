/**
 * Concrete event type definitions built on the event envelope.
 * These are convenience types for working with specific event types.
 */
import { z } from 'zod';
import {
  EventEnvelopeSchema,
  SessionStartedPayloadSchema,
  SessionCompletedPayloadSchema,
  SessionPausedPayloadSchema,
  StepSucceededPayloadSchema,
  WorkflowTaskUpdatePayloadSchema,
  WorkflowRunUpdatePayloadSchema,
} from './eventEnvelope.js';

// ============================================================================
// Session Status
// ============================================================================

/**
 * Session status values.
 */
export const SessionStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'WAITING_ON_CHILD',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'CANCELLING',
  'STALLED',
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// ============================================================================
// Step Execution Status
// ============================================================================

/**
 * Step execution status values.
 * Terminal statuses: SUCCEEDED, FAILED, PAUSED
 */
export const StepExecutionStatusSchema = z.enum([
  'SCHEDULED',
  'STARTED',
  'SUCCEEDED',
  'FAILED',
  'PAUSED',
]);

export type StepExecutionStatus = z.infer<typeof StepExecutionStatusSchema>;

/**
 * Terminal step execution statuses (per spec requirement).
 */
export const StepExecutionTerminalStatusSchema = z.enum(['SUCCEEDED', 'FAILED', 'PAUSED']);

export type StepExecutionTerminalStatus = z.infer<typeof StepExecutionTerminalStatusSchema>;

// ============================================================================
// Event Type Guards
// ============================================================================

/**
 * Check if an event type is a session-level event.
 */
export function isSessionLevelEvent(eventType: string): boolean {
  return eventType.startsWith('Session');
}

/**
 * Check if an event type is a step-level event.
 */
export function isStepLevelEvent(eventType: string): boolean {
  return eventType.startsWith('Step');
}

/**
 * Check if an event type represents a terminal state.
 */
export function isTerminalEvent(eventType: string): boolean {
  return [
    'SessionCompleted',
    'SessionFailed',
    'SessionCancelled',
    'StepSucceeded',
    'StepFailed',
    'StepPaused',
  ].includes(eventType);
}

// ============================================================================
// Typed Event Constructors
// ============================================================================

/**
 * Base event fields required for all events.
 */
export const BaseEventFieldsSchema = EventEnvelopeSchema.pick({
  eventId: true,
  tenantId: true,
  sessionId: true,
  timestamp: true,
  idempotencyKey: true,
  traceId: true,
  sequenceNumber: true,
});

export type BaseEventFields = z.infer<typeof BaseEventFieldsSchema>;

/**
 * Step event fields (extends base with step context).
 */
export const StepEventFieldsSchema = BaseEventFieldsSchema.extend({
  stepExecutionId: EventEnvelopeSchema.shape.stepExecutionId.unwrap(),
  parentStepExecutionId: EventEnvelopeSchema.shape.parentStepExecutionId,
  stepId: EventEnvelopeSchema.shape.stepId,
  stepType: EventEnvelopeSchema.shape.stepType,
  attempt: EventEnvelopeSchema.shape.attempt,
});

export type StepEventFields = z.infer<typeof StepEventFieldsSchema>;

// ============================================================================
// Event Schemas with Payloads (for validation)
// ============================================================================

/**
 * SessionStarted event with inline payload (for small payloads).
 */
export const SessionStartedEventSchema = EventEnvelopeSchema.extend({
  eventType: z.literal('SessionStarted'),
  payload: SessionStartedPayloadSchema.optional(),
});

export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;

/**
 * SessionCompleted event with inline payload.
 */
export const SessionCompletedEventSchema = EventEnvelopeSchema.extend({
  eventType: z.literal('SessionCompleted'),
  payload: SessionCompletedPayloadSchema.optional(),
});

export type SessionCompletedEvent = z.infer<typeof SessionCompletedEventSchema>;

/**
 * SessionPaused event with inline payload.
 */
export const SessionPausedEventSchema = EventEnvelopeSchema.extend({
  eventType: z.literal('SessionPaused'),
  payload: SessionPausedPayloadSchema.optional(),
});

export type SessionPausedEvent = z.infer<typeof SessionPausedEventSchema>;

/**
 * StepSucceeded event with inline payload.
 */
export const StepSucceededEventSchema = EventEnvelopeSchema.extend({
  eventType: z.literal('StepSucceeded'),
  payload: StepSucceededPayloadSchema.optional(),
});

export type StepSucceededEvent = z.infer<typeof StepSucceededEventSchema>;

export const WorkflowTaskUpdateEventSchema = EventEnvelopeSchema.extend({
  eventType: z.literal('WorkflowTaskUpdate'),
  payload: WorkflowTaskUpdatePayloadSchema.optional(),
});

export type WorkflowTaskUpdateEvent = z.infer<typeof WorkflowTaskUpdateEventSchema>;

export const WorkflowRunUpdateEventSchema = EventEnvelopeSchema.extend({
  eventType: z.literal('WorkflowRunUpdate'),
  payload: WorkflowRunUpdatePayloadSchema.optional(),
});

export type WorkflowRunUpdateEvent = z.infer<typeof WorkflowRunUpdateEventSchema>;

// ============================================================================
// Cost Tracking
// ============================================================================

// ============================================================================

/**
 * Per-step usage breakdown: tokens + cost in USD.
 * This is the single source of truth for AI step cost/usage data.
 * Replaces the old CostBreakdownSchema and the ai-client's CostBreakdown.
 */
export const StepUsageBreakdownSchema = z.object({
  /** AI provider (e.g., "openai", "google", "anthropic") */
  provider: z.string(),
  /** Model identifier from the catalog (e.g., "gpt-5.6-terra", "gemini-3.8-flash") */
  model: z.string(),

  // ── Token counts ──────────────────────────────────────────────────────
  /** Prompt/input tokens for this step (= context window usage for this turn) */
  promptTokens: z.number().int().nonnegative(),
  /** Completion/output tokens for this step */
  completionTokens: z.number().int().nonnegative(),
  /** Total tokens (prompt + completion) for this step */
  totalTokens: z.number().int().nonnegative(),

  /** Tokens served from prompt cache (Anthropic cache_read, OpenAI cached_tokens) */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  /** Tokens written to prompt cache on this request (Anthropic cache_creation) */
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  /** Tokens that were neither cached nor cache-written */
  uncachedPromptTokens: z.number().int().nonnegative().optional(),

  // ── Cost in USD ───────────────────────────────────────────────────────
  /** Prompt cost in USD */
  promptCostUsd: z.number().nonnegative(),
  /** Completion cost in USD */
  completionCostUsd: z.number().nonnegative(),
  /** Total cost in USD (prompt + completion + media) */
  totalCostUsd: z.number().nonnegative(),
  /** Cost attributable to generated media (images, seconds of video). */
  mediaCostUsd: z.number().nonnegative().optional(),
  /**
   * `unpriced` marks the figures above as not a measurement: the route reported
   * no billable quantity, or the catalog carries no rate for one. Absent means
   * priced. Without this a zero is indistinguishable from free, and free is
   * what an unmarked media step would claim to be forever.
   */
  costBasis: z.enum(['priced', 'unpriced']).optional(),
});

export type StepUsageBreakdown = z.infer<typeof StepUsageBreakdownSchema>;

// ============================================================================

/**
 * Aggregated usage summary for an entire run, maintained by the orchestrator.
 */
export const RunUsageSummarySchema = z.object({
  totalPromptTokens: z.number().int().nonnegative(),
  totalCompletionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  models: z.array(z.string()),
});

export type RunUsageSummary = z.infer<typeof RunUsageSummarySchema>;
