import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, workflowRuns } from '@aflow/database';
import type {
  BenchmarkAttemptResult,
  BenchmarkFailureClass,
  JudgeCriterionSelection,
  RunEvaluationDecision,
  RunEvaluationEnvelope,
  RunEvaluationSummary,
  RunOutcomeEvaluation,
  TenantId,
} from '@aflow/schemas';
import { RunEvaluationEnvelopeSchema } from '@aflow/schemas';

export type RunEvaluationEnvelopeWrite =
  | {
      kind: 'decision';
      decision: RunEvaluationDecision;
      suiteContentHash?: string;
      summary?: RunEvaluationSummary;
      judgeSelection?: JudgeCriterionSelection[];
      errorMessage?: string;
    }
  | { kind: 'outcome'; outcomeEvaluation: RunOutcomeEvaluation }
  | { kind: 'benchmark'; benchmark: BenchmarkAttemptResult };

/**
 * The failure classes where the official harness gave no verdict. Such an
 * attempt is unscored, never a failed task, so a broken pipeline cannot lower
 * a pass rate.
 */
const UNSCORED_BENCHMARK_FAILURES: ReadonlySet<BenchmarkFailureClass> = new Set([
  'materialize_failed',
  'image_unavailable',
  'harness_error',
]);

/** The official harness's verdict on one attempt, as a pass rate counts it. */
export function benchmarkVerdict(attempt: BenchmarkAttemptResult): 'pass' | 'fail' | 'unscored' {
  if (attempt.failureClass !== null && UNSCORED_BENCHMARK_FAILURES.has(attempt.failureClass)) {
    return 'unscored';
  }
  return attempt.passed ? 'pass' : 'fail';
}

/**
 * The ONLY code path that writes `workflow_runs.evaluation_json`. Each write
 * kind owns its slots and preserves the others: a decision write owns the
 * decision slots, an outcome write the outcome slot, and a benchmark write the
 * benchmark slot (Plan 341 D6). So a production suite's `summary` and the
 * official harness's verdict on one run never overwrite each other. A stored
 * 'ran' decision is final except to a 'ran' under a different
 * suiteContentHash — re-fired hooks and late error writes never clobber a
 * completed evaluation. A stored scored benchmark verdict is final for its
 * harness revision, and a run never changes which task it attempted.
 */
export async function writeRunEvaluationEnvelope(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { runId: string; write: RunEvaluationEnvelopeWrite },
): Promise<{ written: boolean }> {
  const { runId, write } = params;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({ evaluationJson: workflowRuns.evaluationJson })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (!row) return { written: false };

    const parsed = RunEvaluationEnvelopeSchema.safeParse(row.evaluationJson);
    const existing = parsed.success ? parsed.data : undefined;

    let next: RunEvaluationEnvelope;
    if (write.kind === 'decision') {
      if (
        existing?.decision === 'ran' &&
        (write.decision !== 'ran' || existing.suiteContentHash === write.suiteContentHash)
      ) {
        return { written: false };
      }
      next = {
        decision: write.decision,
        decidedAt: new Date().toISOString(),
        ...(write.suiteContentHash !== undefined
          ? { suiteContentHash: write.suiteContentHash }
          : {}),
        ...(write.summary !== undefined ? { summary: write.summary } : {}),
        ...(write.judgeSelection !== undefined ? { judgeSelection: write.judgeSelection } : {}),
        ...(write.errorMessage !== undefined ? { errorMessage: write.errorMessage } : {}),
        ...(existing?.outcomeEvaluation !== undefined
          ? { outcomeEvaluation: existing.outcomeEvaluation }
          : {}),
        ...(existing?.benchmark !== undefined ? { benchmark: existing.benchmark } : {}),
      };
    } else if (write.kind === 'benchmark') {
      const stored = existing?.benchmark;
      if (
        stored !== undefined &&
        (stored.benchmark !== write.benchmark.benchmark ||
          stored.instanceId !== write.benchmark.instanceId ||
          stored.arm !== write.benchmark.arm)
      ) {
        throw new Error(
          `Run ${runId} holds the ${stored.arm} attempt at ${stored.instanceId}, so it cannot record the ${write.benchmark.arm} attempt at ${write.benchmark.instanceId}.`,
        );
      }
      if (
        stored !== undefined &&
        benchmarkVerdict(stored) !== 'unscored' &&
        stored.harnessRevision === write.benchmark.harnessRevision
      ) {
        return { written: false };
      }
      next = { ...(existing ?? {}), benchmark: write.benchmark };
    } else {
      next = { ...(existing ?? {}), outcomeEvaluation: write.outcomeEvaluation };
    }

    await tx
      .update(workflowRuns)
      .set({ evaluationJson: next })
      .where(eq(workflowRuns.runId, runId));
    return { written: true };
  });
}

/** Parse a raw `evaluation_json` value; undefined for null/legacy shapes. */
export function parseRunEvaluationEnvelope(value: unknown): RunEvaluationEnvelope | undefined {
  const parsed = RunEvaluationEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
