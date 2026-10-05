import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  PLAN_NODE_POSITION_MAX,
  PLAN_TREE_DEPTH_LIMIT,
  type PlanNode,
  type PlanNodeKind,
  type PlanNodeStatus,
  type PlanNodeSummary,
  type TenantId,
} from '@aflow/schemas';
import { createTenantContext, planNodes, withTenantSchema } from '@aflow/database';
import type { PlanNodeRow } from '@aflow/database';
import {
  checkPlacement,
  PLAN_SIBLING_ORDER,
  walkPlanTree,
  type PlacementCheck,
  type PlacementReads,
  type PlanTreeLevel,
  type PlanTreeWalk,
  type PlanTreeWalkBounds,
} from './tree.js';

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

/**
 * The columns an update writes; `revision` and `updatedAt` move on their own.
 * A parent is not among them: only `moveAtRevision` changes one.
 */
export interface PlanNodePatch {
  status?: PlanNodeStatus;
  note?: string | null;
  criteria?: string;
  title?: string;
  position?: number;
  outcome?: string | null;
  closedAt?: Date | null;
}

/** Why a node may not go where a write puts it. */
export type PlanPlacementRefusal = Exclude<PlacementCheck, { outcome: 'clear' }>;

export type PlanNodeInsert = { outcome: 'inserted'; node: PlanNode } | PlanPlacementRefusal;

export type PlanNodeMove =
  | { outcome: 'moved'; node: PlanNode }
  /** Not at the expected revision, or gone. */
  | { outcome: 'stale' }
  | PlanPlacementRefusal;

export interface PlanTreeWalkOptions extends PlanTreeWalkBounds {
  /** Walk from this node rather than from the roots. */
  rootId?: string;
  /** Walk through only these statuses: a node of another, and all below it, is not read. */
  statuses?: readonly PlanNodeStatus[];
}

/**
 * Every read and write of `plan_nodes`, scoped to one space. The engine in
 * `./operations.ts` is the only caller; it holds the rules, this holds the SQL.
 */
export interface PlanNodeStore {
  /**
   * Writes the node unless its parent is gone or it would sit past
   * `PLAN_TREE_DEPTH_LIMIT`. The check and the write are one transaction
   * holding the rows from the parent up to its root, so no concurrent move
   * can carry the parent deeper between them.
   */
  insert(spaceId: string, values: NewPlanNode): Promise<PlanNodeInsert>;
  find(spaceId: string, nodeId: string): Promise<PlanNode | null>;
  /** Writes only while the node is still at `expectedRevision`; null when it is not (or is gone). */
  updateAtRevision(
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    patch: PlanNodePatch,
  ): Promise<PlanNode | null>;
  /**
   * Puts the node under `parentId` (null: a root) and writes `patch`, while it
   * is still at `expectedRevision` — after the last of its new siblings unless
   * the patch names a position. The checks — the new parent is not the node or
   * under it, and the node's deepest descendant stays within
   * `PLAN_TREE_DEPTH_LIMIT` — and the write are one transaction. It holds the
   * node's row, which a create anywhere below it must also take, and the rows
   * from the new parent up to its root, so no concurrent write can close a
   * loop through them or deepen the subtree after it was measured.
   */
  moveAtRevision(
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    parentId: string | null,
    patch: PlanNodePatch,
  ): Promise<PlanNodeMove>;
  /** The position after the last sibling under `parentId` (null: the roots). */
  nextPosition(spaceId: string, parentId: string | null): Promise<number>;
  listChildren(
    spaceId: string,
    parentId: string,
    limit: number,
  ): Promise<{ children: PlanNodeSummary[]; total: number }>;
  walk(spaceId: string, opts: PlanTreeWalkOptions): Promise<PlanTreeWalk>;
}

/**
 * Attempts at a create or a move. Two writes whose walks cross each hold a row
 * the other's needs — two moves that would close a loop, or a create below a
 * node being moved under it; Postgres ends one as a deadlock, and its next
 * attempt reads the other's committed write and refuses or places by it.
 */
export const PLAN_PLACEMENT_ATTEMPTS = 3;

const DEADLOCK_DETECTED = '40P01';

function isDeadlock(err: unknown): boolean {
  for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === DEADLOCK_DETECTED) return true;
  }
  return false;
}

async function retryingDeadlocks<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (attempt >= PLAN_PLACEMENT_ATTEMPTS || !isDeadlock(err)) throw err;
    }
  }
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

const siblingOrder = (): SQL[] => {
  const columns = { position: planNodes.position, nodeId: planNodes.id };
  return PLAN_SIBLING_ORDER.map((key) => asc(columns[key]));
};

function levelIs(level: PlanTreeLevel): SQL {
  switch (level.kind) {
    case 'roots':
      return isNull(planNodes.parentId);
    case 'node':
      return eq(planNodes.id, level.nodeId);
    case 'children':
      return inArray(planNodes.parentId, [...level.parentIds]);
  }
}

async function nextPositionIn(
  tx: PostgresJsDatabase,
  spaceId: string,
  parentId: string | null,
): Promise<number> {
  // Summed in bigint so a sibling at the INTEGER ceiling cannot overflow it; a
  // node placed after that sibling shares the ceiling, and the two read by id.
  const [row] = await tx
    .select({
      next: sql<number>`least(coalesce(max(${planNodes.position})::bigint + 1, 0), ${PLAN_NODE_POSITION_MAX})::int`,
    })
    .from(planNodes)
    .where(and(eq(planNodes.spaceId, spaceId), parentIs(parentId)));
  return row?.next ?? 0;
}

/**
 * What a placement check reads inside a write's transaction: each ancestor
 * row locked as the walk passes it, and the height below a node in one query.
 */
function placementReads(tx: PostgresJsDatabase, spaceId: string): PlacementReads {
  return {
    parentOf: async (id) => {
      const [row] = await tx
        .select({ parentId: planNodes.parentId })
        .from(planNodes)
        .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, id)))
        .for('update');
      return row ? row.parentId : undefined;
    },
    heightBelow: async (nodeId, maxHeight) => {
      const rows = await tx.execute(sql`
        WITH RECURSIVE below AS (
          SELECT id, 0 AS height
          FROM plan_nodes
          WHERE space_id = ${spaceId}::uuid AND id = ${nodeId}::uuid
          UNION ALL
          SELECT n.id, b.height + 1
          FROM plan_nodes n
          INNER JOIN below b ON n.parent_id = b.id
          WHERE n.space_id = ${spaceId}::uuid AND b.height < ${maxHeight}
        )
        SELECT coalesce(max(height), 0)::int AS height FROM below
      `);
      return Number((rows as Array<Record<string, unknown>>)[0]?.['height'] ?? 0);
    },
  };
}

async function writeAtRevision(
  tx: PostgresJsDatabase,
  spaceId: string,
  nodeId: string,
  expectedRevision: number,
  columns: PlanNodePatch & { parentId?: string | null },
): Promise<PlanNode | null> {
  const [row] = await tx
    .update(planNodes)
    .set({
      ...columns,
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
}

export function createPlanNodeStore(db: PostgresJsDatabase, tenantId: string): PlanNodeStore {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const inTenant = <T>(fn: (tx: PostgresJsDatabase) => Promise<T>): Promise<T> =>
    withTenantSchema(db, tenantCtx, fn);

  const moveOnce = (
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    parentId: string | null,
    patch: PlanNodePatch,
  ): Promise<PlanNodeMove> =>
    inTenant(async (tx) => {
      if (parentId !== null) {
        const reads = placementReads(tx, spaceId);
        // Held before the subtree is measured, so a create below it waits.
        if ((await reads.parentOf(nodeId)) === undefined) return { outcome: 'stale' };
        const check = await checkPlacement(parentId, nodeId, reads, PLAN_TREE_DEPTH_LIMIT);
        if (check.outcome !== 'clear') return check;
      }
      const position = patch.position ?? (await nextPositionIn(tx, spaceId, parentId));
      const node = await writeAtRevision(tx, spaceId, nodeId, expectedRevision, {
        ...patch,
        parentId,
        position,
      });
      return node ? { outcome: 'moved', node } : { outcome: 'stale' };
    });

  return {
    insert: (spaceId, values) =>
      retryingDeadlocks(() =>
        inTenant(async (tx): Promise<PlanNodeInsert> => {
          if (values.parentId !== null) {
            const check = await checkPlacement(
              values.parentId,
              null,
              placementReads(tx, spaceId),
              PLAN_TREE_DEPTH_LIMIT,
            );
            if (check.outcome !== 'clear') return check;
          }
          const [row] = await tx
            .insert(planNodes)
            .values({ spaceId, ...values })
            .returning();
          if (!row) throw new Error('plan_nodes insert returned no row');
          return { outcome: 'inserted', node: rowToPlanNode(row) };
        }),
      ),

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
      inTenant((tx) => writeAtRevision(tx, spaceId, nodeId, expectedRevision, patch)),

    moveAtRevision: (spaceId, nodeId, expectedRevision, parentId, patch) =>
      retryingDeadlocks(() => moveOnce(spaceId, nodeId, expectedRevision, parentId, patch)),

    nextPosition: (spaceId, parentId) => inTenant((tx) => nextPositionIn(tx, spaceId, parentId)),

    listChildren: (spaceId, parentId, limit) =>
      inTenant(async (tx) => {
        const where = and(eq(planNodes.spaceId, spaceId), eq(planNodes.parentId, parentId));
        const rows = await tx
          .select(summaryColumns())
          .from(planNodes)
          .where(where)
          .orderBy(...siblingOrder())
          .limit(limit);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(planNodes)
          .where(where);
        return { children: rows.map(summaryRowToSummary), total: count?.total ?? 0 };
      }),

    walk: (spaceId, opts) =>
      inTenant((tx) =>
        walkPlanTree(
          async (level, limit) => {
            const rows = await tx
              .select(summaryColumns())
              .from(planNodes)
              .where(
                and(
                  eq(planNodes.spaceId, spaceId),
                  levelIs(level),
                  opts.statuses !== undefined
                    ? inArray(planNodes.status, [...opts.statuses])
                    : undefined,
                ),
              )
              .orderBy(...siblingOrder())
              .limit(limit);
            return rows.map(summaryRowToSummary);
          },
          opts.rootId !== undefined ? { rootId: opts.rootId } : {},
          opts,
        ),
      ),
  };
}
