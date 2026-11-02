import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  BenchmarkAttemptResultSchema,
  type BenchmarkAttemptResult,
  type BenchmarkFailureClass,
} from '@aflow/schemas';

import {
  writeRunEvaluationEnvelope,
  type RunEvaluationEnvelopeWrite,
} from './runEvaluationEnvelope.js';

/**
 * The failure classes where the official harness gave no verdict. Such an
 * attempt is recorded as an evaluation `error`, never as a failed task, so a
 * broken pipeline cannot lower a pass rate.
 */
const UNSCORED: ReadonlySet<BenchmarkFailureClass> = new Set([
  'materialize_failed',
  'image_unavailable',
  'harness_error',
]);

export function isUnscoredBenchmarkAttempt(attempt: BenchmarkAttemptResult): boolean {
  return attempt.failureClass !== null && UNSCORED.has(attempt.failureClass);
}

/**
 * The suite hash a benchmark verdict is idempotent on: the task and the
 * harness revision that graded it. Recording one attempt twice is a no-op,
 * and a later harness revision may grade the run again.
 */
export function benchmarkSuiteContentHash(attempt: BenchmarkAttemptResult): string {
  const digest = createHash('sha256')
    .update(`${attempt.benchmark}\n${attempt.instanceId}\n${attempt.harnessRevision}`)
    .digest('hex');
  return `sha256:${digest}`;
}

/**
 * The envelope write one benchmark attempt makes. The verdict is the official
 * harness's alone (Plan 341 D2): pass scores 1, fail scores 0, and no judge
 * selection is recorded.
 */
export function benchmarkEvaluationWrite(
  attempt: BenchmarkAttemptResult,
): RunEvaluationEnvelopeWrite {
  const parsed = BenchmarkAttemptResultSchema.parse(attempt);
  if (parsed.passed !== (parsed.failureClass === null)) {
    throw new Error(
      `A benchmark attempt names a failure class exactly when it did not pass. ${parsed.instanceId} has passed=${String(parsed.passed)} and failureClass=${String(parsed.failureClass)}.`,
    );
  }
  if (isUnscoredBenchmarkAttempt(parsed)) {
    return {
      kind: 'decision',
      decision: 'error',
      errorMessage:
        parsed.detail ?? `The official harness gave no verdict (${String(parsed.failureClass)}).`,
      benchmark: parsed,
    };
  }
  return {
    kind: 'decision',
    decision: 'ran',
    suiteContentHash: benchmarkSuiteContentHash(parsed),
    summary: {
      verdict: parsed.passed ? 'pass' : 'fail',
      scores: { overall: parsed.passed ? 1 : 0 },
      faultLayer: null,
      regressionDetected: false,
    },
    benchmark: parsed,
  };
}

/**
 * Plan 341 D6 — record one benchmark attempt on its workflow run, through the
 * one evaluation writer. The tenant and run are always named by the caller,
 * so the measurement space is never a default of this code.
 */
export async function writeBenchmarkAttemptEvaluation(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { runId: string; attempt: BenchmarkAttemptResult },
): Promise<{ written: boolean }> {
  return writeRunEvaluationEnvelope(db, tenantId, {
    runId: params.runId,
    write: benchmarkEvaluationWrite(params.attempt),
  });
}
