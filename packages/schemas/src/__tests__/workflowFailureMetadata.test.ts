import { describe, it, expect } from 'vitest';
import {
  WorkflowRunDetailTaskSchema,
  WorkflowTaskPriorFailureSchema,
  WorkflowTaskSchema,
} from '../operations/workflow.js';

describe('WorkflowTaskPriorFailureSchema — Plan 149 §3.3', () => {
  it('accepts a fully-populated prior-failure snapshot', () => {
    const parsed = WorkflowTaskPriorFailureSchema.parse({
      attempt: 1,
      failedAt: '2026-05-14T10:46:00.000Z',
      errorCode: 'EGRESS_HTTP_400',
      errorClassification: 'external_dependency',
      errorRetryable: false,
      failureReason: 'Alpaca returned HTTP 400: request body format is invalid',
      remediationNote:
        'Operator updated alpaca-paper-orders-write binding to declare body parameter.',
    });
    expect(parsed.attempt).toBe(1);
    expect(parsed.errorCode).toBe('EGRESS_HTTP_400');
  });

  it('accepts a minimal snapshot (only attempt + failedAt)', () => {
    const parsed = WorkflowTaskPriorFailureSchema.parse({
      attempt: 2,
      failedAt: '2026-05-15T08:00:00.000Z',
    });
    expect(parsed.attempt).toBe(2);
    expect(parsed.errorCode).toBeUndefined();
  });

  it('rejects attempt = 0 (positive int required)', () => {
    expect(() =>
      WorkflowTaskPriorFailureSchema.parse({ attempt: 0, failedAt: '2026-05-15T08:00:00.000Z' }),
    ).toThrow();
  });

  it('rejects a remediationNote longer than 2000 characters', () => {
    expect(() =>
      WorkflowTaskPriorFailureSchema.parse({
        attempt: 1,
        failedAt: '2026-05-15T08:00:00.000Z',
        remediationNote: 'x'.repeat(2001),
      }),
    ).toThrow();
  });
});

describe('WorkflowRunDetailTaskSchema — Plan 149 Phase 1.5 failure metadata', () => {
  it('accepts the new failure-metadata fields populated on a failed row', () => {
    const parsed = WorkflowRunDetailTaskSchema.parse({
      taskId: 'submit-order',
      label: 'Submit order to Alpaca',
      status: 'failed',
      attempt: 1,
      errorCode: 'EGRESS_HTTP_400',
      errorClassification: 'external_dependency',
      errorRetryable: false,
      failedAt: '2026-05-14T10:46:00.000Z',
      failureReason: 'Alpaca returned HTTP 400',
      priorFailures: [],
    });
    expect(parsed.errorCode).toBe('EGRESS_HTTP_400');
    expect(parsed.errorClassification).toBe('external_dependency');
    expect(parsed.errorRetryable).toBe(false);
    expect(parsed.failedAt).toBe('2026-05-14T10:46:00.000Z');
    expect(parsed.priorFailures).toEqual([]);
  });

  it('accepts retry-attempt rows with non-empty priorFailures', () => {
    const parsed = WorkflowRunDetailTaskSchema.parse({
      taskId: 'submit-order',
      label: 'Submit order to Alpaca',
      status: 'running',
      attempt: 2,
      priorFailures: [
        {
          attempt: 1,
          failedAt: '2026-05-14T10:46:00.000Z',
          errorCode: 'EGRESS_HTTP_400',
          errorClassification: 'external_dependency',
          errorRetryable: false,
          remediationNote: 'Operator fixed the binding.',
        },
      ],
    });
    expect(parsed.priorFailures?.length).toBe(1);
    expect(parsed.priorFailures?.[0]?.remediationNote).toContain('binding');
  });

  it('still accepts rows with no failure metadata (legacy + non-failed rows)', () => {
    const parsed = WorkflowRunDetailTaskSchema.parse({
      taskId: 'hydrate',
      label: 'Hydrate context',
      status: 'succeeded',
      attempt: 1,
    });
    expect(parsed.errorCode).toBeUndefined();
    expect(parsed.priorFailures).toBeUndefined();
  });
});

describe('WorkflowTaskSchema — Plan 149 §3.3 retryability', () => {
  it('accepts retryability=safe + maxAttempts on an agent task', () => {
    const parsed = WorkflowTaskSchema.parse({
      taskId: 'compute-score',
      name: 'Compute score',
      goal: 'Score the lead',
      type: 'agent',
      retryability: 'safe',
      maxAttempts: 3,
    });
    expect(parsed.retryability).toBe('safe');
    expect(parsed.maxAttempts).toBe(3);
  });

  it('accepts retryability=unsafe (operator gating required at runtime)', () => {
    const parsed = WorkflowTaskSchema.parse({
      taskId: 'submit-order',
      name: 'Submit order to Alpaca',
      goal: 'Place the order',
      type: 'agent',
      retryability: 'unsafe',
    });
    expect(parsed.retryability).toBe('unsafe');
    // maxAttempts is optional — when omitted, the atomic helper falls
    // back to a per-call cap. We don't pin a default here.
    expect(parsed.maxAttempts).toBeUndefined();
  });

  it('accepts retryability=unknown (default policy on the wire)', () => {
    const parsed = WorkflowTaskSchema.parse({
      taskId: 'legacy',
      name: 'Legacy task',
      goal: 'do the thing',
      type: 'agent',
      retryability: 'unknown',
    });
    expect(parsed.retryability).toBe('unknown');
  });

  it('omits retryability when not specified (back-compat with pre-Plan-149 task defs)', () => {
    const parsed = WorkflowTaskSchema.parse({
      taskId: 'hydrate',
      name: 'Hydrate',
      goal: 'load context',
      type: 'agent',
    });
    expect(parsed.retryability).toBeUndefined();
    expect(parsed.maxAttempts).toBeUndefined();
  });

  it('rejects retryability outside the enum', () => {
    expect(() =>
      WorkflowTaskSchema.parse({
        taskId: 't',
        name: 'T',
        goal: 'g',
        type: 'agent',
        retryability: 'idempotent_with_key',
      }),
    ).toThrow();
  });

  it('rejects maxAttempts above the platform cap (10)', () => {
    expect(() =>
      WorkflowTaskSchema.parse({
        taskId: 't',
        name: 'T',
        goal: 'g',
        type: 'agent',
        maxAttempts: 11,
      }),
    ).toThrow();
  });

  it('rejects maxAttempts < 1', () => {
    expect(() =>
      WorkflowTaskSchema.parse({
        taskId: 't',
        name: 'T',
        goal: 'g',
        type: 'agent',
        maxAttempts: 0,
      }),
    ).toThrow();
  });
});
