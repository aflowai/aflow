/**
 * The overview's store reads (Plan 332 D7): one recursive query from the roots
 * carrying each open node's root and whether a closed node lies above it, the
 * closed steps only as counts per root, and the runs in flight joined to each
 * row; and the newest runs in flight on the nodes a lane shows.
 * `buildPlanOverview` (`board.ts`) makes the lanes from what these return.
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
import { PLAN_NODE_RUN_STATUSES, PLAN_NOTE_HEAD_MAX_CHARS, planBoardNoteHead } from './store.js';
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
  /** Open steps within the depth bound, whether or not the node bound let them all be returned. */
  openSteps: number;
  done: number;
  dropped: number;
  /** The newest write to a closed step under the root. */
  closedWrittenAt?: string;
  /** Steps lie past the depth bound, uncounted. */
  deeper: boolean;
}

/**
 * The overview's read: every root and the open steps of the open roots as
 * rows, roots first and then level by level, at most the node bound of them;
 * each returned root's steps counted, closed ones only ever counted.
 */
export interface PlanOverviewRead {
  nodes: PlanOverviewNode[];
  counted: Map<string, PlanOverviewRootCount>;
  /** Every root of the space, returned or not. */
  rootsTotal: number;
  /** The node bound, where the rows reached it. */
  truncated?: PlanNodeListTruncation;
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
  // The tree is carried by key alone; a node's row is joined only where it is
  // returned. Below a closed root nothing is read: its plan is closed by rule.
  // Nodes one level past the depth bound are reached only to say they exist.
  const rows = (await tx.execute(sql`
    WITH RECURSIVE tree AS (
      SELECT r.id, r.id AS root_id, r.status, r.updated_at,
        NULL::uuid AS open_parent_id,
        NULL::uuid AS closed_ancestor_id,
        NULL::uuid AS phase_id,
        0 AS depth,
        r.status IN (${closed}) AS closed,
        ARRAY[lpad(r.position::text, ${PATH_POSITION_DIGITS}, '0') || ':' || r.id::text] AS path
      FROM plan_nodes r
      WHERE r.space_id = ${spaceId}::uuid AND r.parent_id IS NULL
      UNION ALL
      SELECT n.id, t.root_id, n.status, n.updated_at,
        CASE WHEN t.closed THEN t.open_parent_id ELSE t.id END,
        CASE WHEN t.closed THEN t.id ELSE t.closed_ancestor_id END,
        CASE WHEN t.depth = 1 THEN t.id ELSE t.phase_id END,
        t.depth + 1,
        n.status IN (${closed}),
        t.path || (lpad(n.position::text, ${PATH_POSITION_DIGITS}, '0') || ':' || n.id::text)
      FROM plan_nodes n
      INNER JOIN tree t ON n.parent_id = t.id
      WHERE n.space_id = ${spaceId}::uuid
        AND t.depth <= ${bounds.maxDepth}
        AND NOT (t.depth = 0 AND t.closed)
    ),
    counted AS (
      SELECT root_id,
        (count(*) FILTER (WHERE ${steps} AND NOT closed))::int AS open_steps,
        (count(*) FILTER (WHERE ${steps} AND status = 'done'))::int AS done,
        (count(*) FILTER (WHERE ${steps} AND status = 'dropped'))::int AS dropped,
        max(updated_at) FILTER (WHERE ${steps} AND closed) AS closed_written_at,
        bool_or(depth > ${bounds.maxDepth}) AS deeper
      FROM tree
      GROUP BY root_id
    ),
    shipped AS (
      SELECT * FROM tree WHERE depth = 0 OR (depth <= ${bounds.maxDepth} AND NOT closed)
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
      (count(*) FILTER (WHERE s.depth = 0) OVER ())::int AS roots_total,
      c.open_steps, c.done, c.dropped, c.closed_written_at, c.deeper
    FROM shipped s
    INNER JOIN plan_nodes n ON n.id = s.id
    LEFT JOIN plan_nodes ancestor_row ON ancestor_row.id = s.closed_ancestor_id
    LEFT JOIN plan_nodes phase_row ON phase_row.id = s.phase_id
    LEFT JOIN counted c ON c.root_id = s.id AND s.depth = 0
    ORDER BY s.depth, s.path COLLATE "C"
    LIMIT ${bounds.maxNodes + 1}
  `)) as Array<Record<string, unknown>>;

  const nodes: PlanOverviewNode[] = [];
  const counted = new Map<string, PlanOverviewRootCount>();
  for (const row of rows.slice(0, bounds.maxNodes)) {
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
        openSteps: Number(row['open_steps'] ?? 0),
        done: Number(row['done'] ?? 0),
        dropped: Number(row['dropped'] ?? 0),
        ...(row['closed_written_at'] != null
          ? { closedWrittenAt: isoOf(row['closed_written_at']) }
          : {}),
        deeper: row['deeper'] === true,
      });
    }
  }
  return {
    nodes,
    counted,
    rootsTotal: Number(rows[0]?.['roots_total'] ?? 0),
    ...(rows.length > bounds.maxNodes
      ? { truncated: { bound: 'nodes' as const, value: bounds.maxNodes } }
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
