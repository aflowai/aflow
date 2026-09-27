import { describe, it, expect } from 'vitest';
import { GoldenCaseSchema, type GoldenCase } from './goldenCase.js';
import { EvalLabelSchema } from './evalLabel.js';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const DATASET_ID = '22222222-2222-4222-8222-222222222222';

function validCase(overrides?: Partial<GoldenCase>): unknown {
  return {
    caseId: CASE_ID,
    datasetId: DATASET_ID,
    title: 'Wrong input pauses at triage',
    stratum: { scenario: 'malformed-input', direction: 'should_pause', tier: 'regression' },
    trigger: { inputs: { ticker: 'not-a-ticker' } },
    fixture: {
      tier: 'seeded',
      memoryDocs: [{ path: '/notes/context.md', contentRef: 'inline:abc' }],
    },
    expectations: [
      {
        kind: 'terminal',
        runStatus: 'paused',
        pausedReason: 'needs_decision',
        pausedTaskId: 'triage',
      },
      { kind: 'task_status', taskId: 'triage', status: 'paused' },
      {
        kind: 'output',
        scope: { taskId: 'triage' },
        check: { op: 'not_contains', pattern: 'fabricated', inField: 'summary' },
      },
      {
        kind: 'trajectory',
        check: { op: 'forbidden_ops', operationIds: ['api.http.call'] },
      },
    ],
    rubrics: [{ kind: 'suite_criterion', criterionId: 'clarity', scopeKey: 'goal' }],
    provenance: {
      source: 'promoted_from_run',
      runId: 'run-123',
      workflowRevision: 7,
      counterexample: {
        outputRef: 'inline:bad',
        critique: 'It fabricated a report instead of pausing.',
      },
    },
    ...overrides,
  };
}

describe('GoldenCaseSchema', () => {
  it('round-trips a full case (defaults applied)', () => {
    const parsed = GoldenCaseSchema.parse(validCase());
    expect(parsed.caseId).toBe(CASE_ID);
    expect(parsed.fixture.learnings).toBe('none');
    expect(parsed.expectations).toHaveLength(4);
    // Reparsing the parsed value is stable — storage round-trip.
    expect(GoldenCaseSchema.parse(parsed)).toEqual(parsed);
  });

  it('accepts every expectation kind including reused criterion shapes', () => {
    const parsed = GoldenCaseSchema.parse(
      validCase({
        expectations: [
          {
            kind: 'output',
            scope: 'run',
            check: {
              type: 'threshold',
              name: 'score floor',
              metric: 'lbValue',
              operator: 'gte',
              target: 0.8,
            },
          },
          {
            kind: 'output',
            scope: { taskId: 'report' },
            check: { type: 'contains', name: 'has ticker', pattern: 'AAPL', inField: 'summary' },
          },
          {
            kind: 'output',
            scope: { taskId: 'report' },
            check: { op: 'equals', path: 'result.label', value: 'buy' },
          },
          {
            kind: 'output',
            scope: { taskId: 'report' },
            check: { op: 'json_schema', schemaRef: 'inline:e30=' },
          },
          {
            kind: 'trajectory',
            check: { op: 'required_ops', operationIds: ['memory.store.get'] },
          },
          {
            kind: 'trajectory',
            check: { type: 'trace_bound', name: 'cheap', metric: 'cost_cents', maxValue: 50 },
          },
        ] as GoldenCase['expectations'],
      }),
    );
    expect(parsed.expectations).toHaveLength(6);
  });

  it('rejects pausedReason/pausedTaskId on a non-paused terminal expectation', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        expectations: [
          { kind: 'terminal', runStatus: 'completed', pausedReason: 'needs_decision' },
        ] as GoldenCase['expectations'],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a pausedReason outside WorkflowRunPauseReasonSchema', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        expectations: [
          { kind: 'terminal', runStatus: 'paused', pausedReason: 'because_reasons' },
        ] as unknown as GoldenCase['expectations'],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a malformed operation id in a trajectory check', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        expectations: [
          { kind: 'trajectory', check: { op: 'required_ops', operationIds: ['Not An Op!'] } },
        ] as unknown as GoldenCase['expectations'],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a sealed binding pinning the persona and baseline it means', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        fixture: {
          tier: 'sealed',
          bindings: [
            {
              integrationId: 'bnpl',
              mode: 'stub',
              simulationId: 'bnpl-desk',
              personaId: 'cus_99',
              baselineVersion: 2,
            },
          ],
        } as unknown as GoldenCase['fixture'],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts an explicit null persona — acting as nobody is a scenario', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        fixture: {
          tier: 'sealed',
          bindings: [
            { integrationId: 'bnpl', mode: 'stub', simulationId: 'bnpl-desk', personaId: null },
          ],
        } as unknown as GoldenCase['fixture'],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a baseline version below the first one a simulation can mint', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        fixture: {
          tier: 'sealed',
          bindings: [
            {
              integrationId: 'bnpl',
              mode: 'stub',
              simulationId: 'bnpl-desk',
              baselineVersion: 0,
            },
          ],
        } as unknown as GoldenCase['fixture'],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a stub binding that names no simulation to answer it', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        fixture: {
          tier: 'sealed',
          bindings: [{ integrationId: 'github', mode: 'stub' }],
        } as unknown as GoldenCase['fixture'],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a promoted case without its originating runId', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        provenance: {
          source: 'promoted_from_run',
          workflowRevision: 7,
        } as unknown as GoldenCase['provenance'],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown stratum direction', () => {
    const result = GoldenCaseSchema.safeParse(
      validCase({
        stratum: {
          scenario: 's',
          direction: 'should_win',
          tier: 'regression',
        } as unknown as GoldenCase['stratum'],
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('EvalLabelSchema', () => {
  const base = {
    runId: 'run-123',
    criterionId: 'clarity',
    scopeKey: 'goal',
    verdict: 'pass',
    critique: 'Concise and correct.',
    partition: 'validation',
    labeledBy: '33333333-3333-4333-8333-333333333333',
    labeledAt: '2026-08-05T12:00:00Z',
  };

  it('parses a run-scoped label (no case) and a case-scoped label', () => {
    expect(EvalLabelSchema.parse(base).caseRevisionId).toBeUndefined();
    const caseScoped = EvalLabelSchema.parse({
      ...base,
      caseRevisionId: '44444444-4444-4444-8444-444444444444',
      batchId: '55555555-5555-4555-8555-555555555555',
      trial: 2,
      partition: 'exemplar',
    });
    expect(caseScoped.trial).toBe(2);
  });

  it('rejects a non-binary verdict', () => {
    expect(EvalLabelSchema.safeParse({ ...base, verdict: 'partial' }).success).toBe(false);
  });

  it('rejects an empty critique', () => {
    expect(EvalLabelSchema.safeParse({ ...base, critique: '' }).success).toBe(false);
  });

  it('rejects an unknown partition', () => {
    expect(EvalLabelSchema.safeParse({ ...base, partition: 'training' }).success).toBe(false);
  });
});
