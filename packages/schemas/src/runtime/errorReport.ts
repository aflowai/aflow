import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  TenantIdSchema,
  SessionIdSchema,
  StepExecutionIdSchema,
  AgentIdSchema,
  type TenantId,
  type SessionId,
  type StepExecutionId,
  type AgentId,
} from './ids.js';
import {
  AflowErrorSchema,
  ErrorClassificationSchema,
  type AflowError,
  type ErrorClassification,
} from './errors.js';

// ============================================================================
// Error Report Severity
// ============================================================================

export const ErrorReportSeveritySchema = z.enum(['warning', 'error', 'critical']);
export type ErrorReportSeverity = z.infer<typeof ErrorReportSeveritySchema>;

// ============================================================================
// Error Report Schema
// ============================================================================

export const ErrorReportSchema = z.object({
  /** Unique report ID */
  id: z.string(),
  /** When the error occurred */
  timestamp: z.string().datetime(),

  // ── Context: where it happened ──
  tenantId: TenantIdSchema,
  runId: SessionIdSchema,
  stepExecutionId: StepExecutionIdSchema.optional(),
  attempt: z.number().int().optional(),
  flowId: AgentIdSchema.optional(),
  flowName: z.string().optional(),
  stepId: z.string().optional(),
  stepType: z.string().optional(),
  operationId: z.string().optional(),

  // ── Correlation ──
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  providerRequestId: z.string().optional(),

  // ── The error itself ──
  classification: ErrorClassificationSchema,
  code: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  cause: z.string().optional(),

  // ── Intent: what was being attempted (redacted — no user content) ──
  intent: z
    .object({
      /** The operation being executed */
      operationId: z.string().optional(),
      /** Redacted structural summary: field names + types only, no values */
      inputSummary: z.string().max(500).optional(),
    })
    .optional(),

  // ── Provider details (for external API errors) ──
  provider: z
    .object({
      name: z.string(),
      errorCode: z.string().optional(),
      requestId: z.string().optional(),
      statusCode: z.number().optional(),
      retryable: z.boolean().optional(),
    })
    .optional(),

  // ── Severity and triage ──
  severity: ErrorReportSeveritySchema,

  // ── Fingerprint: groups recurring errors ──
  fingerprint: z.string(),

  // ── Accumulation counter: how many times this fingerprint has been seen ──
  occurrenceCount: z.number().int().default(1),

  // ── Resolution hints ──
  suggestedAction: z.string().optional(),
});

export type ErrorReport = z.infer<typeof ErrorReportSchema>;

// ============================================================================
// Error Context (used by report helpers)
// ============================================================================

/** Context about where an error occurred, provided by the flush worker. */
export interface ErrorReportContext {
  tenantId: string;
  runId: string;
  stepExecutionId?: string;
  attempt?: number;
  flowId?: string;
  flowName?: string;
  stepId?: string;
  stepType?: string;
  operationId?: string;
  traceId?: string;
  spanId?: string;
}

// ============================================================================
// Fingerprinting
// ============================================================================

/**
 * Compute a deterministic fingerprint for an error.
 * Groups "same bug, different runs" together.
 *
 * Hash of: code + stepType + operationId + classification → 16 hex chars.
 */
export function computeErrorFingerprint(error: AflowError, context: ErrorReportContext): string {
  const parts = [
    error.code,
    context.stepType ?? 'unknown',
    context.operationId ?? 'unknown',
    error.classification,
  ];
  return createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 16);
}

// ============================================================================

/** Fields attached to logger output for error aggregation / dashboards. */
export interface ErrorLogContextFields {
  errorCode: string;
  errorClassification: ErrorClassification;
  errorRetryable: boolean;
  errorMessage: string;
  errorFingerprint: string;
}

function toFingerprintContext(
  ctx: Partial<ErrorReportContext> & Record<string, unknown>,
): ErrorReportContext {
  const out: ErrorReportContext = {
    tenantId: typeof ctx.tenantId === 'string' ? ctx.tenantId : '',
    runId: typeof ctx.runId === 'string' ? ctx.runId : '',
  };
  if (typeof ctx.stepExecutionId === 'string') out.stepExecutionId = ctx.stepExecutionId;
  if (typeof ctx.attempt === 'number') out.attempt = ctx.attempt;
  if (typeof ctx.flowId === 'string') out.flowId = ctx.flowId;
  if (typeof ctx.flowName === 'string') out.flowName = ctx.flowName;
  if (typeof ctx.stepId === 'string') out.stepId = ctx.stepId;
  if (typeof ctx.stepType === 'string') out.stepType = ctx.stepType;
  if (typeof ctx.operationId === 'string') out.operationId = ctx.operationId;
  if (typeof ctx.traceId === 'string') out.traceId = ctx.traceId;
  if (typeof ctx.spanId === 'string') out.spanId = ctx.spanId;
  return out;
}

export function errorContext(
  error: AflowError,
  ctx: Partial<ErrorReportContext> & Record<string, unknown> = {},
): ErrorLogContextFields & Record<string, unknown> {
  const fpCtx = toFingerprintContext(ctx);
  const traceId = error.traceId ?? (typeof ctx.traceId === 'string' ? ctx.traceId : undefined);
  return {
    ...ctx,
    errorCode: error.code,
    errorClassification: error.classification,
    errorRetryable: error.retryable,
    errorMessage: error.message,
    errorFingerprint: computeErrorFingerprint(error, fpCtx),
    ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
    ...(traceId ? { traceId } : {}),
  };
}

/**
 * Catch-block helper when the value is not known to be an {@link AflowError}.
 *
 * Surfaces `error.cause` (ES2022+) when present so wrapper-style errors
 * (DrizzleQueryError, fetch FetchError, etc.) don't bury the underlying
 * Postgres / network message. Walks one level deep — most wrappers are
 * a single hop, and going deeper risks logging hundreds of nested
 * `cause` chains from libraries that aggressively re-wrap.
 */
export function unknownErrorLogContext(
  err: unknown,
  ctx: Record<string, unknown> = {},
): Record<string, unknown> {
  // An object that failed to parse as an AflowError still carries diagnostics,
  // and `String()` throws all of them away as `[object Object]` — the exact
  // stringification the cause branch below already guards against. A thrown
  // object reaching here means something built a malformed error; the log is
  // where that has to be visible.
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null
        ? (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return '[unserialisable error]';
            }
          })()
        : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string' || typeof cause === 'number' || typeof cause === 'boolean'
        ? String(cause)
        : cause !== undefined
          ? // Avoid `[object Object]` stringification — JSON serialise so the
            // diagnostic actually carries data when a non-Error cause is thrown.
            (() => {
              try {
                return JSON.stringify(cause);
              } catch {
                return '[unserialisable cause]';
              }
            })()
          : undefined;
  const causeStack = cause instanceof Error ? cause.stack : undefined;
  return {
    ...ctx,
    errorCode: 'UNKNOWN_EXCEPTION',
    errorClassification: 'internal' satisfies ErrorClassification,
    errorRetryable: false,
    errorMessage: message,
    ...(stack ? { errorStack: stack } : {}),
    ...(causeMessage ? { errorCauseMessage: causeMessage } : {}),
    ...(causeStack ? { errorCauseStack: causeStack } : {}),
  };
}

/**
 * If `err` satisfies {@link AflowErrorSchema}, returns {@link errorContext}; otherwise
 * {@link unknownErrorLogContext}.
 */
export function errorContextFromUnknown(
  err: unknown,
  ctx: Partial<ErrorReportContext> & Record<string, unknown> = {},
): Record<string, unknown> {
  if (err && typeof err === 'object') {
    const parsed = AflowErrorSchema.safeParse(err);
    if (parsed.success) {
      return errorContext(parsed.data, ctx);
    }
  }
  return unknownErrorLogContext(err, ctx);
}

// ============================================================================
// Input Summary (redacted structural description)
// ============================================================================

/**
 * Build a redacted structural summary of an input value.
 * Shows field names + types only — NEVER includes values.
 *
 * Example output: "model: string, messages: array[3], temperature: number"
 *
 * @param input - The raw input object
 * @param _operationId - Operation ID for context (reserved for future use)
 * @returns Structural summary, max 500 chars
 */
export function buildInputSummary(input: unknown, _operationId?: string): string {
  if (input === null || input === undefined) return 'null';

  const summary = describeValue(input);
  if (summary.length <= 500) return summary;
  return summary.slice(0, 497) + '...';
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (Array.isArray(value)) {
    return `array[${value.length}]`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const parts: string[] = [];
    for (const key of keys) {
      const val = obj[key];
      parts.push(`${key}: ${describeFieldType(val)}`);
    }
    return parts.join(', ');
  }

  return typeof value;
}

function describeFieldType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keyCount = Object.keys(obj).length;
    return `object{${keyCount}}`;
  }
  return typeof value;
}

// ============================================================================
// Severity mapping
// ============================================================================

function classificationToSeverity(classification: ErrorClassification): ErrorReportSeverity {
  switch (classification) {
    case 'internal':
      return 'error';
    case 'transient':
    case 'provider':
    case 'configuration':
    case 'validation':
    case 'timeout':
    case 'rate_limit':
    case 'permission':
    case 'not_found':
    case 'conflict':
    case 'content_policy':
    case 'budget':
    case 'context_overflow':
    case 'cancelled':
      return 'warning';
  }
}

// ============================================================================
// Suggested action mapping
// ============================================================================

function classificationToSuggestedAction(classification: ErrorClassification): string | undefined {
  switch (classification) {
    case 'internal':
      return 'Investigate platform bug. Check stack trace and error code.';
    case 'transient':
      return 'Likely transient — monitor for recurrence. Check provider status.';
    case 'provider':
      return 'Check external provider status and credentials.';
    case 'configuration':
      return 'Review flow configuration and step bindings.';
    case 'validation':
    case 'timeout':
    case 'rate_limit':
    case 'permission':
    case 'not_found':
    case 'conflict':
    case 'content_policy':
    case 'budget':
    case 'context_overflow':
    case 'cancelled':
      return undefined;
  }
}

// ============================================================================
// Report factory
// ============================================================================

/**
 * Create a structured ErrorReport from an AflowError + context.
 * Enforces redaction at creation time — reports are born safe.
 */
export function createErrorReport(
  error: AflowError,
  context: ErrorReportContext,
  input?: unknown,
): ErrorReport {
  const fingerprint = computeErrorFingerprint(error, context);
  const severity = classificationToSeverity(error.classification);
  const suggestedAction = classificationToSuggestedAction(error.classification);

  // Build provider details if available
  let provider: ErrorReport['provider'];
  if (error.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
    const d = error.details as Record<string, unknown>;
    if (typeof d['provider'] === 'string') {
      provider = {
        name: d['provider'],
        ...(typeof d['providerErrorCode'] === 'string'
          ? { errorCode: d['providerErrorCode'] }
          : {}),
        ...(typeof d['providerRequestId'] === 'string'
          ? { requestId: d['providerRequestId'] }
          : {}),
        ...(typeof d['statusCode'] === 'number' ? { statusCode: d['statusCode'] } : {}),
        ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      };
    }
  }

  // Build intent with redacted input summary
  let intent: ErrorReport['intent'];
  if (context.operationId || input !== undefined) {
    intent = {
      ...(context.operationId ? { operationId: context.operationId } : {}),
      ...(input !== undefined
        ? { inputSummary: buildInputSummary(input, context.operationId) }
        : {}),
    };
  }

  const report: ErrorReport = {
    id: crypto.randomUUID(),
    timestamp: error.timestamp,
    tenantId: context.tenantId as TenantId,
    runId: context.runId as SessionId,
    classification: error.classification,
    code: error.code,
    message: error.message,
    severity,
    fingerprint,
    occurrenceCount: 1,
    ...(context.stepExecutionId
      ? { stepExecutionId: context.stepExecutionId as StepExecutionId }
      : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
    ...(context.flowId ? { flowId: context.flowId as AgentId } : {}),
    ...(context.flowName ? { flowName: context.flowName } : {}),
    ...(context.stepId ? { stepId: context.stepId } : {}),
    ...(context.stepType ? { stepType: context.stepType } : {}),
    ...(context.operationId ? { operationId: context.operationId } : {}),
    ...(context.traceId ? { traceId: context.traceId } : {}),
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
    ...(intent ? { intent } : {}),
    ...(provider ? { provider } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
  };

  return report;
}

// ============================================================================
// Classification filter
// ============================================================================

/**
 * Determine whether an error report should be created for a given failure.
 *
 * Reports are only created at run failure for:
 * - `internal` — always (platform bugs)
 * - `transient` — yes (retries exhausted, run failed)
 * - `provider` — yes (persistent provider issue)
 * - `configuration` — yes (flow-level config issue)
 *
 * Agent/user-fixable classifications do NOT generate reports.
 */
export function shouldCreateErrorReport(
  classification: ErrorClassification,
  runStatus: string,
): boolean {
  if (runStatus !== 'FAILED') return false;

  return (
    classification === 'internal' ||
    classification === 'transient' ||
    classification === 'provider' ||
    classification === 'configuration'
  );
}
