/**
 * The overview's store reads (Plan 332 D7): one recursive query from the roots,
 * its open nodes stopped at the node bound, carrying each open node's root and
 * whether a closed node lies above it, the closed steps only as counts per
 * root, and the runs in flight joined to each row; and the newest runs in
 * flight on the nodes a lane shows. `buildPlanOverview` (`board.ts`) makes the lanes from
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
 * The overview's read: a walk of at most the node bound of open nodes, open
 * roots first and then level by level, each level in reading order, passing
 * through the closed steps that have steps under them without spending the
 * bound on them; the open roots it reached, the closed roots up to a bound of
 * their own, and the open steps of the open roots as rows; each returned
 * root's steps counted, closed ones only ever counted.
 */
export interface PlanOverviewRead {
  nodes: PlanOverviewNode[];
  counted: Map<string, PlanOverviewRootCount>;
  /** Every root of the space, returned or not. */
  rootsTotal: number;
  /** The node bound, where the walk's open nodes reached it. */
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
  const pathKey = (alias: SQL) =>
    sql`lpad(${alias}.position::text, ${PATH_POSITION_DIGITS}, '0') || ':' || ${alias}.id::text`;
  // A level is one row of parallel arrays, an element for each node the walk
  // stands on with what its children inherit: its root, the open and closed
  // nodes nearest above, its phase and its path. Open nodes are the walk's and
  // alone spend the node bound: each level's are taken in reading order, by
  // path, until one lies past it, and the walk stops there. A closed step is
  // carried only where something lies under it, so an open step stranded
  // below it is still reached, and it spends nothing; a closed leaf is never
  // carried at all. `closed_below` counts each element's closed children with
  // one aggregate, so a plan's done history costs a count, not the bound.
  // Below a closed root nothing is read — its plan is closed by rule — and the
  // closed roots are listed on a budget of their own.
  const childrenOf = (shut: boolean) => sql`
    SELECT n.id, ${sql.raw(shut ? 'true' : 'false')} AS shut, p.root_id,
      CASE WHEN p.shut THEN p.open_parent_id ELSE p.id END AS open_parent_id,
      CASE WHEN p.shut THEN p.id ELSE p.closed_ancestor_id END AS closed_ancestor_id,
      CASE WHEN l.depth = 1 THEN p.id ELSE p.phase_id END AS phase_id,
      p.path || '/' || ${pathKey(sql`n`)} AS node_path
    FROM unnest(l.ids, l.shut, l.roots, l.open_parents, l.closed_ancestors, l.phases, l.paths)
      AS p(id, shut, root_id, open_parent_id, closed_ancestor_id, phase_id, path)
    INNER JOIN plan_nodes n ON n.parent_id = p.id
    WHERE n.space_id = ${spaceId}::uuid
      AND ${
        shut
          ? sql`n.status IN (${closed}) AND EXISTS (
            SELECT 1 FROM plan_nodes under
            WHERE under.space_id = ${spaceId}::uuid AND under.parent_id = n.id
          )`
          : sql`n.status NOT IN (${closed})`
      }`;
  const inLevelOrder = (column: string) =>
    sql`array_agg(${sql.raw(`c.${column}`)} ORDER BY c.node_path COLLATE "C")`;
  const rows = (await tx.execute(sql`
    WITH RECURSIVE levels AS (
      SELECT 0 AS depth, top.ids, top.ids AS roots,
        array_fill(NULL::uuid, ARRAY[cardinality(top.ids)]) AS open_parents,
        array_fill(NULL::uuid, ARRAY[cardinality(top.ids)]) AS closed_ancestors,
        array_fill(NULL::uuid, ARRAY[cardinality(top.ids)]) AS phases,
        array_fill(false, ARRAY[cardinality(top.ids)]) AS shut,
        top.paths,
        cardinality(top.ids) AS reached
      FROM (
        SELECT array_agg(head.id ORDER BY head.position, head.id) AS ids,
          array_agg(head.path ORDER BY head.position, head.id) AS paths
        FROM (
          SELECT r.id, r.position, ${pathKey(sql`r`)} AS path
          FROM plan_nodes r
          WHERE r.space_id = ${spaceId}::uuid AND r.parent_id IS NULL
            AND r.status NOT IN (${closed})
          ORDER BY r.position, r.id
          LIMIT ${bounds.maxNodes + 1}
        ) head
      ) top
      WHERE top.ids IS NOT NULL
      UNION ALL
      SELECT l.depth + 1, below.ids, below.roots, below.open_parents, below.closed_ancestors,
        below.phases, below.shut, below.paths, l.reached + below.opened
      FROM levels l
      CROSS JOIN LATERAL (
        SELECT ${inLevelOrder('id')} AS ids,
          ${inLevelOrder('root_id')} AS roots,
          ${inLevelOrder('open_parent_id')} AS open_parents,
          ${inLevelOrder('closed_ancestor_id')} AS closed_ancestors,
          ${inLevelOrder('phase_id')} AS phases,
          ${inLevelOrder('shut')} AS shut,
          ${inLevelOrder('node_path')} AS paths,
          (count(*) FILTER (WHERE NOT c.shut))::int AS opened
        FROM (
          (
            SELECT * FROM (${childrenOf(false)}) open_child
            ORDER BY open_child.node_path COLLATE "C"
            LIMIT ${bounds.maxNodes + 1} - l.reached
          )
          UNION ALL
          (${childrenOf(true)})
        ) c
      ) below
      WHERE l.depth < ${bounds.maxDepth}
        AND l.reached <= ${bounds.maxNodes}
        AND below.ids IS NOT NULL
    ),
    elements AS (
      SELECT l.depth, e.id, e.shut, e.root_id, e.open_parent_id, e.closed_ancestor_id,
        e.phase_id, e.path,
        row_number() OVER (PARTITION BY e.shut ORDER BY l.depth, e.level_order) AS rank_in_kind
      FROM levels l
      CROSS JOIN LATERAL unnest(
        l.ids, l.shut, l.roots, l.open_parents, l.closed_ancestors, l.phases, l.paths
      ) WITH ORDINALITY
        AS e(id, shut, root_id, open_parent_id, closed_ancestor_id, phase_id, path, level_order)
    ),
    kept AS (
      SELECT * FROM elements WHERE shut OR rank_in_kind <= ${bounds.maxNodes}
    ),
    beyond AS (
      SELECT coalesce(count(*) FILTER (WHERE NOT shut) > ${bounds.maxNodes}, false) AS walk_cut
      FROM elements
    ),
    frontier AS (
      SELECT max(depth) AS last_depth FROM kept
    ),
    closed_below AS (
      SELECT k.root_id,
        (count(*) FILTER (WHERE c.status = 'done'))::int AS done,
        (count(*) FILTER (WHERE c.status = 'dropped'))::int AS dropped,
        max(c.updated_at) AS closed_written_at
      FROM kept k
      INNER JOIN plan_nodes c ON c.parent_id = k.id
      WHERE k.depth < ${bounds.maxDepth}
        AND c.space_id = ${spaceId}::uuid
        AND c.status IN (${closed})
      GROUP BY k.root_id
    ),
    deeper AS (
      SELECT DISTINCT k.root_id FROM kept k
      WHERE k.depth = ${bounds.maxDepth} AND EXISTS (
        SELECT 1 FROM plan_nodes c
        WHERE c.space_id = ${spaceId}::uuid AND c.parent_id = k.id
      )
    ),
    cut AS (
      SELECT DISTINCT k.root_id FROM kept k CROSS JOIN beyond CROSS JOIN frontier
      WHERE beyond.walk_cut AND k.depth >= frontier.last_depth - 1
    ),
    shipped AS (
      SELECT id, root_id, depth, open_parent_id, closed_ancestor_id, phase_id, path
      FROM kept WHERE NOT shut
      UNION ALL
      SELECT shut_root.id, shut_root.id, 0, NULL::uuid, NULL::uuid, NULL::uuid, shut_root.path
      FROM (
        SELECT r.id, ${pathKey(sql`r`)} AS path
        FROM plan_nodes r
        WHERE r.space_id = ${spaceId}::uuid AND r.parent_id IS NULL
          AND r.status IN (${closed})
        ORDER BY r.position, r.id
        LIMIT ${bounds.maxNodes}
      ) shut_root
    )
    SELECT s.id, n.parent_id, s.root_id, s.depth, s.open_parent_id,
      s.closed_ancestor_id, ancestor_row.title AS closed_ancestor_title, phase_row.title AS phase_title,
      n.kind, n.title, n.status, n.revision, n.position,
      left(split_part(n.note, chr(10), 1), ${PLAN_NOTE_HEAD_MAX_CHARS}) AS note_head,
      n.created_at, n.updated_at, n.closed_at,
      CASE WHEN n.status IN (${closed}) THEN 0 ELSE (
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
      cb.done, cb.dropped, cb.closed_written_at,
      s.depth = 0 AND EXISTS (SELECT 1 FROM deeper d WHERE d.root_id = s.id) AS deeper,
      s.depth = 0 AND EXISTS (SELECT 1 FROM cut WHERE cut.root_id = s.id) AS cut
    FROM shipped s
    INNER JOIN plan_nodes n ON n.id = s.id
    LEFT JOIN plan_nodes ancestor_row ON ancestor_row.id = s.closed_ancestor_id
    LEFT JOIN plan_nodes phase_row ON phase_row.id = s.phase_id
    LEFT JOIN closed_below cb ON cb.root_id = s.id AND s.depth = 0
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
