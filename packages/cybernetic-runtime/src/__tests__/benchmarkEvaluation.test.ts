/**
 * Plan 341 D6 — a benchmark attempt is recorded through Plan 269's one
 * evaluation writer and through nothing else, with the official harness's
 * verdict as the only score.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkAttemptResult } from '@aflow/schemas';

const writerCalls: unknown[] = [];

vi.mock('../runEvaluationEnvelope.js', () => ({
  writeRunEvaluationEnvelope: vi.fn(async (_db: unknown, tenantId: string, params: unknown) => {
    writerCalls.push({ tenantId, params });
    return { written: true };
  }),
}));

const { benchmarkEvaluationWrite, benchmarkSuiteContentHash, writeBenchmarkAttemptEvaluation } =
  await import('../benchmarkEvaluation.js');

const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = 'run_proving_ground_1';

function attempt(over: Partial<BenchmarkAttemptResult> = {}): BenchmarkAttemptResult {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: 'instance_example__repo-abc123',
    arm: 'bare_harness',
    passed: true,
    failureClass: null,
    tokens: 120_000,
    costUsd: 1.25,
    wallTimeMs: 600_000,
    patchBytes: 2_048,
    harnessRevision: 'a1b2c3d',
    ...over,
  };
}

beforeEach(() => {
  writerCalls.length = 0;
});

describe('writeBenchmarkAttemptEvaluation', () => {
  it('lands in the one writer, on the tenant and run the caller names', async () => {
    const result = await writeBenchmarkAttemptEvaluation({} as never, TENANT, {
      runId: RUN_ID,
      attempt: attempt(),
    });
    expect(result).toEqual({ written: true });
    expect(writerCalls).toEqual([
      {
        tenantId: TENANT,
        params: {
          runId: RUN_ID,
          write: {
            kind: 'decision',
            decision: 'ran',
            suiteContentHash: benchmarkSuiteContentHash(attempt()),
            summary: {
              verdict: 'pass',
              scores: { overall: 1 },
              faultLayer: null,
              regressionDetected: false,
            },
            benchmark: attempt(),
          },
        },
      },
    ]);
  });

  it('records a hidden-test failure as a ran fail scoring 0, with no judge selection', () => {
    const write = benchmarkEvaluationWrite(
      attempt({ passed: false, failureClass: 'tests_failed' }),
    );
    expect(write).toMatchObject({
      kind: 'decision',
      decision: 'ran',
      summary: { verdict: 'fail', scores: { overall: 0 } },
    });
    expect(write).not.toHaveProperty('judgeSelection');
  });

  it('records an attempt the harness gave no verdict on as an error, not as a failed task', () => {
    const write = benchmarkEvaluationWrite(
      attempt({ passed: false, failureClass: 'image_unavailable', detail: 'docker pull failed' }),
    );
    expect(write).toMatchObject({
      kind: 'decision',
      decision: 'error',
      errorMessage: 'docker pull failed',
      benchmark: { failureClass: 'image_unavailable' },
    });
    expect(write).not.toHaveProperty('summary');
  });

  it('refuses an attempt whose verdict and failure class disagree', () => {
    expect(() =>
      benchmarkEvaluationWrite(attempt({ passed: true, failureClass: 'tests_failed' })),
    ).toThrow(/failure class exactly when it did not pass/);
    expect(() => benchmarkEvaluationWrite(attempt({ passed: false, failureClass: null }))).toThrow(
      /failure class exactly when it did not pass/,
    );
  });

  it('keys idempotence on the task and the harness revision', () => {
    expect(benchmarkSuiteContentHash(attempt())).toBe(
      benchmarkSuiteContentHash(attempt({ arm: 'loop' })),
    );
    expect(benchmarkSuiteContentHash(attempt())).not.toBe(
      benchmarkSuiteContentHash(attempt({ harnessRevision: 'ffffff0' })),
    );
  });
});
