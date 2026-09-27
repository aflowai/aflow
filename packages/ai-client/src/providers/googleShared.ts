/**
 * Timeout and error-normalization helpers shared by the Google adapter and its
 * Veo half. They live here so neither file has to import the other.
 */
import { AIClientError } from '../errors.js';
import { sanitizeTerminalErrorMessage } from '@aflow/schemas';

// ============================================================================
// Timeout Helper
// ============================================================================

export const DEFAULT_TIMEOUT_MS = 120_000; // 2 min for generation
export const STREAM_INIT_TIMEOUT_MS = 60_000; // 1 min to start streaming
export const EMBED_TIMEOUT_MS = 30_000; // 30s for embeddings

/**
 * Race a promise against a timeout. The @google/genai SDK has a known bug
 * where httpOptions.timeout doesn't work for generateContent, so we use
 * Promise.race as a reliable fallback.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AIClientError(`Google API ${label} timed out after ${ms}ms`, 'timeout', 'google', true),
      );
    }, ms);
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => {
        clearTimeout(timer);
      });
  });
}

/** Per-request timeout wins over provider config (createGoogleAdapter). */
export function requestOrConfigTimeout(
  requestMs: number | undefined,
  configMs: number | undefined,
  fallback: number,
): number {
  return requestMs ?? configMs ?? fallback;
}

/**
 * Normalize Google API errors.
 */
export function normalizeGoogleError(error: unknown): AIClientError {
  if (error instanceof AIClientError) return error;
  if (error instanceof Error) {
    const errorAny = error as unknown as Record<string, unknown>;
    /** Google often puts JSON-RPC bodies in `message`; unwrap before branching */
    const msg = sanitizeTerminalErrorMessage(error.message, 4000);
    const lower = msg.toLowerCase();

    // Rate limit
    if (errorAny['status'] === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
      return new AIClientError(msg, 'rate_limit', 'google', true);
    }

    // Auth — includes 400 INVALID_ARGUMENT "API key not valid" (not sent as 401)
    const looksLikeInvalidApiKey =
      lower.includes('api key not valid') ||
      lower.includes('invalid api key') ||
      (lower.includes('api key') &&
        (lower.includes('invalid_argument') || msg.includes('INVALID_ARGUMENT')));
    if (
      errorAny['status'] === 401 ||
      errorAny['status'] === 403 ||
      msg.includes('PERMISSION_DENIED') ||
      looksLikeInvalidApiKey ||
      (errorAny['status'] === 400 && lower.includes('api key'))
    ) {
      return new AIClientError(msg, 'auth', 'google', false);
    }

    // Safety filter
    if (msg.includes('SAFETY')) {
      return new AIClientError(msg, 'content_filter', 'google', false);
    }

    // Abort (fetch AbortError, e.g. platform timeout or caller cancellation) —
    // no status, so the default branch would classify it as terminal. Status-
    // bearing errors that mention "abort" (e.g. gRPC ABORTED conflicts) keep
    // their status-based classification.
    if (
      error.name === 'AbortError' ||
      (typeof errorAny['status'] !== 'number' && lower.includes('abort'))
    ) {
      return new AIClientError(msg, 'timeout', 'google', true);
    }

    // Transient upstream/gateway errors (500/502/503/504 + connection reset).
    // Infrastructure-level issues — often resolved by a retry.
    if (
      errorAny['status'] === 500 ||
      errorAny['status'] === 502 ||
      errorAny['status'] === 503 ||
      errorAny['status'] === 504 ||
      msg.includes('INTERNAL') ||
      msg.includes('UNAVAILABLE') ||
      lower.includes('upstream connect error') ||
      lower.includes('connection termination') ||
      lower.includes('bad gateway') ||
      lower.includes('gateway timeout')
    ) {
      return new AIClientError(
        msg,
        'provider_error',
        'google',
        true, // retryable
      );
    }

    // Default
    return new AIClientError(msg, 'provider_error', 'google', false);
  }

  return new AIClientError(
    error instanceof Error ? sanitizeTerminalErrorMessage(error.message, 4000) : 'Unknown error',
    'provider_error',
    'google',
    false,
  );
}
