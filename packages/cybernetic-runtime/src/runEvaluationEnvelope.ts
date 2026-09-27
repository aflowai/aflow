import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, workflowRuns } from '@aflow/database';
import type {
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
  | { kind: 'outcome'; outcomeEvaluation: RunOutcomeEvaluation };

/**
 * The ONLY code path that writes `workflow_runs.evaluation_json`. A decision
 * write replaces the decision slots and preserves the outcome slot; an
 * outcome write does the reverse. A stored 'ran' decision is final except to
 * a 'ran' under a different suiteContentHash — re-fired hooks and late error
 * writes never clobber a completed evaluation.
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
      };
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
