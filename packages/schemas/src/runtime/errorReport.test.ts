import { describe, it, expect } from 'vitest';
import type { AflowError } from './errors.js';
import {
  computeErrorFingerprint,
  buildInputSummary,
  createErrorReport,
  shouldCreateErrorReport,
  ErrorReportSchema,
  errorContext,
  errorContextFromUnknown,
  unknownErrorLogContext,
  type ErrorReportContext,
} from './errorReport.js';

// ============================================================================
// Helpers
// ============================================================================

function makeError(overrides: Partial<AflowError> = {}): AflowError {
  return {
    code: 'INTERNAL_ERROR',
    message: 'Something broke inside the platform',
    classification: 'internal',
    retryable: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<ErrorReportContext> = {}): ErrorReportContext {
  return {
    tenantId: 'a0000000-0000-0000-0000-000000000001',
    runId: 'b0000000-0000-0000-0000-000000000001',
    ...overrides,
  };
}

// ============================================================================
// computeErrorFingerprint
// ============================================================================

describe('computeErrorFingerprint', () => {
  it('produces a 16 hex-char string', () => {
    const fp = computeErrorFingerprint(makeError(), makeContext());
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — same inputs produce same fingerprint', () => {
    const error = makeError();
    const context = makeContext({ stepType: 'ai', operationId: 'ai.text.generate' });
    const fp1 = computeErrorFingerprint(error, context);
    const fp2 = computeErrorFingerprint(error, context);
    expect(fp1).toBe(fp2);
  });

  it('groups same error across different runs', () => {
    const error = makeError({ code: 'PROVIDER_ERROR', classification: 'provider' });
    const ctx1 = makeContext({ runId: 'r1', stepType: 'ai', operationId: 'ai.text.generate' });
    const ctx2 = makeContext({ runId: 'r2', stepType: 'ai', operationId: 'ai.text.generate' });
    expect(computeErrorFingerprint(error, ctx1)).toBe(computeErrorFingerprint(error, ctx2));
  });

  it('differentiates errors with different codes', () => {
    const ctx = makeContext({ stepType: 'ai', operationId: 'ai.text.generate' });
    const fp1 = computeErrorFingerprint(makeError({ code: 'PROVIDER_ERROR' }), ctx);
    const fp2 = computeErrorFingerprint(makeError({ code: 'TIMEOUT_ERROR' }), ctx);
    expect(fp1).not.toBe(fp2);
  });

  it('differentiates errors with different step types', () => {
    const error = makeError();
    const fp1 = computeErrorFingerprint(error, makeContext({ stepType: 'ai' }));
    const fp2 = computeErrorFingerprint(error, makeContext({ stepType: 'api' }));
    expect(fp1).not.toBe(fp2);
  });

  it('uses "unknown" for missing stepType and operationId', () => {
    const fp = computeErrorFingerprint(makeError(), makeContext());
    // Should not throw, and should be deterministic
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ============================================================================

describe('errorContext', () => {
  it('includes canonical fields and fingerprint', () => {
    const err = makeError({ code: 'ENQUEUE_FAILED', classification: 'internal' });
    const ctx = {
      tenantId: makeContext().tenantId,
      runId: makeContext().runId,
      stepExecutionId: 'step-exec-1',
      operationId: 'ai.text.generate',
      stepType: 'ai',
    };
    const out = errorContext(err, ctx);
    expect(out.errorCode).toBe('ENQUEUE_FAILED');
    expect(out.errorClassification).toBe('internal');
    expect(out.errorRetryable).toBe(false);
    expect(out.errorMessage).toBe(err.message);
    expect(out.errorFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(out.runId).toBe(ctx.runId);
    expect(out.stepExecutionId).toBe('step-exec-1');
  });

  it('matches computeErrorFingerprint for the same context', () => {
    const err = makeError({ code: 'X', classification: 'provider' });
    const full = makeContext({ stepType: 'api', operationId: 'http.get' });
    expect(errorContext(err, full).errorFingerprint).toBe(computeErrorFingerprint(err, full));
  });
});

describe('errorContextFromUnknown', () => {
  it('parses a plain AflowError-shaped object', () => {
    const err = makeError({
      code: 'RATE_LIMIT_EXCEEDED',
      classification: 'rate_limit',
      retryable: true,
    });
    const raw = { ...err };
    const out = errorContextFromUnknown(raw, { runId: 'r1', tenantId: 't1' });
    expect(out.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(out.errorClassification).toBe('rate_limit');
    expect(out.errorRetryable).toBe(true);
  });

  it('falls back for arbitrary exceptions', () => {
    const out = errorContextFromUnknown(new Error('boom'), { runId: 'r1' });
    expect(out.errorCode).toBe('UNKNOWN_EXCEPTION');
    expect(out.errorClassification).toBe('internal');
    expect(out.errorMessage).toBe('boom');
    expect(out.runId).toBe('r1');
  });
});

describe('unknownErrorLogContext', () => {
  it('produces internal classification', () => {
    const out = unknownErrorLogContext('string fail', { tenantId: 't1' });
    expect(out.errorClassification).toBe('internal');
    expect(out.tenantId).toBe('t1');
  });
});

// ============================================================================
// buildInputSummary
// ============================================================================

describe('buildInputSummary', () => {
  it('returns "null" for null input', () => {
    expect(buildInputSummary(null)).toBe('null');
  });

  it('returns "null" for undefined input', () => {
    expect(buildInputSummary(undefined)).toBe('null');
  });

  it('returns type for primitives', () => {
    expect(buildInputSummary('hello')).toBe('string');
    expect(buildInputSummary(42)).toBe('number');
    expect(buildInputSummary(true)).toBe('boolean');
  });

  it('shows field names and types for objects, never values', () => {
    const input = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Hello world' },
        { role: 'assistant', content: 'Hi' },
      ],
      temperature: 0.7,
    };
    const summary = buildInputSummary(input);
    // Should contain field names and types
    expect(summary).toContain('model: string');
    expect(summary).toContain('messages: array[2]');
    expect(summary).toContain('temperature: number');
    // Must NOT contain values
    expect(summary).not.toContain('gpt-4o');
    expect(summary).not.toContain('Hello world');
    expect(summary).not.toContain('0.7');
  });

  it('handles nested objects with count', () => {
    const input = { config: { model: 'test', timeout: 30 } };
    const summary = buildInputSummary(input);
    expect(summary).toContain('config: object{2}');
  });

  it('handles arrays with length', () => {
    const input = { items: [1, 2, 3, 4, 5] };
    const summary = buildInputSummary(input);
    expect(summary).toContain('items: array[5]');
  });

  it('truncates to max 500 chars', () => {
    // Create an object with many fields to exceed 500 chars
    const input: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      input[`very_long_field_name_number_${i}`] = `value_${i}`;
    }
    const summary = buildInputSummary(input);
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary).toMatch(/\.\.\.$/);
  });

  it('never includes field values for string fields', () => {
    const input = {
      apiKey: 'sk-secret-key-12345',
      password: 'hunter2',
      token: 'eyJhbGciOiJIUzI1NiJ9',
    };
    const summary = buildInputSummary(input);
    expect(summary).not.toContain('sk-secret-key');
    expect(summary).not.toContain('hunter2');
    expect(summary).not.toContain('eyJhbGci');
    expect(summary).toContain('apiKey: string');
    expect(summary).toContain('password: string');
    expect(summary).toContain('token: string');
  });
});

// ============================================================================
// createErrorReport
// ============================================================================

describe('createErrorReport', () => {
  it('produces a valid ErrorReport per schema', () => {
    const error = makeError();
    const context = makeContext({
      flowId: '00000000-0000-0000-0000-0000000000f1',
      stepType: 'ai',
      operationId: 'ai.text.generate',
      traceId: 'trace-123',
    });
    const report = createErrorReport(error, context);
    const result = ErrorReportSchema.safeParse(report);
    expect(result.success).toBe(true);
  });

  it('generates a unique ID', () => {
    const error = makeError();
    const context = makeContext();
    const r1 = createErrorReport(error, context);
    const r2 = createErrorReport(error, context);
    expect(r1.id).not.toBe(r2.id);
  });

  it('sets severity to error for internal classification', () => {
    const report = createErrorReport(makeError({ classification: 'internal' }), makeContext());
    expect(report.severity).toBe('error');
  });

  it('sets severity to warning for transient classification', () => {
    const report = createErrorReport(makeError({ classification: 'transient' }), makeContext());
    expect(report.severity).toBe('warning');
  });

  it('includes fingerprint', () => {
    const report = createErrorReport(makeError(), makeContext());
    expect(report.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('sets occurrenceCount to 1', () => {
    const report = createErrorReport(makeError(), makeContext());
    expect(report.occurrenceCount).toBe(1);
  });

  it('includes suggested action for internal errors', () => {
    const report = createErrorReport(makeError({ classification: 'internal' }), makeContext());
    expect(report.suggestedAction).toBeDefined();
    expect(report.suggestedAction).toContain('Investigate');
  });

  it('builds redacted input summary when input is provided', () => {
    const report = createErrorReport(
      makeError(),
      makeContext({ operationId: 'ai.text.generate' }),
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'secret prompt' }] },
    );
    expect(report.intent).toBeDefined();
    expect(report.intent?.inputSummary).toContain('model: string');
    expect(report.intent?.inputSummary).not.toContain('gpt-4o');
    expect(report.intent?.inputSummary).not.toContain('secret prompt');
  });

  it('extracts provider details from error details', () => {
    const error = makeError({
      classification: 'provider',
      details: {
        provider: 'openai',
        providerErrorCode: 'server_error',
        providerRequestId: 'req_abc123',
      },
      retryable: true,
    });
    const report = createErrorReport(error, makeContext());
    expect(report.provider).toBeDefined();
    expect(report.provider?.name).toBe('openai');
    expect(report.provider?.errorCode).toBe('server_error');
    expect(report.provider?.requestId).toBe('req_abc123');
    expect(report.provider?.retryable).toBe(true);
  });

  it('does not include optional fields when context is minimal', () => {
    const report = createErrorReport(makeError(), makeContext());
    // These should not be present when not provided
    expect(report.stepExecutionId).toBeUndefined();
    expect(report.attempt).toBeUndefined();
    expect(report.flowName).toBeUndefined();
    expect(report.spanId).toBeUndefined();
  });
});

// ============================================================================
// shouldCreateErrorReport
// ============================================================================

describe('shouldCreateErrorReport', () => {
  it('returns true for internal + FAILED', () => {
    expect(shouldCreateErrorReport('internal', 'FAILED')).toBe(true);
  });

  it('returns true for transient + FAILED', () => {
    expect(shouldCreateErrorReport('transient', 'FAILED')).toBe(true);
  });

  it('returns true for provider + FAILED', () => {
    expect(shouldCreateErrorReport('provider', 'FAILED')).toBe(true);
  });

  it('returns true for configuration + FAILED', () => {
    expect(shouldCreateErrorReport('configuration', 'FAILED')).toBe(true);
  });

  it('returns false for validation + FAILED (agent/user-fixable)', () => {
    expect(shouldCreateErrorReport('validation', 'FAILED')).toBe(false);
  });

  it('returns false for permission + FAILED', () => {
    expect(shouldCreateErrorReport('permission', 'FAILED')).toBe(false);
  });

  it('returns false for not_found + FAILED', () => {
    expect(shouldCreateErrorReport('not_found', 'FAILED')).toBe(false);
  });

  it('returns false for budget + FAILED', () => {
    expect(shouldCreateErrorReport('budget', 'FAILED')).toBe(false);
  });

  it('returns false for content_policy + FAILED', () => {
    expect(shouldCreateErrorReport('content_policy', 'FAILED')).toBe(false);
  });

  it('returns false for context_overflow + FAILED', () => {
    expect(shouldCreateErrorReport('context_overflow', 'FAILED')).toBe(false);
  });

  it('returns false for cancelled + FAILED', () => {
    expect(shouldCreateErrorReport('cancelled', 'FAILED')).toBe(false);
  });

  it('returns false for internal + SUCCEEDED', () => {
    expect(shouldCreateErrorReport('internal', 'SUCCEEDED')).toBe(false);
  });

  it('returns false for internal + RUNNING', () => {
    expect(shouldCreateErrorReport('internal', 'RUNNING')).toBe(false);
  });

  it('returns false for internal + PAUSED', () => {
    expect(shouldCreateErrorReport('internal', 'PAUSED')).toBe(false);
  });

  it('returns false for internal + CANCELLED', () => {
    expect(shouldCreateErrorReport('internal', 'CANCELLED')).toBe(false);
  });
});
