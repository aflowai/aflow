import { describe, expect, it } from 'vitest';
import { categorizeFailure } from '../digest/errorCategorize.js';

describe('categorizeFailure', () => {
  it('categorizes input validation errors', () => {
    expect(categorizeFailure({ errorCode: 'INPUT_VALIDATION_FAILED' })).toBe('validation');
    expect(categorizeFailure({ errorCode: 'SCHEMA_VIOLATION' })).toBe('validation');
    expect(
      categorizeFailure({ errorCode: 'BAD_REQUEST', errorMessage: 'invalid email format' }),
    ).toBe('validation');
  });

  it('categorizes config errors', () => {
    expect(categorizeFailure({ errorCode: 'API_CREDENTIALS_NOT_CONFIGURED' })).toBe('config');
    expect(categorizeFailure({ errorCode: 'API_DEFINITION_NOT_FOUND' })).toBe('config');
    expect(categorizeFailure({ errorCode: 'CAPABILITY_NOT_GRANTED' })).toBe('config');
  });

  it('categorizes permission errors', () => {
    expect(categorizeFailure({ errorCode: 'PERMISSION_DENIED' })).toBe('permission');
    expect(categorizeFailure({ httpStatus: 403 })).toBe('permission');
    expect(categorizeFailure({ httpStatus: 401 })).toBe('permission');
  });

  it('categorizes rate limit errors', () => {
    expect(categorizeFailure({ httpStatus: 429 })).toBe('rate_limit');
    expect(categorizeFailure({ errorCode: 'RATE_LIMITED' })).toBe('rate_limit');
  });

  it('categorizes timeout errors', () => {
    expect(categorizeFailure({ errorCode: 'TIMEOUT' })).toBe('timeout');
    expect(categorizeFailure({ errorCode: 'STEP_TIMEOUT' })).toBe('timeout');
    expect(categorizeFailure({ httpStatus: 504 })).toBe('timeout');
  });

  it('categorizes provider errors (5xx)', () => {
    expect(categorizeFailure({ httpStatus: 503 })).toBe('provider_error');
    expect(categorizeFailure({ httpStatus: 502 })).toBe('provider_error');
    expect(categorizeFailure({ errorCode: 'NETWORK_ERROR' })).toBe('provider_error');
  });

  it('categorizes model mistakes', () => {
    expect(categorizeFailure({ errorCode: 'TOOL_ARGS_INVALID' })).toBe('model_mistake');
    expect(categorizeFailure({ errorCode: 'MODEL_OUTPUT_INVALID' })).toBe('model_mistake');
    expect(categorizeFailure({ errorCode: 'UNKNOWN_TOOL' })).toBe('model_mistake');
  });

  it('extracts HTTP status from message text when no httpStatus provided', () => {
    expect(categorizeFailure({ errorMessage: 'upstream returned 503 service unavailable' })).toBe(
      'provider_error',
    );
    expect(
      categorizeFailure({ errorMessage: 'request failed with status 429 too many requests' }),
    ).toBe('rate_limit');
  });

  it('falls through to unknown for uncategorized errors', () => {
    expect(categorizeFailure({})).toBe('unknown');
    expect(categorizeFailure({ errorCode: 'SOMETHING_WEIRD' })).toBe('unknown');
    expect(categorizeFailure({ errorMessage: 'something happened' })).toBe('unknown');
  });

  it('does not classify ambiguous BAD_REQUEST as validation without supporting message', () => {
    expect(categorizeFailure({ errorCode: 'BAD_REQUEST', errorMessage: 'unable to process' })).toBe(
      'unknown',
    );
  });
});
