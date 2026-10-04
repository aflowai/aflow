import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
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
  checkNewParent,
  PLAN_SIBLING_ORDER,
  walkPlanTree,
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
  outcome?: string;
  closedAt?: Date | null;
}

export type PlanNodeMove =
  | { outcome: 'moved'; node: PlanNode }
  /** Not at the expected revision, or gone. */
  | { outcome: 'stale' }
  | { outcome: 'parent_not_found' }
  | { outcome: 'cycle' }
  | { outcome: 'too_deep' };

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
  insert(spaceId: string, values: NewPlanNode): Promise<PlanNode>;
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
   * the patch names a position. The check that the new parent is not the node
   * or under it, and the write, are one transaction that holds the rows from
   * the new parent up to its root, so no concurrent move can close a loop
   * through them.
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
 * Attempts at a move. Two moves that would close a loop between them each
 * hold a row the other's walk needs; Postgres ends one as a deadlock, and its
 * next attempt reads the other's committed move and refuses the cycle by name.
 */
export const PLAN_MOVE_ATTEMPTS = 3;

const DEADLOCK_DETECTED = '40P01';

function isDeadlock(err: unknown): boolean {
  for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === DEADLOCK_DETECTED) return true;
  }
  return false;
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
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${planNodes.position}) + 1, 0)::int` })
    .from(planNodes)
    .where(and(eq(planNodes.spaceId, spaceId), parentIs(parentId)));
  return row?.next ?? 0;
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
        const check = await checkNewParent(
          nodeId,
          parentId,
          async (id) => {
            const [row] = await tx
              .select({ parentId: planNodes.parentId })
              .from(planNodes)
              .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, id)))
              .for('update');
            return row ? row.parentId : undefined;
          },
          PLAN_TREE_DEPTH_LIMIT,
        );
        if (check !== 'clear') return { outcome: check };
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
      inTenant((tx) => writeAtRevision(tx, spaceId, nodeId, expectedRevision, patch)),

    moveAtRevision: async (spaceId, nodeId, expectedRevision, parentId, patch) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await moveOnce(spaceId, nodeId, expectedRevision, parentId, patch);
        } catch (err) {
          if (attempt >= PLAN_MOVE_ATTEMPTS || !isDeadlock(err)) throw err;
        }
      }
    },

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
