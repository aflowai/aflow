import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type {
  PlanNode,
  PlanNodeKind,
  PlanNodeStatus,
  PlanNodeSummary,
  TenantId,
} from '@aflow/schemas';
import { createTenantContext, planNodes, withTenantSchema } from '@aflow/database';
import type { PlanNodeRow } from '@aflow/database';

/** How much of the note's first line a summary carries. */
export const PLAN_NOTE_HEAD_MAX_CHARS = 200;

export interface NewPlanNode {
  parentId: string | null;
  kind: PlanNodeKind;
  title: string;
  goal: string;
  criteria: string;
  note: string | null;
  position: number;
  createdBy: string | null;
}

/** The columns an update writes; `revision` and `updatedAt` move on their own. */
export interface PlanNodePatch {
  status?: PlanNodeStatus;
  note?: string | null;
  criteria?: string;
  title?: string;
  parentId?: string | null;
  position?: number;
  outcome?: string;
  closedAt?: Date | null;
}

/**
 * Every read and write of `plan_nodes`, scoped to one space. The engine in
 * `./operations.ts` is the only caller; it holds the rules, this holds the SQL.
 */
export interface PlanNodeStore {
  insert(spaceId: string, values: NewPlanNode): Promise<PlanNode>;
  find(spaceId: string, nodeId: string): Promise<PlanNode | null>;
  /** Writes only while the node is still at `expectedRevision`; null when it is not (or is gone). */
  updateAtRevision(
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    patch: PlanNodePatch,
  ): Promise<PlanNode | null>;
  /** The position after the last sibling under `parentId` (null: the roots). */
  nextPosition(spaceId: string, parentId: string | null): Promise<number>;
  listChildren(
    spaceId: string,
    parentId: string,
    limit: number,
  ): Promise<{ children: PlanNodeSummary[]; total: number }>;
  /** The space's nodes as summaries, at most `limit`, optionally only these statuses. */
  scan(
    spaceId: string,
    opts: { statuses?: readonly PlanNodeStatus[]; limit: number },
  ): Promise<PlanNodeSummary[]>;
}

export function rowToPlanNode(row: PlanNodeRow): PlanNode {
  return {
    nodeId: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    kind: row.kind as PlanNodeKind,
    title: row.title,
    goal: row.goal,
    criteria: row.criteria,
    status: row.status as PlanNodeStatus,
    ...(row.outcome != null ? { outcome: row.outcome } : {}),
    ...(row.note != null ? { note: row.note } : {}),
    revision: row.revision,
    position: row.position,
    ...(row.createdBy != null ? { createdBy: row.createdBy } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.closedAt != null ? { closedAt: row.closedAt.toISOString() } : {}),
  };
}

/** The note's first line, bounded — what a list or the attention block shows of it. */
export function planNoteHead(note: string | null | undefined): string | undefined {
  const head = (note ?? '').split('\n', 1)[0]?.trim() ?? '';
  return head === '' ? undefined : head.slice(0, PLAN_NOTE_HEAD_MAX_CHARS);
}

// Built per query, not at module load: a module-level reference to a table
// breaks every consumer whose tests replace `@aflow/database` wholesale.
const summaryColumns = () => ({
  id: planNodes.id,
  parentId: planNodes.parentId,
  kind: planNodes.kind,
  title: planNodes.title,
  status: planNodes.status,
  revision: planNodes.revision,
  position: planNodes.position,
  // The first line only: a summary must not carry every note in the space.
  noteFirstLine: sql<string | null>`split_part(${planNodes.note}, chr(10), 1)`,
  updatedAt: planNodes.updatedAt,
});

interface SummaryRow {
  id: string;
  parentId: string | null;
  kind: string;
  title: string;
  status: string;
  revision: number;
  position: number;
  noteFirstLine: string | null;
  updatedAt: Date;
}

function summaryRowToSummary(row: SummaryRow): PlanNodeSummary {
  const noteHead = planNoteHead(row.noteFirstLine);
  return {
    nodeId: row.id,
    parentId: row.parentId,
    kind: row.kind as PlanNodeKind,
    title: row.title,
    status: row.status as PlanNodeStatus,
    revision: row.revision,
    position: row.position,
    ...(noteHead !== undefined ? { noteHead } : {}),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function parentIs(parentId: string | null): SQL {
  return parentId === null ? isNull(planNodes.parentId) : eq(planNodes.parentId, parentId);
}

export function createPlanNodeStore(db: PostgresJsDatabase, tenantId: string): PlanNodeStore {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const inTenant = <T>(fn: (tx: PostgresJsDatabase) => Promise<T>): Promise<T> =>
    withTenantSchema(db, tenantCtx, fn);

  return {
    insert: (spaceId, values) =>
      inTenant(async (tx) => {
        const [row] = await tx
          .insert(planNodes)
          .values({ spaceId, ...values })
          .returning();
        if (!row) throw new Error('plan_nodes insert returned no row');
        return rowToPlanNode(row);
      }),

    find: (spaceId, nodeId) =>
      inTenant(async (tx) => {
        const [row] = await tx
          .select()
          .from(planNodes)
          .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, nodeId)))
          .limit(1);
        return row ? rowToPlanNode(row) : null;
      }),

    updateAtRevision: (spaceId, nodeId, expectedRevision, patch) =>
      inTenant(async (tx) => {
        const [row] = await tx
          .update(planNodes)
          .set({
            ...patch,
            revision: sql`${planNodes.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(planNodes.spaceId, spaceId),
              eq(planNodes.id, nodeId),
              eq(planNodes.revision, expectedRevision),
            ),
          )
          .returning();
        return row ? rowToPlanNode(row) : null;
      }),

    nextPosition: (spaceId, parentId) =>
      inTenant(async (tx) => {
        const [row] = await tx
          .select({ next: sql<number>`coalesce(max(${planNodes.position}) + 1, 0)::int` })
          .from(planNodes)
          .where(and(eq(planNodes.spaceId, spaceId), parentIs(parentId)));
        return row?.next ?? 0;
      }),

    listChildren: (spaceId, parentId, limit) =>
      inTenant(async (tx) => {
        const where = and(eq(planNodes.spaceId, spaceId), eq(planNodes.parentId, parentId));
        const rows = await tx
          .select(summaryColumns())
          .from(planNodes)
          .where(where)
          .orderBy(asc(planNodes.position), asc(planNodes.createdAt))
          .limit(limit);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(planNodes)
          .where(where);
        return { children: rows.map(summaryRowToSummary), total: count?.total ?? 0 };
      }),

    scan: (spaceId, opts) =>
      inTenant(async (tx) => {
        const rows = await tx
          .select(summaryColumns())
          .from(planNodes)
          .where(
            and(
              eq(planNodes.spaceId, spaceId),
              opts.statuses !== undefined
                ? inArray(planNodes.status, [...opts.statuses])
                : undefined,
            ),
          )
          .orderBy(asc(planNodes.position), asc(planNodes.createdAt))
          .limit(opts.limit);
        return rows.map(summaryRowToSummary);
      }),
  };
}
