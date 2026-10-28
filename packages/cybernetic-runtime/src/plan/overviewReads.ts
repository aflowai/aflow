/**
 * The overview's store reads (Plan 332 D7): one recursive query from the roots,
 * stopped at the node bound, carrying each open node's root and whether a
 * closed node lies above it, the closed steps only as counts per root, and the
 * runs in flight joined to each row; and the newest runs in flight on the
 * nodes a lane shows. `buildPlanOverview` (`board.ts`) makes the lanes from
 * what these return, and the store reads both in one snapshot.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql, type SQL } from 'drizzle-orm';
import {
  CLOSED_PLAN_NODE_STATUSES,
  type PlanNodeKind,
  type PlanNodeListTruncation,
  type PlanNodeRun,
  type PlanNodeStatus,
  type PlanNodeSummary,
} from '@aflow/schemas';
import {
  PLAN_NODE_RUN_STATUSES,
  PLAN_NOTE_HEAD_MAX_CHARS,
  planBoardNoteHead,
  type PlanNodeNewestPullRequest,
} from './store.js';
import type { PlanTreeWalkBounds } from './tree.js';

/**
 * A node as the overview's read returns it (Plan 332 D7): a root, or an open
 * step under an open root, with where it sits — its root, its phase, the open
 * node and the closed node nearest above it — and the runs in flight on it.
 */
export interface PlanOverviewNode extends PlanNodeSummary {
  rootId: string;
  /** 0 for a root. */
  depth: number;
  /** Where the node falls in its plan's reading order — parents first, siblings by position — across the read. */
  walkOrder: number;
  /** The open node nearest above: the root for a step under no closed one; null for a root. */
  openParentId: string | null;
  /** The closed node nearest above, where one is: the step is stranded under it. */
  closedAncestor?: { nodeId: string; title: string };
  /** The title of the step's ancestor directly under the root; absent at depth 1 and on a root. */
  phaseTitle?: string;
  /** Runs, running or paused, serving the node itself; eval trials never. */
  inFlightRuns: number;
}

/** What the overview's read counted under one root it returned, open or closed. */
export interface PlanOverviewRootCount {
  done: number;
  dropped: number;
  /** The newest write to a closed step under the root. */
  closedWrittenAt?: string;
  /** Steps lie past the depth bound, uncounted. */
  deeper: boolean;
  /** The node bound stopped the walk where steps under the root, open or closed, may lie unread. */
  cut: boolean;
}

/**
 * The overview's read: a walk of at most the node bound of nodes, open and
 * closed, roots first and then level by level, each level in reading order;
 * every root it reached and the open steps of the open roots as rows; each
 * returned root's steps counted, closed ones only ever counted.
 */
export interface PlanOverviewRead {
  nodes: PlanOverviewNode[];
  counted: Map<string, PlanOverviewRootCount>;
  /** Every root of the space, returned or not. */
  rootsTotal: number;
  /** The node bound, where the walk reached it. */
  truncated?: PlanNodeListTruncation;
  /**
   * Where the node bound stopped the walk, the deepest level it kept: a node
   * at that level or the one above it may have children the walk never read.
   */
  frontierDepth?: number;
}

/**
 * What the overview places from its read, and which of the nodes it shows are
 * looked up in the same snapshot: the newest pull request of each of
 * `pullRequestsOf`, and up to `runsPerNode` runs in flight on each of `runsOf`.
 */
export interface PlanOverviewPlacement<T> {
  placed: T;
  pullRequestsOf: readonly string[];
  runsOf: readonly string[];
  runsPerNode: number;
}

/** The overview's read, what was placed from it, and its lookups, all from one snapshot. */
export interface PlanOverviewSnapshot<T> {
  read: PlanOverviewRead;
  placed: T;
  pullRequests: Map<string, PlanNodeNewestPullRequest>;
  runs: Map<string, PlanNodeRun[]>;
}

function statusList(statuses: readonly string[]): SQL {
  return sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  );
}

/** A timestamp a raw query returned: a `Date` from the driver, or its text. */
function isoOf(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

/**
 * Where a node stands among its siblings, as one element of the path from its
 * root: positions are non-negative INTEGERs, so ten digits sort them as
 * numbers, and ids sort after them as `bySiblingOrder` breaks ties. A path
 * sorts as the tree reads, each parent before the nodes under it.
 */
const PATH_POSITION_DIGITS = 10;

export async function overviewIn(
  tx: PostgresJsDatabase,
  spaceId: string,
  bounds: PlanTreeWalkBounds,
): Promise<PlanOverviewRead> {
  const closed = statusList(CLOSED_PLAN_NODE_STATUSES);
  const steps = sql`depth BETWEEN 1 AND ${bounds.maxDepth}`;
  // `levels` walks the tree a level at a time, each level one array of keys
  // in reading order — its parents' order, then siblings by position — and
  // stops once it holds one node past the node bound, closed steps included,
  // so the nodes kept are the reading-order head of the tree: every level
  // above the last one walked whole, and of that one its first nodes. Below a
  // closed root nothing is read: its plan is closed by rule. Nodes one level
  // past the depth bound are reached only to say they exist. `walked` then
  // carries each kept node's root and ancestors over those keys alone; a
  // node's row is joined only where it is returned. Where the bound stopped
  // the walk, only a root that reached its last level or the one above it
  // may hold steps unread.
  const rows = (await tx.execute(sql`
    WITH RECURSIVE levels AS (
      SELECT 0 AS depth, roots.ids, cardinality(roots.ids) AS reached
      FROM (
        SELECT array_agg(head.id ORDER BY head.position, head.id) AS ids
        FROM (
          SELECT r.id, r.position
          FROM plan_nodes r
          WHERE r.space_id = ${spaceId}::uuid AND r.parent_id IS NULL
          ORDER BY r.position, r.id
          LIMIT ${bounds.maxNodes + 1}
        ) head
      ) roots
      WHERE roots.ids IS NOT NULL
      UNION ALL
      SELECT l.depth + 1, below.ids, l.reached + cardinality(below.ids)
      FROM levels l
      CROSS JOIN LATERAL (
        SELECT array_agg(head.id ORDER BY head.parent_order, head.position, head.id) AS ids
        FROM (
          SELECT n.id, n.position, p.parent_order
          FROM unnest(l.ids) WITH ORDINALITY AS p(id, parent_order)
          INNER JOIN plan_nodes n ON n.parent_id = p.id
          WHERE n.space_id = ${spaceId}::uuid
            AND (l.depth > 0 OR NOT EXISTS (
              SELECT 1 FROM plan_nodes shut
              WHERE shut.id = p.id AND shut.status IN (${closed})
            ))
          ORDER BY p.parent_order, n.position, n.id
          LIMIT ${bounds.maxNodes + 1} - l.reached
        ) head
      ) below
      WHERE l.depth <= ${bounds.maxDepth}
        AND l.reached <= ${bounds.maxNodes}
        AND below.ids IS NOT NULL
    ),
    reached AS (
      SELECT k.id, l.depth,
        row_number() OVER (ORDER BY l.depth, k.level_order) AS reading_rank
      FROM levels l
      CROSS JOIN LATERAL unnest(l.ids) WITH ORDINALITY AS k(id, level_order)
    ),
    kept AS (
      SELECT id, depth FROM reached WHERE reading_rank <= ${bounds.maxNodes}
    ),
    walked AS (
      SELECT r.id, r.id AS root_id, r.status, r.updated_at,
        NULL::uuid AS open_parent_id,
        NULL::uuid AS closed_ancestor_id,
        NULL::uuid AS phase_id,
        0 AS depth,
        r.status IN (${closed}) AS closed,
        ARRAY[lpad(r.position::text, ${PATH_POSITION_DIGITS}, '0') || ':' || r.id::text] AS path
      FROM kept k
      INNER JOIN plan_nodes r ON r.id = k.id
      WHERE k.depth = 0
      UNION ALL
      SELECT n.id, t.root_id, n.status, n.updated_at,
        CASE WHEN t.closed THEN t.open_parent_id ELSE t.id END,
        CASE WHEN t.closed THEN t.id ELSE t.closed_ancestor_id END,
        CASE WHEN t.depth = 1 THEN t.id ELSE t.phase_id END,
        t.depth + 1,
        n.status IN (${closed}),
        t.path || (lpad(n.position::text, ${PATH_POSITION_DIGITS}, '0') || ':' || n.id::text)
      FROM walked t
      INNER JOIN kept k ON k.depth = t.depth + 1
      INNER JOIN plan_nodes n ON n.id = k.id AND n.parent_id = t.id
    ),
    beyond AS (
      SELECT count(*) > ${bounds.maxNodes} AS walk_cut FROM reached
    ),
    frontier AS (
      SELECT max(depth) AS last_depth FROM walked
    ),
    counted AS (
      SELECT root_id,
        (count(*) FILTER (WHERE ${steps} AND status = 'done'))::int AS done,
        (count(*) FILTER (WHERE ${steps} AND status = 'dropped'))::int AS dropped,
        max(updated_at) FILTER (WHERE ${steps} AND closed) AS closed_written_at,
        bool_or(depth > ${bounds.maxDepth}) AS deeper,
        coalesce(bool_or(walk_cut AND depth >= last_depth - 1 AND NOT (depth = 0 AND closed)), false) AS cut
      FROM walked CROSS JOIN beyond CROSS JOIN frontier
      GROUP BY root_id
    ),
    shipped AS (
      SELECT * FROM walked WHERE depth = 0 OR (depth <= ${bounds.maxDepth} AND NOT closed)
    )
    SELECT s.id, n.parent_id, s.root_id, s.depth, s.open_parent_id,
      s.closed_ancestor_id, ancestor_row.title AS closed_ancestor_title, phase_row.title AS phase_title,
      n.kind, n.title, n.status, n.revision, n.position,
      left(split_part(n.note, chr(10), 1), ${PLAN_NOTE_HEAD_MAX_CHARS}) AS note_head,
      n.created_at, n.updated_at, n.closed_at,
      CASE WHEN s.closed THEN 0 ELSE (
        SELECT count(*) FROM workflow_runs w
        WHERE w.space_id = ${spaceId}::uuid
          AND w.plan_node_id = s.id
          AND w.status IN (${statusList(PLAN_NODE_RUN_STATUSES)})
          AND w.eval_batch_id IS NULL
      ) END::int AS in_flight_runs,
      (row_number() OVER (ORDER BY s.path COLLATE "C"))::int AS walk_order,
      (SELECT count(*) FROM plan_nodes r
        WHERE r.space_id = ${spaceId}::uuid AND r.parent_id IS NULL)::int AS roots_total,
      (SELECT walk_cut FROM beyond) AS walk_cut,
      (SELECT last_depth FROM frontier) AS last_depth,
      c.done, c.dropped, c.closed_written_at, c.deeper, c.cut
    FROM shipped s
    INNER JOIN plan_nodes n ON n.id = s.id
    LEFT JOIN plan_nodes ancestor_row ON ancestor_row.id = s.closed_ancestor_id
    LEFT JOIN plan_nodes phase_row ON phase_row.id = s.phase_id
    LEFT JOIN counted c ON c.root_id = s.id AND s.depth = 0
    ORDER BY s.depth, s.path COLLATE "C"
  `)) as Array<Record<string, unknown>>;

  const nodes: PlanOverviewNode[] = [];
  const counted = new Map<string, PlanOverviewRootCount>();
  for (const row of rows) {
    const nodeId = String(row['id']);
    const noteHead = planBoardNoteHead(row['note_head'] as string | null);
    const closedAncestorId = row['closed_ancestor_id'] as string | null;
    const phaseTitle = row['phase_title'] as string | null;
    nodes.push({
      nodeId,
      parentId: (row['parent_id'] as string | null) ?? null,
      kind: row['kind'] as PlanNodeKind,
      title: String(row['title']),
      status: row['status'] as PlanNodeStatus,
      revision: Number(row['revision']),
      position: Number(row['position']),
      ...(noteHead !== undefined ? { noteHead } : {}),
      createdAt: isoOf(row['created_at']),
      updatedAt: isoOf(row['updated_at']),
      ...(row['closed_at'] != null ? { closedAt: isoOf(row['closed_at']) } : {}),
      rootId: String(row['root_id']),
      depth: Number(row['depth']),
      walkOrder: Number(row['walk_order']),
      openParentId: (row['open_parent_id'] as string | null) ?? null,
      ...(closedAncestorId != null
        ? {
            closedAncestor: {
              nodeId: closedAncestorId,
              title: (row['closed_ancestor_title'] as string | null) ?? '',
            },
          }
        : {}),
      ...(phaseTitle != null ? { phaseTitle } : {}),
      inFlightRuns: Number(row['in_flight_runs'] ?? 0),
    });
    if (Number(row['depth']) === 0) {
      counted.set(nodeId, {
        done: Number(row['done'] ?? 0),
        dropped: Number(row['dropped'] ?? 0),
        ...(row['closed_written_at'] != null
          ? { closedWrittenAt: isoOf(row['closed_written_at']) }
          : {}),
        deeper: row['deeper'] === true,
        cut: row['cut'] === true,
      });
    }
  }
  return {
    nodes,
    counted,
    rootsTotal: Number(rows[0]?.['roots_total'] ?? 0),
    ...(rows[0]?.['walk_cut'] === true
      ? {
          truncated: { bound: 'nodes' as const, value: bounds.maxNodes },
          frontierDepth: Number(rows[0]['last_depth']),
        }
      : {}),
  };
}

/** The running and paused runs serving each of `nodeIds` itself, newest first, at most `perNode` each; eval trials never. */
export async function runsInFlightIn(
  tx: PostgresJsDatabase,
  spaceId: string,
  nodeIds: readonly string[],
  perNode: number,
): Promise<Map<string, PlanNodeRun[]>> {
  const runs = new Map<string, PlanNodeRun[]>();
  if (nodeIds.length === 0) return runs;
  const ids = sql.join(
    nodeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    SELECT run_id, workflow_slug, status, plan_node_id, started_at
    FROM (
      SELECT run_id, workflow_slug, status, plan_node_id, started_at,
        row_number() OVER (
          PARTITION BY plan_node_id ORDER BY started_at DESC, run_id
        ) AS newest
      FROM workflow_runs
      WHERE space_id = ${spaceId}::uuid
        AND plan_node_id IN (${ids})
        AND status IN (${statusList(PLAN_NODE_RUN_STATUSES)})
        AND eval_batch_id IS NULL
    ) ranked
    WHERE newest <= ${perNode}
    ORDER BY plan_node_id, started_at DESC, run_id
  `)) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const nodeId = String(row['plan_node_id']);
    const held = runs.get(nodeId) ?? [];
    held.push({
      runId: String(row['run_id']),
      slug: String(row['workflow_slug']),
      status: row['status'] as PlanNodeRun['status'],
      nodeId,
      startedAt: isoOf(row['started_at']),
    });
    runs.set(nodeId, held);
  }
  return runs;
}
