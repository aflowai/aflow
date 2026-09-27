/**
 * Standardized error schemas for the Aflow platform.
 * All executors must use this error model.
 */
import { z } from 'zod';

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Error classification for categorizing failures.
 */
export const ErrorClassificationSchema = z.enum([
  /** Input validation failed */
  'validation',
  /** Operation timed out */
  'timeout',
  /** Rate limit exceeded */
  'rate_limit',
  /** Provider/upstream service error */
  'provider',
  /** Permission denied */
  'permission',
  /** Resource not found */
  'not_found',
  /** Resource conflict */
  'conflict',
  /** Content policy / safety filter triggered (replaces legacy 'safety') */
  'content_policy',
  /** Budget/quota exceeded */
  'budget',
  /** Flow/step/operation configuration error (distinct from runtime input validation) */
  'configuration',
  /** Model context window exceeded */
  'context_overflow',
  /** Internal system error */
  'internal',
  /** Transient error (retry likely to succeed) */
  'transient',
  /** Cancelled by user or system */
  'cancelled',
]);

export type ErrorClassification = z.infer<typeof ErrorClassificationSchema>;

// ============================================================================
// Error Detail Schemas
// ============================================================================

/**
 * Validation error detail.
 */
export const ValidationErrorDetailSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])).describe('Path to invalid field'),
  code: z.string().describe('Validation error code'),
  message: z.string().describe('Human-readable error message'),
  expected: z.unknown().optional().describe('Expected value/type'),
  received: z.unknown().optional().describe('Received value/type'),
});

export type ValidationErrorDetail = z.infer<typeof ValidationErrorDetailSchema>;

/**
 * Provider error detail.
 */
export const ProviderErrorDetailSchema = z.object({
  provider: z.string().describe("Provider name (e.g., 'openai', 'anthropic')"),
  providerErrorCode: z.string().optional().describe('Provider-specific error code'),
  providerRequestId: z.string().optional().describe('Provider request ID for debugging'),
  providerMessage: z.string().optional().describe('Original provider error message'),
});

export type ProviderErrorDetail = z.infer<typeof ProviderErrorDetailSchema>;

/**
 * Rate limit error detail.
 */
export const RateLimitErrorDetailSchema = z.object({
  limit: z.number().describe('Rate limit threshold'),
  remaining: z.number().describe('Remaining quota'),
  resetAtMs: z.number().describe('Unix timestamp when limit resets'),
  scope: z.string().optional().describe("Scope of rate limit (e.g., 'tenant', 'model')"),
});

export type RateLimitErrorDetail = z.infer<typeof RateLimitErrorDetailSchema>;

// ============================================================================
// Standardized Error Schema
// ============================================================================

/**
 * Standardized error schema used across all executors and services.
 */
export const AflowErrorSchema = z.object({
  /** Unique error code (e.g., 'VALIDATION_FAILED', 'PROVIDER_TIMEOUT') */
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Must be SCREAMING_SNAKE_CASE')
    .describe('Unique error code'),

  /** Human-readable error message */
  message: z.string().max(1000).describe('Human-readable error message'),

  /** Error classification for routing/retry decisions */
  classification: ErrorClassificationSchema,

  /** Whether this error is retryable */
  retryable: z.boolean().default(false).describe('Whether retry may succeed'),

  /** Suggested delay before retry (milliseconds) */
  retryAfterMs: z.number().int().nonnegative().optional().describe('Suggested retry delay'),

  /** Structured error details */
  details: z
    .union([
      z.array(ValidationErrorDetailSchema),
      ProviderErrorDetailSchema,
      RateLimitErrorDetailSchema,
      z.record(z.unknown()),
    ])
    .optional()
    .describe('Structured error details'),

  /** Provider request ID for debugging */
  providerRequestId: z.string().optional().describe('Provider request ID'),

  /** Stack trace (only in development/debug mode) */
  stack: z.string().optional().describe('Stack trace (debug only)'),

  /** Correlation ID for tracing */
  traceId: z.string().optional().describe('OpenTelemetry trace ID'),

  /** Timestamp when error occurred */
  timestamp: z.string().datetime().describe('ISO 8601 timestamp when error occurred'),
});

export type AflowError = z.infer<typeof AflowErrorSchema>;

// ============================================================================
// Error Factory Helpers
// ============================================================================

/**
 * Create a standardized validation error.
 */
export function createValidationError(
  message: string,
  details: ValidationErrorDetail[],
): AflowError {
  return {
    code: 'VALIDATION_FAILED',
    message,
    classification: 'validation',
    retryable: false,
    details,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a standardized timeout error.
 */
export function createTimeoutError(message: string, timeoutMs: number): AflowError {
  return {
    code: 'EXECUTION_TIMEOUT',
    message,
    classification: 'timeout',
    retryable: true,
    retryAfterMs: Math.min(timeoutMs, 30000),
    details: { timeoutMs },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a standardized provider error.
 */
export function createProviderError(
  message: string,
  detail: ProviderErrorDetail,
  retryable = false,
): AflowError {
  return {
    code: 'PROVIDER_ERROR',
    message,
    classification: 'provider',
    retryable,
    details: detail,
    providerRequestId: detail.providerRequestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a standardized rate limit error.
 */
export function createRateLimitError(message: string, detail: RateLimitErrorDetail): AflowError {
  return {
    code: 'RATE_LIMIT_EXCEEDED',
    message,
    classification: 'rate_limit',
    retryable: true,
    retryAfterMs: Math.max(0, detail.resetAtMs - Date.now()),
    details: detail,
    timestamp: new Date().toISOString(),
  };
}

export function createGateDeniedError(
  operationId: string,
  options: {
    gateReason: string;
    comment?: string | undefined;
    gateRequestId?: string | undefined;
  },
): AflowError {
  const reasonSuffix = options.comment ? `: ${options.comment}` : '';
  return {
    code: 'GATE_DENIED',
    message: `Approval denied for ${operationId}${reasonSuffix}`,
    classification: 'permission',
    retryable: false,
    details: {
      gateReason: options.gateReason,
      ...(options.comment !== undefined ? { comment: options.comment } : {}),
      ...(options.gateRequestId !== undefined ? { gateRequestId: options.gateRequestId } : {}),
    },
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================

/**
 * Error code an `ai.agent.turn` step emits when the model's decision is
 * malformed in a way the agent can itself fix given guidance (a tool-args
 * schema violation, or a decision the persistence gate rejects after its one
 * in-turn repair). Distinct from a plain `VALIDATION_ERROR` so the orchestrator
 * can route it to bounded guided-retry-then-pause instead of the empty
 * `onFailure` edge of an open-ended assistant (which would kill the session).
 */
export const AGENT_DECISION_INVALID_CODE = 'AGENT_DECISION_INVALID';

/** Structured detail carried by an {@link AGENT_DECISION_INVALID_CODE} error. */
export interface AgentDecisionInvalidDetail {
  /** The specific validation failure (Ajv summary with instancePath + message). */
  reason: string;
  /** The tool the agent tried to call, when a single tool is identifiable. */
  toolName?: string;
  /**
   * The decision that was rejected — the only surviving evidence of what the
   * agent tried when the generic reason is all the error would otherwise carry.
   */
  rejectedDecision?: {
    action: string;
    message?: string;
    reasoning?: string;
  };
}

const REJECTED_DECISION_MESSAGE_MAX = 2000;
const REJECTED_DECISION_REASONING_MAX = 1000;

/**
 * Create an agent-decision-invalid error. `message` carries the full,
 * agent-legible reason; `detail.reason` preserves it structurally so the
 * recovery path can quote the exact field/violation back to the model.
 */
export function createAgentDecisionInvalidError(
  message: string,
  detail: AgentDecisionInvalidDetail,
): AflowError {
  const rejected = detail.rejectedDecision;
  return {
    code: AGENT_DECISION_INVALID_CODE,
    message,
    classification: 'validation',
    retryable: false,
    details: {
      reason: detail.reason,
      ...(detail.toolName !== undefined ? { toolName: detail.toolName } : {}),
      ...(rejected !== undefined
        ? {
            rejectedDecision: {
              action: rejected.action,
              ...(rejected.message !== undefined
                ? { message: rejected.message.slice(0, REJECTED_DECISION_MESSAGE_MAX) }
                : {}),
              ...(rejected.reasoning !== undefined
                ? { reasoning: rejected.reasoning.slice(0, REJECTED_DECISION_REASONING_MAX) }
                : {}),
            },
          }
        : {}),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a structured input validation error (Zod schema mismatch).
 */
export function createInputValidationError(
  operationId: string,
  details: ValidationErrorDetail[],
): AflowError {
  return {
    code: 'INPUT_VALIDATION_FAILED',
    message: `Step input validation failed for operation ${operationId}`,
    classification: 'validation',
    retryable: false,
    details,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create an unresolved reference error (leftover ${...} patterns after resolution).
 */
export function createUnresolvedRefError(details: ValidationErrorDetail[]): AflowError {
  return {
    code: 'UNRESOLVED_INPUT_REFERENCE',
    message: 'Step input contains unresolved references',
    classification: 'validation',
    retryable: false,
    details,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a flow-level input validation error.
 */
export function createFlowInputValidationError(
  message: string,
  details: ValidationErrorDetail[],
): AflowError {
  return {
    code: 'FLOW_INPUT_VALIDATION_FAILED',
    message,
    classification: 'validation',
    retryable: false,
    details,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================

/**
 * Agent tool error type — the compact set of error categories an LLM can reason about.
 */
export const AgentToolErrorTypeSchema = z.enum([
  'validation',
  'configuration',
  'not_found',
  'permission',
  'rate_limit',
  'timeout',
  'budget',
  'content_policy',
  'context_overflow',
  'conflict',
  'unavailable',
]);
export type AgentToolErrorType = z.infer<typeof AgentToolErrorTypeSchema>;

/**
 * Compact, token-efficient error representation for LLM consumption (~30 tokens).
 * Designed for agent reasoning about recovery — no trace IDs, timestamps, or stack traces.
 */
export const AgentToolErrorSchema = z.object({
  error: AgentToolErrorTypeSchema,
  // Wide enough to carry a self-contained teaching error (field names, enum
  // values, the corrective next call) — at 150 a teach-by-schema message was
  // truncated mid-sentence and the agent fell back to guessing.
  message: z.string().max(1500),
  retry: z.boolean(),
  details: z
    .record(z.unknown())
    .optional()
    .describe(
      'Structured recovery data from the failing operation (e.g. availableActions, currentVersion). Bounded by truncation; absent for internal/transient failures.',
    ),
});
export type AgentToolError = z.infer<typeof AgentToolErrorSchema>;

/**
 * Serialized-size bound for agent-facing `details`. Enforced by truncation in
 * {@link boundAgentErrorDetails} — never as a schema failure — so an oversized
 * detail payload degrades to a partial record instead of losing the error.
 */
export const AGENT_ERROR_DETAILS_MAX_CHARS = 2048;

function jsonLength(value: unknown): number {
  // JSON.stringify's declared return type hides the undefined it produces for
  // functions/symbols/undefined.
  const serialized = JSON.stringify(value) as string | undefined;
  return serialized === undefined ? 0 : serialized.length;
}

/**
 * Normalize AflowError details into the record shape AgentToolError carries,
 * bounded to ~{@link AGENT_ERROR_DETAILS_MAX_CHARS} serialized chars. Arrays
 * (e.g. ValidationErrorDetail[]) are wrapped as `{ issues }`. When over budget,
 * entries are kept in insertion order — an entry that no longer fits whole is
 * flattened to a truncated string, and a `truncated: true` marker is added.
 */
export function boundAgentErrorDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === null || details === undefined) return undefined;
  const record: Record<string, unknown> =
    typeof details !== 'object'
      ? { value: details }
      : Array.isArray(details)
        ? { issues: details }
        : (details as Record<string, unknown>);
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  if (jsonLength(record) <= AGENT_ERROR_DETAILS_MAX_CHARS) return record;

  const bounded: Record<string, unknown> = { truncated: true };
  let used = jsonLength(bounded);
  for (const [key, value] of entries) {
    const valueJson = (JSON.stringify(value) as string | undefined) ?? 'null';
    // +4 ≈ the quotes around the key, the colon, and the separating comma.
    const entryLength = key.length + valueJson.length + 4;
    if (used + entryLength <= AGENT_ERROR_DETAILS_MAX_CHARS) {
      bounded[key] = value;
      used += entryLength;
      continue;
    }
    // +8 ≈ key quotes/colon/comma plus the value's own quotes and ellipsis.
    const room = AGENT_ERROR_DETAILS_MAX_CHARS - used - key.length - 8;
    if (room > 16) {
      const flat = typeof value === 'string' ? value : valueJson;
      bounded[key] = `${flat.slice(0, room)}…`;
      used += key.length + room + 8;
    }
  }
  return bounded;
}

/**
 * Truncate a string to a maximum length, appending '...' if truncated.
 * Strips trace IDs (UUID patterns) and ISO timestamps from the message.
 */
function compactMessage(raw: string, maxLen: number): string {
  // Strip trace IDs (UUIDs)
  let cleaned = raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
  // Strip ISO timestamps
  cleaned = cleaned.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '');
  // Collapse multiple spaces / leading/trailing whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + '...';
}

/**
 * Map an AflowError classification to the agent-facing error type.
 */
function classificationToAgentErrorType(classification: ErrorClassification): AgentToolErrorType {
  switch (classification) {
    case 'validation':
      return 'validation';
    case 'configuration':
      return 'configuration';
    case 'not_found':
      return 'not_found';
    case 'permission':
      return 'permission';
    case 'rate_limit':
      return 'rate_limit';
    case 'timeout':
      return 'timeout';
    case 'budget':
      return 'budget';
    case 'content_policy':
      return 'content_policy';
    case 'context_overflow':
      return 'context_overflow';
    case 'conflict':
      return 'conflict';
    case 'provider':
      return 'unavailable';
    case 'internal':
      return 'unavailable';
    case 'transient':
      return 'unavailable';
    case 'cancelled':
      return 'unavailable';
  }
}

/**
 * Map an AflowError to a compact AgentToolError for LLM consumption.
 *
 * Key design decisions:
 * - `internal` errors are fully opaque — the agent cannot fix platform bugs
 * - `transient` errors are visible but compact — the agent knows it may resolve
 * - All other classifications map directly with a compact message and carry
 *   `details` (bounded) so structured recovery data reaches the model
 * - `conflict` is its own type with retry: true — retryable only after a
 *   re-read, which the source error's message instructs
 * - `retry` is false for: permission, budget, configuration, internal, cancelled
 * - `retry` is true for: transient (even though type is 'unavailable')
 */
export function toAgentToolError(error: AflowError): AgentToolError {
  const classification = error.classification;

  // Internal errors: fully opaque — agent cannot fix platform bugs
  if (classification === 'internal') {
    return {
      error: 'unavailable',
      message: 'operation failed due to a system error',
      retry: false,
    };
  }

  // Transient errors: visible but compact — may resolve on retry
  if (classification === 'transient') {
    return {
      error: 'unavailable',
      message: 'temporary issue, may resolve if retried',
      retry: true,
    };
  }

  const errorType = classificationToAgentErrorType(classification);
  const message = compactMessage(error.message, 1500);

  // Determine retry based on classification
  const noRetryClassifications: ReadonlySet<ErrorClassification> = new Set([
    'permission',
    'budget',
    'configuration',
    'cancelled',
  ] as const);
  const retry = !noRetryClassifications.has(classification);
  const details = boundAgentErrorDetails(error.details);

  return {
    error: errorType,
    message,
    retry,
    ...(details !== undefined ? { details } : {}),
  };
}
