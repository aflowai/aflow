import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, desc, inArray, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  attentionItems,
  sessions,
  workflowRuns,
} from '@aflow/database';
import type { AttentionItemRow } from '@aflow/database';
import type { AddAttentionItemInput, AttentionItemKind } from '@aflow/schemas';
import { bumpAttentionGeneration } from '../attentionCache.js';
import { drivenByLiveConversationSql } from '../conversationOwnership.js';

/**
 * `tenantId` is the trusted source — it goes into the row regardless of
 * what's in `args`. The schema-level `AddAttentionItemInput` deliberately
 * omits a `tenantId` field to remove the mismatch class.
 *
 * A run's next item supersedes its pause: whether it pauses again after a
 * resume or ends, its earlier pending `workflow_run_paused` items are
 * consumed with the write, so no pause outlives the run's next transition.
 */
async function insertAttentionItem(
  handle: PostgresJsDatabase,
  tenantId: string,
  args: AddAttentionItemInput,
): Promise<string> {
  if (args.relatedRunId !== undefined) {
    await handle
      .update(attentionItems)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(attentionItems.tenantId, tenantId),
          eq(attentionItems.relatedRunId, args.relatedRunId),
          eq(attentionItems.kind, 'workflow_run_paused' satisfies AttentionItemKind),
          sql`${attentionItems.consumedAt} IS NULL`,
        ),
      );
  }
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

/** An attention item with what its run's ownership is read from (`isReadersWork`). */
export interface AttentionItemWithRun {
  item: AttentionItemRow;
  /** The plan node the item's run serves. */
  planNodeId: string | null;
  /** The session that drove the item's run. */
  sessionId: string | null;
  /** That session is a Helmsman conversation that still owns the run. */
  drivenByLiveConversation: boolean;
}

/**
 * A tenant's attention items, newest first, each with its run's placement and
 * driver: pending only unless `includeConsumed`, and only those after
 * `afterItemId` in that order when given. Helmsman reads them via
 * `workflow.run.list_attention`, which decides whose each one is.
 */
export async function listAttentionItems(
  db: PostgresJsDatabase,
  tenantId: string,
  opts: {
    spaceId?: string;
    userId?: string;
    kind?: AttentionItemKind;
    includeConsumed?: boolean;
    limit?: number;
    afterItemId?: string;
  },
): Promise<AttentionItemWithRun[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const limit = opts.limit ?? 25;
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const conditions = [eq(attentionItems.tenantId, tenantId)];
    if (opts.includeConsumed !== true) conditions.push(sql`consumed_at IS NULL`);
    if (opts.spaceId) conditions.push(eq(attentionItems.spaceId, opts.spaceId));
    if (opts.userId) conditions.push(eq(attentionItems.userId, opts.userId));
    if (opts.kind) conditions.push(eq(attentionItems.kind, opts.kind));
    // Read back from the row, not from a Date: a JS Date keeps milliseconds and
    // created_at keeps microseconds, so a cursor rebuilt from one skips rows.
    if (opts.afterItemId !== undefined) {
      conditions.push(
        sql`(${attentionItems.createdAt}, ${attentionItems.id}) < (select created_at, id from attention_items where id = ${opts.afterItemId})`,
      );
    }
    return await tx
      .select({
        item: attentionItems,
        planNodeId: workflowRuns.planNodeId,
        sessionId: workflowRuns.sessionId,
        drivenByLiveConversation: drivenByLiveConversationSql(),
      })
      .from(attentionItems)
      .leftJoin(workflowRuns, eq(workflowRuns.runId, attentionItems.relatedRunId))
      .leftJoin(sessions, eq(sessions.sessionId, workflowRuns.sessionId))
      .where(and(...conditions))
      .orderBy(desc(attentionItems.createdAt), desc(attentionItems.id))
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
  /** The conversation that drove that run (`workflow_runs.session_id`). */
  sessionId: string | null;
  /** That conversation still owns the run (`drivenByLiveConversationSql`). */
  drivenByLiveConversation: boolean;
  createdAt: Date;
}

/** A space's pending attention items as the attention block reads them. */
export interface PendingRunAttention {
  /**
   * Newest first: the newest `perNodeLimit` items about runs serving each plan
   * node, as many of each live conversation's about runs serving none, and as
   * many of those about runs serving none that no conversation owns — so the
   * newest `perNodeLimit` of any set of nodes, a plan root's subtree among
   * them, of any one conversation's unplaced items, and of everyone's are all
   * here.
   */
  items: PendingRunAttentionItem[];
  /** Every pending item, counted by the plan node its run serves and the session that drove it; `null` for none. */
  counts: Array<{
    planNodeId: string | null;
    sessionId: string | null;
    drivenByLiveConversation: boolean;
    count: number;
  }>;
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
    const drivenByLiveConversation = drivenByLiveConversationSql();
    // A placed item is every conversation's on its root, so it is grouped by
    // node alone; an unplaced one by the live conversation that owns it, and
    // those no conversation owns together.
    const unplacedOwner = sql<
      string | null
    >`case when ${workflowRuns.planNodeId} is null and ${drivenByLiveConversation} then ${workflowRuns.sessionId} end`;
    const ranked = tx
      .select({
        itemId: attentionItems.id,
        kind: attentionItems.kind,
        runId: attentionItems.relatedRunId,
        workflowSlug: workflowRuns.workflowSlug,
        planNodeId: workflowRuns.planNodeId,
        sessionId: workflowRuns.sessionId,
        drivenByLiveConversation: drivenByLiveConversation.as('driven_by_live_conversation'),
        createdAt: attentionItems.createdAt,
        rank: sql<number>`row_number() over (partition by ${workflowRuns.planNodeId}, ${unplacedOwner} order by ${attentionItems.createdAt} desc, ${attentionItems.id} desc)`.as(
          'rank',
        ),
      })
      .from(attentionItems)
      .leftJoin(workflowRuns, eq(workflowRuns.runId, attentionItems.relatedRunId))
      .leftJoin(sessions, eq(sessions.sessionId, workflowRuns.sessionId))
      .where(pending)
      .as('ranked');
    const rows = await tx
      .select({
        itemId: ranked.itemId,
        kind: ranked.kind,
        runId: ranked.runId,
        workflowSlug: ranked.workflowSlug,
        planNodeId: ranked.planNodeId,
        sessionId: ranked.sessionId,
        drivenByLiveConversation: ranked.drivenByLiveConversation,
        createdAt: ranked.createdAt,
      })
      .from(ranked)
      .where(lte(ranked.rank, perNodeLimit))
      .orderBy(desc(ranked.createdAt), desc(ranked.itemId));
    const counts = await tx
      .select({
        planNodeId: workflowRuns.planNodeId,
        sessionId: workflowRuns.sessionId,
        drivenByLiveConversation,
        count: sql<number>`count(*)::int`,
      })
      .from(attentionItems)
      .leftJoin(workflowRuns, eq(workflowRuns.runId, attentionItems.relatedRunId))
      .leftJoin(sessions, eq(sessions.sessionId, workflowRuns.sessionId))
      .where(pending)
      // By the columns the ownership reads, not by its expression: Postgres
      // takes each rendering's parameters as a different expression.
      .groupBy(
        workflowRuns.planNodeId,
        workflowRuns.sessionId,
        sessions.targetKind,
        sessions.targetSystemRole,
        sessions.status,
      );
    return {
      items: rows.map((row) => ({ ...row, kind: row.kind as AttentionItemKind })),
      counts,
    };
  });
}

/**
 * Mark attention items consumed by the session that read them and, once that
 * has committed, bump each one's space's attention generation, so the next
 * Helmsman turn's block drops them. An item already consumed keeps its first
 * reader.
 */
export async function markAttentionConsumed(
  db: PostgresJsDatabase,
  redis: Redis,
  tenantId: string,
  args: { ids: readonly string[]; consumedBySession: string },
): Promise<void> {
  if (args.ids.length === 0) return;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const consumed = await withTenantSchema(db, tenantCtx, (tx) =>
    tx
      .update(attentionItems)
      .set({ consumedAt: new Date(), consumedBySession: args.consumedBySession })
      .where(
        and(
          eq(attentionItems.tenantId, tenantId),
          inArray(attentionItems.id, [...args.ids]),
          sql`consumed_at IS NULL`,
        ),
      )
      .returning({ spaceId: attentionItems.spaceId }),
  );
  const spaceIds = new Set(consumed.flatMap(({ spaceId }) => (spaceId !== null ? [spaceId] : [])));
  for (const spaceId of spaceIds) await bumpAttentionGeneration(redis, tenantId, spaceId);
}
