import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  attentionItems,
  workflowRuns,
} from '@aflow/database';
import type { AttentionItemRow } from '@aflow/database';
import type { AddAttentionItemInput, AttentionItemKind } from '@aflow/schemas';
/**
 * Append an attention item. Designed to run inside a larger transaction
 * — pass the transactional `tx` handle from the caller (a Drizzle
 * `PostgresJsDatabase`-typed transaction handle returned by
 * `withTenantSchema`'s callback) to commit the attention insert atomically
 * with the row-state update that triggered it (terminal/pause/cancel).
 * When called outside a transaction (no `tx`), the helper opens its own
 * `withTenantSchema` block.
 *
 * `tenantId` is the trusted source — it goes into the row regardless of
 * what's in `args`. The schema-level `AddAttentionItemInput` deliberately
 * omits a `tenantId` field to remove the mismatch class.
 */
export async function addAttentionItem(
  db: PostgresJsDatabase,
  tenantId: string,
  args: AddAttentionItemInput,
  tx?: PostgresJsDatabase,
): Promise<string> {
  const insertRow = async (handle: PostgresJsDatabase): Promise<string> => {
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
  };

  if (tx) {
    return insertRow(tx);
  }
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, insertRow);
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

/** The space's newest pending attention items, each with the slug and plan node of its run. */
export async function listPendingRunAttention(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  limit: number,
): Promise<PendingRunAttentionItem[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({
        itemId: attentionItems.id,
        kind: attentionItems.kind,
        runId: attentionItems.relatedRunId,
        workflowSlug: workflowRuns.workflowSlug,
        planNodeId: workflowRuns.planNodeId,
        createdAt: attentionItems.createdAt,
      })
      .from(attentionItems)
      .leftJoin(workflowRuns, eq(workflowRuns.runId, attentionItems.relatedRunId))
      .where(
        and(
          sql`${attentionItems.consumedAt} IS NULL`,
          eq(attentionItems.tenantId, tenantId),
          eq(attentionItems.spaceId, spaceId),
        ),
      )
      .orderBy(desc(attentionItems.createdAt))
      .limit(limit);
    return rows.map((row) => ({ ...row, kind: row.kind as AttentionItemKind }));
  });
}

/**
 * Mark an attention item consumed. The Helmsman session that surfaced
 * the item to the user calls this so future queries skip it.
 */
export async function markAttentionConsumed(
  db: PostgresJsDatabase,
  tenantId: string,
  args: { id: string; consumedBySession: string },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .update(attentionItems)
      .set({ consumedAt: new Date(), consumedBySession: args.consumedBySession })
      .where(and(eq(attentionItems.id, args.id), sql`consumed_at IS NULL`));
  });
}
