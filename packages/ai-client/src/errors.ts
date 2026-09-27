/**
 * AI client error handling and normalization.
 *
 * Error chain: Provider Error → AIClientError → AflowError → UserFacingError
 */
import type { AflowError } from '@aflow/schemas';
import { toUserFacingError, type UserFacingError } from '@aflow/schemas';
import type { AIProvider, AIErrorCode, AIError } from './types.js';

// ============================================================================
// AIClientError Class
// ============================================================================

/**
 * Error class for AI client operations.
 */
export class AIClientError extends Error {
  readonly code: AIErrorCode;
  readonly provider: AIProvider | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerErrorCode?: string;
  readonly providerRequestId?: string;

  constructor(
    message: string,
    code: AIErrorCode,
    provider: AIProvider | undefined,
    retryable: boolean,
    options?: {
      retryAfterMs?: number;
      providerErrorCode?: string;
      providerRequestId?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AIClientError';
    this.code = code;
    this.provider = provider;
    this.retryable = retryable;
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options?.providerErrorCode !== undefined) {
      this.providerErrorCode = options.providerErrorCode;
    }
    if (options?.providerRequestId !== undefined) {
      this.providerRequestId = options.providerRequestId;
    }
  }

  /**
   * Convert to normalized AIError object.
   */
  toAIError(): AIError {
    const error: AIError = {
      code: this.code,
      message: this.message,
      provider: this.provider,
      retryable: this.retryable,
    };
    if (this.retryAfterMs !== undefined) {
      error.retryAfterMs = this.retryAfterMs;
    }
    if (this.providerErrorCode !== undefined) {
      error.providerErrorCode = this.providerErrorCode;
    }
    if (this.providerRequestId !== undefined) {
      error.providerRequestId = this.providerRequestId;
    }
    return error;
  }

  /**
   * Convert to AflowError format for executor results.
   */
  toAflowError(): AflowError {
    // Map AI error codes to AflowError classification
    const classification = this.getAflowClassification();

    return {
      code: `AI_${this.code.toUpperCase()}`,
      message: this.message,
      classification,
      retryable: this.retryable,
      timestamp: new Date().toISOString(),
      details: {
        provider: this.provider,
        providerErrorCode: this.providerErrorCode,
        providerRequestId: this.providerRequestId,
      },
    };
  }

  /**
   * Map AI error code to AflowError classification.
   */
  private getAflowClassification(): AflowError['classification'] {
    switch (this.code) {
      case 'rate_limit':
        return 'rate_limit';
      case 'auth':
        return 'configuration';
      case 'timeout':
        return 'timeout';
      case 'invalid_request':
        return 'validation';
      case 'content_filter':
        return 'content_policy';
      case 'context_length':
        return 'context_overflow';
      case 'output_truncated':
        return 'validation'; // Output hit max_tokens — caller can retry with higher limit or simpler prompt
      case 'model_not_found':
        return 'configuration';
      case 'network_error':
      case 'provider_error':
      case 'network':
        return this.retryable ? 'transient' : 'provider';
      case 'budget_exceeded':
        return 'budget';
      default:
        return 'provider';
    }
  }

  /**
   * Convert to UserFacingError for UI display.
   *
   * @param context - Additional context (runId, traceId, etc.)
   */
  toUserFacingError(context?: {
    runId?: string;
    traceId?: string;
    stepId?: string;
    attempt?: number;
    includeDebug?: boolean;
  }): UserFacingError {
    const aflowError = this.toAflowError();
    return toUserFacingError(aflowError, context ?? {});
  }
}

// ============================================================================
// Error Normalization Helpers
// ============================================================================

/**
 * Safely convert a value to string, handling objects.
 */
function safeStringify(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * Build options object conditionally.
 */
function buildErrorOptions(
  providerErrorCode?: string,
  providerRequestId?: string,
  retryAfterMs?: number,
  cause?: unknown,
): {
  retryAfterMs?: number;
  providerErrorCode?: string;
  providerRequestId?: string;
  cause?: unknown;
} {
  const opts: {
    retryAfterMs?: number;
    providerErrorCode?: string;
    providerRequestId?: string;
    cause?: unknown;
  } = {};
  if (retryAfterMs !== undefined) opts.retryAfterMs = retryAfterMs;
  if (providerErrorCode !== undefined) opts.providerErrorCode = providerErrorCode;
  if (providerRequestId !== undefined) opts.providerRequestId = providerRequestId;
  if (cause !== undefined) opts.cause = cause;
  return opts;
}

/**
 * Normalize an OpenAI error to AIClientError.
 */
export function normalizeOpenAIError(error: unknown, requestId?: string): AIClientError {
  // Handle OpenAI SDK errors
  if (error instanceof Error) {
    const errorAny = error as unknown as Record<string, unknown>;

    // Rate limit error
    if (errorAny['status'] === 429 || error.message.includes('rate limit')) {
      const retryAfter = errorAny['headers']
        ? (errorAny['headers'] as Record<string, unknown>)['retry-after']
        : undefined;

      const retryMs = typeof retryAfter === 'number' ? retryAfter * 1000 : undefined;
      return new AIClientError(
        error.message,
        'rate_limit',
        'openai',
        true,
        buildErrorOptions(safeStringify(errorAny['code'], 'rate_limit'), requestId, retryMs, error),
      );
    }

    // Auth error
    if (errorAny['status'] === 401 || errorAny['status'] === 403) {
      return new AIClientError(
        error.message,
        'auth',
        'openai',
        false,
        buildErrorOptions(
          safeStringify(errorAny['code'], 'auth_error'),
          requestId,
          undefined,
          error,
        ),
      );
    }

    // Context length
    if (
      error.message.includes('context_length') ||
      error.message.includes('maximum context length')
    ) {
      return new AIClientError(
        error.message,
        'context_length',
        'openai',
        false,
        buildErrorOptions('context_length_exceeded', requestId, undefined, error),
      );
    }

    // Content filter
    if (error.message.includes('content_filter') || error.message.includes('content policy')) {
      return new AIClientError(
        error.message,
        'content_filter',
        'openai',
        false,
        buildErrorOptions('content_filter', requestId, undefined, error),
      );
    }

    // Abort (SDK's APIUserAbortError or fetch AbortError): no status, so the
    // status-based branches below would classify it as a terminal provider
    // error. The SDK leaves `.name` as 'Error' — match the constructor name.
    // Status-bearing HTTP errors that merely mention "abort" keep their
    // status-based classification.
    if (
      error.name === 'AbortError' ||
      error.constructor.name === 'APIUserAbortError' ||
      (typeof errorAny['status'] !== 'number' && error.message.includes('abort'))
    ) {
      return new AIClientError(
        error.message,
        'timeout',
        'openai',
        true,
        buildErrorOptions('timeout', requestId, undefined, error),
      );
    }

    // Connection-level failures (no HTTP response → no status). Transient by
    // nature — DNS hiccup, TCP reset, TLS close mid-stream, brief upstream
    // outage. The SDK reports them as APIConnectionError (no `.status`), so
    // the status/message-based transient branch below misses them. Mirrors the
    // explicit handling in fireworks.ts / openrouter.ts / anthropic normalize.
    const isConnectionTimeout =
      error.name === 'APIConnectionTimeoutError' ||
      error.constructor.name === 'APIConnectionTimeoutError';
    const isConnectionError =
      isConnectionTimeout ||
      error.name === 'APIConnectionError' ||
      error.constructor.name === 'APIConnectionError' ||
      error.message === 'Connection error.';
    if (isConnectionError) {
      return new AIClientError(
        error.message,
        isConnectionTimeout ? 'timeout' : 'network_error',
        'openai',
        true,
        buildErrorOptions('connection_error', requestId, undefined, error),
      );
    }

    // Timeout
    if (errorAny['code'] === 'ETIMEDOUT' || error.message.includes('timeout')) {
      return new AIClientError(
        error.message,
        'timeout',
        'openai',
        true,
        buildErrorOptions('timeout', requestId, undefined, error),
      );
    }

    // Transient upstream/gateway errors (500/502/503/504 + connection reset).
    // These are infrastructure-level issues — often resolved by a retry.
    const status = errorAny['status'];
    const isTransientStatus = status === 500 || status === 502 || status === 503 || status === 504;
    const isTransientMessage =
      error.message.includes('upstream connect error') ||
      error.message.includes('connection termination') ||
      error.message.includes('Bad Gateway') ||
      error.message.includes('Gateway Timeout') ||
      error.message.includes('Service Unavailable');
    if (isTransientStatus || isTransientMessage) {
      return new AIClientError(
        error.message,
        'provider_error',
        'openai',
        true,
        buildErrorOptions(
          safeStringify(status ?? errorAny['code'], 'upstream_unavailable'),
          requestId,
          undefined,
          error,
        ),
      );
    }

    // Default to provider error
    return new AIClientError(
      error.message,
      'provider_error',
      'openai',
      false,
      buildErrorOptions(safeStringify(errorAny['code'], 'unknown'), requestId, undefined, error),
    );
  }

  // Unknown error
  return new AIClientError(
    error instanceof Error ? error.message : 'Unknown error',
    'provider_error',
    'openai',
    false,
    buildErrorOptions(undefined, undefined, undefined, error),
  );
}

/**
 * Normalize an Anthropic error to AIClientError.
 */
export function normalizeAnthropicError(error: unknown, requestId?: string): AIClientError {
  if (error instanceof AIClientError) return error;
  // Handle Anthropic SDK errors
  if (error instanceof Error) {
    const errorAny = error as unknown as Record<string, unknown>;

    // Rate limit error
    if (errorAny['status'] === 429 || error.message.includes('rate_limit')) {
      return new AIClientError(
        error.message,
        'rate_limit',
        'anthropic',
        true,
        buildErrorOptions('rate_limit', requestId, undefined, error),
      );
    }

    // Auth error
    if (errorAny['status'] === 401 || errorAny['status'] === 403) {
      return new AIClientError(
        error.message,
        'auth',
        'anthropic',
        false,
        buildErrorOptions('auth_error', requestId, undefined, error),
      );
    }

    // Overloaded
    if (errorAny['status'] === 529 || error.message.includes('overloaded')) {
      return new AIClientError(
        'Anthropic API is overloaded',
        'rate_limit',
        'anthropic',
        true,
        buildErrorOptions('overloaded', requestId, undefined, error),
      );
    }

    // Abort / timeout (SDK's APIUserAbortError or fetch AbortError)
    if (
      error.name === 'AbortError' ||
      error.name === 'APIUserAbortError' ||
      error.message.includes('aborted') ||
      error.message.includes('timeout')
    ) {
      return new AIClientError(
        error.message,
        'timeout',
        'anthropic',
        true,
        buildErrorOptions('timeout', requestId, undefined, error),
      );
    }

    // Transient upstream/gateway errors (502/503/504 + connection reset).
    // These are infrastructure-level issues — often resolved by a retry.
    // Examples seen in the wild:
    //   - "503 upstream connect error or disconnect/reset before headers"
    //   - "502 Bad Gateway"
    //   - "504 Gateway Timeout"
    //   - "Connection error." — Anthropic SDK's `APIConnectionError`, thrown
    //     on socket-level failures (DNS hiccup, TCP RST, TLS close mid-stream).
    //     Also fires as `error.name === 'APIConnectionError'`. These ARE
    //     transient — retrying after a brief backoff usually succeeds.
    const status = errorAny['status'];
    const isTransientStatus = status === 502 || status === 503 || status === 504;
    const isTransientName =
      error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError';
    const isTransientMessage =
      error.message.includes('upstream connect error') ||
      error.message.includes('connection termination') ||
      error.message.includes('Bad Gateway') ||
      error.message.includes('Gateway Timeout') ||
      // SDK's generic network-failure message — exact-match to avoid catching
      // unrelated 4xx errors that happen to mention "connection".
      error.message === 'Connection error.';
    if (isTransientStatus || isTransientName || isTransientMessage) {
      return new AIClientError(
        error.message,
        'provider_error',
        'anthropic',
        true,
        buildErrorOptions(
          safeStringify(status ?? errorAny['type'], 'upstream_unavailable'),
          requestId,
          undefined,
          error,
        ),
      );
    }

    // Default to provider error
    return new AIClientError(
      error.message,
      'provider_error',
      'anthropic',
      false,
      buildErrorOptions(safeStringify(errorAny['type'], 'unknown'), requestId, undefined, error),
    );
  }

  // Unknown error
  return new AIClientError(
    error instanceof Error ? error.message : 'Unknown error',
    'provider_error',
    'anthropic',
    false,
    buildErrorOptions(undefined, undefined, undefined, error),
  );
}

/**
 * Normalize any unknown error to AIClientError.
 * Use when the provider is unknown or for catch-all scenarios.
 */
export function normalizeUnknownError(
  error: unknown,
  provider: AIProvider = 'openai',
): AIClientError {
  if (error instanceof AIClientError) {
    return error;
  }

  if (error instanceof Error) {
    const errorMessage = error.message.toLowerCase();

    // Network errors
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('socket')
    ) {
      return new AIClientError(
        error.message,
        'network',
        provider,
        true,
        buildErrorOptions('network_error', undefined, undefined, error),
      );
    }

    // Timeout errors
    if (
      errorMessage.includes('timeout') ||
      errorMessage.includes('etimedout') ||
      errorMessage.includes('aborted')
    ) {
      return new AIClientError(
        error.message,
        'timeout',
        provider,
        true,
        buildErrorOptions('timeout', undefined, undefined, error),
      );
    }

    return new AIClientError(
      error.message,
      'provider_error',
      provider,
      false,
      buildErrorOptions(undefined, undefined, undefined, error),
    );
  }

  return new AIClientError(
    String(error),
    'provider_error',
    provider,
    false,
    buildErrorOptions(undefined, undefined, undefined, error),
  );
}

// ============================================================================
// Stream truncation
// ============================================================================

/**
 * A streaming completion that ends without a `finish_reason` chunk was cut
 * mid-generation (network drop, upstream close, or a platform-timeout abort
 * that the SDK surfaces as a clean stream end). Resolving the accumulated
 * partial content as a successful response silently hands truncated text to
 * the caller — every provider's stream loop must throw this instead.
 */
export function buildStreamTruncationError(opts: {
  provider: AIProvider;
  model: string;
  signal?: AbortSignal | undefined;
  startMs: number;
  accumulatedChars: number;
  toolCallCount: number;
}): AIClientError {
  const elapsedMs = Math.round(Date.now() - opts.startMs);
  const partial =
    `${opts.accumulatedChars} content chars + ${opts.toolCallCount} tool calls ` +
    `accumulated, no finish_reason — partial response discarded`;
  const reason = opts.signal?.aborted
    ? (opts.signal.reason as { marker?: unknown; timeoutMs?: unknown; kind?: unknown } | undefined)
    : undefined;
  if (reason?.marker === 'phoenix.executor.timeout' && typeof reason.timeoutMs === 'number') {
    const message =
      reason.kind === 'idle'
        ? `Model stream stalled: no chunks arrived for ${reason.timeoutMs}ms ` +
          `(provider=${opts.provider} model=${opts.model}, ${partial}). ` +
          `The stream was treated as hung.`
        : reason.kind === 'ceiling'
          ? `Model stream exceeded the ${reason.timeoutMs}ms generation ceiling while still ` +
            `streaming (provider=${opts.provider} model=${opts.model}, ${partial}).`
          : `Platform timeout exceeded after ${reason.timeoutMs}ms mid-stream ` +
            `(provider=${opts.provider} model=${opts.model}, ${partial}).`;
    return new AIClientError(message, 'timeout', opts.provider, true);
  }
  return new AIClientError(
    `${opts.provider} stream ended without finish_reason after ${elapsedMs}ms ` +
      `(model=${opts.model}, ${partial}) — response truncated mid-generation.`,
    'network_error',
    opts.provider,
    true,
  );
}
