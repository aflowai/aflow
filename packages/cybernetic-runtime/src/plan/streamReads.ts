/**
 * The reads `plan.node.next` makes past the plan's own tables (Plan 322 P2b,
 * Plan 331 P1): a node's rounds from `workflow_runs`, what a publication
 * promoted and a commission made, the publications naming a commission, a
 * node's spend, and the space's pending pauses in `attention_items`.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
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
  sessions,
  withTenantSchema,
  workflowRuns,
} from '@aflow/database';
import { extractRunFailureReason } from '../evalJudgeEvidence.js';
import { loadRunById } from '../ledger/queries.js';
import { buildWorkflowRunResult } from '../runResult.js';
import type {
  PlanCommissionOutcome,
  PlanPublicationOutcome,
  PlanStreamReads,
  PlanStreamRun,
} from './stream.js';

const PUBLICATION_OUTCOME_FIELDS = ['prUrl', 'afterReview', 'pushDecision', 'reviewRunId'] as const;

/** How many runs a node's spend names; the sum covers every one. */
const SPEND_RUNS_LIMIT = 200;

/**
 * The run a wake started records the wake's session (`workflow.run.start`),
 * so the end of that run can wake the space again, and a node's spend counts
 * the wake that started it.
 */
export const RUN_WAKE_SESSION_METADATA_KEY = 'wakeSessionId';

/** The inputs a run was started with, as `workflow.run.start` records them. */
export function runStartInputs(metadata: unknown): Record<string, unknown> {
  const recorded = (metadata as { parentTaskInputs?: { inputs?: unknown } } | null)
    ?.parentTaskInputs?.inputs;
  return typeof recorded === 'object' && recorded !== null
    ? (recorded as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * When a person last opened the node — approved, resumed or reopened it — as
 * the plan page's `plan.node.open` write records it. The spend counts from
 * there, so a lifted stop starts afresh, as a person's write does for attempts.
 */
async function lastOpenedAt(
  tx: PostgresJsDatabase,
  tenantId: string,
  nodeId: string,
): Promise<Date | null> {
  const rows = await tx.execute<{ at: string | Date | null }>(
    sql`SELECT max(timestamp) AS at FROM public.platform_audit_log
         WHERE tenant_id = ${tenantId}::uuid AND action = 'plan.node.open'
           AND resource_id = ${nodeId} AND outcome = 'success'`,
  );
  const at = (rows as unknown as Array<{ at: string | Date | null }>)[0]?.at ?? null;
  return at === null ? null : new Date(at);
}

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

    commissionOutcome: async (spaceId, runId) => {
      const run = await loadRunById(db, tenantId, spaceId, runId);
      if (!run) return null;
      const result = await buildWorkflowRunResult(deps, { tenantId, run, scope: 'partial' });
      if (!result) return null;
      const output = result.output ?? {};
      const merge = output['merge'] as { from?: unknown } | undefined;
      const [row] = await inTenant((tx) =>
        tx
          .select({ metadata: workflowRuns.metadata })
          .from(workflowRuns)
          .where(eq(workflowRuns.runId, runId))
          .limit(1),
      );
      const bindingId = text(runStartInputs(row?.metadata)['bindingId']);
      const patchRef = text(output['patchRef']);
      const baseSha = text(output['baseSha']);
      const mergeFrom = text(merge?.from);
      const outcome: PlanCommissionOutcome = {
        ...(patchRef !== undefined ? { patchRef } : {}),
        ...(baseSha !== undefined ? { baseSha } : {}),
        ...(mergeFrom !== undefined ? { mergeFrom } : {}),
        ...(bindingId !== undefined ? { bindingId } : {}),
      };
      return outcome;
    },

    publicationsOf: (spaceId, commissionRunId) =>
      inTenant(async (tx) => {
        const rows = await tx
          .select({
            runId: workflowRuns.runId,
            slug: workflowRuns.workflowSlug,
            status: workflowRuns.status,
            startedAt: workflowRuns.startedAt,
          })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.spaceId, spaceId),
              eq(workflowRuns.workflowSlug, PLAN_STREAM_PUBLICATION_SLUG),
              isNull(workflowRuns.evalBatchId),
              sql`${workflowRuns.metadata} -> 'parentTaskInputs' -> 'inputs' ->> 'commission' = ${commissionRunId}`,
            ),
          )
          .orderBy(desc(workflowRuns.startedAt))
          .limit(10);
        return rows.map((row): PlanStreamRun => ({
          runId: row.runId,
          slug: row.slug,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
        }));
      }),

    spendOf: (spaceId, nodeId) =>
      inTenant(async (tx) => {
        const since = await lastOpenedAt(tx, tenantId, nodeId);
        const runs = await tx
          .select({
            runId: workflowRuns.runId,
            cents: workflowRuns.totalCostCents,
            metadata: workflowRuns.metadata,
          })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.spaceId, spaceId),
              eq(workflowRuns.planNodeId, nodeId),
              isNull(workflowRuns.evalBatchId),
              ...(since !== null ? [gt(workflowRuns.startedAt, since)] : []),
            ),
          )
          .orderBy(desc(workflowRuns.startedAt));
        const wakeSessionIds = [
          ...new Set(
            runs
              .map((run) =>
                text((run.metadata as Record<string, unknown>)[RUN_WAKE_SESSION_METADATA_KEY]),
              )
              .filter((id): id is string => id !== undefined),
          ),
        ];
        const [wakes] =
          wakeSessionIds.length > 0
            ? await tx
                .select({ cents: sql<string>`coalesce(sum(${sessions.totalCostCents}), 0)::text` })
                .from(sessions)
                .where(inArray(sessions.sessionId, wakeSessionIds))
            : [{ cents: '0' }];
        const runCents = runs.reduce((sum, run) => sum + (run.cents ?? 0), 0);
        return {
          cents: Math.round(runCents + Number(wakes?.cents ?? 0)),
          runIds: runs.slice(0, SPEND_RUNS_LIMIT).map((run) => run.runId),
          wakeSessionIds,
        };
      }),

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
