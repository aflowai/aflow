import { describe, it, expect } from 'vitest';
import type { AflowError } from './errors.js';
import {
  AGENT_ERROR_DETAILS_MAX_CHARS,
  boundAgentErrorDetails,
  toAgentToolError,
} from './errors.js';

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

describe('toAgentToolError', () => {
  // ── Classification mapping ──────────────────────────────────────────────

  it('maps validation → validation', () => {
    const result = toAgentToolError(makeError({ classification: 'validation' }));
    expect(result.error).toBe('validation');
  });

  it('maps configuration → configuration', () => {
    const result = toAgentToolError(makeError({ classification: 'configuration' }));
    expect(result.error).toBe('configuration');
    expect(result.retry).toBe(false);
  });

  it('maps not_found → not_found', () => {
    const result = toAgentToolError(makeError({ classification: 'not_found' }));
    expect(result.error).toBe('not_found');
    expect(result.retry).toBe(true);
  });

  it('maps permission → permission (no retry)', () => {
    const result = toAgentToolError(makeError({ classification: 'permission' }));
    expect(result.error).toBe('permission');
    expect(result.retry).toBe(false);
  });

  it('maps rate_limit → rate_limit', () => {
    const result = toAgentToolError(makeError({ classification: 'rate_limit' }));
    expect(result.error).toBe('rate_limit');
    expect(result.retry).toBe(true);
  });

  it('maps timeout → timeout', () => {
    const result = toAgentToolError(makeError({ classification: 'timeout' }));
    expect(result.error).toBe('timeout');
    expect(result.retry).toBe(true);
  });

  it('maps budget → budget (no retry)', () => {
    const result = toAgentToolError(makeError({ classification: 'budget' }));
    expect(result.error).toBe('budget');
    expect(result.retry).toBe(false);
  });

  it('maps content_policy → content_policy', () => {
    const result = toAgentToolError(makeError({ classification: 'content_policy' }));
    expect(result.error).toBe('content_policy');
    expect(result.retry).toBe(true);
  });

  it('maps context_overflow → context_overflow', () => {
    const result = toAgentToolError(makeError({ classification: 'context_overflow' }));
    expect(result.error).toBe('context_overflow');
    expect(result.retry).toBe(true);
  });

  it('maps conflict → conflict (retryable, with the source re-read guidance intact)', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'conflict',
        code: 'APPLET_VERSION_CONFLICT',
        message:
          'Stale baseVersion — the instance is at version 7. Re-read with ui.applet.get and recompute before retrying.',
        details: { currentVersion: 7 },
      }),
    );
    expect(result.error).toBe('conflict');
    expect(result.retry).toBe(true);
    expect(result.message).toContain('Re-read with ui.applet.get and recompute');
    expect(result.details).toEqual({ currentVersion: 7 });
  });

  it('maps provider → unavailable', () => {
    const result = toAgentToolError(makeError({ classification: 'provider' }));
    expect(result.error).toBe('unavailable');
    expect(result.retry).toBe(true);
  });

  it('maps cancelled → unavailable (no retry)', () => {
    const result = toAgentToolError(makeError({ classification: 'cancelled' }));
    expect(result.error).toBe('unavailable');
    expect(result.retry).toBe(false);
  });

  // ── Internal errors: fully opaque ────────────────────────────────────────

  it('produces opaque message for internal errors', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'internal',
        message: 'Drizzle query failed: INSERT INTO runs...',
        details: { query: 'INSERT INTO runs', host: '10.0.0.1' },
      }),
    );
    expect(result.error).toBe('unavailable');
    expect(result.message).toBe('operation failed due to a system error');
    expect(result.retry).toBe(false);
    // Must NOT leak internal details
    expect(result.message).not.toContain('Drizzle');
    expect(result.message).not.toContain('INSERT');
    expect(result.details).toBeUndefined();
  });

  // ── Transient errors: compact but descriptive ────────────────────────────

  it('produces descriptive message for transient errors with retry: true', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'transient',
        message: 'Redis connection timeout at 10.0.0.1:6379',
        details: { host: '10.0.0.1', port: 6379 },
      }),
    );
    expect(result.error).toBe('unavailable');
    expect(result.message).toBe('temporary issue, may resolve if retried');
    expect(result.retry).toBe(true);
    // Must NOT leak infra details
    expect(result.message).not.toContain('Redis');
    expect(result.message).not.toContain('10.0.0.1');
    expect(result.details).toBeUndefined();
  });

  // ── Message truncation ──────────────────────────────────────────────────

  it('truncates messages longer than the agent-error cap', () => {
    const longMessage = 'A'.repeat(2000);
    const result = toAgentToolError(
      makeError({ classification: 'validation', message: longMessage }),
    );
    expect(result.message.length).toBeLessThanOrEqual(1500);
    expect(result.message).toContain('...');
  });

  it('preserves messages under 150 characters', () => {
    const result = toAgentToolError(
      makeError({ classification: 'validation', message: 'Invalid email format' }),
    );
    expect(result.message).toBe('Invalid email format');
  });

  // ── Trace ID and timestamp stripping ────────────────────────────────────

  it('strips UUIDs from messages', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'not_found',
        message: 'Resource 550e8400-e29b-41d4-a716-446655440000 not found',
      }),
    );
    expect(result.message).not.toContain('550e8400');
    expect(result.message).toContain('not found');
  });

  it('strips ISO timestamps from messages', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'timeout',
        message: 'Operation timed out at 2024-01-15T10:30:00.000Z',
      }),
    );
    expect(result.message).not.toContain('2024-01-15');
    expect(result.message).toContain('timed out');
  });

  it('strips both UUIDs and timestamps from messages', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'validation',
        message:
          'Step abc12345-1234-5678-9abc-def012345678 failed at 2024-06-01T12:00:00.123Z: bad input',
      }),
    );
    expect(result.message).not.toContain('abc12345');
    expect(result.message).not.toContain('2024-06-01');
    expect(result.message).toContain('bad input');
  });

  // ── Output shape ────────────────────────────────────────────────────────

  it('returns exactly { error, message, retry } when the source has no details', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'validation',
        traceId: 'trace-123',
        stack: 'Error: foo\n    at bar.ts:10',
      }),
    );
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['error', 'message', 'retry']);
    // Must not include traceId, timestamp, stack, or any extra fields
    expect(result).not.toHaveProperty('traceId');
    expect(result).not.toHaveProperty('timestamp');
    expect(result).not.toHaveProperty('stack');
  });

  it('returns exactly { details, error, message, retry } when the source carries details', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'validation',
        details: { reason: 'unknown_action' },
        traceId: 'trace-123',
      }),
    );
    expect(Object.keys(result).sort()).toEqual(['details', 'error', 'message', 'retry']);
  });

  // ── Structured details ──────────────────────────────────────────────────

  it('carries record details through for non-opaque classifications', () => {
    const details = {
      reason: 'input_invalid',
      availableActions: ['move', 'resign', 'raw_patch'],
      validation: [{ path: ['from'], message: 'Required' }],
    };
    const result = toAgentToolError(makeError({ classification: 'validation', details }));
    expect(result.details).toEqual(details);
  });

  it('wraps array details (ValidationErrorDetail[]) as { issues }', () => {
    const issues = [{ path: ['to'], code: 'invalid_type', message: 'Expected string' }];
    const result = toAgentToolError(makeError({ classification: 'validation', details: issues }));
    expect(result.details).toEqual({ issues });
  });

  it('bounds oversized details by truncation instead of dropping them', () => {
    const result = toAgentToolError(
      makeError({
        classification: 'validation',
        details: { reason: 'input_invalid', dump: 'A'.repeat(10_000) },
      }),
    );
    expect(result.details).toBeDefined();
    expect(result.details!['truncated']).toBe(true);
    expect(result.details!['reason']).toBe('input_invalid');
    expect(String(result.details!['dump'])).toContain('…');
    expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(
      AGENT_ERROR_DETAILS_MAX_CHARS + 16,
    );
  });
});

describe('boundAgentErrorDetails', () => {
  it('returns undefined for nullish or empty input', () => {
    expect(boundAgentErrorDetails(undefined)).toBeUndefined();
    expect(boundAgentErrorDetails(null)).toBeUndefined();
    expect(boundAgentErrorDetails({})).toBeUndefined();
  });

  it('passes small records through unchanged', () => {
    const details = { currentVersion: 12 };
    expect(boundAgentErrorDetails(details)).toEqual(details);
  });

  it('wraps primitives as { value }', () => {
    expect(boundAgentErrorDetails('boom')).toEqual({ value: 'boom' });
  });

  it('keeps insertion-order entries whole while they fit, truncates the first overflowing one', () => {
    const bounded = boundAgentErrorDetails({
      first: 'kept',
      big: 'B'.repeat(5_000),
      last: 'may be dropped',
    });
    expect(bounded).toBeDefined();
    expect(bounded!['truncated']).toBe(true);
    expect(bounded!['first']).toBe('kept');
    expect(String(bounded!['big']).endsWith('…')).toBe(true);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(AGENT_ERROR_DETAILS_MAX_CHARS + 16);
  });
});
