import { describe, it, expect } from 'vitest';
import { isRetryableExecutionError } from './execution.js';
import { ApiExecutionError } from './types.js';
import { apiError } from '../../lib/api-errors.js';
import {
  buildEgressBlockedMessage,
  SUGGESTED_FIX_BIND_CAPABILITY,
  DO_NOT_RUNNER_GUIDANCE,
} from './errors.js';

describe('isRetryableExecutionError', () => {
  describe('typed ApiExecutionError → respects aflowError.retryable', () => {
    it('does NOT retry API_BINDING_EGRESS_BLOCKED even though message contains "network"', () => {
      const message = buildEgressBlockedMessage(
        'https://storage.googleapis.com/kagglesdsdata/competitions/3136/26502/train.csv',
        'cross-host-redirect-blocked',
      );
      // Sanity: the message really does contain the substring that bit us.
      expect(message.toLowerCase()).toContain('network');

      const err = new ApiExecutionError(
        apiError('API_BINDING_EGRESS_BLOCKED', message, {
          retryable: false,
          details: {
            blockedTarget: 'https://storage.googleapis.com/...',
            reason: 'cross-host-redirect-blocked',
            suggestedFix: SUGGESTED_FIX_BIND_CAPABILITY,
            doNot: DO_NOT_RUNNER_GUIDANCE,
          },
        }),
      );
      expect(isRetryableExecutionError(err)).toBe(false);
    });

    it('does NOT retry API_SSRF_BLOCKED even if delivered as ApiExecutionError', () => {
      const err = new ApiExecutionError(apiError('API_SSRF_BLOCKED', 'private IP'));
      expect(isRetryableExecutionError(err)).toBe(false);
    });

    it('retries API_RATE_LIMITED (retryable=true by default)', () => {
      const err = new ApiExecutionError(apiError('API_RATE_LIMITED', 'slow down'));
      expect(isRetryableExecutionError(err)).toBe(true);
    });

    it('retries API_PROVIDER_ERROR (retryable=true by default)', () => {
      const err = new ApiExecutionError(apiError('API_PROVIDER_ERROR', 'upstream 502'));
      expect(isRetryableExecutionError(err)).toBe(true);
    });

    it('honors explicit retryable override on otherwise-retryable codes', () => {
      const err = new ApiExecutionError(
        apiError('API_PROVIDER_ERROR', 'do not retry this one', { retryable: false }),
      );
      expect(isRetryableExecutionError(err)).toBe(false);
    });
  });

  describe('untyped Error → falls back to message-pattern matching', () => {
    it('retries fetch-style transient errors', () => {
      expect(isRetryableExecutionError(new Error('ECONNRESET while reading'))).toBe(true);
      expect(isRetryableExecutionError(new Error('fetch failed'))).toBe(true);
      expect(isRetryableExecutionError(new Error('socket hang up'))).toBe(true);
    });

    it('does not retry arbitrary unrelated errors', () => {
      expect(isRetryableExecutionError(new Error('schema validation failed'))).toBe(false);
    });

    it('does not retry non-Error values', () => {
      expect(isRetryableExecutionError('string error')).toBe(false);
      expect(isRetryableExecutionError(undefined)).toBe(false);
      expect(isRetryableExecutionError({ kind: 'object' })).toBe(false);
    });
  });
});
