/**
 * Durable stores for the label queue and the re-judge verdict ledger
 * (Plan 269 D10/D9). Queue inserts are idempotent on the subject identity
 * (batch, caseRevision, trial, criterion, scope) — a terminalization retry
 * re-derives the same seeded draw and conflict-skips; validation rows are
 * inserted before exemplar rows so the draw always wins the identity.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  evalBatches,
  evalLabelQueue,
  evalLabels,
  evalRejudgeVerdicts,
  goldenCaseRevisions,
  withTenantSchema,
  type EvalLabelQueueRow,
  type EvalLabelRow,
  type EvalRejudgeVerdictRow,
  type NewEvalRejudgeVerdictRow,
} from '@aflow/database';
import type { EvalLabelQueuePlanItem } from './evalLabelQueue.js';

// ============================================================================
// Label queue
// ============================================================================

export async function insertLabelQueueItems(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; batchId: string; items: readonly EvalLabelQueuePlanItem[] },
): Promise<number> {
  if (params.items.length === 0) return 0;
  const tenantCtx = createTenantContext(tenantId);
  const inserted = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .insert(evalLabelQueue)
      .values(
        params.items.map((item) => ({
          spaceId: params.spaceId,
          batchId: params.batchId,
          caseRevisionId: item.caseRevisionId,
          trial: item.trial,
          runId: item.runId,
          criterionId: item.criterionId,
          scopeKey: item.scopeKey,
          partition: item.partition,
          source: item.source,
          inclusionProbability:
            item.inclusionProbability !== undefined ? String(item.inclusionProbability) : null,
          judgeVersion: item.judgeVersion ?? null,
          conversationJson: item.conversation ?? null,
          evidenceJson: item.evidence ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: evalLabelQueue.id }),
  );
  return inserted.length;
}

export interface LabelQueueListEntry {
  item: EvalLabelQueueRow;
  workflowSlug: string | null;
  caseTitle: string | null;
}

export async function listLabelQueueItems(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    spaceId: string;
    status: string;
    batchId?: string | undefined;
    /** Filter to one skill's queue via the item's batch (per-skill inboxes). */
    workflowSlug?: string | undefined;
    limit: number;
  },
): Promise<LabelQueueListEntry[]> {
  const tenantCtx = createTenantContext(tenantId);
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        item: evalLabelQueue,
        workflowSlug: evalBatches.workflowSlug,
        caseTitle: goldenCaseRevisions.title,
      })
      .from(evalLabelQueue)
      .leftJoin(evalBatches, eq(evalBatches.id, evalLabelQueue.batchId))
      .leftJoin(goldenCaseRevisions, eq(goldenCaseRevisions.id, evalLabelQueue.caseRevisionId))
      .where(
        and(
          eq(evalLabelQueue.spaceId, params.spaceId),
          eq(evalLabelQueue.status, params.status),
          ...(params.batchId !== undefined ? [eq(evalLabelQueue.batchId, params.batchId)] : []),
          ...(params.workflowSlug !== undefined
            ? [eq(evalBatches.workflowSlug, params.workflowSlug)]
            : []),
        ),
      )
      .orderBy(evalLabelQueue.createdAt, evalLabelQueue.id)
      .limit(params.limit),
  );
  return rows;
}

export async function getLabelQueueItemById(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; itemId: string },
): Promise<EvalLabelQueueRow | null> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [row] = await tx
      .select()
      .from(evalLabelQueue)
      .where(and(eq(evalLabelQueue.id, params.itemId), eq(evalLabelQueue.spaceId, params.spaceId)))
      .limit(1);
    return row ?? null;
  });
}

/** CAS pending → labeled|dismissed; false when the item already resolved. */
export async function resolveLabelQueueItem(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    spaceId: string;
    itemId: string;
    status: 'labeled' | 'dismissed';
    labelId?: string | undefined;
  },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(evalLabelQueue)
      .set({
        status: params.status,
        labelId: params.labelId ?? null,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(evalLabelQueue.id, params.itemId),
          eq(evalLabelQueue.spaceId, params.spaceId),
          eq(evalLabelQueue.status, 'pending'),
        ),
      )
      .returning({ id: evalLabelQueue.id });
    return updated.length > 0;
  });
}

/**
 * Resolve the pending item covering one label's subject, if there is one.
 *
 * A label's identity and a queue item's subject are the same tuple, so a label
 * filed anywhere but the bench — an operator disputing a verdict where they
 * read it — makes the bench's own submit collide later. Left alone the item
 * stays pending forever: the conflict path cannot resolve what it did not
 * insert, and the reviewer meets a row that can never be cleared.
 */
export async function resolveLabelQueueItemForSubject(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    spaceId: string;
    batchId: string;
    caseRevisionId: string;
    trial: number;
    criterionId: string;
    scopeKey: string;
    partition: string;
    labelId?: string | undefined;
  },
): Promise<number> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(evalLabelQueue)
      .set({
        status: 'labeled',
        labelId: params.labelId ?? null,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(evalLabelQueue.spaceId, params.spaceId),
          eq(evalLabelQueue.batchId, params.batchId),
          eq(evalLabelQueue.caseRevisionId, params.caseRevisionId),
          eq(evalLabelQueue.trial, params.trial),
          eq(evalLabelQueue.criterionId, params.criterionId),
          eq(evalLabelQueue.scopeKey, params.scopeKey),
          eq(evalLabelQueue.partition, params.partition),
          eq(evalLabelQueue.status, 'pending'),
        ),
      )
      .returning({ id: evalLabelQueue.id });
    return updated.length;
  });
}

// ============================================================================
// Labels (measurement reads)
// ============================================================================

/** Case-scoped labels for a set of batches — the scorecard/re-judge input. */
export async function listCaseScopedLabelsForBatches(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; batchIds: readonly string[]; criterionId?: string | undefined },
): Promise<EvalLabelRow[]> {
  if (params.batchIds.length === 0) return [];
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(evalLabels)
      .where(
        and(
          eq(evalLabels.spaceId, params.spaceId),
          inArray(evalLabels.batchId, [...params.batchIds]),
          ...(params.criterionId !== undefined
            ? [eq(evalLabels.criterionId, params.criterionId)]
            : []),
        ),
      ),
  );
}

// ============================================================================
// Re-judge verdict ledger
// ============================================================================

/** Conflict-skip on (batch, caseRevision, trial, criterion, judgeVersion): a
 * replay never overwrites — the same version's verdict is already the record. */
export async function insertRejudgeVerdict(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  values: NewEvalRejudgeVerdictRow,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId);
  const inserted = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .insert(evalRejudgeVerdicts)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: evalRejudgeVerdicts.id }),
  );
  return inserted.length > 0;
}

export async function listRejudgeVerdictsForBatches(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; batchIds: readonly string[]; criterionId?: string | undefined },
): Promise<EvalRejudgeVerdictRow[]> {
  if (params.batchIds.length === 0) return [];
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(evalRejudgeVerdicts)
      .where(
        and(
          eq(evalRejudgeVerdicts.spaceId, params.spaceId),
          inArray(evalRejudgeVerdicts.batchId, [...params.batchIds]),
          ...(params.criterionId !== undefined
            ? [eq(evalRejudgeVerdicts.criterionId, params.criterionId)]
            : []),
        ),
      ),
  );
}
