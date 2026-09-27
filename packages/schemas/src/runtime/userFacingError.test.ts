import { describe, expect, it } from 'vitest';
import type { AflowError } from './errors.js';
import {
  getFailedRunFallbackMessage,
  shouldExposeFailedRunUserError,
  toFailedRunDisplay,
} from './userFacingError.js';

function makeError(overrides: Partial<AflowError>): AflowError {
  return {
    code: 'TEST_ERROR',
    message: 'Test error message',
    classification: 'validation',
    retryable: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('failed run display helpers', () => {
  it('suppresses internal failed-run user errors', () => {
    const result = toFailedRunDisplay(
      makeError({
        classification: 'internal',
        message: 'CREDENTIAL_ENCRYPTION_KEY is required in production.',
      }),
      { runId: 'run-123' },
    );

    expect(shouldExposeFailedRunUserError('internal')).toBe(false);
    expect(result.userError).toBeUndefined();
    expect(result.errorMessage).toBe(getFailedRunFallbackMessage('internal'));
    expect(result.errorMessage).not.toContain('CREDENTIAL_ENCRYPTION_KEY');
  });

  it('suppresses transient failed-run user errors', () => {
    const result = toFailedRunDisplay(
      makeError({
        classification: 'transient',
        message: 'Redis unavailable at 10.0.0.1:6379',
      }),
    );

    expect(shouldExposeFailedRunUserError('transient')).toBe(false);
    expect(result.userError).toBeUndefined();
    expect(result.errorMessage).toBe(getFailedRunFallbackMessage('transient'));
    expect(result.errorMessage).not.toContain('10.0.0.1');
  });

  it('preserves user-facing configuration failures', () => {
    const result = toFailedRunDisplay(
      makeError({
        classification: 'configuration',
        message: 'OpenAI API key is missing',
      }),
      { runId: 'run-123' },
    );

    expect(shouldExposeFailedRunUserError('configuration')).toBe(true);
    expect(result.userError?.message).toBe('OpenAI API key is missing');
    expect(result.errorMessage).toBe('OpenAI API key is missing');
  });
});
