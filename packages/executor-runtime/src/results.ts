/**
 * Helper functions for creating step results.
 */
import type { PayloadRef, AflowError } from '@aflow/schemas';
import type { SuccessResult, FailureResult, PausedResult, ExecutorContext } from './types.js';

/**
 * Create a success result.
 */
export function success(
  outputRef: PayloadRef,
  options?: {
    costJson?: Record<string, unknown>;
    durationMs?: number;
  },
): SuccessResult {
  const result: SuccessResult = {
    status: 'SUCCEEDED',
    outputRef,
    durationMs: options?.durationMs ?? 0,
  };
  if (options?.costJson !== undefined) {
    return { ...result, costJson: options.costJson };
  }
  return result;
}

/**
 * Create a success result by writing output data.
 */
export async function successWithData(
  ctx: ExecutorContext,
  data: unknown,
  options?: {
    costJson?: Record<string, unknown>;
  },
): Promise<SuccessResult> {
  const startTime = Date.now();
  const outputRef = await ctx.writePayload('output', data);
  const result: SuccessResult = {
    status: 'SUCCEEDED',
    outputRef,
    durationMs: Date.now() - startTime,
  };
  if (options?.costJson !== undefined) {
    return { ...result, costJson: options.costJson };
  }
  return result;
}

/**
 * Create a failure result.
 */
export function failure(error: AflowError, errorRef: PayloadRef, durationMs = 0): FailureResult {
  return {
    status: 'FAILED',
    error,
    errorRef,
    durationMs,
  };
}

/**
 * Create a failure result by writing error data.
 */
export async function failureWithError(
  ctx: ExecutorContext,
  error: AflowError,
): Promise<FailureResult> {
  const startTime = Date.now();
  const errorRef = await ctx.writePayload('error', error);
  return {
    status: 'FAILED',
    error,
    errorRef,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Create a paused result (for user input steps).
 */
export function paused(requestedInputRef: PayloadRef, durationMs = 0): PausedResult {
  return {
    status: 'PAUSED',
    requestedInputRef,
    durationMs,
  };
}

/**
 * Create a paused result by writing input request data.
 *
 * The request shape is free-form — the executor that pauses owns the contract
 * with the resume payload. Common fields used by user.* ops:
 *   - kind: 'input' | 'approval'                          (the canonical discriminator)
 *   - prompt, inputSchema, uiHints, timeoutSeconds        (input)
 *   - title, description, reviewData, policy, approvers,
 *     defaultOnTimeout, timeoutSeconds                    (approval)
 *   - gateContext, relatesTo                              (plan 156 — gate-derived steps)
 */
export async function pausedWithRequest(
  ctx: ExecutorContext,
  inputRequest: Record<string, unknown>,
): Promise<PausedResult> {
  const startTime = Date.now();
  const requestedInputRef = await ctx.writePayload('input_request', inputRequest);
  return {
    status: 'PAUSED',
    requestedInputRef,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Create a validation error.
 */
export function validationError(message: string, details?: Record<string, unknown>): AflowError {
  const error: AflowError = {
    code: 'VALIDATION_ERROR',
    message,
    classification: 'validation',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

/**
 * Create a provider error (external service failure).
 */
export function providerError(
  message: string,
  options?: {
    retryable?: boolean;
    providerRequestId?: string;
    details?: Record<string, unknown>;
  },
): AflowError {
  const error: AflowError = {
    code: 'PROVIDER_ERROR',
    message,
    classification: 'provider',
    retryable: options?.retryable ?? true,
    timestamp: new Date().toISOString(),
  };
  if (options?.providerRequestId !== undefined) {
    error.providerRequestId = options.providerRequestId;
  }
  if (options?.details !== undefined) {
    error.details = options.details;
  }
  return error;
}

/**
 * Create a permission error.
 */
export function permissionError(message: string, details?: Record<string, unknown>): AflowError {
  const error: AflowError = {
    code: 'PERMISSION_DENIED',
    message,
    classification: 'permission',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

/**
 * Create a not-found error. Use this for "no such resource at <path/id>" — it
 * carries classification `not_found`, so the agent receives a legible
 * `{ error: 'not_found', message, ... }` and keeps the real message. Do NOT use
 * `internalError` for a missing resource: `internal` is fully opaque to the
 * agent (`toAgentToolError` rewrites it to a generic "system error"), which
 * makes an ordinary not-found read like a platform outage.
 */
export function notFoundError(message: string, details?: Record<string, unknown>): AflowError {
  const error: AflowError = {
    code: 'NOT_FOUND',
    message,
    classification: 'not_found',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

/**
 * Create an internal error.
 */
export function internalError(
  message: string,
  options?: {
    retryable?: boolean;
    details?: Record<string, unknown>;
  },
): AflowError {
  const error: AflowError = {
    code: 'INTERNAL_ERROR',
    message,
    classification: 'internal',
    retryable: options?.retryable ?? true,
    timestamp: new Date().toISOString(),
  };
  if (options?.details !== undefined) {
    error.details = options.details;
  }
  return error;
}
