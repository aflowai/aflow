import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, desc, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  attentionItems,
  workflowRuns,
} from '@aflow/database';
import type { AttentionItemRow } from '@aflow/database';
import type { AddAttentionItemInput, AttentionItemKind } from '@aflow/schemas';
import { bumpAttentionGeneration } from '../attentionCache.js';

/**
 * `tenantId` is the trusted source — it goes into the row regardless of
 * what's in `args`. The schema-level `AddAttentionItemInput` deliberately
 * omits a `tenantId` field to remove the mismatch class.
 */
async function insertAttentionItem(
  handle: PostgresJsDatabase,
  tenantId: string,
  args: AddAttentionItemInput,
): Promise<string> {
  const rows = await handle
    .insert(attentionItems)
    .values({
      tenantId,
      userId: args.userId ?? null,
      spaceId: args.spaceId ?? null,
      kind: args.kind,
      relatedRunId: args.relatedRunId ?? null,
      relatedResource: args.relatedResource ?? null,
      payload: args.payload,
      priority: args.priority,
    })
    .returning({ id: attentionItems.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error('addAttentionItem: insert returned no row');
  }
  return id;
}

/**
 * Append an attention item and, once it has committed, bump its space's
 * attention generation, so the next Helmsman turn's block carries it.
 */
export async function addAttentionItem(
  db: PostgresJsDatabase,
  redis: Redis,
  tenantId: string,
  args: AddAttentionItemInput,
): Promise<string> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const id = await withTenantSchema(db, tenantCtx, (tx) => insertAttentionItem(tx, tenantId, args));
  if (args.spaceId) await bumpAttentionGeneration(redis, tenantId, args.spaceId);
  return id;
}

/**
 * Append an attention item inside the caller's transaction, so it commits
 * atomically with the run transition that raised it (terminal/pause/cancel).
 * The generation is not bumped here: a bump before the commit lets a
 * concurrent build cache the space without the item under the new
 * generation. The transition's `emitRunUpdated`, after the commit, bumps it.
 */
export function addAttentionItemInTransaction(
  tx: PostgresJsDatabase,
  tenantId: string,
  args: AddAttentionItemInput,
): Promise<string> {
  return insertAttentionItem(tx, tenantId, args);
}

/**
 * Read pending attention items for a tenant/user. Helmsman polls via
 * `workflow.run.list_attention`; future surfaces inject at session start
 * or agent.turn boundaries.
 */
export async function listPendingAttention(
  db: PostgresJsDatabase,
  tenantId: string,
  opts: { spaceId?: string; userId?: string; kind?: AttentionItemKind; limit?: number },
): Promise<AttentionItemRow[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const limit = opts.limit ?? 25;
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const conditions = [sql`consumed_at IS NULL`, eq(attentionItems.tenantId, tenantId)];
    if (opts.spaceId) conditions.push(eq(attentionItems.spaceId, opts.spaceId));
    if (opts.userId) conditions.push(eq(attentionItems.userId, opts.userId));
    if (opts.kind) conditions.push(eq(attentionItems.kind, opts.kind));
    return await tx
      .select()
      .from(attentionItems)
      .where(and(...conditions))
      .orderBy(desc(attentionItems.createdAt))
      .limit(limit);
  });
}

/** A pending attention item with the run it is about, as the attention block groups it. */
export interface PendingRunAttentionItem {
  itemId: string;
  kind: AttentionItemKind;
  runId: string | null;
  /** The run's workflow, when the item names a run that is still recorded. */
  workflowSlug: string | null;
  /** The plan node that run serves (Plan 322 D5). */
  planNodeId: string | null;
  createdAt: Date;
}

/** A space's pending attention items as the attention block reads them. */
export interface PendingRunAttention {
  /**
   * Newest first: the newest `perNodeLimit` items about runs serving each plan
   * node, and as many about runs serving none — so the newest `perNodeLimit`
   * of any set of nodes, a plan root's subtree among them, are all here.
   */
  items: PendingRunAttentionItem[];
  /** Every pending item, counted by the plan node its run serves; `null` for none. */
  counts: Array<{ planNodeId: string | null; count: number }>;
}

/** The space's pending attention items by the plan node of their run, each with its run's slug. */
export async function readPendingRunAttention(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  perNodeLimit: number,
): Promise<PendingRunAttention> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const pending = and(
      sql`${attentionItems.consumedAt} IS NULL`,
      eq(attentionItems.tenantId, tenantId),
      eq(attentionItems.spaceId, spaceId),
    );
    const ranked = tx
      .select({
        itemId: attentionItems.id,
        kind: attentionItems.kind,
        runId: attentionItems.relatedRunId,
        workflowSlug: workflowRuns.workflowSlug,
        planNodeId: workflowRuns.planNodeId,
        createdAt: attentionItems.createdAt,
        rank: sql<number>`row_number() over (partition by ${workflowRuns.planNodeId} order by ${attentionItems.createdAt} desc, ${attentionItems.id} desc)`.as(
          'rank',
        ),
      })
      .from(attentionItems)
      .leftJoin(workflowRuns, eq(workflowRuns.runId, attentionItems.relatedRunId))
      .where(pending)
      .as('ranked');
    const rows = await tx
      .select({
        itemId: ranked.itemId,
        kind: ranked.kind,
        runId: ranked.runId,
        workflowSlug: ranked.workflowSlug,
        planNodeId: ranked.planNodeId,
        createdAt: ranked.createdAt,
      })
      .from(ranked)
      .where(lte(ranked.rank, perNodeLimit))
      .orderBy(desc(ranked.createdAt), desc(ranked.itemId));
    const counts = await tx
      .select({ planNodeId: workflowRuns.planNodeId, count: sql<number>`count(*)::int` })
      .from(attentionItems)
      .leftJoin(workflowRuns, eq(workflowRuns.runId, attentionItems.relatedRunId))
      .where(pending)
      .groupBy(workflowRuns.planNodeId);
    return {
      items: rows.map((row) => ({ ...row, kind: row.kind as AttentionItemKind })),
      counts,
    };
  });
}

/**
 * Mark an attention item consumed and, once that has committed, bump its
 * space's attention generation, so the next Helmsman turn's block drops it.
 */
export async function markAttentionConsumed(
  db: PostgresJsDatabase,
  redis: Redis,
  tenantId: string,
  args: { id: string; consumedBySession: string },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const consumed = await withTenantSchema(db, tenantCtx, (tx) =>
    tx
      .update(attentionItems)
      .set({ consumedAt: new Date(), consumedBySession: args.consumedBySession })
      .where(and(eq(attentionItems.id, args.id), sql`consumed_at IS NULL`))
      .returning({ spaceId: attentionItems.spaceId }),
  );
  const spaceId = consumed[0]?.spaceId;
  if (spaceId) await bumpAttentionGeneration(redis, tenantId, spaceId);
}
