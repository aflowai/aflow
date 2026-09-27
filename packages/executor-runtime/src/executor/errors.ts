/**
 * AflowError helpers for executor runtime.
 */
import { AflowErrorSchema, type AflowError } from '@aflow/schemas';
import { TimeoutError } from '../timeout.js';

export function createAflowError(
  code: string,
  message: string,
  classification: AflowError['classification'],
  retryable: boolean,
  details?: Record<string, unknown>,
): AflowError {
  const error: AflowError = {
    code,
    message,
    classification,
    retryable,
    timestamp: new Date().toISOString(),
  };
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function hasToAflowError(error: unknown): error is { toAflowError: () => AflowError } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'toAflowError' in error &&
    typeof (error as { toAflowError?: unknown }).toAflowError === 'function'
  );
}

export function toAflowError(error: unknown): AflowError {
  if (error instanceof TimeoutError) {
    return error.toAflowError();
  }

  if (hasToAflowError(error)) {
    return error.toAflowError();
  }

  if (error && typeof error === 'object') {
    const parsed = AflowErrorSchema.safeParse(error);
    if (parsed.success) {
      return parsed.data;
    }
  }

  if (error instanceof Error) {
    return createAflowError('STEP_EXECUTION_ERROR', error.message, 'internal', true, {
      name: error.name,
      stack: error.stack,
    });
  }

  return createAflowError('UNKNOWN_ERROR', String(error), 'internal', true);
}
