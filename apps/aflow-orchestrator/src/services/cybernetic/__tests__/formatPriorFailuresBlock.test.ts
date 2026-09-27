import { describe, it, expect } from 'vitest';
import { formatPriorFailuresBlock } from '../taskHelpers.js';

describe('formatPriorFailuresBlock — Plan 149 §2', () => {
  it('renders a fully-populated single-attempt block', () => {
    const block = formatPriorFailuresBlock([
      {
        attempt: 1,
        failedAt: '2026-05-14T10:46:00.000Z',
        errorCode: 'EGRESS_HTTP_400',
        errorClassification: 'external_dependency',
        errorRetryable: false,
        failureReason: 'Alpaca returned HTTP 400: request body format is invalid',
        remediationNote:
          'Operator updated alpaca-paper-orders-write binding to declare body parameter.',
      },
    ]);
    expect(block).toContain('PRIOR ATTEMPTS:');
    expect(block).toContain('attempt 1:');
    expect(block).toContain('failed_at: 2026-05-14T10:46:00.000Z');
    expect(block).toContain('error_code: EGRESS_HTTP_400');
    expect(block).toContain('error_classification: external_dependency');
    expect(block).toContain('error_retryable: false');
    expect(block).toContain('failure_reason:');
    expect(block).toContain('remediation_note:');
  });

  it('renders multiple attempts in order', () => {
    const block = formatPriorFailuresBlock([
      {
        attempt: 1,
        failedAt: '2026-05-14T10:46:00.000Z',
        errorCode: 'EGRESS_HTTP_400',
      },
      {
        attempt: 2,
        failedAt: '2026-05-14T11:00:00.000Z',
        errorCode: 'EGRESS_HTTP_429',
        remediationNote: 'Operator added backoff.',
      },
    ]);
    expect(block).toBeTruthy();
    const attempt1Pos = block!.indexOf('attempt 1:');
    const attempt2Pos = block!.indexOf('attempt 2:');
    expect(attempt1Pos).toBeGreaterThan(-1);
    expect(attempt2Pos).toBeGreaterThan(attempt1Pos);
  });

  it('returns null for an empty array (no block injected on first attempt)', () => {
    expect(formatPriorFailuresBlock([])).toBeNull();
  });

  it('returns null for non-array input (legacy / malformed data)', () => {
    expect(formatPriorFailuresBlock(undefined)).toBeNull();
    expect(formatPriorFailuresBlock(null)).toBeNull();
    expect(formatPriorFailuresBlock('not an array')).toBeNull();
    expect(formatPriorFailuresBlock({ attempt: 1 })).toBeNull();
  });

  it('returns null when every entry is malformed (no valid attempt field)', () => {
    expect(
      formatPriorFailuresBlock([
        { failedAt: '2026-05-14T10:46:00.000Z' }, // missing attempt
        null,
        'garbage',
      ]),
    ).toBeNull();
  });

  it('skips fields that are present but the wrong type (fail-soft)', () => {
    const block = formatPriorFailuresBlock([
      {
        attempt: 1,
        failedAt: 12345, // wrong type — skipped
        errorCode: 'EGRESS_HTTP_400',
        errorRetryable: 'true', // wrong type — skipped
      },
    ]);
    expect(block).toContain('attempt 1:');
    expect(block).toContain('error_code: EGRESS_HTTP_400');
    expect(block).not.toContain('failed_at');
    expect(block).not.toContain('error_retryable');
  });

  it('Plan 171 P1 — renders a paused-attempt snapshot using the same field names', () => {
    // The paused-task re_execute commit helper writes snapshots using
    // the same keys (`failedAt`, `failureReason`, `errorClassification`,
    // `remediationNote`) so this formatter doesn't need branching. The
    // distinguishing tag is `errorClassification: 'paused'` — the
    // Runner sees the pause cause in the same "PRIOR ATTEMPTS:" block.
    const block = formatPriorFailuresBlock([
      {
        attempt: 1,
        failedAt: '2026-06-02T10:00:00.000Z',
        errorClassification: 'paused',
        failureReason: 'Kaggle MCP unreachable (timeout after 30s)',
        summary: 'Paused on transient external dependency.',
        remediationNote: 'Operator confirmed Kaggle MCP connectivity restored.',
      },
    ]);
    expect(block).toContain('PRIOR ATTEMPTS:');
    expect(block).toContain('attempt 1:');
    expect(block).toContain('failed_at: 2026-06-02T10:00:00.000Z');
    expect(block).toContain('error_classification: paused');
    expect(block).toContain('failure_reason: "Kaggle MCP unreachable (timeout after 30s)"');
    expect(block).toContain(
      'remediation_note: "Operator confirmed Kaggle MCP connectivity restored."',
    );
  });

  it('JSON-stringifies failure_reason + remediation_note (preserves newlines / quotes)', () => {
    const block = formatPriorFailuresBlock([
      {
        attempt: 1,
        failureReason: 'multi\nline\nreason',
        remediationNote: 'fixed "the binding"',
      },
    ]);
    expect(block).toContain('failure_reason: "multi\\nline\\nreason"');
    expect(block).toContain('remediation_note: "fixed \\"the binding\\""');
  });
});
