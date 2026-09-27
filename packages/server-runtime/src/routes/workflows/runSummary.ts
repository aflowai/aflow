/**
 * Shared workflow-run summary shape + mapper.
 *
 * One producer for both the per-skill run history (`/workflows/:slug/runs`)
 * and the space-wide run feed (`/workflow-runs`). Resolves the root (Helmsman)
 * session via the Redis parent chain and folds in eval score/verdict from the
 * run row (or the memory-doc fallback for historical runs).
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { EvalResultSchema, RunEvaluationEnvelopeSchema, type TenantId } from '@aflow/schemas';
import { getSessionStateSafe } from '@aflow/redis';
import { createWorkflowRepo } from './shared.js';

export const WorkflowRunSummarySchema = z.object({
  // There is ONE run identifier, and it is `runId`. The table's surrogate
  // primary key used to ride along beside it: two uuids of identical shape
  // where every write endpoint rejects one of them with "no workflow run found
  // in this space" — which reads as a tenancy bug and is how a runaway run got
  // diagnosed as uncancellable.
  runId: z.string(),
  status: z.string(),
  workflowSlug: z.string(),
  workflowRevision: z.number().int(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  totalCostCents: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  evalScore: z.number().nullable(),
  evalVerdict: z.string().nullable(),
  /** Envelope decision — why evaluation did or didn't run on this run. */
  evalDecision: z.string().nullable(),
  taskCount: z.number().int(),
  /** Typed pause cause (WorkflowRunPauseReason); NULL unless status is paused. */
  pausedReason: z.string().nullable(),
  initiatedByUserId: z.string().uuid().nullable(),
  sessionId: z.string().uuid().nullable(),
  /** Root (Helmsman) session — resolved from parent chain, falls back to sessionId. */
  rootSessionId: z.string().uuid().nullable(),
});

export type WorkflowRunSummary = z.infer<typeof WorkflowRunSummarySchema>;

/** The DB columns the mapper reads. Both routes select exactly these. */
export interface WorkflowRunSummaryRow {
  runId: string;
  status: string;
  workflowSlug: string;
  workflowRevision: number;
  startedAt: Date;
  completedAt: Date | null;
  totalCostCents: number | null;
  totalTokens: number | null;
  evaluationJson: unknown;
  pausedReason: string | null;
  initiatedByUserId: string | null;
  sessionId: string | null;
}

export async function buildWorkflowRunSummaries(
  fastify: FastifyInstance,
  tenantId: TenantId,
  spaceId: string,
  rows: WorkflowRunSummaryRow[],
  taskCounts: Map<string, number>,
): Promise<WorkflowRunSummary[]> {
  // Resolve root (Helmsman) session for each run by walking up the
  // parentSessionId chain in Redis. Falls back to the stored sessionId
  // (driver) when Redis state has expired.
  const redis = fastify.appContext.redis;
  const rootSessionMap = new Map<string, string>();
  if (redis) {
    for (const r of rows) {
      if (!r.sessionId) continue;
      try {
        let current = r.sessionId;
        let depth = 0;
        while (depth < 5) {
          const result = await getSessionStateSafe(redis, tenantId, current);
          if (!result.ok || !result.state.parentSessionId) break;
          current = result.state.parentSessionId;
          depth++;
        }
        if (current !== r.sessionId) {
          rootSessionMap.set(r.sessionId, current);
        }
      } catch {
        // Best-effort — fall back to driver session.
      }
    }
  }

  // Eval fallback from memory docs (keyed by runId in path), read per-slug.
  const repo = createWorkflowRepo(fastify, tenantId);
  const evalMap = new Map<string, { score: number | null; verdict: string | null }>();
  for (const r of rows) {
    try {
      const doc = await repo.getByPath(`/evals/${r.workflowSlug}/results/${r.runId}.json`, spaceId);
      if (doc?.inlineContent) {
        const parsed = EvalResultSchema.safeParse(JSON.parse(doc.inlineContent));
        if (parsed.success) {
          evalMap.set(r.runId, { score: parsed.data.scores.overall, verdict: parsed.data.verdict });
        }
      }
    } catch {
      // Skip — eval result may not exist for this run.
    }
  }

  return rows.map((r) => {
    const evalFallback = evalMap.get(r.runId);

    // Eval: primary from the run's evaluation envelope (single writer),
    // fallback to the memory doc when the envelope carries no summary.
    const envelopeParse = RunEvaluationEnvelopeSchema.safeParse(r.evaluationJson);
    const envelope = envelopeParse.success ? envelopeParse.data : undefined;
    const evalScore = envelope?.summary?.scores.overall ?? evalFallback?.score ?? null;
    const evalVerdict = envelope?.summary?.verdict ?? evalFallback?.verdict ?? null;
    const evalDecision = envelope?.decision ?? null;

    const totalCostCents =
      typeof r.totalCostCents === 'number' && r.totalCostCents > 0 ? r.totalCostCents : null;

    const startMs = new Date(r.startedAt).getTime();
    const endMs = r.completedAt ? new Date(r.completedAt).getTime() : null;
    const durationMs = endMs !== null ? endMs - startMs : null;

    return {
      runId: r.runId,
      status: r.status,
      workflowSlug: r.workflowSlug,
      workflowRevision: r.workflowRevision,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      durationMs,
      totalCostCents,
      totalTokens: r.totalTokens,
      evalScore,
      evalVerdict,
      evalDecision,
      taskCount: taskCounts.get(r.runId) ?? 0,
      pausedReason: r.pausedReason,
      initiatedByUserId: r.initiatedByUserId,
      sessionId: r.sessionId,
      rootSessionId: rootSessionMap.get(r.sessionId ?? '') ?? r.sessionId,
    };
  });
}
