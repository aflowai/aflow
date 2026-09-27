import type { FailureCategory } from '@aflow/schemas';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CategorizeInput {
  /** Step status string (typically 'FAILED', 'SUCCEEDED', etc.). */
  status?: string;
  /** Application errorCode if present (e.g. INPUT_VALIDATION_FAILED, TIMEOUT, 503). */
  errorCode?: string | null;
  /** Free-text error message (used as a secondary signal). */
  errorMessage?: string | null;
  /** Optional HTTP-style status code if the error originated from an HTTP call. */
  httpStatus?: number;
}

/**
 * Categorize a tool-call failure into one of the closed-set categories.
 * Returns 'unknown' when no rule matches — the unknown rate is itself a
 * monitored health metric (the taxonomy needs expansion if it climbs).
 */
export function categorizeFailure(input: CategorizeInput): FailureCategory {
  const code = (input.errorCode ?? '').toUpperCase();
  const msg = (input.errorMessage ?? '').toLowerCase();
  const httpStatus = input.httpStatus ?? extractHttpStatus(code, msg);

  // 1. Validation — input schema rejected before execution
  if (code.includes('VALIDATION') || code.includes('SCHEMA_VIOLATION')) {
    return 'validation';
  }
  if (code === 'BAD_REQUEST' || httpStatus === 400) {
    // 400 alone is ambiguous — only treat as validation when message points there.
    if (
      msg.includes('validation') ||
      msg.includes('schema') ||
      msg.includes('invalid') ||
      msg.includes('required')
    ) {
      return 'validation';
    }
  }

  // 2. Config — missing credentials, binding, capability, definition
  if (
    code === 'API_CREDENTIALS_NOT_CONFIGURED' ||
    code === 'API_DEFINITION_NOT_FOUND' ||
    code === 'CAPABILITY_NOT_GRANTED' ||
    code === 'CAPABILITY_NOT_BOUND' ||
    code === 'BINDING_NOT_FOUND' ||
    code === 'CONFIG_MISSING' ||
    code === 'CREDENTIALS_MISSING'
  ) {
    return 'config';
  }

  // 3. Permission — RBAC / authz denial
  if (
    code === 'PERMISSION_DENIED' ||
    code === 'FORBIDDEN' ||
    code === 'ACCESS_DENIED' ||
    code === 'UNAUTHORIZED' ||
    httpStatus === 401 ||
    httpStatus === 403
  ) {
    return 'permission';
  }

  // 4. Rate limit
  if (code === 'RATE_LIMITED' || code === 'TOO_MANY_REQUESTS' || httpStatus === 429) {
    return 'rate_limit';
  }

  // 5. Timeout
  if (
    code === 'TIMEOUT' ||
    code === 'DEADLINE_EXCEEDED' ||
    code === 'STEP_TIMEOUT' ||
    code === 'TOOL_TIMEOUT' ||
    httpStatus === 408 ||
    httpStatus === 504
  ) {
    return 'timeout';
  }

  // 6. Provider error — external 5xx, network failures
  if (
    code === 'UPSTREAM_ERROR' ||
    code === 'NETWORK_ERROR' ||
    code === 'PROVIDER_ERROR' ||
    code === 'BAD_GATEWAY' ||
    code === 'SERVICE_UNAVAILABLE' ||
    (typeof httpStatus === 'number' && httpStatus >= 500)
  ) {
    return 'provider_error';
  }

  // 7. Model mistake — agent emitted invalid output
  if (
    code === 'TOOL_ARGS_INVALID' ||
    code === 'MODEL_OUTPUT_INVALID' ||
    code === 'AGENT_DECISION_INVALID' ||
    code === 'MALFORMED_TOOL_CALL' ||
    code === 'UNKNOWN_TOOL'
  ) {
    return 'model_mistake';
  }

  // 8. Unknown — falls through
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort HTTP status extraction from errorCode or message text.
 * Looks for "503", "404", etc. as standalone tokens.
 */
function extractHttpStatus(code: string, msg: string): number | undefined {
  const haystack = `${code} ${msg}`;
  const match = /\b([1-5]\d{2})\b/.exec(haystack);
  if (!match?.[1]) return undefined;
  const n = Number.parseInt(match[1], 10);
  if (Number.isNaN(n) || n < 100 || n > 599) return undefined;
  return n;
}
