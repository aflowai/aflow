/**
 * The reads `plan.node.next` makes past the plan's own tables (Plan 322 P2b):
 * a node's rounds from `workflow_runs`, what a publication promoted, and the
 * space's pending pauses in `attention_items`.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PayloadStore } from '@aflow/payload-store';
import {
  PLAN_STREAM_COMMISSION_SLUG,
  PLAN_STREAM_PUBLICATION_SLUG,
  type AttentionItemKind,
  type TenantId,
} from '@aflow/schemas';
import {
  attentionItems,
  createTenantContext,
  withTenantSchema,
  workflowRuns,
} from '@aflow/database';
import { extractRunFailureReason } from '../evalJudgeEvidence.js';
import { loadRunById } from '../ledger/queries.js';
import { buildWorkflowRunResult } from '../runResult.js';
import type { PlanPublicationOutcome, PlanStreamReads } from './stream.js';

const PUBLICATION_OUTCOME_FIELDS = ['prUrl', 'afterReview', 'pushDecision', 'reviewRunId'] as const;

export function createPlanStreamReads(
  deps: { db: PostgresJsDatabase; payloadStore: PayloadStore },
  tenantId: string,
): PlanStreamReads {
  const { db } = deps;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const inTenant = <T>(fn: (tx: PostgresJsDatabase) => Promise<T>): Promise<T> =>
    withTenantSchema(db, tenantCtx, fn);

  return {
    roundsOf: (spaceId, nodeId, limit) =>
      inTenant(async (tx) => {
        const rows = await tx
          .select({
            runId: workflowRuns.runId,
            slug: workflowRuns.workflowSlug,
            status: workflowRuns.status,
            startedAt: workflowRuns.startedAt,
            failureJson: workflowRuns.failureJson,
          })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.spaceId, spaceId),
              eq(workflowRuns.planNodeId, nodeId),
              inArray(workflowRuns.workflowSlug, [
                PLAN_STREAM_COMMISSION_SLUG,
                PLAN_STREAM_PUBLICATION_SLUG,
              ]),
              isNull(workflowRuns.evalBatchId),
            ),
          )
          .orderBy(desc(workflowRuns.startedAt))
          .limit(limit);
        return rows.map((row) => {
          const failure = row.status === 'failed' ? extractRunFailureReason(row.failureJson) : null;
          return {
            runId: row.runId,
            slug: row.slug,
            status: row.status,
            startedAt: row.startedAt.toISOString(),
            ...(failure !== null ? { failure } : {}),
          };
        });
      }),

    publicationOutcome: async (spaceId, runId) => {
      const run = await loadRunById(db, tenantId, spaceId, runId);
      if (!run) return null;
      const result = await buildWorkflowRunResult(deps, { tenantId, run, scope: 'partial' });
      if (!result) return null;
      const output = result.output ?? {};
      const outcome: PlanPublicationOutcome = {};
      for (const field of PUBLICATION_OUTCOME_FIELDS) {
        const value = output[field];
        if (typeof value === 'string' && value.length > 0) outcome[field] = value;
      }
      return outcome;
    },

    pausedItemsServing: (spaceId, nodeIds) =>
      inTenant(async (tx) => {
        if (nodeIds.length === 0) return 0;
        const [row] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(attentionItems)
          .innerJoin(workflowRuns, eq(workflowRuns.runId, attentionItems.relatedRunId))
          .where(
            and(
              eq(attentionItems.tenantId, tenantId),
              eq(attentionItems.spaceId, spaceId),
              eq(attentionItems.kind, 'workflow_run_paused' satisfies AttentionItemKind),
              isNull(attentionItems.consumedAt),
              inArray(workflowRuns.planNodeId, [...nodeIds]),
            ),
          );
        return row?.total ?? 0;
      }),
  };
}
