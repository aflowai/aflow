import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  PLAN_NODE_GOAL_HEAD_MAX_CHARS,
  PLAN_NODE_NOTE_HEAD_MAX_CHARS,
  PLAN_NODE_POSITION_MAX,
  PLAN_REVIEW_WORKFLOW_SLUGS,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  planDependencyMet,
  type CoachLearning,
  type PlanNode,
  type PlanNodeDependency,
  type PlanNodeDependencyCondition,
  type PlanNodeDependencyView,
  type PlanNodeKind,
  type PlanNodeLink,
  type PlanNodeLinkKind,
  type PlanNodeRun,
  type PlanNodeSibling,
  type PlanNodeStatus,
  type PlanNodeSummary,
  type TenantId,
} from '@aflow/schemas';
import {
  coachLearnings,
  createTenantContext,
  planNodeDependencies,
  planNodeLinks,
  planNodes,
  withTenantSchema,
  workflowRuns,
} from '@aflow/database';
import type { PlanNodeDependencyRow, PlanNodeLinkRow, PlanNodeRow } from '@aflow/database';
import { coachLearningToRow, rowToCoachLearning } from '../coachLearningsStore.js';
import { checkDependency, type DependencyCheck, type DependencyReads } from './dependencies.js';
import { placeAmongSiblings, type PlanPlaceAnchor } from './placement.js';
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

/** What a run in flight is: `plan.node.get` lists runs in these statuses. */
export const PLAN_NODE_RUN_STATUSES: ReadonlyArray<PlanNodeRun['status']> = ['running', 'paused'];

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
  goal?: string;
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

export type PlanNodePlaceWrite =
  /** The node at its new position, its revision moved; no sibling's revision moved. */
  | { outcome: 'placed'; node: PlanNode }
  /** The node is not at the expected revision; `node` is how it stands. */
  | { outcome: 'stale'; node: PlanNode }
  /** The node already stands directly there; nothing was written. */
  | { outcome: 'unchanged'; node: PlanNode }
  /** The anchor is not a sibling of the node any more; `siblings` in order, the node among them. */
  | { outcome: 'not_sibling'; siblings: PlanNodeSibling[] }
  | { outcome: 'not_found' };

export interface PlanTreeWalkOptions extends PlanTreeWalkBounds {
  /** Walk from this node rather than from the roots. */
  rootId?: string;
  /**
   * Walk through only these statuses: a node of another, and all below it, is
   * not read. `rootId` is read whatever its status — it is where the caller
   * chose to look, not a node the walk came upon.
   */
  statuses?: readonly PlanNodeStatus[];
}

export interface NewPlanNodeLink {
  nodeId: string;
  kind: PlanNodeLinkKind;
  ref: string;
  label: string | null;
}

/** What a board card carries of a node past its summary, read from its own row. */
export interface PlanNodeBoardFacts {
  createdAt: string;
  closedAt?: string;
  /** The goal's head, by `planGoalHead`. */
  goalHead: string;
  /** The note's first line, by `planBoardNoteHead`; absent where there is none. */
  noteHead?: string;
}

/** A node's links counted by kind, and its review rounds among its run links. */
export interface PlanNodeLinkTally {
  runs: number;
  pullRequests: number;
  findings: number;
  documents: number;
  rounds: number;
}

/** A node's newest pull request link, and the `merge` link to the same pull request if it holds one. */
export interface PlanNodeNewestPullRequest {
  ref: string;
  merge: PlanNodeLink | null;
}

/** Where a page of links ends: the last link's key, its time at the database's own precision. */
export interface PlanLinkPageKey {
  at: string;
  kind: PlanNodeLinkKind;
  ref: string;
}

export interface PlanLinkPage {
  /** Newest first; ties by kind, then ref. */
  links: PlanNodeLink[];
  /** Every link of the kind asked for (or of any kind) the node holds. */
  total: number;
  /** Absent on the last page. */
  next?: PlanLinkPageKey;
}

export type PlanNodeLinkInsert =
  /** `revision` is the node's, which a link leaves where it stands. */
  | { outcome: 'inserted'; link: PlanNodeLink; revision: number }
  /** The node already holds a link of this kind to this ref; `link` is that one. */
  | { outcome: 'exists'; link: PlanNodeLink }
  | { outcome: 'node_not_found' };

export type PlanDependencyWrite =
  /** `dependency` is the edge as it now stands; absent where it was removed. */
  | { outcome: 'written'; node: PlanNode; dependency?: PlanNodeDependency }
  /** The waiting node is not at the expected revision, or gone. */
  | { outcome: 'stale' }
  | Exclude<DependencyCheck, { outcome: 'clear' }>;

export type PlanLearningInsert =
  | { outcome: 'inserted'; learning: CoachLearning }
  | { outcome: 'node_not_found' }
  /** Ids in `supersedes` that are not this node's learnings still read. */
  | { outcome: 'supersedes_unknown'; learningIds: string[] };

/** The learnings a node's read returns: plan-scope, still read (auto-recorded or ratified). */
export const PLAN_LEARNING_READ_STATUSES: ReadonlyArray<CoachLearning['status']> = [
  'auto_recorded',
  'ratified',
];

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
  /**
   * Puts the node directly before or after a sibling (roots among roots),
   * while it is still at `expectedRevision`, by `placeAmongSiblings`. The
   * siblings are read and locked in one transaction, so two places under one
   * parent take turns and the second decides against the first's order. A
   * renumbering writes the siblings' positions only, never their revisions:
   * it changes no sibling's place relative to another.
   */
  placeAtRevision(
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    anchor: PlanPlaceAnchor,
  ): Promise<PlanNodePlaceWrite>;
  /** The position after the last sibling under `parentId` (null: the roots). */
  nextPosition(spaceId: string, parentId: string | null): Promise<number>;
  listChildren(
    spaceId: string,
    parentId: string,
    limit: number,
  ): Promise<{ children: PlanNodeSummary[]; total: number }>;
  walk(spaceId: string, opts: PlanTreeWalkOptions): Promise<PlanTreeWalk>;
  /** Each node's parent (null for a root); a node not in the space is absent. */
  parentsOf(spaceId: string, nodeIds: readonly string[]): Promise<Map<string, string | null>>;
  /** Writes the link unless its node is not in the space or already holds it. */
  insertLink(spaceId: string, link: NewPlanNodeLink): Promise<PlanNodeLinkInsert>;
  /** The node's newest link of `kind`, read by kind rather than from a page of every link. */
  newestLink(spaceId: string, nodeId: string, kind: PlanNodeLinkKind): Promise<PlanNodeLink | null>;
  /** The node's link of `kind` to `ref`, by its key; null where there is none. */
  findLink(
    spaceId: string,
    nodeId: string,
    kind: PlanNodeLinkKind,
    ref: string,
  ): Promise<PlanNodeLink | null>;
  /**
   * One page of the node's links, newest first, of `kind` where one is named,
   * after `after` — the `next` of the page before.
   */
  pageLinks(
    spaceId: string,
    nodeId: string,
    page: { kind?: PlanNodeLinkKind; after?: PlanLinkPageKey; limit: number },
  ): Promise<PlanLinkPage>;
  /** Each of `nodeIds`'s creation, closing, goal head and note head; a node not in the space is absent. */
  boardFactsOf(
    spaceId: string,
    nodeIds: readonly string[],
  ): Promise<Map<string, PlanNodeBoardFacts>>;
  /** Each of `nodeIds`'s links counted, in one aggregate; a node with none is absent. */
  linkTalliesOf(
    spaceId: string,
    nodeIds: readonly string[],
  ): Promise<Map<string, PlanNodeLinkTally>>;
  /** Each of `nodeIds`'s newest pull request link; a node with none is absent. */
  newestPullRequestsOf(
    spaceId: string,
    nodeIds: readonly string[],
  ): Promise<Map<string, PlanNodeNewestPullRequest>>;
  /** How many runs, running or paused, serve each of `nodeIds` itself; eval trials never. */
  inFlightRunCountsOf(spaceId: string, nodeIds: readonly string[]): Promise<Map<string, number>>;
  /** The running and paused runs serving any of `nodeIds`, newest first; eval trials never. */
  listRunsServing(
    spaceId: string,
    nodeIds: readonly string[],
    limit: number,
  ): Promise<{ runs: PlanNodeRun[]; total: number }>;
  /**
   * Makes `nodeId` wait on `dependsOnId` for `condition` — or, with null,
   * takes that edge away — while `nodeId` is still at `expectedRevision`, and
   * moves its revision on. Setting an edge is checked by `checkDependency` in
   * the same transaction, which holds `nodeId`'s row and every row it walks
   * before reading that node's edges, so two writes that would close a loop
   * between them cannot both pass.
   */
  setDependencyAtRevision(
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    dependsOnId: string,
    condition: PlanNodeDependencyCondition | null,
  ): Promise<PlanDependencyWrite>;
  /** The edge from `nodeId` to `dependsOnId`; null where there is none. */
  findDependency(
    spaceId: string,
    nodeId: string,
    dependsOnId: string,
  ): Promise<PlanNodeDependency | null>;
  /** What `nodeId` waits on, each with that node's title and status; by title. */
  listDependencies(
    spaceId: string,
    nodeId: string,
    limit: number,
  ): Promise<{ dependencies: PlanNodeDependencyView[]; total: number }>;
  /** What waits on `nodeId`, each with the waiting node's title and status; by title. */
  listDependents(
    spaceId: string,
    nodeId: string,
    limit: number,
  ): Promise<{ dependents: PlanNodeDependencyView[]; total: number }>;
  /**
   * Writes a `plan`-scope learning on the node its scope names, and marks the
   * learnings it supersedes as superseded — each must be that node's and still
   * read — in one transaction.
   */
  insertLearning(spaceId: string, learning: CoachLearning): Promise<PlanLearningInsert>;
  /** The `plan`-scope learnings still read written on any of `nodeIds`, newest first. */
  listLearningsOf(
    spaceId: string,
    nodeIds: readonly string[],
    limit: number,
  ): Promise<{ learnings: CoachLearning[]; total: number }>;
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

export function rowToPlanNodeLink(row: PlanNodeLinkRow): PlanNodeLink {
  return {
    nodeId: row.nodeId,
    kind: row.kind as PlanNodeLinkKind,
    ref: row.ref,
    ...(row.label != null ? { label: row.label } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export function rowToPlanNodeDependency(row: PlanNodeDependencyRow): PlanNodeDependency {
  return {
    nodeId: row.nodeId,
    dependsOnId: row.dependsOnId,
    condition: row.condition as PlanNodeDependencyCondition,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One end of an edge as a node's read shows it. `met` is the dependency's
 * status against the condition, whichever end `other` is.
 */
export function planDependencyView(
  other: { nodeId: string; title: string; status: PlanNodeStatus },
  condition: PlanNodeDependencyCondition,
  dependencyStatus: PlanNodeStatus,
): PlanNodeDependencyView {
  return {
    nodeId: other.nodeId,
    title: other.title,
    status: other.status,
    condition,
    met: planDependencyMet(condition, dependencyStatus),
  };
}

/**
 * The goal's head as the board carries it: whole code points, at most
 * `PLAN_NODE_GOAL_HEAD_MAX_CHARS` UTF-16 units — the unit the schema counts.
 * Postgres's `left()` counts code points, so an astral character in its cut
 * would carry the head past the schema's limit; and a cut by units alone could
 * split a surrogate pair.
 */
export function planGoalHead(goal: string): string {
  return headByCodePoints(goal, PLAN_NODE_GOAL_HEAD_MAX_CHARS);
}

function headByCodePoints(text: string, maxUnits: number): string {
  let head = '';
  for (const codePoint of text) {
    if (head.length + codePoint.length > maxUnits) break;
    head += codePoint;
  }
  return head;
}

/**
 * The note's first line as a board card carries it: trimmed, then cut as the
 * goal's head is, at `PLAN_NODE_NOTE_HEAD_MAX_CHARS`. Undefined for no line.
 */
export function planBoardNoteHead(note: string | null | undefined): string | undefined {
  const line = (note ?? '').split('\n', 1)[0]?.trim() ?? '';
  return line === '' ? undefined : headByCodePoints(line, PLAN_NODE_NOTE_HEAD_MAX_CHARS);
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
  createdAt: planNodes.createdAt,
  updatedAt: planNodes.updatedAt,
  closedAt: planNodes.closedAt,
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
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
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
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    ...(row.closedAt != null ? { closedAt: new Date(row.closedAt).toISOString() } : {}),
  };
}

function parentIs(parentId: string | null): SQL {
  return parentId === null ? isNull(planNodes.parentId) : eq(planNodes.parentId, parentId);
}

const siblingOrder = (): SQL[] => {
  const columns = { position: planNodes.position, nodeId: planNodes.id };
  return PLAN_SIBLING_ORDER.map((key) => asc(columns[key]));
};

function levelIs(level: PlanTreeLevel, statuses: readonly PlanNodeStatus[] | undefined): SQL {
  const ofStatus = statuses !== undefined ? inArray(planNodes.status, [...statuses]) : undefined;
  switch (level.kind) {
    case 'roots':
      return and(isNull(planNodes.parentId), ofStatus)!;
    case 'node':
      return eq(planNodes.id, level.nodeId);
    case 'children':
      return and(inArray(planNodes.parentId, [...level.parentIds]), ofStatus)!;
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

/**
 * What a dependency check reads inside a write's transaction: each node's row
 * locked before its edges are read. Every edge write holds its waiting node's
 * row, so an edge out of a node the walk has passed cannot appear before the
 * write commits — and two writes that would close a loop each hold a row the
 * other's walk needs, so Postgres ends one as a deadlock.
 */
function dependencyReads(tx: PostgresJsDatabase, spaceId: string): DependencyReads {
  return {
    dependenciesOf: async (nodeId) => {
      const [held] = await tx
        .select({ id: planNodes.id })
        .from(planNodes)
        .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, nodeId)))
        .for('update');
      if (!held) return undefined;
      const rows = await tx
        .select({ dependsOnId: planNodeDependencies.dependsOnId })
        .from(planNodeDependencies)
        .where(
          and(eq(planNodeDependencies.spaceId, spaceId), eq(planNodeDependencies.nodeId, nodeId)),
        );
      return rows.map((row) => row.dependsOnId);
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

  const placeOnce = (
    spaceId: string,
    nodeId: string,
    expectedRevision: number,
    anchor: PlanPlaceAnchor,
  ): Promise<PlanNodePlaceWrite> =>
    inTenant(async (tx): Promise<PlanNodePlaceWrite> => {
      const findIn = async (): Promise<PlanNode | null> => {
        const [row] = await tx
          .select()
          .from(planNodes)
          .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, nodeId)))
          .limit(1);
        return row ? rowToPlanNode(row) : null;
      };
      const held = await findIn();
      if (!held) return { outcome: 'not_found' };
      // Every sibling locked, the node among them: a second place under this
      // parent waits here and then reads this one's order. Sorted again once
      // locked, since a row another write changed is returned as it now
      // stands but where the query first ordered it.
      const locked = await tx
        .select({
          nodeId: planNodes.id,
          title: planNodes.title,
          status: planNodes.status,
          position: planNodes.position,
          revision: planNodes.revision,
        })
        .from(planNodes)
        .where(and(eq(planNodes.spaceId, spaceId), parentIs(held.parentId)))
        .orderBy(...siblingOrder())
        .for('update');
      const siblings = locked.sort(
        (a, b) =>
          a.position - b.position || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
      );
      const self = siblings.find((s) => s.nodeId === nodeId);
      if (!self || self.revision !== expectedRevision) {
        // Moved under another parent, or written, since the first read.
        const now = await findIn();
        return now ? { outcome: 'stale', node: now } : { outcome: 'not_found' };
      }
      const placement = placeAmongSiblings(siblings, nodeId, anchor);
      if (placement.outcome === 'not_sibling') {
        return {
          outcome: 'not_sibling',
          siblings: siblings.map((s) => ({
            nodeId: s.nodeId,
            title: s.title,
            status: s.status as PlanNodeStatus,
            position: s.position,
          })),
        };
      }
      if (placement.outcome === 'unchanged') return { outcome: 'unchanged', node: held };
      if (placement.renumbered.size > 0) {
        const values = [...placement.renumbered].map(
          ([id, position]) => sql`(${id}::uuid, ${position}::int)`,
        );
        await tx.execute(sql`
          UPDATE plan_nodes AS n SET position = v.position
          FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, position)
          WHERE n.space_id = ${spaceId}::uuid AND n.id = v.id
        `);
      }
      const node = await writeAtRevision(tx, spaceId, nodeId, expectedRevision, {
        position: placement.position,
      });
      if (!node) throw new Error('a plan node held for a place changed under its lock');
      return { outcome: 'placed', node };
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

    placeAtRevision: (spaceId, nodeId, expectedRevision, anchor) =>
      retryingDeadlocks(() => placeOnce(spaceId, nodeId, expectedRevision, anchor)),

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
              .where(and(eq(planNodes.spaceId, spaceId), levelIs(level, opts.statuses)))
              .orderBy(...siblingOrder())
              .limit(limit);
            return rows.map(summaryRowToSummary);
          },
          opts.rootId !== undefined ? { rootId: opts.rootId } : {},
          opts,
        ),
      ),

    parentsOf: (spaceId, nodeIds) =>
      inTenant(async (tx) => {
        if (nodeIds.length === 0) return new Map<string, string | null>();
        const rows = await tx
          .select({ id: planNodes.id, parentId: planNodes.parentId })
          .from(planNodes)
          .where(and(eq(planNodes.spaceId, spaceId), inArray(planNodes.id, [...nodeIds])));
        return new Map(rows.map((row) => [row.id, row.parentId]));
      }),

    insertLink: (spaceId, link) =>
      inTenant(async (tx): Promise<PlanNodeLinkInsert> => {
        const [node] = await tx
          .select({ id: planNodes.id, revision: planNodes.revision })
          .from(planNodes)
          .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, link.nodeId)))
          .limit(1);
        if (!node) return { outcome: 'node_not_found' };
        const [inserted] = await tx
          .insert(planNodeLinks)
          .values({ spaceId, ...link })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return {
            outcome: 'inserted',
            link: rowToPlanNodeLink(inserted),
            revision: node.revision,
          };
        }
        const [held] = await tx
          .select()
          .from(planNodeLinks)
          .where(
            and(
              eq(planNodeLinks.nodeId, link.nodeId),
              eq(planNodeLinks.kind, link.kind),
              eq(planNodeLinks.ref, link.ref),
            ),
          )
          .limit(1);
        if (!held) throw new Error('plan_node_links conflicted on a link it does not hold');
        return { outcome: 'exists', link: rowToPlanNodeLink(held) };
      }),

    newestLink: (spaceId, nodeId, kind) =>
      inTenant(async (tx) => {
        const [row] = await tx
          .select()
          .from(planNodeLinks)
          .where(
            and(
              eq(planNodeLinks.spaceId, spaceId),
              eq(planNodeLinks.nodeId, nodeId),
              eq(planNodeLinks.kind, kind),
            ),
          )
          .orderBy(desc(planNodeLinks.createdAt))
          .limit(1);
        return row ? rowToPlanNodeLink(row) : null;
      }),

    findLink: (spaceId, nodeId, kind, ref) =>
      inTenant(async (tx) => {
        const [row] = await tx
          .select()
          .from(planNodeLinks)
          .where(
            and(
              eq(planNodeLinks.spaceId, spaceId),
              eq(planNodeLinks.nodeId, nodeId),
              eq(planNodeLinks.kind, kind),
              eq(planNodeLinks.ref, ref),
            ),
          )
          .limit(1);
        return row ? rowToPlanNodeLink(row) : null;
      }),

    pageLinks: (spaceId, nodeId, page) =>
      inTenant(async (tx) => {
        const ofNode = and(
          eq(planNodeLinks.spaceId, spaceId),
          eq(planNodeLinks.nodeId, nodeId),
          page.kind !== undefined ? eq(planNodeLinks.kind, page.kind) : undefined,
        );
        const after = page.after;
        // The key's time is the column's own text, so a tie at the microsecond
        // compares equal rather than falling either side of a millisecond.
        const afterKey =
          after === undefined
            ? undefined
            : or(
                lt(planNodeLinks.createdAt, sql`${after.at}::timestamptz`),
                and(
                  eq(planNodeLinks.createdAt, sql`${after.at}::timestamptz`),
                  or(
                    gt(planNodeLinks.kind, after.kind),
                    and(eq(planNodeLinks.kind, after.kind), gt(planNodeLinks.ref, after.ref)),
                  ),
                ),
              );
        const rows = await tx
          .select({
            nodeId: planNodeLinks.nodeId,
            spaceId: planNodeLinks.spaceId,
            kind: planNodeLinks.kind,
            ref: planNodeLinks.ref,
            label: planNodeLinks.label,
            createdAt: planNodeLinks.createdAt,
            at: sql<string>`${planNodeLinks.createdAt}::text`,
          })
          .from(planNodeLinks)
          .where(and(ofNode, afterKey))
          .orderBy(desc(planNodeLinks.createdAt), asc(planNodeLinks.kind), asc(planNodeLinks.ref))
          .limit(page.limit + 1);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(planNodeLinks)
          .where(ofNode);
        const shown = rows.slice(0, page.limit);
        const last = shown.at(-1);
        return {
          links: shown.map(({ at: _at, ...row }) =>
            rowToPlanNodeLink({ ...row, createdAt: new Date(row.createdAt) }),
          ),
          total: count?.total ?? 0,
          ...(rows.length > page.limit && last !== undefined
            ? { next: { at: last.at, kind: last.kind as PlanNodeLinkKind, ref: last.ref } }
            : {}),
        };
      }),

    boardFactsOf: (spaceId, nodeIds) =>
      inTenant(async (tx) => {
        const facts = new Map<string, PlanNodeBoardFacts>();
        if (nodeIds.length === 0) return facts;
        const rows = await tx
          .select({
            id: planNodes.id,
            createdAt: planNodes.createdAt,
            closedAt: planNodes.closedAt,
            // The head only: a board must not carry every goal in the space.
            goalHead: sql<string>`left(${planNodes.goal}, ${PLAN_NODE_GOAL_HEAD_MAX_CHARS})`,
            // The first line's head, with room for the whitespace a trim takes off it.
            noteHead: sql<
              string | null
            >`left(split_part(${planNodes.note}, chr(10), 1), ${PLAN_NOTE_HEAD_MAX_CHARS})`,
          })
          .from(planNodes)
          .where(and(eq(planNodes.spaceId, spaceId), inArray(planNodes.id, [...nodeIds])));
        for (const row of rows) {
          const noteHead = planBoardNoteHead(row.noteHead);
          facts.set(row.id, {
            createdAt: new Date(row.createdAt).toISOString(),
            ...(row.closedAt != null ? { closedAt: new Date(row.closedAt).toISOString() } : {}),
            goalHead: planGoalHead(row.goalHead),
            ...(noteHead !== undefined ? { noteHead } : {}),
          });
        }
        return facts;
      }),

    linkTalliesOf: (spaceId, nodeIds) =>
      inTenant(async (tx) => {
        const tallies = new Map<string, PlanNodeLinkTally>();
        if (nodeIds.length === 0) return tallies;
        const ofKind = (kind: PlanNodeLinkKind) =>
          sql<number>`(count(*) filter (where ${planNodeLinks.kind} = ${kind}))::int`;
        const reviewSlugs = sql.join(
          PLAN_REVIEW_WORKFLOW_SLUGS.map((slug) => sql`${slug}`),
          sql`, `,
        );
        const rows = await tx
          .select({
            nodeId: planNodeLinks.nodeId,
            runs: ofKind('run'),
            pullRequests: ofKind('pull_request'),
            findings: ofKind('finding'),
            documents: ofKind('document'),
            rounds: sql<number>`(count(*) filter (where ${planNodeLinks.kind} = 'run' and split_part(${planNodeLinks.label}, ' ', 1) in (${reviewSlugs})))::int`,
          })
          .from(planNodeLinks)
          .where(
            and(eq(planNodeLinks.spaceId, spaceId), inArray(planNodeLinks.nodeId, [...nodeIds])),
          )
          .groupBy(planNodeLinks.nodeId);
        for (const { nodeId, ...tally } of rows) tallies.set(nodeId, tally);
        return tallies;
      }),

    newestPullRequestsOf: (spaceId, nodeIds) =>
      inTenant(async (tx) => {
        const newest = new Map<string, PlanNodeNewestPullRequest>();
        if (nodeIds.length === 0) return newest;
        const merges = alias(planNodeLinks, 'merges');
        const rows = await tx
          .selectDistinctOn([planNodeLinks.nodeId], {
            nodeId: planNodeLinks.nodeId,
            ref: planNodeLinks.ref,
            merge: {
              kind: merges.kind,
              ref: merges.ref,
              label: merges.label,
              createdAt: merges.createdAt,
            },
          })
          .from(planNodeLinks)
          .leftJoin(
            merges,
            and(
              eq(merges.nodeId, planNodeLinks.nodeId),
              eq(merges.kind, 'merge'),
              eq(merges.ref, planNodeLinks.ref),
            ),
          )
          .where(
            and(
              eq(planNodeLinks.spaceId, spaceId),
              eq(planNodeLinks.kind, 'pull_request'),
              inArray(planNodeLinks.nodeId, [...nodeIds]),
            ),
          )
          .orderBy(
            asc(planNodeLinks.nodeId),
            desc(planNodeLinks.createdAt),
            asc(planNodeLinks.ref),
          );
        for (const row of rows) {
          newest.set(row.nodeId, {
            ref: row.ref,
            merge:
              row.merge === null
                ? null
                : rowToPlanNodeLink({
                    nodeId: row.nodeId,
                    spaceId,
                    kind: row.merge.kind,
                    ref: row.merge.ref,
                    label: row.merge.label,
                    createdAt: new Date(row.merge.createdAt),
                  }),
          });
        }
        return newest;
      }),

    inFlightRunCountsOf: (spaceId, nodeIds) =>
      inTenant(async (tx) => {
        const counts = new Map<string, number>();
        if (nodeIds.length === 0) return counts;
        const rows = await tx
          .select({ nodeId: workflowRuns.planNodeId, total: sql<number>`count(*)::int` })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.spaceId, spaceId),
              inArray(workflowRuns.planNodeId, [...nodeIds]),
              inArray(workflowRuns.status, [...PLAN_NODE_RUN_STATUSES]),
              isNull(workflowRuns.evalBatchId),
            ),
          )
          .groupBy(workflowRuns.planNodeId);
        for (const row of rows) if (row.nodeId !== null) counts.set(row.nodeId, row.total);
        return counts;
      }),

    listRunsServing: (spaceId, nodeIds, limit) =>
      inTenant(async (tx) => {
        if (nodeIds.length === 0) return { runs: [], total: 0 };
        const where = and(
          eq(workflowRuns.spaceId, spaceId),
          inArray(workflowRuns.planNodeId, [...nodeIds]),
          inArray(workflowRuns.status, [...PLAN_NODE_RUN_STATUSES]),
          isNull(workflowRuns.evalBatchId),
        );
        const rows = await tx
          .select({
            runId: workflowRuns.runId,
            slug: workflowRuns.workflowSlug,
            status: workflowRuns.status,
            nodeId: workflowRuns.planNodeId,
            startedAt: workflowRuns.startedAt,
          })
          .from(workflowRuns)
          .where(where)
          .orderBy(desc(workflowRuns.startedAt))
          .limit(limit);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(workflowRuns)
          .where(where);
        return {
          runs: rows.map((row) => ({
            runId: row.runId,
            slug: row.slug,
            status: row.status as PlanNodeRun['status'],
            nodeId: row.nodeId!,
            startedAt: row.startedAt.toISOString(),
          })),
          total: count?.total ?? 0,
        };
      }),

    setDependencyAtRevision: (spaceId, nodeId, expectedRevision, dependsOnId, condition) =>
      retryingDeadlocks(() =>
        inTenant(async (tx): Promise<PlanDependencyWrite> => {
          const [held] = await tx
            .select({ revision: planNodes.revision })
            .from(planNodes)
            .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, nodeId)))
            .for('update');
          if (held?.revision !== expectedRevision) return { outcome: 'stale' };
          const edge = and(
            eq(planNodeDependencies.nodeId, nodeId),
            eq(planNodeDependencies.dependsOnId, dependsOnId),
          );
          if (condition === null) {
            await tx.delete(planNodeDependencies).where(edge);
            const node = await writeAtRevision(tx, spaceId, nodeId, expectedRevision, {});
            return node ? { outcome: 'written', node } : { outcome: 'stale' };
          }
          const check = await checkDependency(
            nodeId,
            dependsOnId,
            dependencyReads(tx, spaceId),
            PLAN_TREE_WALK_NODE_LIMIT,
          );
          if (check.outcome !== 'clear') return check;
          const [row] = await tx
            .insert(planNodeDependencies)
            .values({ nodeId, dependsOnId, spaceId, condition })
            .onConflictDoUpdate({
              target: [planNodeDependencies.nodeId, planNodeDependencies.dependsOnId],
              set: { condition },
            })
            .returning();
          if (!row) throw new Error('plan_node_dependencies upsert returned no row');
          const node = await writeAtRevision(tx, spaceId, nodeId, expectedRevision, {});
          return node
            ? { outcome: 'written', node, dependency: rowToPlanNodeDependency(row) }
            : { outcome: 'stale' };
        }),
      ),

    findDependency: (spaceId, nodeId, dependsOnId) =>
      inTenant(async (tx) => {
        const [row] = await tx
          .select()
          .from(planNodeDependencies)
          .where(
            and(
              eq(planNodeDependencies.spaceId, spaceId),
              eq(planNodeDependencies.nodeId, nodeId),
              eq(planNodeDependencies.dependsOnId, dependsOnId),
            ),
          )
          .limit(1);
        return row ? rowToPlanNodeDependency(row) : null;
      }),

    listDependencies: (spaceId, nodeId, limit) =>
      inTenant(async (tx) => {
        const where = and(
          eq(planNodeDependencies.spaceId, spaceId),
          eq(planNodeDependencies.nodeId, nodeId),
        );
        const rows = await tx
          .select({
            nodeId: planNodes.id,
            title: planNodes.title,
            status: planNodes.status,
            condition: planNodeDependencies.condition,
          })
          .from(planNodeDependencies)
          .innerJoin(planNodes, eq(planNodes.id, planNodeDependencies.dependsOnId))
          .where(where)
          .orderBy(asc(planNodes.title), asc(planNodes.id))
          .limit(limit);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(planNodeDependencies)
          .where(where);
        return {
          dependencies: rows.map((row) => {
            const status = row.status as PlanNodeStatus;
            return planDependencyView(
              { nodeId: row.nodeId, title: row.title, status },
              row.condition as PlanNodeDependencyCondition,
              status,
            );
          }),
          total: count?.total ?? 0,
        };
      }),

    listDependents: (spaceId, nodeId, limit) =>
      inTenant(async (tx) => {
        const [self] = await tx
          .select({ status: planNodes.status })
          .from(planNodes)
          .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, nodeId)))
          .limit(1);
        if (!self) return { dependents: [], total: 0 };
        const where = and(
          eq(planNodeDependencies.spaceId, spaceId),
          eq(planNodeDependencies.dependsOnId, nodeId),
        );
        const rows = await tx
          .select({
            nodeId: planNodes.id,
            title: planNodes.title,
            status: planNodes.status,
            condition: planNodeDependencies.condition,
          })
          .from(planNodeDependencies)
          .innerJoin(planNodes, eq(planNodes.id, planNodeDependencies.nodeId))
          .where(where)
          .orderBy(asc(planNodes.title), asc(planNodes.id))
          .limit(limit);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(planNodeDependencies)
          .where(where);
        return {
          dependents: rows.map((row) =>
            planDependencyView(
              { nodeId: row.nodeId, title: row.title, status: row.status as PlanNodeStatus },
              row.condition as PlanNodeDependencyCondition,
              self.status as PlanNodeStatus,
            ),
          ),
          total: count?.total ?? 0,
        };
      }),

    insertLearning: (spaceId, learning) =>
      inTenant(async (tx): Promise<PlanLearningInsert> => {
        if (learning.scope.kind !== 'plan') {
          throw new Error('the plan store writes plan-scope learnings only');
        }
        const nodeId = learning.scope.planNodeId;
        const [node] = await tx
          .select({ id: planNodes.id })
          .from(planNodes)
          .where(and(eq(planNodes.spaceId, spaceId), eq(planNodes.id, nodeId)))
          .limit(1);
        if (!node) return { outcome: 'node_not_found' };
        const ofNode = and(
          eq(coachLearnings.spaceId, spaceId),
          eq(coachLearnings.scopeKind, 'plan'),
          eq(coachLearnings.planNodeId, nodeId),
          inArray(coachLearnings.status, [...PLAN_LEARNING_READ_STATUSES]),
        );
        if (learning.supersedes.length > 0) {
          const held = await tx
            .select({ id: coachLearnings.id })
            .from(coachLearnings)
            .where(and(ofNode, inArray(coachLearnings.id, learning.supersedes)))
            .for('update');
          const found = new Set(held.map((row) => row.id));
          const missing = learning.supersedes.filter((id) => !found.has(id));
          if (missing.length > 0) return { outcome: 'supersedes_unknown', learningIds: missing };
        }
        const [row] = await tx
          .insert(coachLearnings)
          .values(coachLearningToRow(spaceId, learning))
          .returning();
        if (!row) throw new Error('coach_learnings insert returned no row');
        if (learning.supersedes.length > 0) {
          await tx
            .update(coachLearnings)
            .set({
              status: 'superseded',
              resolvedAt: new Date(),
              resolvedBy: learning.coachSessionId,
            })
            .where(and(ofNode, inArray(coachLearnings.id, learning.supersedes)));
        }
        return { outcome: 'inserted', learning: rowToCoachLearning(row) };
      }),

    listLearningsOf: (spaceId, nodeIds, limit) =>
      inTenant(async (tx) => {
        if (nodeIds.length === 0) return { learnings: [], total: 0 };
        const where = and(
          eq(coachLearnings.spaceId, spaceId),
          eq(coachLearnings.scopeKind, 'plan'),
          inArray(coachLearnings.planNodeId, [...nodeIds]),
          inArray(coachLearnings.status, [...PLAN_LEARNING_READ_STATUSES]),
        );
        const rows = await tx
          .select()
          .from(coachLearnings)
          .where(where)
          .orderBy(desc(coachLearnings.createdAt), desc(coachLearnings.id))
          .limit(limit);
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(coachLearnings)
          .where(where);
        return { learnings: rows.map(rowToCoachLearning), total: count?.total ?? 0 };
      }),
  };
}
