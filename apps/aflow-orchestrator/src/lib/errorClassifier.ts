import type { AflowError, ErrorClassification } from '@aflow/schemas';

/**
 * Result of classifying an orchestrator error.
 *
 * `classified` is the user-safe AflowError (for run events / UI).
 * `internalMessage` is the raw error text (for server logs only).
 */
export interface ClassifiedError {
  classified: AflowError;
  internalMessage: string;
}

export function classifyOrchestratorError(
  error: unknown,
  context?: { runId?: string; flowId?: string; operation?: string },
): ClassifiedError {
  const raw = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.constructor.name : '';

  // ── Agent definition invalid (broken definition, not caller's fault) ───
  // Must come before generic Zod check — AgentDefinitionInvalidError wraps
  // a ZodError but means the stored definition is broken, not the caller's input.
  if (errorName === 'AgentDefinitionInvalidError' || raw.includes('has an invalid definition')) {
    // Surface the specific validation errors so the agent/user can fix the definition.
    // Extract just the readable part (after the agent ID prefix).
    const safeMsg = raw.length > 500 ? raw.slice(0, 500) + '…' : raw;
    return result('AGENT_DEFINITION_INVALID', safeMsg, 'validation', false, raw);
  }

  // ── Zod / schema validation ────────────────────────────────────────────
  // MUST come before guardrail check: Zod enum errors include all valid
  // options in the message (e.g., "'guardrail'"), which would false-match
  // the guardrail keyword check.
  if (
    errorName === 'ZodError' ||
    raw.includes('Invalid enum value') ||
    raw.includes('invalid_enum_value')
  ) {
    return result(
      'VALIDATION_FAILED',
      'The request contains invalid data. Check your flow configuration and input.',
      'validation',
      false,
      raw,
    );
  }

  // ── Flow definition not found ──────────────────────────────────────────
  if (raw.includes('not found') && (raw.includes('flow') || raw.includes('Flow'))) {
    return result(
      'FLOW_NOT_FOUND',
      `Flow ${context?.flowId ?? ''} not found.`.trim(),
      'not_found',
      false,
      raw,
    );
  }

  // ── Guardrail / safety block ───────────────────────────────────────────
  if (
    errorName === 'GuardrailBlockedError' ||
    raw.includes('guardrail') ||
    raw.includes('blocked by')
  ) {
    return result(
      'GUARDRAIL_BLOCKED',
      'This request was blocked by a safety policy.',
      'content_policy',
      false,
      raw,
    );
  }

  if (
    raw.includes('FLOW_INPUT_VALIDATION_FAILED') ||
    raw.includes('Input format error') ||
    raw.includes('input validation failed')
  ) {
    // These are structured errors with user-friendly messages from the coercion pipeline.
    // Extract the message after the code prefix if present.
    const safeMsg = raw.replace(/^.*?:\s*/, '');
    return result(
      'FLOW_INPUT_VALIDATION_FAILED',
      safeMsg || 'Flow input validation failed.',
      'validation',
      false,
      raw,
    );
  }

  // ── Generic Zod-style validation (non-ZodError but contains schema-like messages) ─
  if (raw.includes('Expected')) {
    return result(
      'VALIDATION_FAILED',
      'The request contains invalid data. Check your flow configuration and input.',
      'validation',
      false,
      raw,
    );
  }

  // ── No executor available ──────────────────────────────────────────────
  if (
    raw.includes('No executor') ||
    raw.includes('NoExecutorAvailable') ||
    errorName === 'NoExecutorAvailableError'
  ) {
    return result(
      'NO_EXECUTOR_AVAILABLE',
      'No executor is available to process this step. The system may be starting up — try again in a moment.',
      'transient',
      true,
      raw,
    );
  }

  if (raw.includes('pinned_tool_cap_exceeded') || raw.includes('exceeds MAX_TOTAL_TOOLS')) {
    return result(
      'TOOL_BUDGET_EXCEEDED',
      'Too many tools are available to this agent. Narrow the tool access policy on the contributing connections (Integrations → MCP servers → Edit connection → Tool permissions → Allow only these tools), or remove some core operations.',
      'configuration',
      false,
      raw,
    );
  }

  // ── Run state corrupt ──────────────────────────────────────────────────
  if (raw.includes('corrupt') || raw.includes('quarantine')) {
    return result(
      'RUN_STATE_CORRUPT',
      'The run state is corrupted and cannot be recovered.',
      'internal',
      false,
      raw,
    );
  }

  // ── Permission / auth ──────────────────────────────────────────────────
  if (
    raw.includes('permission') ||
    raw.includes('Permission') ||
    raw.includes('forbidden') ||
    raw.includes('unauthorized')
  ) {
    return result(
      'PERMISSION_DENIED',
      'You do not have permission to perform this action.',
      'permission',
      false,
      raw,
    );
  }

  // ── Database errors (Drizzle/Postgres) ─────────────────────────────────
  if (
    raw.includes('Failed query:') ||
    raw.includes('duplicate key') ||
    raw.includes('violates') ||
    raw.includes('relation') ||
    raw.includes('PostgresError') ||
    errorName === 'PostgresError'
  ) {
    return result(
      'DATABASE_ERROR',
      'A database error occurred. Please try again or contact support.',
      'internal',
      true,
      raw,
    );
  }

  // ── Redis / connection errors ──────────────────────────────────────────
  if (
    raw.includes('ECONNREFUSED') ||
    raw.includes('ECONNRESET') ||
    raw.includes('Redis') ||
    raw.includes('Connection')
  ) {
    return result(
      'CONNECTION_ERROR',
      'A connection error occurred. The system may be experiencing temporary issues.',
      'transient',
      true,
      raw,
    );
  }

  // ── Timeout ────────────────────────────────────────────────────────────
  if (
    raw.includes('timeout') ||
    raw.includes('Timeout') ||
    raw.includes('timed out') ||
    raw.includes('ETIMEDOUT')
  ) {
    return result(
      'EXECUTION_TIMEOUT',
      'The operation timed out. Try again or simplify the request.',
      'timeout',
      true,
      raw,
    );
  }

  // ── Default: unknown internal error ────────────────────────────────────
  return result(
    'INTERNAL_ERROR',
    'An unexpected error occurred while processing the run.',
    'internal',
    false,
    raw,
  );
}

function result(
  code: string,
  message: string,
  classification: ErrorClassification,
  retryable: boolean,
  internalMessage: string,
): ClassifiedError {
  return {
    classified: {
      code,
      message,
      classification,
      retryable,
      timestamp: new Date().toISOString(),
    },
    internalMessage,
  };
}
