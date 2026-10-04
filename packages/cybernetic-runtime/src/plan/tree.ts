import type { PlanNodeListTruncation, PlanNodeSummary } from '@aflow/schemas';

export interface PlacedPlanNode {
  node: PlanNodeSummary;
  /** 0 for the node the walk starts from. */
  depth: number;
}

/**
 * How siblings read, and the only statement of it: lowest position first, and
 * nodes sharing a position by id. The store builds its `ORDER BY` from this
 * list, so a page cut in SQL and a tree ordered here agree on every tie.
 */
export const PLAN_SIBLING_ORDER = ['position', 'nodeId'] as const;

export function bySiblingOrder(a: PlanNodeSummary, b: PlanNodeSummary): number {
  for (const key of PLAN_SIBLING_ORDER) {
    // Code-unit order, which is Postgres's byte order for a lowercase uuid.
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

// ============================================================================
// Walking down: a read of the tree
// ============================================================================

/** One level of a walk down the tree: where it begins, or the children of the level above. */
export type PlanTreeLevel =
  | { kind: 'roots' }
  | { kind: 'node'; nodeId: string }
  | { kind: 'children'; parentIds: readonly string[] };

/** The nodes of `level`, in sibling order, at most `limit` of them. */
export type ReadPlanTreeLevel = (level: PlanTreeLevel, limit: number) => Promise<PlanNodeSummary[]>;

export interface PlanTreeWalkBounds {
  /** Levels read below the first; the first is depth 0. */
  maxDepth: number;
  maxNodes: number;
}

export interface PlanTreeWalk {
  /** Level by level from where the walk began; `orderPlanTree` puts them in reading order. */
  nodes: PlanNodeSummary[];
  /** The bound that stopped the walk before it read every node it would reach. */
  truncated?: PlanNodeListTruncation;
}

/**
 * Walk down from the roots, or from one node, a level at a time by parent key,
 * reading no more than the bounds allow and naming the one that stopped it.
 */
export async function walkPlanTree(
  readLevel: ReadPlanTreeLevel,
  start: { rootId?: string },
  bounds: PlanTreeWalkBounds,
): Promise<PlanTreeWalk> {
  const nodes: PlanNodeSummary[] = [];
  let level: PlanTreeLevel =
    start.rootId !== undefined ? { kind: 'node', nodeId: start.rootId } : { kind: 'roots' };
  for (let depth = 0; ; depth++) {
    const room = bounds.maxNodes - nodes.length;
    const read = await readLevel(level, room + 1);
    nodes.push(...read.slice(0, room));
    if (read.length > room) {
      return { nodes, truncated: { bound: 'nodes', value: bounds.maxNodes } };
    }
    if (read.length === 0) return { nodes };
    level = { kind: 'children', parentIds: read.map((node) => node.nodeId) };
    if (depth === bounds.maxDepth) {
      const deeper = await readLevel(level, 1);
      return deeper.length > 0
        ? { nodes, truncated: { bound: 'depth', value: bounds.maxDepth } }
        : { nodes };
    }
  }
}

// ============================================================================
// Walking up: may a node go under a new parent?
// ============================================================================

export type NewParentCheck = 'clear' | 'cycle' | 'parent_not_found' | 'too_deep';

/**
 * Walk from `parentId` up to its root, by key, and say whether `nodeId` may
 * move under it: not if the walk meets `nodeId` (it would sit under itself),
 * nor if the walk is longer than `maxDepth`. `parentOf` answers undefined for
 * a node that is not there.
 */
export async function checkNewParent(
  nodeId: string,
  parentId: string,
  parentOf: (nodeId: string) => Promise<string | null | undefined>,
  maxDepth: number,
): Promise<NewParentCheck> {
  let current: string | null = parentId;
  for (let depth = 0; current !== null; depth++) {
    if (current === nodeId) return 'cycle';
    if (depth === maxDepth) return 'too_deep';
    const next = await parentOf(current);
    if (next === undefined) return 'parent_not_found';
    current = next;
  }
  return 'clear';
}

// ============================================================================
// Reading order
// ============================================================================

/**
 * Order nodes as the tree reads: each parent before its children, siblings by
 * `bySiblingOrder`. Starts from the roots, or from `rootId` alone. A node whose
 * parent is not among `nodes` is unreachable and left out, which is what keeps
 * an open child of a closed parent out of a tree of open nodes.
 */
export function orderPlanTree(
  nodes: readonly PlanNodeSummary[],
  opts: { rootId?: string } = {},
): PlacedPlanNode[] {
  const childrenOf = new Map<string | null, PlanNodeSummary[]>();
  for (const node of nodes) {
    const siblings = childrenOf.get(node.parentId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentId, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort(bySiblingOrder);

  const starts =
    opts.rootId !== undefined
      ? nodes.filter((n) => n.nodeId === opts.rootId)
      : (childrenOf.get(null) ?? []);

  const placed: PlacedPlanNode[] = [];
  const visited = new Set<string>();
  const stack: PlacedPlanNode[] = [...starts].reverse().map((node) => ({ node, depth: 0 }));
  while (stack.length > 0) {
    const next = stack.pop()!;
    // The rows form a tree only because every move is checked; placing each
    // node once keeps one bad row from hanging a read.
    if (visited.has(next.node.nodeId)) continue;
    visited.add(next.node.nodeId);
    placed.push(next);
    const children = childrenOf.get(next.node.nodeId) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, depth: next.depth + 1 });
    }
  }
  return placed;
}
